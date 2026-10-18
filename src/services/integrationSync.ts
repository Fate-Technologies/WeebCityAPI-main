import { env } from "../config/env.js";
import { log } from "../config/logger.js";
import { anilistLimiter } from "../lib/rateLimiter.js";
import * as mangabaka from "./mangabakaSync.js";

/**
 * All AniList calls (sync AND catalog) must share the one rate budget or a large
 * sync starves catalog lookups into 429s. Route every AniList request in this
 * file through the shared token bucket before it hits the network.
 */
async function anilistFetch(input: string, init?: RequestInit): Promise<Response> {
  await anilistLimiter.acquire(1);
  return fetch(input, init);
}

/**
 * Two-way sync direction between Tatakai (hub) and a tracker.
 * Higher progress wins; on tied progress the higher volume count wins
 * (manga); on fully tied progress the LOCAL status wins, so a local-only
 * status change (e.g. marked completed at the same episode) pushes out
 * instead of being silently overwritten. Every tracker converges toward the
 * hub, and the hub converges back — run each Sync button once and both sides
 * end up with everything.
 */
export function syncDirection(
  localProgress: number,
  remoteProgress: number,
  localVolumes = 0,
  remoteVolumes = 0,
): "import" | "export" {
  if (localProgress !== remoteProgress) return localProgress > remoteProgress ? "export" : "import";
  if (localVolumes !== remoteVolumes) return localVolumes > remoteVolumes ? "export" : "import";
  return "export";
}

/** Normalized title for exact-match resolution (`One Piece` === `one-piece!`). */
export function normalizeSyncTitle(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Custom AniList lists can repeat the same MediaList entry. */
export function uniqueAniListEntries(entries: any[]): any[] {
  return [...new Map(entries.filter(entry => entry?.media?.id).map(entry => [Number(entry.media.id), entry])).values()];
}

/** Resolve identities before diffing, so an unresolved local alias cannot produce
 * an import and an export for the same tracker entry. Titles must be unambiguous. */
export async function resolveAniListLocalRows(rows: any[], remote: any[], type: "anime" | "manga", resolve: (title: string) => Promise<number | null>): Promise<void> {
  const idColumn = type === "anime" ? "anime_id" : "manga_id";
  const titleColumn = type === "anime" ? "anime_name" : "manga_title";
  for (const row of rows) {
    if (row.anilist_id) continue;
    const encodedId = /^(?:anilist:)?(\d+)$/.exec(String(row[idColumn]));
    if (encodedId) { row.anilist_id = Number(encodedId[1]); continue; }
    const byMal = row.mal_id ? remote.filter(entry => Number(entry.media.idMal) === Number(row.mal_id)) : [];
    const wanted = normalizeSyncTitle(row[titleColumn]);
    const byTitle = wanted ? remote.filter(entry => titleCandidates(...Object.values(entry.media.title || {})).includes(wanted)) : [];
    const matches = byMal.length ? byMal : byTitle;
    if (matches.length === 1) row.anilist_id = Number(matches[0].media.id);
    else if (matches.length === 0) row.anilist_id = await resolve(row[titleColumn]);
  }
}

async function fetchWatchProgressMap(sb: any, userId: string): Promise<Map<string, number>> {
  const progress = new Map<string, number>();
  // Supabase caps a select at 1000 rows by default. Large imported libraries
  // must read every page or the next preview forgets previously saved progress.
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await sb.from("watch_history").select("anime_id, episode_number").eq("user_id", userId).order("id").range(offset, offset + 999);
    if (error) throw new Error(`Failed to read watch history: ${error.message}`);
    for (const row of data || []) progress.set(row.anime_id, Math.max(progress.get(row.anime_id) || 0, Number(row.episode_number || 0)));
    if (!data || data.length < 1000) break;
  }
  return progress;
}

/**
 * Bounded parallelism for bulk sync work. A full "sync everything" fans out to
 * hundreds of upstream writes — sequential awaits would blow past the request
 * timeout, while unbounded Promise.all would hammer tracker rate limits.
 * AniList calls stay correct under parallelism: they all funnel through the
 * shared token bucket.
 */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const workers = Math.min(Math.max(limit, 1), items.length);
  if (workers === 0) return;
  let index = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (index < items.length) {
        const item = items[index++];
        await fn(item);
      }
    }),
  );
}

/**
 * Resolve a profile row for an authenticated user, tolerant of this schema's two
 * id spaces: `profiles.id` (random PK) vs `profiles.user_id` (the auth uid, set by
 * the handle_new_user trigger). Most rows key on `user_id`, but some legacy rows
 * were created with `id = auth uid`. Look up by `user_id` first, then fall back to
 * `id`, so linking never silently no-ops. Returns the full row (with its PK `id`).
 */
export async function resolveProfileRow(sb: any, userId: string): Promise<any | null> {
  const byUserId = await sb.from("profiles").select("*").eq("user_id", userId).maybeSingle();
  if (byUserId.data) return byUserId.data;

  const byId = await sb.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (byId.data) return byId.data;

  return null;
}

// Helper to retrieve MAL credentials
function getMalCredentials() {
  const clientId = env.MAL_CLIENT_ID || env.VITE_MAL_CLIENT_ID;
  const clientSecret = env.MAL_CLIENT_SECRET || env.VITE_MAL_CLIENT_SECRET;
  return { clientId, clientSecret };
}

// Helper to retrieve AniList credentials
function getAnilistCredentials() {
  const clientId = env.ANILIST_CLIENT_ID || env.VITE_ANILIST_CLIENT_ID;
  const clientSecret = env.ANILIST_CLIENT_SECRET || env.VITE_ANILIST_CLIENT_SECRET;
  return { clientId, clientSecret };
}

// Ensure MAL token is valid, refreshing it if expired
export async function getOrRefreshMalToken(sb: any, userId: string, profile: any): Promise<string> {
  let accessToken = profile.mal_access_token;
  const now = new Date();
  const expiresAt = profile.mal_token_expires_at ? new Date(profile.mal_token_expires_at) : null;

  if (expiresAt && now >= expiresAt && profile.mal_refresh_token) {
    log.info(`[MAL Token] Refreshing token for user ${userId}`);
    const { clientId, clientSecret } = getMalCredentials();
    const refreshParams = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret || "",
      grant_type: "refresh_token",
      refresh_token: profile.mal_refresh_token,
    });

    const refreshRes = await fetch("https://myanimelist.net/v1/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: refreshParams.toString(),
    });

    const refreshData: any = await refreshRes.json();
    if (!refreshRes.ok) {
      log.error({ refreshData }, `[MAL Token] Refresh failed for user ${userId}`);
      throw new Error(`MAL token refresh failed`);
    }

    accessToken = refreshData.access_token;
    const newExpiresAt = new Date();
    newExpiresAt.setSeconds(newExpiresAt.getSeconds() + refreshData.expires_in);

    // Update by PK when available (profile may be keyed by id, not user_id).
    const refreshFilter = profile?.id
      ? { col: "id", val: profile.id }
      : { col: "user_id", val: userId };
    await sb.from("profiles").update({
      mal_access_token: refreshData.access_token,
      mal_refresh_token: refreshData.refresh_token,
      mal_token_expires_at: newExpiresAt.toISOString(),
    }).eq(refreshFilter.col, refreshFilter.val);
  }

  return accessToken;
}

