/**
 * Full-catalog scraper for AniList media — defaults to MANGA, which on AniList
 * covers manga, manhwa, manhua, light novels, one-shots and web comics (the
 * `format`/`countryOfOrigin` fields distinguish them).
 *
 * Two strategies (pick with --strategy):
 *
 *   ids   (default) — walk the whole id space in windows of 50 via `id_in`,
 *           always on page 1, filtered to one type. Complete (incl. titles with
 *           no start date) but sparse: many windows hit few/zero of one type.
 *
 *   dates — recursively bisect start-date ranges (FuzzyDateInt YYYYMMDD) and
 *           page each slice holding <=5000 entries. AniList refuses any page past
 *           5000 entries and even single years exceed that, so a range is split
 *           in half (by real date) whenever a page-100 probe shows more remain.
 *           Dense and fast, but date filters can't see titles with a null start
 *           date — so a `dates` run finishes with the cleanup pass below (skip
 *           with --no-cleanup).
 *
 *   cleanup — DB-pruned id sweep (also via --cleanup): only calls AniList for
 *           ids missing from the DB, catching null-start-date titles and any gaps.
 *
 * Every hit is stored through the shared normalizeMedia -> persistMedia pipeline
 * (identical shape to the CSV import and live fallback). Resumable: progress is
 * checkpointed per strategy; createMany(skipDuplicates) + upsert make re-runs
 * idempotent, so range overlaps at bisection boundaries are harmless.
 *
 * Usage:
 *   npm run scrape                              # MANGA, id-window sweep
 *   npm run scrape -- --strategy dates          # MANGA, date bisection + cleanup
 *   npm run scrape -- --strategy dates --no-cleanup
 *   npm run scrape -- --type ANIME --strategy dates
 *   npm run scrape -- --cleanup                 # gap-fill only
 *   npm run scrape -- --from 100000 --to 120000 # bound an id sweep
 *   npm run scrape -- --reset                   # ignore checkpoint, start over
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/mirror/db.js';
import {
  fetchMaxMediaId, fetchMediaByIds, fetchMediaByDatePage, probeDateOverflow,
  persistNodes, tally, type MediaType,
} from '../src/mirror/anilist/bulk.js';
import type { RawMediaNode } from '../src/mirror/anilist/ingest.js';

const WINDOW = 50; // id_in cap == Page perPage cap

// PLACEHOLDER_ARGS

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const TYPE = ((arg('type') || 'MANGA').toUpperCase() as MediaType);
const STRATEGY = (arg('strategy') || (has('cleanup') ? 'cleanup' : 'ids')).toLowerCase();

// --- shared run state, mutated across strategies ---
let stored = 0;
let reqs = 0;
let stopping = false;
const fmt: Record<string, number> = {};
const ctry: Record<string, number> = {};
const t0 = Date.now();

function progress(tag: string) {
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`  ${tag} — ${reqs} reqs, ${secs}s, stored=${stored} fmt=${JSON.stringify(fmt)} ctry=${JSON.stringify(ctry)}`);
}

async function store(nodes: RawMediaNode[]) {
  if (!nodes.length) return;
  await persistNodes(nodes);
  stored += nodes.length;
  tally(nodes, fmt, 'format');
  tally(nodes, ctry, 'countryOfOrigin');
}

// --- FuzzyDateInt (YYYYMMDD) <-> UTC ms helpers ---
const DAY = 86_400_000;
const toUTC = (n: number) => Date.UTC(Math.floor(n / 10000), (Math.floor(n / 100) % 100) - 1, n % 100);
const toInt = (ms: number) => {
  const d = new Date(ms);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
};
const addDays = (n: number, k: number) => toInt(toUTC(n) + k * DAY);
const midDate = (lo: number, hi: number) => toInt(Math.floor((toUTC(lo) + toUTC(hi)) / (2 * DAY)) * DAY);

// PLACEHOLDER_BODY

/** Page a start-date range fully (up to the 5000-entry cap), persisting each page. */
async function pageDateRange(gt: number, lt: number) {
  for (let page = 1; !stopping; page++) {
    const { nodes, hasNext } = await fetchMediaByDatePage(TYPE, gt, lt, page);
    await store(nodes);
    if (++reqs % 50 === 0) progress(`dates ${gt}..${lt} p${page}`);
    if (!hasNext || page >= 100) break;
  }
}

/**
 * Cover an inclusive [loInc, hiInc] YYYYMMDD range. Filters are exclusive, so we
 * pad ±1 day; overlaps are harmless (idempotent upsert). If the range overflows
 * 5000 entries we split it by real-date midpoint and recurse.
 */
async function scrapeDateRange(loInc: number, hiInc: number) {
  if (stopping) return;
  const gt = addDays(loInc, -1);
  const lt = addDays(hiInc, 1);
  reqs++;
  if (await probeDateOverflow(TYPE, gt, lt)) {
    if (hiInc <= loInc) {
      console.warn(`  ! >5000 ${TYPE} dated ${loInc}; storing first 5000 only`);
      await pageDateRange(gt, lt);
      return;
    }
    const mid = midDate(loInc, hiInc);
    await scrapeDateRange(loInc, mid);
    await scrapeDateRange(addDays(mid, 1), hiInc);
  } else {
    await pageDateRange(gt, lt);
  }
}

