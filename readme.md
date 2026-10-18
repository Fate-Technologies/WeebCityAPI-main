# Tatakai API 🎌

> Unified anime & manga **catalog** API powering the Tatakai V6 platform — AniList + Jikan metadata behind a self-healing Postgres mirror, extension manifests, cross-source id mapping, MAL/AniList list sync, news, and dynamic OG images.

<p>
  <img alt="version" src="https://img.shields.io/badge/version-6.0.0-6C5CE7" />
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Node%20%2B%20Hono-000" />
  <img alt="data" src="https://img.shields.io/badge/data-Prisma%20%C2%B7%20Supabase%20%C2%B7%20Redis-3ECF8E" />
  <img alt="license" src="https://img.shields.io/badge/license-MPL--2.0-orange" />
</p>

---

## Overview

Tatakai API (`@tatakai/api-v3`) is the backend catalog service for the Tatakai
V6 otaku-community app. It aggregates public metadata from **AniList** and
**Jikan (MyAnimeList)** into a folded-in Postgres **mirror**, then serves it
through a cache + live-fallback + background-backfill pipeline so clients stay
fast without hammering the upstream APIs.

It **does not host or scrape streaming content** — playback sources come from
user-installed extensions. This service handles metadata, id-mappings, account
list-sync, news, telemetry and share images only.

---

## What's new in V6

- **Prisma + Postgres media mirror** — AniList catalog cached locally with TTL
  freshness, fetch-on-miss and background backfill (`ANILIST_USE_MIRROR`).
- **MAL / AniList list sync** — OAuth exchange, preview diff, apply, and
  realtime single-item progress sync under `/api/v3/sync/*`, with unified
  anime + manga proposals.
- **Manga id-mapping + chapter-hierarchy merge** across multiple sources.
- **News ingestion** (RSS → forum bot account) and **airing-reminder** jobs.
- **Dynamic OG share cards** rendered with Satori + resvg (`/api/og/*`).
- **Inbound hardening** — per-IP rate limits, request timeouts, body-size caps,
  CORS allow-list, Cloudflare Turnstile verification, and a Supabase-JWT admin
  gate.

---

## Tech stack