// Fetch all MyAnimeList anime entries
export async function fetchAllMALAnime(accessToken: string): Promise<any[]> {
  let url = "https://api.myanimelist.net/v2/users/@me/animelist?fields=list_status{status,score,num_watched_episodes},main_picture,title&limit=1000";
  const results: any[] = [];
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`MAL anime fetch failed: ${res.statusText}`);
    }
    const data: any = await res.json();
    if (data.data) {
      results.push(...data.data);
    }
    url = data.paging?.next || "";
  }
  return results;
}

// Fetch all MyAnimeList manga entries
export async function fetchAllMALManga(accessToken: string): Promise<any[]> {
  let url = "https://api.myanimelist.net/v2/users/@me/mangalist?fields=list_status{status,score,num_chapters_read,num_volumes_read},main_picture,title&limit=1000";
  const results: any[] = [];
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`MAL manga fetch failed: ${res.statusText}`);
    }
    const data: any = await res.json();
    if (data.data) {
      results.push(...data.data);
    }
    url = data.paging?.next || "";
  }
  return results;
}

// Fetch all AniList anime list entries
export async function fetchAllAniListAnime(accessToken: string, userId: number): Promise<any[]> {
  const query = `
    query ($userId: Int) {
      MediaListCollection(userId: $userId, type: ANIME) {
        lists {
          name
          status
          entries {
            id
            mediaId
            status
            progress
            score(format: POINT_10)
            media {
              id
              idMal
              title { romaji english native }
              coverImage { medium large }
              episodes
            }
          }
        }
      }
    }
  `;
  const response = await anilistFetch("https://graphql.anilist.co", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables: { userId } }),
  });
  if (!response.ok) {
    throw new Error(`AniList anime query failed: ${response.status}`);
  }
  const data: any = await response.json();
  if (data.errors) {
    throw new Error(data.errors[0].message);
  }
  return uniqueAniListEntries(data.data?.MediaListCollection?.lists?.flatMap((list: any) => list.entries) || []);
}

// Fetch all AniList manga list entries
export async function fetchAllAniListManga(accessToken: string, userId: number): Promise<any[]> {
  const query = `
    query ($userId: Int) {
      MediaListCollection(userId: $userId, type: MANGA) {
        lists {
          name
          status
          entries {
            id
            mediaId
            status
            progress
            progressVolumes
            score(format: POINT_10)
            media {
              id
              idMal
              title { romaji english native }
              coverImage { medium large }
              chapters
              volumes
            }
          }
        }
      }
    }
  `;
  const response = await anilistFetch("https://graphql.anilist.co", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables: { userId } }),
  });
  if (!response.ok) {
    throw new Error(`AniList manga query failed: ${response.status}`);
  }
  const data: any = await response.json();
  if (data.errors) {
    throw new Error(data.errors[0].message);
  }
  return uniqueAniListEntries(data.data?.MediaListCollection?.lists?.flatMap((list: any) => list.entries) || []);
}

// Map MyAnimeList status strings to local Tatakai watchlist status
export function mapMalStatusToTatakai(status: string): string {
  const map: Record<string, string> = {
    watching: "watching",
    completed: "completed",
    plan_to_watch: "plan_to_watch",
    dropped: "dropped",
    on_hold: "on_hold",
  };
  return map[status] || "plan_to_watch";
}

// Map local Tatakai watchlist status to MyAnimeList status
export function mapTatakaiStatusToMal(status: string): string {
  const map: Record<string, string> = {
    watching: "watching",
    completed: "completed",
    plan_to_watch: "plan_to_watch",
    dropped: "dropped",
    on_hold: "on_hold",
  };
  return map[status] || "plan_to_watch";
}

// Map AniList status strings to local Tatakai watchlist status
export function mapAniListStatusToTatakai(status: string): string {
  const map: Record<string, string> = {
    CURRENT: "watching",
    COMPLETED: "completed",
    PLANNING: "plan_to_watch",
    DROPPED: "dropped",
    PAUSED: "on_hold",
    REPEATING: "watching",
  };
  return map[status] || "plan_to_watch";
}

// Map local Tatakai watchlist status to AniList status
export function mapTatakaiStatusToAniList(status: string): string {
  const map: Record<string, string> = {
    watching: "CURRENT",
    completed: "COMPLETED",
    plan_to_watch: "PLANNING",
    dropped: "DROPPED",
    on_hold: "PAUSED",
  };
  return map[status] || "PLANNING";
}

// ── Manga uses a DIFFERENT status vocabulary than anime ──
// manga_readlist_status_check allows: plan_to_read | reading | completed | on_hold | dropped
// (never "watching"/"plan_to_watch"), so manga rows must map through these.

export function mapAniListStatusToTatakaiManga(status: string): string {
  const map: Record<string, string> = {
    CURRENT: "reading",
    COMPLETED: "completed",
    PLANNING: "plan_to_read",
    DROPPED: "dropped",
    PAUSED: "on_hold",
    REPEATING: "reading",
  };
  return map[String(status || "").toUpperCase()] || "plan_to_read";
}

export function mapMalStatusToTatakaiManga(status: string): string {
  const map: Record<string, string> = {
    reading: "reading",
    completed: "completed",
    plan_to_read: "plan_to_read",
    on_hold: "on_hold",
    dropped: "dropped",
  };
  return map[String(status || "").toLowerCase()] || "plan_to_read";
}

export function mapTatakaiMangaStatusToMal(status: string): string {
  const map: Record<string, string> = {
    reading: "reading",
    completed: "completed",
    plan_to_read: "plan_to_read",
    on_hold: "on_hold",
    dropped: "dropped",
  };
  return map[String(status || "").toLowerCase()] || "plan_to_read";
}

export function mapTatakaiMangaStatusToAniList(status: string): string {
  const map: Record<string, string> = {
    reading: "CURRENT",
    completed: "COMPLETED",
    plan_to_read: "PLANNING",
    on_hold: "PAUSED",
    dropped: "DROPPED",
  };
  return map[String(status || "").toLowerCase()] || "PLANNING";
}

