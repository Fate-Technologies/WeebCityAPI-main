import { Hono } from "hono";
import { jsonOk, jsonError } from "../lib/envelope.js";
import { getSupabase } from "../lib/supabase.js";
import { createMiddleware } from "hono/factory";
import * as syncService from "../services/integrationSync.js";
import * as mangabakaService from "../services/mangabakaSync.js";
import { log } from "../config/logger.js";
import { anilistLimiter } from "../lib/rateLimiter.js";

type SyncEnv = { Variables: { userId: string } };

const syncRouter = new Hono<SyncEnv>();

// Auth Middleware: Resolve Bearer token to user ID using Supabase Auth
export const requireUserAuth = createMiddleware<SyncEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return c.json(jsonError("Missing Authorization header"), 401);
  }
  const token = authHeader.replace("Bearer ", "");
  const sb = getSupabase();
  if (!sb) {
    return c.json(jsonError("Database not configured"), 500);
  }
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) {
    return c.json(jsonError("Unauthorized"), 401);
  }
  if (c.req.method !== "GET" && user.app_metadata?.tatakai_email_proof_required) {
    return c.json(jsonError("Verify your email before linking or changing external accounts"), 403);
  }
  c.set("userId", user.id);
  await next();
});

// Protect all sync routes under user auth
syncRouter.use("*", requireUserAuth);