| Layer | Tooling |
| --- | --- |
| HTTP | [Hono](https://hono.dev) on `@hono/node-server` |
| Language | TypeScript (ESM); `tsx` for dev/watch |
| Catalog data | **Prisma** ORM over Postgres (media mirror) |
| App data / auth | **Supabase** (service-role, server-side) |
| Cache | Redis via `ioredis` + in-memory stale-while-revalidate |
| GraphQL mirror | `@pothos/core` + `graphql` (AniList-compatible) |
| Rate limiting | `bottleneck` (shared AniList token bucket) |
| Images | `satori` + `@resvg/resvg-js` (OG cards) |
| Validation | `zod`, `envalid` |
| Logging | `pino` / `pino-pretty` |

---

## Project structure

```
src/
├── config/       # env (envalid) + logger
├── lib/          # supabase client, response envelope, rate limiter, cache
├── middleware/   # auth gates (Supabase admin, optional catalog auth)
├── mirror/       # AniList Postgres mirror (schema + resolvers)
├── providers/    # anilist + jikan upstream adapters
├── routes/       # HTTP endpoints (+ routes/admin/*)
├── services/     # integration sync, id-mapping, news
├── jobs/         # background workers (ingest, feeds, mappings, news, airing)
└── types/        # shared types
prisma/           # schema.prisma + migrations
scripts/          # db / import / scrape / refresh CLIs
```

---

## API surface

Base path: `/api/v3` — live docs at [api.tatakai.me/docs](http://api.tatakai.me/docs).

| Area | Routes |
| --- | --- |
| Catalog | `content`, `countries`, `providers` |
| Manga | `manga`, `mapping` |
| Account sync | `sync` (MAL/AniList import·export·preview·apply), `playback` |
| Extensions | `extensions`, `toko` |
| Sharing | `publicShare`, `og` |
| Proxy / relay | `proxy`, `anilistProxy`, `relay` |
| Telemetry | `crash`, `security` |
| News | `news` |
| Admin | `admin/{content,countries,extensions,mappings,news,providers}` |

---

## Getting started

**Prerequisites:** Node.js 20+, a Postgres database (the mirror) and a Supabase
project.

```bash
# 1. install (runs `prisma generate` on postinstall)
npm install

# 2. configure — create .env and fill in your own secrets (see below)

# 3. generate the Prisma client
npm run prisma:generate

# 4. run in watch mode → http://localhost:4001
npm run dev
```

Production:

```bash
npm run build     # prisma generate && tsc
npm start         # node dist/server.js
```

> **Windows note:** stop the `tsx watch` dev server before `npm run build` — a
> running server keeps the Prisma query-engine DLL locked and `prisma generate`
> fails with `EPERM … query_engine-windows.dll.node`.

---

## Environment variables

Secrets live in `.env`, which is **git-ignored — never commit it**. Key vars:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default `4001`) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase server client |
| `DATABASE_URL` | Postgres connection for the Prisma media mirror |
| `ANILIST_TOKEN` | Optional AniList OAuth token (higher rate limit) |
| `ANILIST_USE_MIRROR` / `ENABLE_LIVE_FALLBACK` | Mirror + fetch-on-miss toggles |
| `REDIS_URL` | Redis cache (optional) |
| `CORS_ALLOWED_ORIGINS` | Comma-separated CORS allow-list (`*` = any) |
| `RATE_LIMIT_*` / `REQUEST_TIMEOUT_MS` / `MAX_BODY_BYTES` | Inbound hardening |
| `TATAKAI_ADMIN_API_SECRET` | Admin API secret |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile siteverify |
| `MAL_CLIENT_ID` / `MAL_CLIENT_SECRET` | MyAnimeList OAuth |
| `ANILIST_CLIENT_ID` / `ANILIST_CLIENT_SECRET` | AniList OAuth |
| `TOKO_API_URL` | Toko extension streaming-service base URL |
| `NEWS_BOT_USER_ID` / `NEWS_BOT_EMAIL` | News-ingestion bot account |
| `CRASH_DISCORD_WEBHOOK` | Crash-report Discord forward |
| `PUBLIC_SITE_ORIGIN` / `PUBLIC_API_ORIGIN` | Absolute share / OG URLs |

Production boot **fails fast** if `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`DATABASE_URL`, `TATAKAI_ADMIN_API_SECRET` or `RELAY_TICKET_SECRET` are unset.

---

## Background jobs

```bash
npm run job:ingest          # media ingestion worker
npm run job:feeds           # content / feed refresh
npm run job:mappings        # id-mapping refresh
npm run job:news            # news RSS ingestion
npm run job:news-bootstrap  # create the News bot account (one-time)
npm run job:airing          # airing-schedule reminders
```

---

## Social

> **Discord**: [https://dsc.gg/tatakai](https://dsc.gg/tatakai)

### Disclaimer
- No other social media handles are available right now. If you see any, please report us. We only have a **Discord server**.
- If you are using our **project to create your own project**, you must:
  - **Open-source** your project
  - **Give credit** to me
  - You **cannot sell** this project under the guise of modification, as it is licensed under the
    `Mozilla Public License Version 2.0`.

---

## Legal / DMCA

- We **DO NOT** host any anime content on our servers
- We **DO NOT** own any of the anime content displayed
- All content is sourced from third-party platforms via public APIs and user-installed extensions
- We are merely a frontend interface demonstrating technical capabilities
- This is a **non-commercial, educational project**

> *Need contact?* [Click Here](mailto:snozxyx@gmail.com)

---

## Note 🚨

- This project is directly connected with the [Tatakai](https://github.com/snozxyx/tatakai) project. Therefore, I do **not** recommend using this independently. Use the main project instead. I am one of the head maintainers at **CoorenLabs**:
  - **GitHub**: [https://github.com/coorenlabs/cooren](https://github.com/coorenlabs/cooren)
  - *(Make sure to ⭐ the project!)*
  - For scraping logic, [Toko](https://github.com/snozxyx/toko) is the official unified extension.

---

## API

[http://api.tatakai.me/docs](http://api.tatakai.me/docs)

---

## License

Licensed under the **Mozilla Public License 2.0 (MPL-2.0)**.