// Exchange MAL OAuth authorization code
export async function exchangeMalCode(sb: any, userId: string, code: string, codeVerifier: string, redirectUri: string, authorizeClientId?: string) {
  const { clientId, clientSecret } = getMalCredentials();
  // The authorize-time app and the exchange-time app MUST be identical —
  // typically broken by using a localhost dev client ID in the browser while
  // the server still holds the production app's credentials (or vice versa).
  // Catch it here with a readable error instead of MAL's cryptic invalid_grant.
  if (authorizeClientId && clientId && authorizeClientId !== clientId) {
    throw new Error(
      `MAL app mismatch: the login was started with MAL client ${authorizeClientId} but the server exchanges with a different MAL app. ` +
      `Use the same MAL application (client ID + secret) in the browser build and on the server, then connect again with a fresh login.`
    );
  }
  const tokenParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret || "",
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });

  const res = await fetch("https://myanimelist.net/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams.toString(),
  });

  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(`MAL exchange failed: ${JSON.stringify(data)}`);
  }
  if (!data?.access_token) {
    throw new Error(`MAL exchange returned no access_token: ${JSON.stringify(data)}`);
  }

  const expiresAt = new Date();
  expiresAt.setSeconds(expiresAt.getSeconds() + (Number(data.expires_in) || 2419200));

  // Fetch MAL username (best-effort).
  let malUserId: string | null = null;
  try {
    const userRes = await fetch("https://api.myanimelist.net/v2/users/@me", {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    const userData: any = await userRes.json();
    malUserId = userData?.name || null;
  } catch (err) {
    log.warn({ err }, "[MAL] User lookup failed; continuing with token only");
  }

  // Resolve across both id spaces, then update by PK (see exchangeAniListCode note).
  const profile = await resolveProfileRow(sb, userId);
  if (!profile) {
    log.error({ userId }, "[MAL] No profile row for user");
    throw new Error("No profile found for this account. Please sign out and back in, then retry linking.");
  }

  const malPatch: Record<string, unknown> = {
    mal_access_token: data.access_token,
    mal_refresh_token: data.refresh_token,
    mal_token_expires_at: expiresAt.toISOString(),
    mal_user_id: malUserId,
  };
  if (profile.user_id !== userId) malPatch.user_id = userId;

  const { data: updated, error: updateError } = await sb
    .from("profiles")
    .update(malPatch)
    .eq("id", profile.id)
    .select("id, user_id, mal_user_id");

  if (updateError) {
    log.error({ updateError }, `[MAL] Failed to persist tokens for user ${userId}`);
    throw new Error(`Failed to save MAL tokens: ${updateError.message}`);
  }
  if (!updated || updated.length === 0) {
    log.error({ userId, profileId: profile.id }, "[MAL] Update matched no profile row");
    throw new Error("Linked to MAL but the token could not be saved to your profile.");
  }

  log.info({ userId, profileId: profile.id, malUserId }, "[MAL] Tokens persisted");
  return { success: true, username: malUserId };
}

// Exchange AniList OAuth authorization code
export async function exchangeAniListCode(sb: any, userId: string, code: string, redirectUri: string) {
  const { clientId, clientSecret } = getAnilistCredentials();
  const response = await fetch("https://anilist.co/api/v2/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    }),
  });

  const data: any = await response.json();
  if (!response.ok) {
    throw new Error(`AniList exchange failed: ${JSON.stringify(data)}`);
  }
  if (!data?.access_token) {
    throw new Error(`AniList exchange returned no access_token: ${JSON.stringify(data)}`);
  }

  const expiresAt = new Date(Date.now() + (Number(data.expires_in) || 31536000) * 1000);

  // Fetch Viewer Info (best-effort — token is already valid without it).
  let viewer: { id?: number; name?: string } | null = null;
  try {
    const viewerRes = await anilistFetch("https://graphql.anilist.co", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${data.access_token}`,
      },
      body: JSON.stringify({ query: `query { Viewer { id name } }` }),
    });
    const viewerData: any = await viewerRes.json();
    viewer = viewerData?.data?.Viewer || null;
  } catch (err) {
    log.warn({ err }, "[AniList] Viewer lookup failed; continuing with token only");
  }

  // Resolve the profile across both id spaces, then update by its PK so the
  // write can't silently miss. NOTE: `profiles` has no `anilist_username` column.
  const profile = await resolveProfileRow(sb, userId);
  if (!profile) {
    log.error({ userId }, "[AniList] No profile row for user");
    throw new Error("No profile found for this account. Please sign out and back in, then retry linking.");
  }

  // If we matched a legacy row whose user_id isn't the auth uid, realign it so
  // the client (which reads profiles by user_id) can see the same row.
  const anilistPatch: Record<string, unknown> = {
    anilist_access_token: data.access_token,
    anilist_token_expires_at: expiresAt.toISOString(),
    anilist_user_id: viewer?.id ? String(viewer.id) : null,
  };
  if (profile.user_id !== userId) anilistPatch.user_id = userId;

  const { data: updated, error: updateError } = await sb
    .from("profiles")
    .update(anilistPatch)
    .eq("id", profile.id)
    .select("id, user_id, anilist_user_id");

  if (updateError) {
    log.error({ updateError }, `[AniList] Failed to persist tokens for user ${userId}`);
    throw new Error(`Failed to save AniList tokens: ${updateError.message}`);
  }
  if (!updated || updated.length === 0) {
    log.error({ userId, profileId: profile.id }, "[AniList] Update matched no profile row");
    throw new Error("Linked to AniList but the token could not be saved to your profile.");
  }

  log.info({ userId, profileId: profile.id, anilistUserId: viewer?.id }, "[AniList] Tokens persisted");
  return { success: true, username: viewer?.name, anilistUserId: viewer?.id ? String(viewer.id) : null };
}

// ===========================================
// Normalized profile statistics (server-side — avoids browser CORS to AniList/MAL)
// ===========================================

export interface ExternalStats {
  provider: "anilist" | "mal";
  username?: string | null;
  profileUrl?: string | null;
  avatar?: string | null;
  anime: {
    count: number;
    episodesWatched: number;
    daysWatched: number;
    meanScore: number;
    watching?: number;
    completed?: number;
    planning?: number;
    dropped?: number;
    paused?: number;
  };
  manga?: {
    count: number;
    chaptersRead: number;
    volumesRead?: number;
    meanScore: number;
  } | null;
  topGenres?: { genre: string; count: number }[];
}

async function getAniListStats(accessToken: string): Promise<ExternalStats | null> {
  const query = `
    query {
      Viewer {
        id name siteUrl
        avatar { large medium }
        statistics {
          anime { count meanScore minutesWatched episodesWatched statuses { status count } genres { genre count } }
          manga { count meanScore chaptersRead volumesRead }
        }
      }
    }
  `;
  const res = await anilistFetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) return null;
  const json: any = await res.json();
  const viewer = json?.data?.Viewer;
  if (!viewer) return null;

  const a = viewer.statistics?.anime || {};
  const m = viewer.statistics?.manga || {};
  const statusMap: Record<string, number> = {};
  for (const s of a.statuses || []) statusMap[String(s.status).toUpperCase()] = Number(s.count || 0);
  const topGenres = (a.genres || [])
    .slice()
    .sort((x: any, y: any) => Number(y.count || 0) - Number(x.count || 0))
    .slice(0, 5)
    .map((g: any) => ({ genre: g.genre, count: Number(g.count || 0) }));

  return {
    provider: "anilist",
    username: viewer.name || null,
    profileUrl: viewer.siteUrl || (viewer.name ? `https://anilist.co/user/${viewer.name}` : null),
    avatar: viewer.avatar?.large || viewer.avatar?.medium || null,
    anime: {
      count: Number(a.count || 0),
      episodesWatched: Number(a.episodesWatched || 0),
      daysWatched: Number(((a.minutesWatched || 0) / 1440).toFixed(1)),
      meanScore: Number(a.meanScore || 0),
      watching: statusMap.CURRENT || 0,
      completed: statusMap.COMPLETED || 0,
      planning: statusMap.PLANNING || 0,
      dropped: statusMap.DROPPED || 0,
      paused: statusMap.PAUSED || 0,
    },
    manga: m.count
      ? {
          count: Number(m.count || 0),
          chaptersRead: Number(m.chaptersRead || 0),
          volumesRead: Number(m.volumesRead || 0),
          meanScore: Number(m.meanScore || 0),
        }
      : null,
    topGenres,
  };
}

async function getMalStats(accessToken: string): Promise<ExternalStats | null> {
  const res = await fetch("https://api.myanimelist.net/v2/users/@me?fields=anime_statistics", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data: any = await res.json();
  const s = data?.anime_statistics || {};
  const name = data?.name || null;

  return {
    provider: "mal",
    username: name,
    profileUrl: name ? `https://myanimelist.net/profile/${name}` : null,
    avatar: data?.picture || null,
    anime: {
      count: Number(s.num_items || 0),
      episodesWatched: Number(s.num_episodes || 0),
      daysWatched: Number(s.num_days_watched ?? s.num_days ?? 0),
      meanScore: Number(s.mean_score || 0),
      watching: Number(s.num_items_watching || 0),
      completed: Number(s.num_items_completed || 0),
      planning: Number(s.num_items_plan_to_watch || 0),
      dropped: Number(s.num_items_dropped || 0),
      paused: Number(s.num_items_on_hold || 0),
    },
    manga: null,
    topGenres: [],
  };
}

/** Collect normalized stats for whichever trackers the user has linked. */
export async function getExternalStats(sb: any, userId: string): Promise<ExternalStats[]> {
  const profile = await resolveProfileRow(sb, userId);
  if (!profile) return [];

  const out: ExternalStats[] = [];

  if (profile.anilist_access_token) {
    try {
      const s = await getAniListStats(profile.anilist_access_token);
      if (s) out.push(s);
    } catch (err) {
      log.warn({ err }, "[Stats] AniList stats failed");
    }
  }

  if (profile.mal_access_token) {
    try {
      const token = await getOrRefreshMalToken(sb, userId, profile);
      const s = await getMalStats(token);
      if (s) out.push(s);
    } catch (err) {
      log.warn({ err }, "[Stats] MAL stats failed");
    }
  }

  return out;
}

export interface SyncProposalItem {
  id: string; // Composite unique key
  mediaId: string | number;
  /** All local aliases of the same tracker identity, updated together on import. */
  localMediaIds?: string[];
  malId?: number | null;
  anilistId?: number | null;
  mangabakaId?: number | null;
  title: string;
  poster: string | null;
  type: "anime" | "manga";
  direction: "import" | "export" | "conflict";
  localStatus?: string | null;
  localProgress?: number | null;
  remoteStatus?: string | null;
  remoteProgress?: number | null;
  /** Manga only: volume progress, tracked alongside chapters. */
  localVolumes?: number | null;
  remoteVolumes?: number | null;
  actionText: string;
}

// ── Exact-title resolution for export ─────────────────────────────────────────
// Local watchlist/readlist rows don't always carry a tracker id. For those,
// resolve by exact (normalized) title match against the tracker's own search
// so the entry can still be exported instead of silently skipped. Anything
// without an exact match is skipped — a wrong fuzzy match would corrupt the
// user's remote list.

/** Per-preview budget: bounds how many title searches one sync may perform. */
const TITLE_RESOLUTION_BUDGET = 40;

function titleCandidates(...values: Array<unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    const n = normalizeSyncTitle(v);
    if (n) out.push(n);
  };
  for (const v of values) {
    if (Array.isArray(v)) v.forEach(push);
    else push(v);
  }
  return out;
}

async function searchMalId(
  title: string,
  type: "anime" | "manga",
  accessToken: string,
  cache: Map<string, number | null>,
): Promise<number | null> {
  const want = normalizeSyncTitle(title);
  if (!want) return null;
  const key = `mal:${type}:${want}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  let found: number | null = null;
  try {
    const res = await fetch(
      `https://api.myanimelist.net/v2/${type}?q=${encodeURIComponent(title)}&limit=10&fields=alternative_titles`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (res.ok) {
      const body: any = await res.json();
      for (const item of body?.data || []) {
        const node = item?.node;
        if (!node?.id) continue;
        const names = titleCandidates(
          node.title,
          node.alternative_titles?.en,
          node.alternative_titles?.ja,
          node.alternative_titles?.synonyms,
        );
        if (names.includes(want)) {
          found = Number(node.id);
          break;
        }
      }
    }
  } catch {
    /* resolution failure → skipped export */
  }
  cache.set(key, found);
  return found;
}

