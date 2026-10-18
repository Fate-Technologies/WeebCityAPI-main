import { prisma } from "../mirror/db.js";
import { getSupabase } from "../lib/supabase.js";
import { log } from "../config/logger.js";

/**
 * Admin content-editor persistence — writes to the AniList mirror (Tiger DB).
 *
 * Catalog data lives in the mirror's Postgres `Media` table (keyed by AniList
 * id), NOT Supabase. An admin edit updates that row directly and sets
 * `isLocked = true`, which makes `persistMedia` (live-fallback / re-sync /
 * trending refresh) skip it so the curated values are never clobbered. Because
 * the row is the same one every visitor reads (getMediaByAnilistId prefers a
 * locked mirror row), edits are live for everyone on the next fetch.
 *
 * Fields the frontend form still sends but the mirror has no column for
 * (`rating`, `trailer_url`, `episode_sub_count`, `episode_dub_count`) are
 * silently dropped.
 */

type FieldKind = "string" | "number" | "stringArray";

/** Editable frontend key → mirror `Media` column. Keys with no mirror column are omitted. */
const MIRROR_COLUMN: Record<string, { col: string; kind: FieldKind }> = {
  title_romaji: { col: "titleRomaji", kind: "string" },
  title_english: { col: "titleEnglish", kind: "string" },
  title_native: { col: "titleNative", kind: "string" },
  description: { col: "description", kind: "string" },
  cover_image_large: { col: "coverImageLarge", kind: "string" },
  cover_image_medium: { col: "coverImageMedium", kind: "string" },
  banner_image: { col: "bannerImage", kind: "string" },
  format: { col: "format", kind: "string" },
  status: { col: "status", kind: "string" },
  season: { col: "season", kind: "string" },
  source: { col: "source", kind: "string" },
  country_of_origin: { col: "countryOfOrigin", kind: "string" },
  season_year: { col: "seasonYear", kind: "number" },
  episodes: { col: "episodes", kind: "number" },
  chapters: { col: "chapters", kind: "number" },
  volumes: { col: "volumes", kind: "number" },
  duration: { col: "duration", kind: "number" },
  average_score: { col: "averageScore", kind: "number" },
  mean_score: { col: "meanScore", kind: "number" },
  popularity: { col: "popularity", kind: "number" },
  favourites: { col: "favourites", kind: "number" },
  genres: { col: "genres", kind: "stringArray" },
};

export const EDITABLE_CONTENT_FIELDS = Object.keys(MIRROR_COLUMN);

/** Returns the coerced value, or `undefined` to signal "skip this field". */
function coerce(kind: FieldKind, value: unknown): unknown {
  if (value === null) return null;
  if (kind === "number") {
    if (value === "" || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  if (kind === "stringArray") {
    if (!Array.isArray(value)) return undefined;
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (value === undefined) return undefined;
  const s = String(value).trim();
  return s === "" ? null : s;
}

/**
 * Overrides now live in the mirror as the `isLocked` guard, so there is no
 * Supabase override log to re-apply. Kept as a no-op for the legacy Supabase
 * re-sync path (contentIngestion) that still imports it.
 */
export async function getOverrideColumns(
  _sb: NonNullable<ReturnType<typeof getSupabase>>,
  _tatakaiId: string,
): Promise<Record<string, unknown>> {
  return {};
}

export type OverrideRecord = {
  field: string;
  value: unknown;
  reason: string | null;
  at: string;
  by: string | null;
};

/** No mirror audit table — `isLocked` is the durable guard, not a history. */
export async function listOverrides(_anilistId: number): Promise<OverrideRecord[]> {
  return [];
}

/**
 * Apply an admin edit to a mirror `Media` row (by AniList id) and lock it.
 * Only whitelisted, mirror-backed columns are touched; unknown / no-column
 * keys are ignored. Caller must have backfilled the row (ensureMedia) first.
 */
export async function applyContentEdit(
  anilistId: number,
  edits: Record<string, unknown>,
  adminUserId: string,
  reason?: string,
): Promise<void> {
  const data: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(edits)) {
    const mapping = MIRROR_COLUMN[key];
    if (!mapping) continue;
    const value = coerce(mapping.kind, raw);
    if (value === undefined) continue;
    data[mapping.col] = value;
  }

  if (!Object.keys(data).length) throw new Error("No editable fields supplied");

  data.isLocked = true;
  data.fetchedAt = new Date();

  try {
    await prisma.media.update({ where: { id: anilistId }, data });
  } catch (err) {
    // Prisma P2025 = record to update not found.
    if ((err as { code?: string }).code === "P2025") throw new Error("Content not found");
    log.error({ err, anilistId }, "[contentAdmin] mirror Media update failed");
    throw err;
  }

  log.info(
    { anilistId, admin: adminUserId, fields: Object.keys(data), reason: reason ?? null },
    "[contentAdmin] mirror edit applied + locked",
  );
}
