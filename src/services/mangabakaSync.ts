import { env } from "../config/env.js";
import { log } from "../config/logger.js";
import { fetchMangaBakaSeries } from "./mapping/mangabaka.js";

/**
 * MangaBaka tracker sync (OAuth2 + OpenID Connect, server-side).
 *
 * MangaBaka is an OpenID Connect provider
 * (https://mangabaka.org/.well-known/openid-configuration):
 *   authorization: https://mangabaka.org/auth/oauth2/authorize
 *   token:         https://mangabaka.org/auth/oauth2/token
 *   userinfo:      https://mangabaka.org/auth/oauth2/userinfo
 * Scopes used: openid profile library.read library.write offline_access.
 *
 * The access/refresh tokens are bearer secrets stored in the
 * `mangabaka_credentials` table (service_role only — never SELECT-able by
 * clients). All calls below run in TatakaiAPI with the caller's stored token;
 * the browser only ever sees `{ connected, username, avatar }` plus library
 * entries fetched through these routes.
 *
 * Library endpoints (base https://api.mangabaka.org/v1):
 *   GET    /my/library               — list (?limit, ?page, ?sort_by)
 *   POST   /my/library/{series_id}   — add
 *   PATCH  /my/library/{series_id}   — update progress / state / rating
 *   DELETE /my/library/{series_id}   — remove
 *   GET    /source/{source}/{id}     — map AniList/MAL/Kitsu id → series
 *
 * MangaBaka states: reading | completed | plan_to_read | dropped | paused |
 * considering | rereading. Tatakai's `on_hold` maps to MangaBaka's `paused`.
 */

const MANGABAKA_BASE = "https://api.mangabaka.org";
const MANGABAKA_AUTH_BASE = "https://mangabaka.org/auth";
const REQUEST_TIMEOUT_MS = 12_000;

export type MangaBakaState =
  | "reading"
  | "completed"
  | "plan_to_read"
  | "dropped"
  | "paused"
  | "considering"
  | "rereading";

export interface MangaBakaLibraryEntry {
  seriesId: number;
  state: string | null;
  progressChapter: number | null;
  progressVolume: number | null;
  rating: number | null;
  title: string | null;
  coverUrl: string | null;
  anilistId: number | null;
  malId: number | null;
  kitsuId: number | null;
  updatedAt: string | null;
}

function getMangabakaCredentials() {
  const clientId = env.MANGABAKA_CLIENT_ID;
  const clientSecret = env.MANGABAKA_CLIENT_SECRET;
  return { clientId, clientSecret };
}

function bearerHeaders(accessToken: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      message?: string;
      error?: string;
      error_description?: string;
    };
    const msg =
      (typeof body?.message === "string" && body.message) ||
      (typeof body?.error_description === "string" && body.error_description) ||
      (typeof body?.error === "string" && body.error) ||
      "";
    return msg || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

function toPositiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const t = Math.trunc(n);
  return t > 0 ? t : null;
}

/** API error carrying the HTTP status (MangaBaka messages like "NOT_FOUND"
 * don't include it, so callers must not match on message text). */
export class MangaBakaApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MangaBakaApiError";
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers.get("Retry-After") ?? res.headers.get("retry-after");
  if (raw) {
    const secs = Number(raw);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return null;
}

/**
 * MangaBaka fetch with 429 backoff. The `/my/*` endpoints are never cached and
 * rate-limited per IP (leaky bucket) — a full-library sync bursts past it, so
 * honor Retry-After then fall back to exponential backoff (max ~4 retries).
 * Only 429 is retried; every other status is returned for the caller to handle.
 */
async function mbFetch(
  input: string,
  init: Omit<RequestInit, "signal"> = {},
  retries = 4,
): Promise<Response> {
  let attempt = 0;
  for (;;) {
    const res = await fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.status !== 429 || attempt >= retries) return res;
    const wait =
      parseRetryAfterMs(res) ?? Math.min(1000 * 2 ** attempt, 8000);
    log.warn({ attempt, waitMs: wait, url: input }, "[MangaBaka] Rate limited, backing off");
    try {
      await res.arrayBuffer();
    } catch {
      /* drain best-effort */
    }
    await sleep(wait);
    attempt += 1;
  }
}

/** Throws MangaBakaApiError carrying the status when the response is not ok. */
async function throwIfMbError(res: Response): Promise<void> {
  if (res.ok) return;
  throw new MangaBakaApiError(res.status, await readErrorMessage(res));
}