async function searchAnilistId(
  title: string,
  type: "ANIME" | "MANGA",
  cache: Map<string, number | null>,
): Promise<number | null> {
  const want = normalizeSyncTitle(title);
  if (!want) return null;
  const key = `anilist:${type}:${want}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  let found: number | null = null;
  try {
    const query = `
      query ($search: String) {
        Page(page: 1, perPage: 10) {
          media(search: $search, type: ${type}) {
            id
            title { romaji english native }
            synonyms
          }
        }
      }
    `;
    const res = await anilistFetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { search: title } }),
    });
    if (res.ok) {
      const body: any = await res.json();
      const matches = new Set<number>();
      for (const media of body?.data?.Page?.media || []) {
        const names = titleCandidates(
          media?.title?.romaji,
          media?.title?.english,
          media?.title?.native,
          media?.synonyms,
        );
        if (names.includes(want)) {
          matches.add(Number(media.id));
        }
      }
      if (matches.size === 1) found = [...matches][0];
    }
  } catch {
    /* resolution failure → skipped export */
  }
  cache.set(key, found);
  return found;
}

// Build Sync Proposal representing difference between Tatakai local DB and external list
export async function buildSyncProposal(
  sb: any,
  userId: string,
  integration: "mal" | "anilist" | "mangabaka",
  mediaType: "anime" | "manga"
): Promise<SyncProposalItem[]> {
  const profile = await resolveProfileRow(sb, userId);
  if (!profile) throw new Error("Profile not found");

  const proposal: SyncProposalItem[] = [];

  // Shared exact-title resolution cache + budget for this preview, so local
  // rows without a stored tracker id can still be exported (and backfilled).
  const resolutionCache = new Map<string, number | null>();
  let resolutionBudget = TITLE_RESOLUTION_BUDGET;
  const resolveTitle = (fn: () => Promise<number | null>): Promise<number | null> => {
    if (resolutionBudget <= 0) return Promise.resolve(null);
    resolutionBudget -= 1;
    return fn();
  };
  /** Best-effort: persist a resolved tracker id so the next sync matches directly. */
  const backfillTrackerId = async (
    table: "watchlist" | "manga_readlist",
    idColumn: "anime_id" | "manga_id",
    localId: string,
    patch: Record<string, number>,
  ): Promise<void> => {
    try {
      await sb.from(table).update(patch).eq("user_id", userId).eq(idColumn, localId);
    } catch {
      /* backfill is opportunistic */
    }
  };

  if (integration === "mal") {
    const accessToken = await getOrRefreshMalToken(sb, userId, profile);
    if (!accessToken) throw new Error("MAL not connected");

    if (mediaType === "anime") {
      const malList = await fetchAllMALAnime(accessToken);
      const { data: watchlist, error: watchlistError } = await sb.from("watchlist").select("*").eq("user_id", userId);
      if (watchlistError) throw new Error(`Failed to read watchlist: ${watchlistError.message}`);
      const localWatchlist: any[] = watchlist || [];

      const localProgressMap = await fetchWatchProgressMap(sb, userId);

      const localByMalId = new Map<number, any>();
      const localByAnimeId = new Map<string, any>();
      for (const item of localWatchlist) {
        if (item.mal_id) localByMalId.set(Number(item.mal_id), item);
        localByAnimeId.set(item.anime_id, item);
      }

      const matchedRemoteIds = new Set<number>();

      // 1. Process MAL list for Import/Update
      for (const malItem of malList) {
        const node = malItem.node;
        const listStatus = malItem.list_status;
        const malId = Number(node.id);
        const title = node.title;
        const poster = node.main_picture?.large || node.main_picture?.medium || null;
        matchedRemoteIds.add(malId);

        const localItem = localByMalId.get(malId);
        const remoteStatus = mapMalStatusToTatakai(listStatus.status);
        const remoteProgress = Number(listStatus.num_watched_episodes || 0);

        if (localItem) {
          const localStatus = localItem.status;
          const localProgress = localProgressMap.get(localItem.anime_id) || 0;

          if (localStatus !== remoteStatus || localProgress !== remoteProgress) {
            const direction = syncDirection(localProgress, remoteProgress);
            proposal.push({
              id: `update:mal:anime:${malId}`,
              mediaId: localItem.anime_id,
              malId,
              title,
              poster,
              type: "anime",
              direction,
              localStatus,
              localProgress,
              remoteStatus,
              remoteProgress,
              actionText: direction === "export"
                ? `Export progress to MAL (${localStatus} - Ep ${localProgress})`
                : `Import progress from MAL (${remoteStatus} - Ep ${remoteProgress})`,
            });
          }
        } else {
          // Add to local Tatakai
          proposal.push({
            id: `import:mal:anime:${malId}`,
            mediaId: `mal:${malId}`,
            malId,
            title,
            poster,
            type: "anime",
            direction: "import",
            remoteStatus,
            remoteProgress,
            actionText: `Import from MAL to watchlist as ${remoteStatus} (Ep ${remoteProgress})`,
          });
        }
      }

      // 2. Export local items not on MAL — including rows with no stored
      // MAL id (resolved by exact title match, then backfilled).
      for (const localItem of localWatchlist) {
        let mid = localItem.mal_id ? Number(localItem.mal_id) : null;
        if (!mid) {
          mid = await resolveTitle(() => searchMalId(localItem.anime_name, "anime", accessToken, resolutionCache));
          if (mid) await backfillTrackerId("watchlist", "anime_id", localItem.anime_id, { mal_id: mid });
        }
        if (mid && !matchedRemoteIds.has(mid)) {
          const localProgress = localProgressMap.get(localItem.anime_id) || 0;
          proposal.push({
            id: `export:mal:anime:${localItem.anime_id}`,
            mediaId: localItem.anime_id,
            malId: mid,
            title: localItem.anime_name,
            poster: localItem.anime_poster,
            type: "anime",
            direction: "export",
            localStatus: localItem.status,
            localProgress,
            actionText: `Export to MAL as ${localItem.status} (Ep ${localProgress})`,
          });
        }
      }
    } else {
      // Manga MAL Sync
      const malManga = await fetchAllMALManga(accessToken);
      const { data: readlist, error: readlistError } = await sb.from("manga_readlist").select("*").eq("user_id", userId);
      if (readlistError) throw new Error(`Failed to read manga_readlist: ${readlistError.message}`);
      const localReadlist: any[] = readlist || [];

      const localByMalId = new Map<number, any>();
      for (const item of localReadlist) {
        if (item.mal_id) localByMalId.set(Number(item.mal_id), item);
      }

      const matchedRemoteIds = new Set<number>();

      for (const malItem of malManga) {
        const node = malItem.node;
        const listStatus = malItem.list_status;
        const malId = Number(node.id);
        const title = node.title;
        const poster = node.main_picture?.large || node.main_picture?.medium || null;
        matchedRemoteIds.add(malId);

        const localItem = localByMalId.get(malId);
        const remoteStatus = mapMalStatusToTatakaiManga(listStatus.status);
        const remoteProgress = Number(listStatus.num_chapters_read || 0);
        const remoteVolumes = Number(listStatus.num_volumes_read || 0);

        if (localItem) {
          const localStatus = localItem.status;
          const localProgress = Number(localItem.last_chapter_number || 0);
          const localVolumes = Number(localItem.last_volume_number || 0);

          if (localStatus !== remoteStatus || localProgress !== remoteProgress || localVolumes !== remoteVolumes) {
            const exporting = syncDirection(localProgress, remoteProgress, localVolumes, remoteVolumes) === "export";
            proposal.push({
              id: `update:mal:manga:${malId}`,
              mediaId: localItem.manga_id,
              malId,
              title,
              poster,
              type: "manga",
              direction: exporting ? "export" : "import",
              localStatus,
              localProgress,
              localVolumes,
              remoteStatus,
              remoteProgress,
              remoteVolumes,
              actionText: exporting
                ? `Export to MAL (${localStatus} - Ch ${localProgress}, Vol ${localVolumes})`
                : `Import from MAL (${remoteStatus} - Ch ${remoteProgress}, Vol ${remoteVolumes})`,
            });
          }
        } else {
          proposal.push({
            id: `import:mal:manga:${malId}`,
            mediaId: `mal:${malId}`,
            malId,
            title,
            poster,
            type: "manga",
            direction: "import",
            remoteStatus,
            remoteProgress,
            remoteVolumes,
            actionText: `Import from MAL to readlist as ${remoteStatus} (Ch ${remoteProgress}, Vol ${remoteVolumes})`,
          });
        }
      }

      for (const localItem of localReadlist) {
        let mid = localItem.mal_id ? Number(localItem.mal_id) : null;
        if (!mid) {
          mid = await resolveTitle(() => searchMalId(localItem.manga_title, "manga", accessToken, resolutionCache));
          if (mid) await backfillTrackerId("manga_readlist", "manga_id", localItem.manga_id, { mal_id: mid });
        }
        if (mid && !matchedRemoteIds.has(mid)) {
          const localProgress = Number(localItem.last_chapter_number || 0);
          const localVolumes = Number(localItem.last_volume_number || 0);
          proposal.push({
            id: `export:mal:manga:${localItem.manga_id}`,
            mediaId: localItem.manga_id,
            malId: mid,
            title: localItem.manga_title,
            poster: localItem.manga_poster,
            type: "manga",
            direction: "export",
            localStatus: localItem.status,
            localProgress,
            localVolumes,
            actionText: `Export to MAL as ${localItem.status} (Ch ${localProgress}, Vol ${localVolumes})`,
          });
        }
      }
    }
  } else if (integration === "anilist") {
    const accessToken = profile.anilist_access_token;
    const aniListUserId = Number(profile.anilist_user_id);
    if (!accessToken || !aniListUserId) throw new Error("AniList not connected");

    if (mediaType === "anime") {
      const aniList = await fetchAllAniListAnime(accessToken, aniListUserId);
      const { data: watchlist, error: watchlistError } = await sb.from("watchlist").select("*").eq("user_id", userId);
      if (watchlistError) throw new Error(`Failed to read watchlist: ${watchlistError.message}`);
      const localWatchlist: any[] = watchlist || [];

      const localProgressMap = await fetchWatchProgressMap(sb, userId);

      const localByAniListId = new Map<number, any>();
      const unresolved = new Set(localWatchlist.filter(item => !item.anilist_id));
      await resolveAniListLocalRows(localWatchlist, aniList, "anime", title => resolveTitle(() => searchAnilistId(title, "ANIME", resolutionCache)));
      for (const item of localWatchlist) {
        if (!item.anilist_id) continue;
        const aid = Number(item.anilist_id);
        const existing = localByAniListId.get(aid);
        const progress = localProgressMap.get(item.anime_id) || 0;
        const existingProgress = existing ? localProgressMap.get(existing.anime_id) || 0 : -1;
        if (!existing || progress > existingProgress || (progress === existingProgress && item.status === "completed")) localByAniListId.set(aid, item);
        if (unresolved.has(item)) await backfillTrackerId("watchlist", "anime_id", item.anime_id, { anilist_id: aid });
      }

      const matchedRemoteIds = new Set<number>();

      for (const aniItem of aniList) {
        const media = aniItem.media;
        const anilistId = Number(media.id);
        const title = media.title.english || media.title.romaji || media.title.native;
        const poster = media.coverImage.large || media.coverImage.medium || null;
        matchedRemoteIds.add(anilistId);

        const localItem = localByAniListId.get(anilistId);
        const remoteStatus = mapAniListStatusToTatakai(aniItem.status);
        const remoteProgress = Number(aniItem.progress || 0);

        if (localItem) {
          const localStatus = localItem.status;
          const localProgress = localProgressMap.get(localItem.anime_id) || 0;

          const aliasesDiffer = localWatchlist.some(item => Number(item.anilist_id) === anilistId && (item.status !== remoteStatus || (localProgressMap.get(item.anime_id) || 0) !== remoteProgress));
          if (localStatus !== remoteStatus || localProgress !== remoteProgress || aliasesDiffer) {
            // Two-way sync: the side that is further ahead wins, so the local
            // watchlist also flows OUT to AniList — not only the reverse.
            const direction = localStatus === remoteStatus && localProgress === remoteProgress ? "import" : syncDirection(localProgress, remoteProgress);
            proposal.push({
              id: `update:anilist:anime:${anilistId}`,
              mediaId: localItem.anime_id,
              anilistId,
              localMediaIds: localWatchlist.filter(item => Number(item.anilist_id) === anilistId).map(item => String(item.anime_id)),
              malId: media.idMal || null,
              title,
              poster,
              type: "anime",
              direction,
              localStatus,
              localProgress,
              remoteStatus,
              remoteProgress,
              actionText: direction === "export"
                ? `Export to AniList (${localStatus} - Ep ${localProgress})`
                : `Import from AniList (${remoteStatus} - Ep ${remoteProgress})`,
            });
          }
        } else {
          proposal.push({
            id: `import:anilist:anime:${anilistId}`,
            mediaId: `anilist:${anilistId}`,
            anilistId,
            malId: media.idMal || null,
            title,
            poster,
            type: "anime",
            direction: "import",
            remoteStatus,
            remoteProgress,
            actionText: `Import from AniList to watchlist as ${remoteStatus} (Ep ${remoteProgress})`,
          });
        }
      }

      for (const localItem of localWatchlist) {
        let aid = localItem.anilist_id ? Number(localItem.anilist_id) : null;
        if (!aid) {
          aid = await resolveTitle(() => searchAnilistId(localItem.anime_name, "ANIME", resolutionCache));
          if (aid) await backfillTrackerId("watchlist", "anime_id", localItem.anime_id, { anilist_id: aid });
        }
        if (aid && !matchedRemoteIds.has(aid)) {
          const canonical = localByAniListId.get(aid);
          if (canonical && canonical !== localItem) continue;
          matchedRemoteIds.add(aid);
          const localProgress = localProgressMap.get(localItem.anime_id) || 0;
          proposal.push({
            id: `export:anilist:anime:${localItem.anime_id}`,
            mediaId: localItem.anime_id,
            anilistId: aid,
            title: localItem.anime_name,
            poster: localItem.anime_poster,
            type: "anime",
            direction: "export",
            localStatus: localItem.status,
            localProgress,
            actionText: `Export to AniList as ${localItem.status} (Ep ${localProgress})`,
          });
        }
      }
    } else {
      // Manga AniList Sync
      const aniList = await fetchAllAniListManga(accessToken, aniListUserId);
      const { data: readlist, error: readlistError } = await sb.from("manga_readlist").select("*").eq("user_id", userId);
      if (readlistError) throw new Error(`Failed to read manga_readlist: ${readlistError.message}`);
      const localReadlist: any[] = readlist || [];

      const localByAniListId = new Map<number, any>();
      const unresolved = new Set(localReadlist.filter(item => !item.anilist_id));
      await resolveAniListLocalRows(localReadlist, aniList, "manga", title => resolveTitle(() => searchAnilistId(title, "MANGA", resolutionCache)));
      for (const item of localReadlist) {
        if (!item.anilist_id) continue;
        const aid = Number(item.anilist_id);
        const existing = localByAniListId.get(aid);
        if (!existing || syncDirection(Number(item.last_chapter_number || 0), Number(existing.last_chapter_number || 0), Number(item.last_volume_number || 0), Number(existing.last_volume_number || 0)) === "export") localByAniListId.set(aid, item);
        if (unresolved.has(item)) await backfillTrackerId("manga_readlist", "manga_id", item.manga_id, { anilist_id: aid });
      }

      const matchedRemoteIds = new Set<number>();

      for (const aniItem of aniList) {
        const media = aniItem.media;
        const anilistId = Number(media.id);
        const title = media.title.english || media.title.romaji || media.title.native;
        const poster = media.coverImage.large || media.coverImage.medium || null;
        matchedRemoteIds.add(anilistId);

        const localItem = localByAniListId.get(anilistId);
        const remoteStatus = mapAniListStatusToTatakaiManga(aniItem.status);
        const remoteProgress = Number(aniItem.progress || 0);
        const remoteVolumes = Number(aniItem.progressVolumes || 0);

        if (localItem) {
          const localStatus = localItem.status;
          const localProgress = Number(localItem.last_chapter_number || 0);
          const localVolumes = Number(localItem.last_volume_number || 0);

          const aliasesDiffer = localReadlist.some(item => Number(item.anilist_id) === anilistId && (item.status !== remoteStatus || Number(item.last_chapter_number || 0) !== remoteProgress || Number(item.last_volume_number || 0) !== remoteVolumes));
          if (localStatus !== remoteStatus || localProgress !== remoteProgress || localVolumes !== remoteVolumes || aliasesDiffer) {
            // Two-way sync: the side that is further ahead wins (see anime).
            const direction = localStatus === remoteStatus && localProgress === remoteProgress && localVolumes === remoteVolumes ? "import" : syncDirection(localProgress, remoteProgress, localVolumes, remoteVolumes);
            proposal.push({
              id: `update:anilist:manga:${anilistId}`,
              mediaId: localItem.manga_id,
              anilistId,
              localMediaIds: localReadlist.filter(item => Number(item.anilist_id) === anilistId).map(item => String(item.manga_id)),
              malId: media.idMal || null,
              title,
              poster,
              type: "manga",
              direction,
              localStatus,
              localProgress,
              localVolumes,
              remoteStatus,
              remoteProgress,
              remoteVolumes,
              actionText: direction === "export"
                ? `Export to AniList (${localStatus} - Ch ${localProgress}, Vol ${localVolumes})`
                : `Import from AniList (${remoteStatus} - Ch ${remoteProgress}, Vol ${remoteVolumes})`,
            });
          }
        } else {
          proposal.push({
            id: `import:anilist:manga:${anilistId}`,
            mediaId: `anilist:${anilistId}`,
            anilistId,
            malId: media.idMal || null,
            title,
            poster,
            type: "manga",
            direction: "import",
            remoteStatus,
            remoteProgress,
            remoteVolumes,
            actionText: `Import from AniList to readlist as ${remoteStatus} (Ch ${remoteProgress}, Vol ${remoteVolumes})`,
          });
        }
      }

      for (const localItem of localReadlist) {
        let aid = localItem.anilist_id ? Number(localItem.anilist_id) : null;
        if (!aid) {
          aid = await resolveTitle(() => searchAnilistId(localItem.manga_title, "MANGA", resolutionCache));
          if (aid) await backfillTrackerId("manga_readlist", "manga_id", localItem.manga_id, { anilist_id: aid });
        }
        if (aid && !matchedRemoteIds.has(aid)) {
          const canonical = localByAniListId.get(aid);
          if (canonical && canonical !== localItem) continue;
          matchedRemoteIds.add(aid);
          const localProgress = Number(localItem.last_chapter_number || 0);
          const localVolumes = Number(localItem.last_volume_number || 0);
          proposal.push({
            id: `export:anilist:manga:${localItem.manga_id}`,
            mediaId: localItem.manga_id,
            anilistId: aid,
            title: localItem.manga_title,
            poster: localItem.manga_poster,
            type: "manga",
            direction: "export",
            localStatus: localItem.status,
            localProgress,
            localVolumes,
            actionText: `Export to AniList as ${localItem.status} (Ch ${localProgress}, Vol ${localVolumes})`,
          });
        }
      }
    }
  } else if (integration === "mangabaka") {
    // MangaBaka is a manga-only tracker: anime has no remote side.
    if (mediaType === "manga") {
      const accessToken = await mangabaka.getOrRefreshMangabakaToken(sb, userId);
      if (!accessToken) throw new Error("MangaBaka not connected");

      const mbLibrary = await mangabaka.fetchMangabakaLibrary(accessToken);
      const { data: readlist, error: readlistError } = await sb.from("manga_readlist").select("*").eq("user_id", userId);
      if (readlistError) throw new Error(`Failed to read manga_readlist: ${readlistError.message}`);
      const localReadlist: any[] = readlist || [];

      const localByAnilistId = new Map<number, any>();
      const localByMalId = new Map<number, any>();
      const localByMbId = new Map<number, any>();
      for (const item of localReadlist) {
        if (item.anilist_id) localByAnilistId.set(Number(item.anilist_id), item);
        if (item.mal_id) localByMalId.set(Number(item.mal_id), item);
        const mbMatch = String(item.manga_id || "").match(/^mangabaka:(\d+)$/i);
        if (mbMatch) localByMbId.set(Number(mbMatch[1]), item);
      }

      const matchedLocalIds = new Set<string>();
      const matchedRemoteSeries = new Set<number>();

      // 1. Remote → local (import new, update mismatched).
      for (const entry of mbLibrary) {
        const seriesId = Number(entry.seriesId);
        const title = entry.title || `MangaBaka #${seriesId}`;
        const poster = entry.coverUrl;
        const anilistId = entry.anilistId ? Number(entry.anilistId) : null;
        const malId = entry.malId ? Number(entry.malId) : null;
        matchedRemoteSeries.add(seriesId);

        const localItem =
          (anilistId && localByAnilistId.get(anilistId)) ||
          (malId && localByMalId.get(malId)) ||
          localByMbId.get(seriesId) ||
          null;

        const remoteStatus = mangabaka.mapMangaBakaStatusToTatakai(entry.state || "plan_to_read");
        const remoteProgress = Number(entry.progressChapter || 0);
        const remoteVolumes = Number(entry.progressVolume || 0);
        const mediaId = anilistId
          ? String(anilistId)
          : malId
            ? `mal:${malId}`
            : `mangabaka:${seriesId}`;

        if (localItem) {
          matchedLocalIds.add(String(localItem.manga_id));
          const localStatus = localItem.status;
          const localProgress = Number(localItem.last_chapter_number || 0);
          const localVolumes = Number(localItem.last_volume_number || 0);

          if (localStatus !== remoteStatus || localProgress !== remoteProgress || localVolumes !== remoteVolumes) {
            const exporting = syncDirection(localProgress, remoteProgress, localVolumes, remoteVolumes) === "export";
            proposal.push({
              id: `update:mangabaka:manga:${seriesId}`,
              mediaId: localItem.manga_id,
              malId,
              anilistId,
              mangabakaId: seriesId,
              title,
              poster,
              type: "manga",
              direction: exporting ? "export" : "import",
              localStatus,
              localProgress,
              localVolumes,
              remoteStatus,
              remoteProgress,
              remoteVolumes,
              actionText: exporting
                ? `Export to MangaBaka (${localStatus} - Ch ${localProgress}, Vol ${localVolumes})`
                : `Import from MangaBaka (${remoteStatus} - Ch ${remoteProgress}, Vol ${remoteVolumes})`,
            });
          }
        } else {
          proposal.push({
            id: `import:mangabaka:manga:${seriesId}`,
            mediaId,
            malId,
            anilistId,
            mangabakaId: seriesId,
            title,
            poster,
            type: "manga",
            direction: "import",
            remoteStatus,
            remoteProgress,
            remoteVolumes,
            actionText: `Import from MangaBaka to readlist as ${remoteStatus} (Ch ${remoteProgress}, Vol ${remoteVolumes})`,
          });
        }
      }

      // 2. Local → remote (entries missing from the MangaBaka library).
      for (const localItem of localReadlist) {
        if (matchedLocalIds.has(String(localItem.manga_id))) continue;
        const anilistId = localItem.anilist_id ? Number(localItem.anilist_id) : null;
        const malId = localItem.mal_id ? Number(localItem.mal_id) : null;
        let mbId: number | null = null;
        const mbMatch = String(localItem.manga_id || "").match(/^mangabaka:(\d+)$/i);
        if (mbMatch) {
          mbId = Number(mbMatch[1]);
        } else if (anilistId || malId) {
          try {
            mbId = await mangabaka.resolveMangabakaSeriesId({ anilistId, malId });
          } catch {
            mbId = null;
          }
        }
        if (!mbId) {
          // Last resort: exact title match (bounded by the shared budget).
          try {
            mbId = await resolveTitle(() =>
              mangabaka.searchMangabakaSeriesByTitle(localItem.manga_title),
            );
          } catch {
            mbId = null;
          }
        }
        if (!mbId || matchedRemoteSeries.has(mbId)) continue;
        const localProgress = Number(localItem.last_chapter_number || 0);
        const localVolumes = Number(localItem.last_volume_number || 0);
        proposal.push({
          id: `export:mangabaka:manga:${localItem.manga_id}`,
          mediaId: localItem.manga_id,
          malId,
          anilistId,
          mangabakaId: mbId,
          title: localItem.manga_title,
          poster: localItem.manga_poster,
          type: "manga",
          direction: "export",
          localStatus: localItem.status,
          localProgress,
          localVolumes,
          actionText: `Export to MangaBaka as ${localItem.status} (Ch ${localProgress}, Vol ${localVolumes})`,
        });
      }
    }
  }

  return proposal;
}

