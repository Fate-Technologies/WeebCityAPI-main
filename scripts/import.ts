/**
 * Streaming importer for anilist_anime_data_complete.csv (~438 MB, ~51k rows).
 *
 * Strategy:
 *  - Stream the file with csv-parse (never load it whole).
 *  - Accumulate global de-duped maps of Character/Staff/Studio/Tag across all
 *    rows, plus buffers of Media + join rows, flushing in batches.
 *  - Parent entities are flushed before join rows in each batch, and every
 *    createMany uses skipDuplicates so re-running the import is idempotent.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import { prisma } from '../src/mirror/db.js';
import { csvRowToMedia, normalizeMedia, type MappedMedia } from '../src/mirror/anilist/ingest.js';

const CSV_PATH = process.env.CSV_PATH || './anilist_anime_data_complete.csv';
// Bigger batch = fewer round trips, which dominate wall-clock on a high-latency
// remote link. Override with IMPORT_BATCH. Retries below absorb the flaky drops.
const BATCH = Number(process.env.IMPORT_BATCH || 1000);

// Global de-dupe so we don't re-send the same Character/Staff/Studio/Tag.
const seenChar = new Set<number>();
const seenStaff = new Set<number>();
const seenStudio = new Set<number>();
const seenTag = new Set<number>();

interface Buffers {
  media: any[];
  characters: any[]; staff: any[]; studios: any[]; tags: any[];
  mediaCharacters: any[]; mediaStaff: any[]; mediaStudios: any[]; mediaTags: any[];
  relations: any[]; recommendations: any[];
}
const fresh = (): Buffers => ({
  media: [], characters: [], staff: [], studios: [], tags: [],
  mediaCharacters: [], mediaStaff: [], mediaStudios: [], mediaTags: [],
  relations: [], recommendations: [],
});

let buf = fresh();
let pending = 0;
let totalRows = 0;

// Resumable checkpoint: the flaky remote link can kill a multi-hour import at any
// point, so we record the count of consumed rows after every successful flush.
// A restart skips already-imported rows (createMany(skipDuplicates) makes even an
// overlapping redo harmless). `--reset` (or IMPORT_RESET=1) ignores the checkpoint.
let rowNum = 0;
const PROGRESS_PATH = path.resolve('.import-progress.json');
const RESET = process.argv.includes('--reset') || process.env.IMPORT_RESET === '1';
let skipUntil = 0;
if (!RESET) {
  try { skipUntil = (JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8')).rows as number) ?? 0; } catch { skipUntil = 0; }
}
const saveProgress = () => { try { fs.writeFileSync(PROGRESS_PATH, JSON.stringify({ rows: rowNum })); } catch { /* best-effort */ } };

function add(mapped: MappedMedia) {
  buf.media.push(mapped.media);
  for (const c of mapped.characters) if (!seenChar.has(c.id)) { seenChar.add(c.id); buf.characters.push(c); }
  for (const s of mapped.staff) if (!seenStaff.has(s.id)) { seenStaff.add(s.id); buf.staff.push(s); }
  for (const s of mapped.studios) if (!seenStudio.has(s.id)) { seenStudio.add(s.id); buf.studios.push(s); }
  for (const t of mapped.tags) if (!seenTag.has(t.id)) { seenTag.add(t.id); buf.tags.push(t); }
  buf.mediaCharacters.push(...mapped.mediaCharacters);
  buf.mediaStaff.push(...mapped.mediaStaff);
  buf.mediaStudios.push(...mapped.mediaStudios);
  buf.mediaTags.push(...mapped.mediaTags);
  buf.relations.push(...mapped.relations);
  buf.recommendations.push(...mapped.recommendations);
  pending++;
}

