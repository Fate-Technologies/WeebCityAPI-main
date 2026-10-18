/**
 * Fetch-and-cache-on-miss orchestration.
 *
 * For each root entity (Media/Character/Staff/Studio), when the DB has no row
 * (or a stale one) we hit the live AniList API, persist everything, and return
 * the fresh DB row. Concurrent misses for the same id are coalesced so a burst
 * of identical requests produces a single upstream call.
 */
import { prisma } from '../db.js';
import { anilistRequest } from './client.js';
import { MEDIA_BY_ID, CHARACTER_BY_ID, STAFF_BY_ID, STUDIO_BY_ID } from './queries.js';
import { normalizeMedia, type RawMediaNode } from './ingest.js';
import { persistMedia } from './persist.js';

const ENABLED = (process.env.ENABLE_LIVE_FALLBACK ?? 'true') !== 'false';
const TTL_MS = Number(process.env.CACHE_TTL_DAYS || 7) * 24 * 60 * 60 * 1000;
// Airing/upcoming titles carry fast-moving fields (trending, nextAiringEpisode,
// rankings), so they go stale much sooner and re-fetch on access.
const VOLATILE_TTL_MS = Number(process.env.VOLATILE_TTL_HOURS || 6) * 60 * 60 * 1000;
const VOLATILE_STATUSES = new Set(['RELEASING', 'NOT_YET_RELEASED']);

const inflight = new Map<string, Promise<unknown>>();

function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

const isStale = (fetchedAt: Date | null | undefined, status?: string | null): boolean => {
  if (!fetchedAt) return true;
  const ttl = status && VOLATILE_STATUSES.has(status) ? VOLATILE_TTL_MS : TTL_MS;
  return Date.now() - fetchedAt.getTime() > ttl;
};

async function persistManyMedia(nodes: (RawMediaNode | null | undefined)[]): Promise<void> {
  for (const n of nodes) {
    if (n?.id) await persistMedia(prisma, normalizeMedia(n));
  }
}

/** Ensure a Media row exists & is fresh, fetching from AniList on miss. Returns the id or null. */
export async function ensureMedia(id: number): Promise<number | null> {
  const existing = await prisma.media.findUnique({ where: { id }, select: { id: true, fetchedAt: true, status: true } });
  if (existing && !isStale(existing.fetchedAt, existing.status)) return existing.id;
  if (!ENABLED) return existing?.id ?? null;

  return coalesce(`media:${id}`, async () => {
    const data = await anilistRequest<{ Media: RawMediaNode | null }>(MEDIA_BY_ID, { id });
    const node = data?.Media;
    if (!node?.id) return existing?.id ?? null;
    await persistMedia(prisma, normalizeMedia(node));
    return node.id;
  });
}

/** Ensure a Character row exists, fetching the character + its media on miss. */
export async function ensureCharacter(id: number): Promise<number | null> {
  const existing = await prisma.character.findUnique({ where: { id }, select: { id: true, fetchedAt: true } });
  if (existing && !isStale(existing.fetchedAt)) return existing.id;
  if (!ENABLED) return existing?.id ?? null;

  return coalesce(`character:${id}`, async () => {
    const data = await anilistRequest<{ Character: {
      id: number; name?: { full?: string; native?: string; alternative?: string[] };
      image?: { large?: string; medium?: string }; description?: string;
      media?: { nodes?: RawMediaNode[] };
    } | null }>(CHARACTER_BY_ID, { id });
    const c = data?.Character;
    if (!c?.id) return existing?.id ?? null;

    await persistManyMedia(c.media?.nodes ?? []);
    await prisma.character.upsert({
      where: { id: c.id },
      create: {
        id: c.id, nameFull: c.name?.full ?? null, nameNative: c.name?.native ?? null,
        nameAlternative: c.name?.alternative ?? [], imageLarge: c.image?.large ?? null,
        imageMedium: c.image?.medium ?? null, description: c.description ?? null, fetchedAt: new Date(),
      },
      update: {
        nameFull: c.name?.full ?? null, nameNative: c.name?.native ?? null,
        nameAlternative: c.name?.alternative ?? [], imageLarge: c.image?.large ?? null,
        imageMedium: c.image?.medium ?? null, description: c.description ?? null, fetchedAt: new Date(),
      },
    });
    return c.id;
  });
}

export async function ensureStaff(id: number): Promise<number | null> {
  const existing = await prisma.staff.findUnique({ where: { id }, select: { id: true, fetchedAt: true } });
  if (existing && !isStale(existing.fetchedAt)) return existing.id;
  if (!ENABLED) return existing?.id ?? null;

  return coalesce(`staff:${id}`, async () => {
    const data = await anilistRequest<{ Staff: {
      id: number; name?: { full?: string; native?: string }; languageV2?: string;
      image?: { large?: string; medium?: string }; staffMedia?: { nodes?: RawMediaNode[] };
    } | null }>(STAFF_BY_ID, { id });
    const s = data?.Staff;
    if (!s?.id) return existing?.id ?? null;

    await persistManyMedia(s.staffMedia?.nodes ?? []);
    await prisma.staff.upsert({
      where: { id: s.id },
      create: {
        id: s.id, nameFull: s.name?.full ?? null, nameNative: s.name?.native ?? null,
        languageV2: s.languageV2 ?? null, imageLarge: s.image?.large ?? null,
        imageMedium: s.image?.medium ?? null, fetchedAt: new Date(),
      },
      update: {
        nameFull: s.name?.full ?? null, nameNative: s.name?.native ?? null,
        languageV2: s.languageV2 ?? null, imageLarge: s.image?.large ?? null,
        imageMedium: s.image?.medium ?? null, fetchedAt: new Date(),
      },
    });
    return s.id;
  });
}

export async function ensureStudio(id: number): Promise<number | null> {
  const existing = await prisma.studio.findUnique({ where: { id }, select: { id: true, fetchedAt: true } });
  if (existing && !isStale(existing.fetchedAt)) return existing.id;
  if (!ENABLED) return existing?.id ?? null;

  return coalesce(`studio:${id}`, async () => {
    const data = await anilistRequest<{ Studio: {
      id: number; name?: string; isAnimationStudio?: boolean; media?: { nodes?: RawMediaNode[] };
    } | null }>(STUDIO_BY_ID, { id });
    const st = data?.Studio;
    if (!st?.id) return existing?.id ?? null;

    await persistManyMedia(st.media?.nodes ?? []);
    await prisma.studio.upsert({
      where: { id: st.id },
      create: { id: st.id, name: st.name ?? null, isAnimationStudio: st.isAnimationStudio ?? false, fetchedAt: new Date() },
      update: { name: st.name ?? null, isAnimationStudio: st.isAnimationStudio ?? false, fetchedAt: new Date() },
    });
    return st.id;
  });
}