/**
 * Unified proposal covering BOTH anime and manga for one integration, for the
 * single-button "Sync" flow. De-duplication is inherent: buildSyncProposal keys
 * every existing entry by its MAL/AniList id, so an item already in the user's
 * watchlist/readlist becomes an "update" (never a duplicate "import").
 * Direction is two-way (see syncDirection): the side that is further ahead
 * wins, so local entries flow out to the tracker and tracker entries flow in —
 * run each Sync button once and both sides end up with everything.
 */
export async function buildUnifiedProposal(
  sb: any,
  userId: string,
  integration: "mal" | "anilist" | "mangabaka",
): Promise<SyncProposalItem[]> {
  const [anime, manga] = await Promise.all([
    buildSyncProposal(sb, userId, integration, "anime"),
    buildSyncProposal(sb, userId, integration, "manga"),
  ]);
  return [...anime, ...manga];
}

// Apply selected actions in proposal
export async function applySyncActions(
  sb: any,
  userId: string,
  integration: "mal" | "anilist" | "mangabaka",
  actions: SyncProposalItem[]
) {
  const profile = await resolveProfileRow(sb, userId);
  if (!profile) throw new Error("Profile not found");

  const malToken = integration === "mal" ? await getOrRefreshMalToken(sb, userId, profile) : null;
  const anilistToken = integration === "anilist" ? profile.anilist_access_token : null;
  if (integration === "anilist" && !anilistToken) throw new Error("AniList not connected");
  if (integration === "mal" && !malToken) throw new Error("MAL not connected");

  const importLocally = async (action: SyncProposalItem) => {
    if (action.type === "anime") {
      // Import/Update locally in watchlist
      const animeId = String(action.mediaId);
      const upsertPayload: any = {
        user_id: userId,
        anime_id: animeId,
        anime_name: action.title,
        anime_poster: action.poster,
        status: action.remoteStatus || "plan_to_watch",
        updated_at: new Date().toISOString(),
      };
      if (action.malId) upsertPayload.mal_id = action.malId;
      if (action.anilistId) upsertPayload.anilist_id = action.anilistId;

      const { error: watchlistError } = await sb.from("watchlist").upsert(upsertPayload, { onConflict: "user_id,anime_id" });
      if (watchlistError) throw new Error(`Watchlist save failed: ${watchlistError.message}`);

      // Write dummy completed history up to remote progress
      if (action.remoteProgress && action.remoteProgress > 0) {
        const baseTime = Date.now() - action.remoteProgress;
        const historyRows = Array.from({ length: action.remoteProgress }, (_, i) => ({
          user_id: userId,
          anime_id: animeId,
          anime_name: action.title,
          anime_poster: action.poster,
          episode_id: `${animeId}?ep=${i + 1}`,
          episode_number: i + 1,
          completed: true,
          watched_at: new Date(baseTime + i).toISOString(),
          mal_id: action.malId || null,
          anilist_id: action.anilistId || null,
        }));
        const { error: historyError } = await sb.from("watch_history").upsert(historyRows, { onConflict: "user_id,episode_id" });
        if (historyError) throw new Error(`History save failed: ${historyError.message}`);
      }
    } else {
      // Import/Update locally in manga readlist
      const mangaId = String(action.mediaId);
      const upsertPayload: any = {
        user_id: userId,
        manga_id: mangaId,
        manga_title: action.title,
        manga_poster: action.poster,
        status: action.remoteStatus || "plan_to_read",
        last_chapter_number: action.remoteProgress || 0,
        last_volume_number: action.remoteVolumes || 0,
        updated_at: new Date().toISOString(),
      };
      if (action.malId) upsertPayload.mal_id = action.malId;
      if (action.anilistId) upsertPayload.anilist_id = action.anilistId;

      let { error: mangaErr } = await sb
        .from("manga_readlist")
        .upsert(upsertPayload, { onConflict: "user_id,manga_id" });

      // Resilience: if the last_volume_number column hasn't been migrated yet
      // (42703 undefined_column), retry without it so manga still saves.
      if (mangaErr && (mangaErr.code === "42703" || /last_volume_number/.test(mangaErr.message || ""))) {
        delete upsertPayload.last_volume_number;
        ({ error: mangaErr } = await sb
          .from("manga_readlist")
          .upsert(upsertPayload, { onConflict: "user_id,manga_id" }));
      }
      if (mangaErr) {
        log.error({ mangaErr, mangaId }, "[Sync] Failed to save manga_readlist row");
        throw new Error(`Manga save failed: ${mangaErr.message}`);
      }
    }
  };

  // Reject conflicting writes before making any changes, including previews from
  // older clients. Identical duplicates can safely collapse to one action.
  const uniqueActions = new Map<string, SyncProposalItem>();
  for (const action of actions) {
    const trackerId = integration === "anilist" ? action.anilistId : integration === "mal" ? action.malId : action.mangabakaId;
    const key = `${action.type}:${trackerId || action.mediaId}`;
    const previous = uniqueActions.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(action)) throw new Error(`Conflicting sync actions for ${action.title}. Reload the preview.`);
    if (action.direction === "conflict") throw new Error(`Resolve the conflict for ${action.title} before applying.`);
    uniqueActions.set(key, action);
  }
  const expandedActions = [...uniqueActions.values()].flatMap(action => action.direction === "import" && action.localMediaIds?.length
    ? [...new Set(action.localMediaIds)].map(mediaId => ({ ...action, mediaId })) : [action]);
  const failures: string[] = [];

  // Bounded parallelism: a full-library apply fans out to hundreds of upstream
  // writes — sequential awaits would blow past the request timeout. Per-action
  // failures are collected and reported after the batch. MangaBaka's
  // never-cached /my/* endpoints rate-limit aggressively per IP, so those
  // run at lower concurrency (429s still back off and retry server-side).
  await mapWithConcurrency(expandedActions, integration === "mangabaka" ? 2 : 5, async (action) => {
    try {
      if (action.direction === "import") {
        await importLocally(action);
      } else if (action.direction === "export") {
        if (integration === "mal" && malToken) {
          if (action.type === "anime" && action.malId) {
            const updateParams = new URLSearchParams({
              status: mapTatakaiStatusToMal(action.localStatus || "plan_to_watch"),
              num_watched_episodes: String(action.localProgress || 0),
            });
            const response = await fetch(`https://api.myanimelist.net/v2/anime/${action.malId}/my_list_status`, {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${malToken}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: updateParams.toString(),
            });
            if (!response.ok) throw new Error(`MAL save failed: ${response.status}`);
          } else if (action.type === "manga" && action.malId) {
            const updateParams = new URLSearchParams({
              status: mapTatakaiMangaStatusToMal(action.localStatus || "plan_to_read"),
              num_chapters_read: String(action.localProgress || 0),
            });
            if (action.localVolumes != null) {
              updateParams.append("num_volumes_read", String(action.localVolumes || 0));
            }
            const response = await fetch(`https://api.myanimelist.net/v2/manga/${action.malId}/my_list_status`, {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${malToken}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: updateParams.toString(),
            });
            if (!response.ok) throw new Error(`MAL save failed: ${response.status}`);
          }
        } else if (integration === "anilist" && anilistToken) {
          const mediaId = Number(action.anilistId);
          if (mediaId) {
            // Volumes only apply to manga; send progressVolumes when we have it.
            const isManga = action.type === "manga";
            const aniStatus = isManga
              ? mapTatakaiMangaStatusToAniList(action.localStatus || "plan_to_read")
              : mapTatakaiStatusToAniList(action.localStatus || "plan_to_watch");
            const progress = action.localProgress || 0;
            const progressVolumes = isManga ? (action.localVolumes ?? 0) : undefined;
            const query = `
              mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int, $progressVolumes: Int) {
                SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress, progressVolumes: $progressVolumes) {
                  id
                  status
                  progress
                  progressVolumes
                }
              }
            `;
            const response = await anilistFetch("https://graphql.anilist.co", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${anilistToken}`,
              },
              body: JSON.stringify({ query, variables: { mediaId, status: aniStatus, progress, progressVolumes } }),
            });
            const body: any = await response.json();
            if (!response.ok || body.errors?.length || !body.data?.SaveMediaListEntry) throw new Error(body.errors?.[0]?.message || `AniList save failed: ${response.status}`);
          }
        } else if (integration === "mangabaka" && action.type === "manga") {
          // Server resolves the series id from any known external id.
          await mangabaka.pushMangabakaProgress(sb, userId, {
            anilistId: action.anilistId ?? null,
            malId: action.malId ?? null,
            mangabakaId: action.mangabakaId ?? null,
            status: action.localStatus || "reading",
            chapter: action.localProgress ?? 0,
            volume: action.localVolumes ?? 0,
          });
        }
        if (integration === "anilist" && action.localMediaIds && action.localMediaIds.length > 1) {
          for (const mediaId of new Set(action.localMediaIds)) {
            await importLocally({ ...action, mediaId, remoteStatus: action.localStatus, remoteProgress: action.localProgress, remoteVolumes: action.localVolumes });
          }
        }
      }
    } catch (err) {
      log.error({ err, action }, "Failed to apply sync action");
      failures.push(`${action.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  if (failures.length) throw new Error(`${failures.length} sync change(s) failed. Reopen the preview to retry. ${failures[0]}`);
}
