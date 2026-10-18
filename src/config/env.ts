import { cleanEnv, str, port, bool, num } from "envalid";

export const env = cleanEnv(
  process.env,
  {
  NODE_ENV: str({ choices: ["development", "test", "production"], default: "development" }),
  PORT: port({ default: 4001 }),
  /** Supabase project URL */
  SUPABASE_URL: str({ default: "" }),
  /** Service role key — server only */
  SUPABASE_SERVICE_ROLE_KEY: str({ default: "" }),
  /** Optional AniList OAuth token for 90 req/min */
  ANILIST_TOKEN: str({ default: "" }),
  JIKAN_BASE_URL: str({ default: "https://api.jikan.moe/v4" }),
  REDIS_URL: str({ default: "" }),
  REDIS_CONTROL_URL: str({ default: "" }),
  TRUST_PROXY: bool({ default: false }),
  METRICS_TOKEN: str({ default: "" }),
  POSTHOG_KEY: str({ default: "" }),
  POSTHOG_HOST: str({ default: "" }),
  CACHE_MAX_ENTRIES: num({ default: 2000 }),
  REQUEST_LOG_SAMPLE_RATE: num({ default: 0.01 }),
  TURNSTILE_ALLOWED_HOSTNAMES: str({ default: "tatakai.me,www.tatakai.me" }),

  // ---- Mirror (folded-in AniList Postgres cache) --------------------------
  /** Prisma Postgres connection string for the media mirror (remote Timescale). */
  DATABASE_URL: str({ default: "" }),
  /** Real AniList GraphQL endpoint used for fallback + backfill. */
  ANILIST_UPSTREAM_URL: str({ default: "https://graphql.anilist.co" }),
  /** Serve public catalog from the in-process mirror before hitting AniList. */
  ANILIST_USE_MIRROR: bool({ default: true }),
  /** Upper bound on outbound AniList requests/min (mirror's Bottleneck). */
  ANILIST_MAX_RPM: num({ default: 60 }),
  /** Fetch-on-miss against live AniList for exact-id roots. */
  ENABLE_LIVE_FALLBACK: bool({ default: true }),
  /** Background backfill on search/Page misses (follows ENABLE_LIVE_FALLBACK). */
  SEARCH_BACKFILL_ENABLED: bool({ default: true }),
  /** Days a cached media row stays fresh before re-fetch. */
  CACHE_TTL_DAYS: num({ default: 7 }),
  /** Hours a volatile (releasing/upcoming) row stays fresh. */
  VOLATILE_TTL_HOURS: num({ default: 6 }),
  /** Startup refresh loop cadence in minutes (0 = disabled). */
  REFRESH_INTERVAL_MIN: num({ default: 0 }),
  /** How many trending titles the refresh loop re-pulls per cycle. */
  TRENDING_REFRESH_COUNT: num({ default: 100 }),
  /** Cap on airing rows refreshed per cycle. */
  AIRING_REFRESH_LIMIT: num({ default: 5000 }),

  // ---- Inbound hardening --------------------------------------------------
  /** Comma-separated allowed CORS origins; "*" allows any. */
  CORS_ALLOWED_ORIGINS: str({ default: "*" }),
  /** Sliding window (seconds) for per-IP inbound rate limiting. */
  RATE_LIMIT_WINDOW_SEC: num({ default: 60 }),
  /** Max requests per window on the generous /api/v3/* bucket. */
  RATE_LIMIT_MAX: num({ default: 600 }),
  /** Max requests per window on the strict proxy/graphql bucket. */
  RATE_LIMIT_PROXY_MAX: num({ default: 60 }),
  /** Per-request timeout (ms) before a 504 is returned. */
  REQUEST_TIMEOUT_MS: num({ default: 30000 }),
  /** Max inbound body size (bytes) before a 413 is returned. */
  MAX_BODY_BYTES: num({ default: 1_000_000 }),
  /** Admin API secret (X-Admin-Secret header) */
  TATAKAI_ADMIN_API_SECRET: str({ default: "" }),
  /** Cloudflare Turnstile secret key — server-side siteverify. Empty = disabled (verify fails open). */
  TURNSTILE_SECRET_KEY: str({ default: "" }),
  /** If false, catalog routes are public; admin still requires secret */
  REQUIRE_ADMIN_FOR_CATALOG: bool({ default: false }),
  /** Default stale TTL for in-memory cache (seconds) */
  CACHE_DEFAULT_TTL_SEC: num({ default: 300 }),
  RELAY_TICKET_SECRET: str({ default: "" }),
  STREAM_PROXY_URLS: str({ default: "" }),
  STREAM_PROXY_PASSWORD: str({ default: "" }),
  
  // Integrations (AniList / MyAnimeList)
  MAL_CLIENT_ID: str({ default: "" }),
  MAL_CLIENT_SECRET: str({ default: "" }),
  VITE_MAL_CLIENT_ID: str({ default: "" }),
  VITE_MAL_CLIENT_SECRET: str({ default: "" }),
  
  ANILIST_CLIENT_ID: str({ default: "" }),
  ANILIST_CLIENT_SECRET: str({ default: "" }),
  VITE_ANILIST_CLIENT_ID: str({ default: "" }),
  VITE_ANILIST_CLIENT_SECRET: str({ default: "" }),
  VITE_ANILIST_REDIRECT_URI: str({ default: "" }),

  // MangaBaka OAuth (OpenID Connect). Secret stays server-side — never VITE_*.
  MANGABAKA_CLIENT_ID: str({ default: "" }),
  MANGABAKA_CLIENT_SECRET: str({ default: "" }),

  /**
   * Base URL of the running toko-api service (extension/toko/api).
   * When set, TatakaiAPI proxies /toko/sources, /toko/stream, /toko/debug to it.
   * Default: the standard local dev port used by `npm run api` in extension/toko.
   */
  TOKO_API_URL: str({ default: "http://127.0.0.1:8099" }),

  /**
   * Auth id (= profiles.user_id) of the "Tatakai News" bot account whose
   * forum_posts the news ingestion job upserts. Created once by the bot
   * bootstrap (npm run job:news-bootstrap); empty disables ingestion.
   */
  NEWS_BOT_USER_ID: str({ default: "" }),
  /** Contact email for the News bot auth user (bootstrap only). */
  NEWS_BOT_EMAIL: str({ default: "news-bot@tatakai.local" }),

  /**
   * Discord webhook the /api/v3/crash route posts a crash embed to when the
   * desktop app forwards crash metadata. Server-side so the secret is never
   * shipped to clients; empty disables the Discord forward (the crash is still
   * persisted to the crash_reports table).
   */
  CRASH_DISCORD_WEBHOOK: str({ default: "" }),

  /**
   * Per-channel Discord webhooks the /api/v3/webhooks/discord route forwards
   * client-initiated embeds to. Server-side so the URLs are never shipped to
   * clients. Empty disables that channel (the route logs and no-ops). The
   * frontend's discord-webhook.ts maps its `channel` field to one of these:
   *   user_created  → new-account notifications (AuthContext)
   *   error_logs    → client error reports (errorLogger)
   *   comment       → new community comments (useComments)
   *   review_popup  → in-app feedback / suggestions (ReviewPopup, SuggestionsPage)
   *   status        → status-page / uptime notifications
   */
  DISCORD_WEBHOOK_USER_CREATED: str({ default: "" }),
  DISCORD_WEBHOOK_ERROR_LOGS: str({ default: "" }),
  DISCORD_WEBHOOK_COMMENT: str({ default: "" }),
  DISCORD_WEBHOOK_REVIEW_POPUP: str({ default: "" }),
  DISCORD_WEBHOOK_STATUS: str({ default: "" }),

  /**
   * Public origins used to build absolute share URLs. PUBLIC_SITE_ORIGIN is the
   * canonical web app (og:url, canonicalPath base); PUBLIC_API_ORIGIN is this
   * API's own public origin, used to build generated OG-card image URLs
   * (/api/og/*). Both are read by the /api/public/* share endpoints.
   */
  PUBLIC_SITE_ORIGIN: str({ default: "https://tatakai.me" }),
  PUBLIC_API_ORIGIN: str({ default: "https://api.tatakai.me" }),
  },
);

export const hasSupabase =
  Boolean(env.SUPABASE_URL?.trim()) && Boolean(env.SUPABASE_SERVICE_ROLE_KEY?.trim());

/**
 * Fail fast in production: the "" defaults above keep local dev frictionless,
 * but a prod boot with missing secrets should abort loudly rather than serve
 * broken auth / an unreachable mirror.
 */
if (env.NODE_ENV === "production") {
  const required: Array<[string, string]> = [
    ["SUPABASE_URL", env.SUPABASE_URL],
    ["SUPABASE_SERVICE_ROLE_KEY", env.SUPABASE_SERVICE_ROLE_KEY],
    ["DATABASE_URL", env.DATABASE_URL],
    ["TATAKAI_ADMIN_API_SECRET", env.TATAKAI_ADMIN_API_SECRET],
    ["RELAY_TICKET_SECRET", env.RELAY_TICKET_SECRET],
  ];
  const missing = required.filter(([, v]) => !v?.trim()).map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables in production: ${missing.join(", ")}`,
    );
  }
}