// Existing desktop/mobile MAL list calls now use the API, without Edge Functions.
syncRouter.post("/mal/legacy", async (c) => {
  const body = await c.req.json();
  const action = String(body.action || "");
  if (!["fetch_list", "fetch_manga_list", "delete", "delete_manga"].includes(action)) return c.json(jsonError("Unsupported action"), 400);
  const sb = getSupabase()!;
  const profile = await syncService.resolveProfileRow(sb, c.get("userId"));
  if (!profile?.mal_access_token) return c.json(jsonError("MyAnimeList is not linked"), 400);
  const token = await syncService.getOrRefreshMalToken(sb, c.get("userId"), profile);
  const type = action.includes("manga") ? "manga" : "anime";
  if (action.startsWith("delete")) {
    const id = Number(body.malId);
    if (!Number.isSafeInteger(id) || id < 1) return c.json(jsonError("Invalid MAL id"), 400);
    const response = await fetch(`https://api.myanimelist.net/v2/${type}/${id}/my_list_status`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    return response.ok ? c.json(jsonOk({ deleted: true })) : c.json(jsonError("MyAnimeList deletion failed"), 502);
  }
  const entries: unknown[] = [];
  for (let page = 0; page < 20; page++) {
    const url = new URL(`https://api.myanimelist.net/v2/users/@me/${type}list`);
    url.searchParams.set("fields", "list_status"); url.searchParams.set("limit", "1000"); url.searchParams.set("offset", String(page * 1000));
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return c.json(jsonError("MyAnimeList list unavailable"), 502);
    const result = await response.json() as { data?: unknown[]; paging?: { next?: string } };
    entries.push(...(result.data || []));
    if (!result.paging?.next) return c.json({ data: entries });
  }
  return c.json(jsonError("MyAnimeList list exceeds the import limit"), 413);
});

// 1. Exchange MAL / AniList authorization code
syncRouter.post("/exchange", async (c) => {
  const userId = c.get("userId");
  const sb = getSupabase()!;
  try {
    const body = await c.req.json();
    const { integration, code, codeVerifier, redirectUri, clientId } = body;

    if (integration === "mal") {
      const res = await syncService.exchangeMalCode(sb, userId, code, codeVerifier, redirectUri, clientId);
      return c.json(jsonOk(res));
    } else if (integration === "anilist") {
      const res = await syncService.exchangeAniListCode(sb, userId, code, redirectUri);
      return c.json(jsonOk(res));
    } else if (integration === "mangabaka") {
      const res = await mangabakaService.exchangeMangabakaCode(sb, userId, code, codeVerifier, redirectUri);
      return c.json(jsonOk(res));
    } else {
      return c.json(jsonError("Invalid integration type"), 400);
    }
  } catch (err: any) {
    return c.json(jsonError(err.message || "Exchange failed"), 400);
  }
});

// 1b. Normalized tracker statistics for the profile (server-side; no browser CORS)
syncRouter.get("/stats", async (c) => {
  const userId = c.get("userId");
  const sb = getSupabase()!;
  try {
    const stats = await syncService.getExternalStats(sb, userId);
    return c.json(jsonOk(stats));
  } catch (err: any) {
    return c.json(jsonError(err.message || "Failed to load stats"), 400);
  }
});

// 1c. MangaBaka (OAuth tracker) — connection state never exposes the tokens.
syncRouter.get("/mangabaka/status", async (c) => {
  const userId = c.get("userId");
  const sb = getSupabase()!;
  try {
    const status = await mangabakaService.getMangabakaStatus(sb, userId);
    return c.json(jsonOk(status));
  } catch (err: any) {
    return c.json(jsonError(err.message || "Failed to load MangaBaka status"), 400);
  }
});

syncRouter.post("/mangabaka/disconnect", async (c) => {
  const userId = c.get("userId");
  const sb = getSupabase()!;
  try {
    await mangabakaService.disconnectMangabaka(sb, userId);
    return c.json(jsonOk({ success: true }));
  } catch (err: any) {
    return c.json(jsonError(err.message || "MangaBaka disconnect failed"), 400);
  }
});

// MangaBaka library for the import review step (server holds the OAuth token).
syncRouter.get("/mangabaka/library", async (c) => {
  const userId = c.get("userId");
  const sb = getSupabase()!;
  try {
    const accessToken = await mangabakaService.getOrRefreshMangabakaToken(sb, userId);
    if (!accessToken) {
      return c.json(jsonError("MangaBaka is not connected."), 400);
    }
    const entries = await mangabakaService.fetchMangabakaLibrary(accessToken);
    return c.json(jsonOk({ entries }));
  } catch (err: any) {
    return c.json(jsonError(err.message || "Failed to fetch MangaBaka library"), 400);
  }
});

// 2. Generate a preview of differences to apply (Import/Export diff list)
syncRouter.post("/preview", async (c) => {
  const userId = c.get("userId");
  const sb = getSupabase()!;
  try {
    const body = await c.req.json();
    // integration: "mal" | "anilist" | "mangabaka"; mediaType: "anime" | "manga" | "all"
    const { integration, mediaType = "all" } = body;

    if (!["mal", "anilist", "mangabaka"].includes(integration) || !["anime", "manga", "all"].includes(mediaType)) {
      return c.json(jsonError("Invalid parameters"), 400);
    }

    const proposal =
      mediaType === "all"
        ? await syncService.buildUnifiedProposal(sb, userId, integration)
        : await syncService.buildSyncProposal(sb, userId, integration, mediaType);
    return c.json(jsonOk(proposal));
  } catch (err: any) {
    return c.json(jsonError(err.message || "Failed to generate sync preview"), 400);
  }
});

// 3. Apply user-confirmed actions
syncRouter.post("/apply", async (c) => {
  const userId = c.get("userId");
  const sb = getSupabase()!;
  try {
    const body = await c.req.json();
    const { integration, actions } = body;

    if (!["mal", "anilist", "mangabaka"].includes(integration) || !Array.isArray(actions)) {
      return c.json(jsonError("Invalid parameters"), 400);
    }

    await syncService.applySyncActions(sb, userId, integration, actions);
    return c.json(jsonOk({ success: true }));
  } catch (err: any) {
    return c.json(jsonError(err.message || "Failed to apply sync actions"), 400);
  }
});

// 4. real-time single item synchronization (e.g. smart watch progress sync triggers)
syncRouter.post("/single-sync", async (c) => {
  const userId = c.get("userId");
  const sb = getSupabase()!;
  try {
    const body = await c.req.json();
    const { type, malId, anilistId, mangabakaId, kitsuId, status, progress, volume, score } = body;

    const profile = await syncService.resolveProfileRow(sb, userId);
    if (!profile) {
      return c.json(jsonError("Profile not found"), 404);
    }

    // Sync to MAL if connected
    if (profile.mal_access_token && malId) {
      try {
        const malToken = await syncService.getOrRefreshMalToken(sb, userId, profile);
        if (type === "anime") {
          const updateParams = new URLSearchParams({
            status: syncService.mapTatakaiStatusToMal(status || "watching"),
            num_watched_episodes: String(progress || 0),
          });
          if (score) updateParams.append("score", String(score));

          await fetch(`https://api.myanimelist.net/v2/anime/${malId}/my_list_status`, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${malToken}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: updateParams.toString(),
          });
        } else {
          const updateParams = new URLSearchParams({
            status: syncService.mapTatakaiStatusToMal(status || "reading"),
            num_chapters_read: String(progress || 0),
          });
          if (score) updateParams.append("score", String(score));

          await fetch(`https://api.myanimelist.net/v2/manga/${malId}/my_list_status`, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${malToken}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: updateParams.toString(),
          });
        }
      } catch (malErr) {
        log.warn({ malErr }, "Realtime MAL sync failed");
      }
    }

    // Sync to AniList if connected
    if (profile.anilist_access_token && anilistId) {
      try {
        const mediaId = Number(anilistId);
        const aniStatus = syncService.mapTatakaiStatusToAniList(status);
        const query = `
          mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int, $score: Float) {
            SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress, score: $score) {
              id
              status
              progress
            }
          }
        `;
        await anilistLimiter.acquire(1);
        await fetch("https://graphql.anilist.co", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${profile.anilist_access_token}`,
          },
          body: JSON.stringify({ query, variables: { mediaId, status: aniStatus, progress: progress || 0, score } }),
        });
      } catch (aniErr) {
        log.warn({ aniErr }, "Realtime AniList sync failed");
      }
    }

    // Sync to MangaBaka if connected (manga only — MangaBaka is a manga tracker).
    // Fire-and-forget like the others: a push failure must not fail the read.
    if (type === "manga") {
      try {
        await mangabakaService.pushMangabakaProgress(sb, userId, {
          anilistId: anilistId != null ? Number(anilistId) : null,
          malId: malId != null ? Number(malId) : null,
          kitsuId: kitsuId != null ? Number(kitsuId) : null,
          mangabakaId: mangabakaId != null ? Number(mangabakaId) : null,
          status: status || "reading",
          chapter: progress != null ? Number(progress) : null,
          volume: volume != null ? Number(volume) : null,
          score: score != null ? Number(score) : null,
        });
      } catch (mbErr) {
        log.warn({ mbErr }, "Realtime MangaBaka sync failed");
      }
    }

    return c.json(jsonOk({ success: true }));
  } catch (err: any) {
    return c.json(jsonError(err.message || "Failed realtime item sync"), 400);
  }
});

export { syncRouter };