/** Reject if a promise hasn't settled in `ms` — a hung socket on the flaky link
 * never throws on its own, so we race every DB call against a client-side clock. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`client timeout after ${ms}ms (${label})`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// A stalled query can hang far longer than any real one; kill it and reconnect.
const STMT_TIMEOUT = Number(process.env.IMPORT_STMT_TIMEOUT_MS || 60_000);

/** Retry a write across transient connection drops (common on remote/cloud PG). */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const MAX = 8;
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTimeout(fn(), STMT_TIMEOUT, label);
    } catch (e) {
      const msg = (e as Error).message || '';
      const transient = /timeout|can't reach database server|connection|ECONN|terminat|reset|socket|P1001|P1017/i.test(msg);
      if (!transient || attempt >= MAX) throw e;
      const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      const short = msg.replace(/\s+/g, ' ').trim().slice(0, 120) || '(no message)';
      console.warn(`  ${label} failed (attempt ${attempt}/${MAX}): ${short} — reconnect + retry in ${delay}ms`);
      // Drop the (possibly half-open) socket so the next attempt dials fresh.
      try { await prisma.$disconnect(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, delay));
      try { await prisma.$connect(); } catch { /* lazily reconnects on next query anyway */ }
    }
  }
}

async function writeBatch(b: Buffers) {
  // Each createMany is retried independently: on a flaky remote link, wrapping
  // the whole batch would re-run every statement whenever any one drops.
  // Parents first.
  await withRetry(() => prisma.media.createMany({ data: b.media, skipDuplicates: true }), 'media');
  if (b.characters.length) await withRetry(() => prisma.character.createMany({ data: b.characters, skipDuplicates: true }), 'characters');
  if (b.staff.length) await withRetry(() => prisma.staff.createMany({ data: b.staff, skipDuplicates: true }), 'staff');
  if (b.studios.length) await withRetry(() => prisma.studio.createMany({ data: b.studios, skipDuplicates: true }), 'studios');
  if (b.tags.length) await withRetry(() => prisma.tag.createMany({ data: b.tags, skipDuplicates: true }), 'tags');

  // Join rows.
  if (b.mediaCharacters.length) await withRetry(() => prisma.mediaCharacter.createMany({ data: b.mediaCharacters, skipDuplicates: true }), 'mediaCharacters');
  if (b.mediaStaff.length) await withRetry(() => prisma.mediaStaff.createMany({ data: b.mediaStaff, skipDuplicates: true }), 'mediaStaff');
  if (b.mediaStudios.length) await withRetry(() => prisma.mediaStudio.createMany({ data: b.mediaStudios, skipDuplicates: true }), 'mediaStudios');
  if (b.mediaTags.length) await withRetry(() => prisma.mediaTag.createMany({ data: b.mediaTags, skipDuplicates: true }), 'mediaTags');
  if (b.relations.length) await withRetry(() => prisma.mediaRelation.createMany({ data: b.relations, skipDuplicates: true }), 'relations');
  if (b.recommendations.length) await withRetry(() => prisma.mediaRecommendation.createMany({ data: b.recommendations, skipDuplicates: true }), 'recommendations');
}

async function flush() {
  if (pending === 0) return;
  const b = buf;
  buf = fresh();
  pending = 0;
  await writeBatch(b);
  saveProgress();
}

async function main() {
  console.log(`Importing from ${CSV_PATH} ...`);
  const started = Date.now();

  const parser = fs.createReadStream(CSV_PATH).pipe(
    parse({ columns: true, relax_quotes: true, skip_empty_lines: true, relax_column_count: true }),
  );

  if (skipUntil > 0) console.log(`  resuming: skipping first ${skipUntil} rows already imported (--reset to reimport all)`);
  for await (const record of parser) {
    const row = record as Record<string, string>;
    if (!row.id || row.id.trim() === '') continue;
    rowNum++;
    if (rowNum <= skipUntil) continue;
    try {
      add(normalizeMedia(csvRowToMedia(row)));
    } catch (err) {
      console.warn(`Skipping row id=${row.id}: ${(err as Error).message}`);
      continue;
    }
    totalRows++;
    if (pending >= BATCH) {
      await flush();
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      console.log(`  row ${rowNum} (+${totalRows} new, ${secs}s) — chars=${seenChar.size} staff=${seenStaff.size} studios=${seenStudio.size} tags=${seenTag.size}`);
    }
  }
  await flush();

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`Done: ${totalRows} media rows in ${secs}s.`);
  console.log(`Entities: characters=${seenChar.size} staff=${seenStaff.size} studios=${seenStudio.size} tags=${seenTag.size}`);
  try { fs.unlinkSync(PROGRESS_PATH); } catch { /* checkpoint already gone */ }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