interface IdCkpt { lastId: number; stored: number; startedAt: string }
interface DateCkpt { doneBuckets: string[]; stored: number; startedAt: string }
const idCkptPath = path.resolve(`.scrape-${TYPE.toLowerCase()}.json`);
const dateCkptPath = path.resolve(`.scrape-${TYPE.toLowerCase()}-dates.json`);
const load = <T>(p: string): T | null => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return null; } };
const save = (p: string, v: unknown) => fs.writeFileSync(p, JSON.stringify(v));

// PLACEHOLDER_RUNNERS

/** Sparse but complete: walk the whole id space in id_in windows of 50. */
async function runIds() {
  const to = Number(arg('to')) || (await fetchMaxMediaId());
  const resumed = !has('reset') ? load<IdCkpt>(idCkptPath) : null;
  const from = Number(arg('from')) || (resumed ? resumed.lastId + 1 : 1);
  stored = resumed?.stored ?? 0;
  const startedAt = resumed?.startedAt ?? new Date().toISOString();
  console.log(`[ids] scraping ${TYPE}: ids ${from}..${to}${resumed ? ` (resumed, ${stored} stored)` : ''}`);
  for (let start = from; start <= to && !stopping; start += WINDOW) {
    const ids = Array.from({ length: Math.min(WINDOW, to - start + 1) }, (_, i) => start + i);
    await store(await fetchMediaByIds(ids, TYPE));
    const lastId = start + ids.length - 1;
    save(idCkptPath, { lastId, stored, startedAt } satisfies IdCkpt);
    if (++reqs % 20 === 0) progress(`id ${lastId}`);
  }
}

/** Dense: recursively bisect start-date ranges, checkpointing per year bucket. */
async function runDates() {
  const startYear = Number(arg('startYear')) || 1930;
  const endYear = new Date().getUTCFullYear() + 2;
  const buckets: { label: string; lo: number; hi: number }[] = [
    { label: `pre${startYear}`, lo: 18000101, hi: (startYear - 1) * 10000 + 1231 },
  ];
  for (let y = startYear; y <= endYear; y++) buckets.push({ label: `${y}`, lo: y * 10000 + 101, hi: y * 10000 + 1231 });
  buckets.push({ label: `post${endYear}`, lo: (endYear + 1) * 10000 + 101, hi: 99991231 });

  const ck = !has('reset') ? load<DateCkpt>(dateCkptPath) : null;
  const done = new Set(ck?.doneBuckets ?? []);
  stored = ck?.stored ?? 0;
  const startedAt = ck?.startedAt ?? new Date().toISOString();
  console.log(`[dates] ${TYPE} start-date bisection ${startYear}..${endYear}${done.size ? ` (resumed, ${done.size} buckets done, ${stored} stored)` : ''}`);

  for (const b of buckets) {
    if (stopping) break;
    if (done.has(b.label)) continue;
    console.log(`[dates] bucket ${b.label}`);
    await scrapeDateRange(b.lo, b.hi);
    if (!stopping) { done.add(b.label); save(dateCkptPath, { doneBuckets: [...done], stored, startedAt } satisfies DateCkpt); }
  }
}

/** Gap-fill: only call AniList for ids not already in the DB (finds null-date titles). */
async function runCleanup() {
  const to = Number(arg('to')) || (await fetchMaxMediaId());
  const from = Number(arg('from')) || 1;
  console.log(`[cleanup] DB-pruned id sweep ${from}..${to} for ${TYPE} (catches null-start-date titles & any gaps)`);
  let apiCalls = 0;
  for (let start = from; start <= to && !stopping; start += WINDOW) {
    const ids = Array.from({ length: Math.min(WINDOW, to - start + 1) }, (_, i) => start + i);
    const present = new Set((await prisma.media.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id));
    const missing = ids.filter((id) => !present.has(id));
    if (missing.length) { await store(await fetchMediaByIds(missing, TYPE)); apiCalls++; }
    if (++reqs % 100 === 0) progress(`cleanup id ${start + ids.length - 1} (apiCalls=${apiCalls})`);
  }
}

async function main() {
  if (TYPE !== 'ANIME' && TYPE !== 'MANGA') throw new Error(`--type must be ANIME or MANGA, got ${TYPE}`);
  const onStop = () => { stopping = true; console.log('\nFinishing current step, then stopping (resumable)...'); };
  process.on('SIGINT', onStop);
  process.on('SIGTERM', onStop);

  if (STRATEGY === 'cleanup') {
    await runCleanup();
  } else if (STRATEGY === 'dates') {
    await runDates();
    if (!stopping && !has('no-cleanup')) await runCleanup();
  } else if (STRATEGY === 'ids') {
    await runIds();
  } else {
    throw new Error(`--strategy must be ids, dates or cleanup, got ${STRATEGY}`);
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n${stopping ? 'Stopped' : 'Done'} (${STRATEGY}): stored ${stored} ${TYPE} rows, ${reqs} requests, ${secs}s.`);
  console.log(`Formats: ${JSON.stringify(fmt)}`);
  console.log(`Countries (JP=manga, KR=manhwa, CN/TW=manhua): ${JSON.stringify(ctry)}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
