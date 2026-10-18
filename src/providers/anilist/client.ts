import { env } from "../../config/env.js";
import { log } from "../../config/logger.js";
import { anilistLimiter } from "../../lib/rateLimiter.js";
import { executeMirror } from "../../mirror/execute.js";
import type { AniListMedia, AniListPage } from "./types.js";

/** Real AniList endpoint — used for account-scoped ops and mirror fallback. */
const UPSTREAM = env.ANILIST_UPSTREAM_URL || "https://graphql.anilist.co";

/**
 * Upper bound for a single upstream round trip. Without this, a hung AniList
 * socket holds the request until the 30s request-timeout middleware fires —
 * and since callers fan out several queries, one stuck socket could sink the
 * whole bundle. Callers already degrade per-source, so fail fast instead.
 */
const UPSTREAM_TIMEOUT_MS = 12_000;

export interface QueryOptions {
  /** Skip the in-process mirror and hit real AniList directly (account-scoped ops). */
  forceUpstream?: boolean;
  /**
   * When set, emit structured `[anilist-resolve]` diagnostics tagged with this
   * label so a specific lookup (e.g. media-by-id) can be traced through the
   * mirror-vs-upstream decision. Off by default to keep logs quiet.
   */
  diag?: string;
}

export class AniListClient {
  async query<T>(
    query: string,
    variables?: Record<string, unknown>,
    opts: QueryOptions = {},
  ): Promise<T> {
    const diag = opts.diag;
    // Mirror-first for public catalog reads. On throw or GraphQL errors we fall
    // back to upstream; a valid-but-empty result is NOT a failure (returning it
    // avoids hammering AniList for legitimately empty pages).
    if (env.ANILIST_USE_MIRROR && !opts.forceUpstream) {
      try {
        const res = await executeMirror<T>(query, variables);
        if (!res.errors?.length && res.data != null) {
          if (diag) {
            log.info({ diag, source: "mirror", event: "anilist-resolve" }, "[anilist-resolve] mirror hit");
          }
          return res.data as T;
        }
        if (diag) {
          log.warn(
            {
              diag,
              source: "mirror",
              event: "anilist-resolve",
              errs: res.errors?.map((e) => e.message).slice(0, 3),
              dataNull: res.data == null,
            },
            "[anilist-resolve] mirror miss/error — falling back to upstream AniList",
          );
        } else {
          log.debug(
            { errs: res.errors?.map((e) => e.message).slice(0, 3) },
            "mirror miss/error — falling back to upstream AniList",
          );
        }
      } catch (err) {
        if (diag) {
          log.warn(
            { diag, source: "mirror", event: "anilist-resolve", err: (err as Error).message },
            "[anilist-resolve] mirror threw — falling back to upstream AniList",
          );
        } else {
          log.debug({ err: (err as Error).message }, "mirror threw — falling back to upstream AniList");
        }
      }
    } else if (diag && opts.forceUpstream) {
      log.info({ diag, source: "upstream", event: "anilist-resolve", forced: true }, "[anilist-resolve] forced upstream");
    }

    const data = await this.queryUpstream<T>(query, variables);
    if (diag) {
      log.info({ diag, source: "upstream", event: "anilist-resolve" }, "[anilist-resolve] upstream hit");
    }
    return data;
  }

  /** The original live-AniList path: outbound limiter + optional token + one 429 retry. */
  private async queryUpstream<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    await anilistLimiter.acquire(1, signal);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const token = env.ANILIST_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;

    let res = await fetch(UPSTREAM, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      signal,
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const delayMs = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 3000) : 1000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await anilistLimiter.acquire(1, signal);
      res = await fetch(UPSTREAM, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
        signal,
      });
    }

    const json = (await res.json()) as {
      data?: T;
      errors?: { message: string }[];
    };

    if (!res.ok || json.errors?.length) {
      const msg = json.errors?.map((e) => e.message).join("; ") || res.statusText;
      log.warn({ msg, status: res.status }, "AniList GraphQL error");
      throw new Error(msg || "AniList request failed");
    }
    if (!json.data) throw new Error("AniList empty response");
    return json.data;
  }

  async pageMedia(
    variables: Record<string, unknown>,
    document: string,
    opts: QueryOptions = {},
  ): Promise<AniListPage<AniListMedia>> {
    const data = await this.query<{ Page: AniListPage<AniListMedia> }>(document, variables, opts);
    return data.Page;
  }
}

export const anilistClient = new AniListClient();