// ── Token exchange / refresh ──────────────────────────────────────────────────

interface MangabakaTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
}

async function requestToken(params: URLSearchParams): Promise<MangabakaTokenSet> {
  const res = await mbFetch(`${MANGABAKA_AUTH_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok) {
    throw new MangaBakaApiError(res.status, `MangaBaka token request failed: ${await readErrorMessage(res)}`);
  }
  if (!data?.access_token) {
    throw new Error("MangaBaka token response returned no access_token.");
  }
  const expiresAt =
    data.expires_in != null && Number.isFinite(Number(data.expires_in))
      ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
      : null;
  return {
    accessToken: String(data.access_token),
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
    expiresAt,
  };
}

/** Display handle from OIDC userinfo. Prefers the account handle and skips
 * placeholder display names ("Anonymous User") that accounts without a set
 * name carry — otherwise the UI shows a bogus "Anonymous User". */
function pickMangabakaUsername(userData: any): string | null {
  const candidates = [userData?.preferred_username, userData?.name, userData?.nickname];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (!value) continue;
    if (/^anonymous(\s+user)?$/i.test(value)) continue;
    return value;
  }
  return null;
}

/** Exchanges an authorization code for tokens and persists them. */
export async function exchangeMangabakaCode(
  sb: any,
  userId: string,
  code: string,
  codeVerifier: string | null,
  redirectUri: string,
): Promise<{ success: boolean; username: string | null }> {
  const { clientId, clientSecret } = getMangabakaCredentials();
  if (!clientId || !clientSecret) {
    throw new Error("MangaBaka OAuth is not configured on the server.");
  }
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  if (codeVerifier) params.set("code_verifier", codeVerifier);

  const tokens = await requestToken(params);

  // Best-effort profile lookup (sub + name + picture via OIDC userinfo).
  let mbUserId: string | null = null;
  let mbUsername: string | null = null;
  try {
    const userRes = await mbFetch(`${MANGABAKA_AUTH_BASE}/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (userRes.ok) {
      const userData: any = await userRes.json();
      mbUserId = userData?.sub != null ? String(userData.sub) : null;
      mbUsername = pickMangabakaUsername(userData);
    }
  } catch (err) {
    log.warn({ err }, "[MangaBaka] Userinfo lookup failed; continuing with token only");
  }

  const now = new Date().toISOString();
  const { error } = await sb.from("mangabaka_credentials").upsert(
    {
      user_id: userId,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_expires_at: tokens.expiresAt,
      mangabaka_user_id: mbUserId,
      mangabaka_username: mbUsername,
      connected_at: now,
      updated_at: now,
    },
    { onConflict: "user_id" },
  );
  if (error) {
    log.error({ error }, "[MangaBaka] Failed to persist tokens");
    throw new Error(`Failed to save MangaBaka connection: ${error.message}`);
  }
  log.info({ userId, mbUserId }, "[MangaBaka] Tokens persisted");
  return { success: true, username: mbUsername };
}

/** Returns a valid access token, refreshing it when expired. */
export async function getOrRefreshMangabakaToken(
  sb: any,
  userId: string,
): Promise<string | null> {
  const { data: row, error } = await sb
    .from("mangabaka_credentials")
    .select("access_token, refresh_token, token_expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !row?.access_token) return null;

  let accessToken: string = row.access_token;
  const expiresAt = row.token_expires_at ? new Date(row.token_expires_at) : null;
  if (expiresAt && new Date() >= expiresAt && row.refresh_token) {
    log.info(`[MangaBaka] Refreshing token for user ${userId}`);
    const { clientId, clientSecret } = getMangabakaCredentials();
    try {
      const tokens = await requestToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: row.refresh_token,
        }),
      );
      accessToken = tokens.accessToken;
      await sb
        .from("mangabaka_credentials")
        .update({
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken ?? row.refresh_token,
          token_expires_at: tokens.expiresAt,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    } catch (err) {
      log.error({ err }, `[MangaBaka] Token refresh failed for user ${userId}`);
      throw new Error("MangaBaka session expired. Please reconnect MangaBaka.");
    }
  }
  return accessToken;
}

