import { createHash } from "node:crypto";
import { NovelFallback, isNovelCatalogQuery, normalizeNovelVariables } from "../lib/novelFallback.js";
import { Hono } from "hono";
import { parse, type SelectionSetNode } from "graphql";
import { jsonError } from "../lib/envelope.js";
import { getSupabase } from "../lib/supabase.js";
import { env } from "../config/env.js";
import { log } from "../config/logger.js";
import { anilistLimiter } from "../lib/rateLimiter.js";
import { executeMirror } from "../mirror/execute.js";
import * as syncService from "../services/integrationSync.js";

/**
 * Server-side AniList GraphQL proxy.
 *
 * The browser cannot call https://graphql.anilist.co directly: 429 responses (and
 * some others) omit CORS headers, so the fetch surfaces as an opaque CORS error.
 * Routing every AniList query through here fixes that, keeps the user's OAuth
 * token server-side, and lets us attach the optional ANILIST_TOKEN for a higher
 * rate limit on public queries.
 *
 * POST /api/v3/anilist/graphql
 *   body: { query: string, variables?: object, useUserToken?: boolean, forceUpstream?: boolean }
 *   - useUserToken: when true and a Supabase Bearer is present, the caller's
 *     stored anilist_access_token is used (required for mutations like
 *     SaveMediaListEntry). Otherwise the request is anonymous / server-token.
 *   - forceUpstream: skip the in-process mirror and read real AniList directly.
 *     Set by callers of volatile data that must stay fresh — the airing calendar
 *     and per-show next-airing countdown — which would otherwise serve the
 *     mirror's stale stored schedule.
 */
const anilistProxyRouter = new Hono();

const ANILIST_GRAPHQL = "https://graphql.anilist.co";
const novelFallback = new NovelFallback();

// Public-branch abuse limits. Account-scoped (useUserToken) requests skip these:
// SaveMediaListEntry is a legitimate mutation and its documents are our own.
const MAX_QUERY_LEN = 20_000;
const MAX_QUERY_DEPTH = 15;

/** Deepest selection-set nesting in the document (guards against deep-query DoS). */
function selectionDepth(sel: SelectionSetNode | undefined, depth = 0): number {
  if (!sel) return depth;
  let max = depth;
  for (const node of sel.selections) {
    if ("selectionSet" in node && node.selectionSet) {
      max = Math.max(max, selectionDepth(node.selectionSet, depth + 1));
    }
  }
  return max;
}

/**
 * Validate a public (anonymous) GraphQL request: bounded length, no mutations,
 * bounded nesting. Returns an error message, or null when the query is allowed.
 */
function rejectPublicQuery(query: string): string | null {
  if (query.length > MAX_QUERY_LEN) return "Query too large";
  let doc;
  try {
    doc = parse(query);
  } catch {
    return "Invalid GraphQL query";
  }
  for (const def of doc.definitions) {
    if (def.kind === "OperationDefinition") {
      if (def.operation === "mutation" || def.operation === "subscription") {
        return "Only queries are allowed on the public endpoint";
      }
      if (selectionDepth(def.selectionSet) > MAX_QUERY_DEPTH) return "Query too deeply nested";
    }
  }
  return null;
}

anilistProxyRouter.post("/graphql", async (c) => {
  let body: { query?: string; variables?: Record<string, unknown>; useUserToken?: boolean; forceUpstream?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json(jsonError("Invalid JSON body"), 400);
  }

  const { query, variables: rawVariables, useUserToken, forceUpstream } = body;
  if (!query || typeof query !== "string") {
    return c.json(jsonError("Missing GraphQL query"), 400);
  }

  // Lock down the anonymous branch: no mutations, bounded size/depth. Account-
  // scoped requests carry our own trusted documents and are exempt.
  if (!useUserToken) {
    const reason = rejectPublicQuery(query);
    if (reason) return c.json(jsonError(reason), reason === "Invalid GraphQL query" ? 400 : 403);
  }
  const variables = !useUserToken && isNovelCatalogQuery(query, rawVariables ?? {})
    ? normalizeNovelVariables(query, rawVariables ?? {}) : rawVariables;

  // Public (non-account) reads try the in-process mirror first — no upstream hop,
  // no rate limit. On a mirror error / empty payload we fall through to upstream.
  // Account-scoped requests (useUserToken: Viewer / MediaListCollection / mutations)
  // always go upstream — the mirror has no user/viewer/mutation roots. `forceUpstream`
  // opts a public read out of the mirror too (fresh airing calendar / next-airing).
  if (env.ANILIST_USE_MIRROR && !useUserToken && !forceUpstream) {
    try {
      const res = await executeMirror(query, variables ?? {});
      if (!res.errors?.length && res.data != null) {
        return c.json({ data: res.data });
      }
      log.debug(
        { errs: res.errors?.map((e) => e.message).slice(0, 3) },
        "[AniListProxy] mirror miss/error — falling back to upstream",
      );
    } catch (err) {
      log.debug({ err: (err as Error).message }, "[AniListProxy] mirror threw — falling back to upstream");
    }
  }

  // Resolve an auth token for the upstream request.
  let bearer: string | null = null;
  if (useUserToken) {
    const authHeader = c.req.header("Authorization");
    const supaToken = authHeader?.replace("Bearer ", "");
    const sb = getSupabase();
    if (supaToken && sb) {
      const { data: { user } } = await sb.auth.getUser(supaToken);
      if (user) {
        const profile = await syncService.resolveProfileRow(sb, user.id);
        bearer = profile?.anilist_access_token || null;
      }
    }
    if (!bearer) {
      return c.json(jsonError("AniList account not linked"), 401);
    }
  } else if (env.ANILIST_TOKEN) {
    bearer = env.ANILIST_TOKEN;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  // One deadline includes waiting for the shared limiter and reading the response.
  // Retrying 429 here only increases pressure and outlives the inbound request.
  const requestUpstream = async () => {
    const signal = AbortSignal.timeout(12_000);
    await anilistLimiter.acquire(1, signal);
    const upstream = await fetch(ANILIST_GRAPHQL, {
      method: "POST", headers,
      body: JSON.stringify({ query, variables: variables ?? {} }), signal,
    });
    const text = await upstream.text();
    return { upstream, text };
  };

  if (env.ANILIST_USE_MIRROR && !useUserToken && isNovelCatalogQuery(query, variables ?? {})) {
    try {
      const key = createHash('sha256').update(JSON.stringify([query, variables ?? {}])).digest('hex');
      const result = await novelFallback.query(key, async () => {
        const { upstream, text } = await requestUpstream();
        if (!upstream.ok) throw new Error(`AniList status ${upstream.status}`);
        return JSON.parse(text);
      }, async () => executeMirror(query, variables ?? {}));
      c.header('Cache-Control', 'private, no-store');
      c.header('X-Tatakai-Catalog-Source', result.extensions?.source === 'mirror' ? 'mirror' : 'upstream');
      return c.json(result);
    } catch {
      return c.json(jsonError("Novel catalog temporarily unavailable"), 503);
    }
  }

  try {
    const { upstream, text } = await requestUpstream();
    return new Response(text, { status: upstream.status, headers: { "Content-Type": "application/json" } });
  } catch {
    log.warn("[AniListProxy] Upstream unavailable within request deadline");
    return c.json(jsonError("AniList request failed, please retry shortly"), 502);
  }

});

export { anilistProxyRouter };