export async function getMangabakaStatus(
  sb: any,
  userId: string,
): Promise<{ connected: boolean; username: string | null; connectedAt: string | null }> {
  const { data, error } = await sb
    .from("mangabaka_credentials")
    .select("mangabaka_username, connected_at")
    .eq("user_id", userId)
    .maybeSingle();
  // A missing row means "not connected" — but a real DB error (missing table,
  // RLS misconfig) must surface loudly instead of masquerading as "Connect".
  if (error) {
    log.error({ error }, "[MangaBaka] Status lookup failed");
    throw new Error(
      "MangaBaka status check failed on the server. If this persists, the mangabaka_credentials database migration may not be applied.",
    );
  }
  if (!data) return { connected: false, username: null, connectedAt: null };
  let username: string | null = data.mangabaka_username ?? null;
  // Heal rows stored before the placeholder filter existed (or accounts that
  // set a handle after connecting): re-read userinfo when the stored name is
  // missing or a placeholder. Best-effort — never fails the status check.
  if (!username || /^anonymous(\s+user)?$/i.test(username)) {
    try {
      const accessToken = await getOrRefreshMangabakaToken(sb, userId);
      if (accessToken) {
        const userRes = await mbFetch(`${MANGABAKA_AUTH_BASE}/oauth2/userinfo`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (userRes.ok) {
          const fresh = pickMangabakaUsername(await userRes.json());
          if (fresh) {
            username = fresh;
            await sb
              .from("mangabaka_credentials")
              .update({ mangabaka_username: fresh, updated_at: new Date().toISOString() })
              .eq("user_id", userId);
          }
        }
      }
    } catch (err) {
      log.warn({ err }, "[MangaBaka] Username heal lookup failed; keeping stored value");
    }
  }
  return {
    connected: true,
    username,
    connectedAt: data.connected_at ?? null,
  };
}

export async function disconnectMangabaka(sb: any, userId: string): Promise<void> {
  // Best-effort remote revocation, then local delete regardless.
  try {
    const { data: row } = await sb
      .from("mangabaka_credentials")
      .select("access_token")
      .eq("user_id", userId)
      .maybeSingle();
    const { clientId, clientSecret } = getMangabakaCredentials();
    if (row?.access_token && clientId && clientSecret) {
      await mbFetch(`${MANGABAKA_AUTH_BASE}/oauth2/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: row.access_token,
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      }).catch(() => null);
    }
  } catch {
    /* revocation is best-effort */
  }
  const { error } = await sb.from("mangabaka_credentials").delete().eq("user_id", userId);
  if (error) {
    log.error({ error }, "[MangaBaka] Failed to delete credential");
    throw new Error(`Failed to disconnect MangaBaka: ${error.message}`);
  }
  log.info({ userId }, "[MangaBaka] Disconnected");
}

// ── Library reads ─────────────────────────────────────────────────────────────

function pickCoverUrl(series: any): string | null {
  return (
    series?.cover?.x250?.x1 ||
    series?.cover?.x350?.x1 ||
    series?.cover?.x150?.x1 ||
    series?.cover?.raw?.url ||
    series?.cover_url ||
    series?.coverUrl ||
    null
  );
}

function normalizeLibraryEntry(node: any): MangaBakaLibraryEntry | null {
  if (!node || typeof node !== "object") return null;
  const series = node.series && typeof node.series === "object" ? node.series : node;
  const entry = node.entry && typeof node.entry === "object" ? node.entry : node;
  const seriesId =
    toPositiveInt(entry?.series_id) ||
    toPositiveInt(entry?.seriesId) ||
    toPositiveInt(series?.id) ||
    toPositiveInt(node?.series_id) ||
    toPositiveInt(node?.id);
  if (!seriesId) return null;

  const sources = series?.source && typeof series.source === "object" ? series.source : {};
  const sourceId = (v: unknown): number | null => {
    const n = Number((v as { id?: unknown })?.id ?? v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
  };
  const rating = Number(entry?.rating ?? node?.rating);

  return {
    seriesId,
    state:
      typeof entry?.state === "string"
        ? entry.state
        : typeof node?.state === "string"
          ? node.state
          : null,
    progressChapter: toPositiveInt(
      entry?.progress_chapter ?? entry?.progressChapter ?? node?.progress_chapter,
    ),
    progressVolume: toPositiveInt(
      entry?.progress_volume ?? entry?.progressVolume ?? node?.progress_volume,
    ),
    rating: Number.isFinite(rating) ? rating : null,
    title: String(series?.title || entry?.title || node?.title || "") || null,
    coverUrl: pickCoverUrl(series),
    anilistId: sourceId(sources?.anilist) ?? toPositiveInt(entry?.anilist_id),
    malId:
      sourceId(sources?.my_anime_list ?? sources?.myAnimeList ?? sources?.mal) ??
      toPositiveInt(entry?.mal_id),
    kitsuId: sourceId(sources?.kitsu),
    updatedAt: typeof entry?.updated_at === "string" ? entry.updated_at : null,
  };
}

function extractLibraryNodes(body: any): any[] {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.data?.entries)) return body.data.entries;
  if (Array.isArray(body?.data?.library)) return body.data.library;
  if (Array.isArray(body?.entries)) return body.entries;
  if (body?.data && typeof body.data === "object") return [body.data];
  return [];
}

export async function fetchMangabakaLibrary(
  accessToken: string,
): Promise<MangaBakaLibraryEntry[]> {
  const all: MangaBakaLibraryEntry[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const params = new URLSearchParams({ page: String(page), limit: "100" });
    const res = await mbFetch(`${MANGABAKA_BASE}/v1/my/library?${params.toString()}`, {
      headers: bearerHeaders(accessToken),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("MangaBaka rejected the saved session. Please reconnect MangaBaka.");
    }
    await throwIfMbError(res);
    const body = await res.json();
    const entries = extractLibraryNodes(body)
      .map(normalizeLibraryEntry)
      .filter((e): e is MangaBakaLibraryEntry => !!e);
    // Library rows can contain only progress and a series_id. Resolve the
    // public record before import so IDs and placeholder labels are not saved.
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(5, entries.length) }, async () => {
      while (cursor < entries.length) {
        const entry = entries[cursor++];
        if (entry.title && entry.coverUrl && (entry.anilistId || entry.malId)) continue;
        const series = await fetchMangaBakaSeries(entry.seriesId, { source: "mangabaka" });
        if (!series) continue;
        entry.title ||= series.title || null;
        entry.coverUrl ||= series.cover.large || series.cover.medium || series.cover.original;
        entry.anilistId ||= series.anilistId;
        entry.malId ||= series.malId;
        entry.kitsuId ||= series.kitsuId;
      }
    }));
    all.push(...entries);
    const pagination = (body as { pagination?: { next?: string | null; has_next?: boolean } })
      ?.pagination;
    if (!pagination?.next && !pagination?.has_next) break;
    if (entries.length === 0) break;
  }
  return all;
}

// ── Status mapping ────────────────────────────────────────────────────────────

const TATAKAI_TO_MANGABAKA: Record<string, MangaBakaState> = {
  reading: "reading",
  completed: "completed",
  plan_to_read: "plan_to_read",
  dropped: "dropped",
  on_hold: "paused",
};

export function mapTatakaiMangaStatusToMangaBaka(status: string): MangaBakaState {
  return TATAKAI_TO_MANGABAKA[String(status || "").trim().toLowerCase()] || "plan_to_read";
}

const MANGABAKA_TO_TATAKAI: Record<string, string> = {
  reading: "reading",
  rereading: "reading",
  completed: "completed",
  plan_to_read: "plan_to_read",
  considering: "plan_to_read",
  dropped: "dropped",
  paused: "on_hold",
};

export function mapMangaBakaStatusToTatakai(status: string): string {
  return MANGABAKA_TO_TATAKAI[String(status || "").trim().toLowerCase()] || "plan_to_read";
}

// ── ID resolution ─────────────────────────────────────────────────────────────

function normalizeMbTitle(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Last-resort exact-title search for export: resolves a local title with no
 * stored external id to a MangaBaka series id. Exact normalized match only —
 * anything else returns null so the entry is skipped, never misfiled.
 */
export async function searchMangabakaSeriesByTitle(title: string): Promise<number | null> {
  const want = normalizeMbTitle(title);
  if (!want) return null;
  try {
    const params = new URLSearchParams({ q: String(title), limit: "10", page: "1" });
    const res = await mbFetch(`${MANGABAKA_BASE}/v1/series/search?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ id?: number; title?: string; romanized_title?: string; native_title?: string }> };
    for (const s of body?.data || []) {
      const names = [s?.title, s?.romanized_title, s?.native_title].map(normalizeMbTitle);
      if (s?.id && names.includes(want)) return Number(s.id);
    }
  } catch {
    return null;
  }
  return null;
}

export async function resolveMangabakaSeriesId(input: {
  anilistId?: number | null;
  malId?: number | null;
  kitsuId?: number | null;
  mangabakaId?: number | null;
}): Promise<number | null> {
  if (input.mangabakaId && Number(input.mangabakaId) > 0) {
    return Math.trunc(Number(input.mangabakaId));
  }
  const attempts: Array<[string, number]> = [];
  if (input.anilistId && Number(input.anilistId) > 0) {
    attempts.push(["anilist", Math.trunc(Number(input.anilistId))]);
  }
  if (input.malId && Number(input.malId) > 0) {
    attempts.push(["my-anime-list", Math.trunc(Number(input.malId))]);
  }
  if (input.kitsuId && Number(input.kitsuId) > 0) {
    attempts.push(["kitsu", Math.trunc(Number(input.kitsuId))]);
  }
  for (const [source, id] of attempts) {
    try {
      const res = await mbFetch(
        `${MANGABAKA_BASE}/v1/source/${source}/${encodeURIComponent(String(id))}`,
        {
          headers: { Accept: "application/json" },
        },
      );
      if (!res.ok) continue;
      const body = (await res.json()) as {
        data?: { series?: Array<{ id?: number; state?: string }> };
      };
      const list = body?.data?.series || [];
      const chosen = list.find((s) => s?.state === "active") || list[0];
      if (chosen?.id) return Number(chosen.id);
    } catch {
      /* try next source */
    }
  }
  return null;
}

// ── Library writes ────────────────────────────────────────────────────────────

export interface MangaBakaProgressUpdate {
  state?: MangaBakaState;
  progressChapter?: number | null;
  progressVolume?: number | null;
  rating?: number | null;
}

async function writeLibraryEntry(
  accessToken: string,
  method: "POST" | "PATCH",
  seriesId: number,
  update: MangaBakaProgressUpdate,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (update.state) body.state = update.state;
  if (update.progressChapter != null) body.progress_chapter = update.progressChapter;
  if (update.progressVolume != null) body.progress_volume = update.progressVolume;
  if (update.rating != null) body.rating = update.rating;
  const res = await mbFetch(`${MANGABAKA_BASE}/v1/my/library/${Number(seriesId)}`, {
    method,
    headers: bearerHeaders(accessToken),
    body: JSON.stringify(body),
  });
  await throwIfMbError(res);
}

/**
 * Pushes manga progress to the user's MangaBaka library (create-or-update).
 * Returns false when there is nothing to do (not connected / no series
 * mapping); throws on API errors so callers can log them. Never let this
 * reject a read — the single-sync route catches it into a warning.
 */
export async function pushMangabakaProgress(
  sb: any,
  userId: string,
  input: {
    anilistId?: number | null;
    malId?: number | null;
    kitsuId?: number | null;
    mangabakaId?: number | null;
    status: string;
    chapter?: number | null;
    volume?: number | null;
    score?: number | null;
  },
): Promise<boolean> {
  const accessToken = await getOrRefreshMangabakaToken(sb, userId);
  if (!accessToken) return false;
  const seriesId = await resolveMangabakaSeriesId(input);
  if (!seriesId) return false;
  const chapter =
    input.chapter != null && Number.isFinite(Number(input.chapter)) && Number(input.chapter) > 0
      ? Math.trunc(Number(input.chapter))
      : null;
  const update: MangaBakaProgressUpdate = {
    state: mapTatakaiMangaStatusToMangaBaka(input.status),
    progressChapter: chapter,
    progressVolume:
      input.volume != null && Number(input.volume) > 0 ? Math.trunc(Number(input.volume)) : null,
    rating: input.score != null && Number(input.score) > 0 ? Number(input.score) : null,
  };
  try {
    await writeLibraryEntry(accessToken, "PATCH", seriesId, update);
  } catch (err) {
    // PATCH on an entry missing from the library → create it. Match on the
    // HTTP status, not the message (MangaBaka answers e.g. "NOT_FOUND").
    if (err instanceof MangaBakaApiError && err.status === 404) {
      await writeLibraryEntry(accessToken, "POST", seriesId, update);
      return true;
    }
    throw err;
  }
  return true;
}

export async function removeMangabakaEntry(
  sb: any,
  userId: string,
  seriesId: number,
): Promise<void> {
  const accessToken = await getOrRefreshMangabakaToken(sb, userId);
  if (!accessToken) return;
  const res = await mbFetch(`${MANGABAKA_BASE}/v1/my/library/${Number(seriesId)}`, {
    method: "DELETE",
    headers: bearerHeaders(accessToken),
  });
  if (res.status === 404) return;
  await throwIfMbError(res);
}
