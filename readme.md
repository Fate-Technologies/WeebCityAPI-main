# WeebCity API 🎌

> The official backend API powering Weeb City — an anime and manga catalog service providing metadata aggregation, cross-source ID mapping, account list synchronisation, news, extension integrations, and dynamic Open Graph images.

<p>
  <img alt="Version" src="https://img.shields.io/badge/version-6.0.0-7F03FE" />
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Node.js%20%2B%20Hono-000" />
  <img alt="Data" src="https://img.shields.io/badge/data-Prisma%20%C2%B7%20Postgres%20%C2%B7%20Supabase-3ECF8E" />
  <img alt="License" src="https://img.shields.io/badge/license-Proprietary-red" />
</p>

---

## Overview

**WeebCity API** is the backend service powering the Weeb City platform. It integrates metadata from **AniList** and **Jikan (MyAnimeList)**, using a PostgreSQL media mirror, caching, live fallbacks, and background processing to deliver reliable catalog data.

The API provides services for anime and manga metadata, cross-source ID mappings, account list synchronisation, news ingestion, extension integrations, playback-related functionality, telemetry, and dynamic social-sharing images.

WeebCity API is designed to support the Weeb City ecosystem. Access to the source code and use of the software are subject to the terms established by Fate Technologies.

**Content policy:** WeebCity API does not itself host anime or manga video content. Metadata and related functionality may rely on third-party services, while playback integrations may use separately configured sources.

---

## Features

- **Anime catalog:** Metadata aggregation from AniList and Jikan.
- **PostgreSQL media mirror:** Locally stored catalog data with freshness checks, fetch-on-miss, and background updates.
- **Manga services:** Manga metadata, cross-source ID mapping, and chapter hierarchy merging.
- **Account synchronisation:** MyAnimeList and AniList list integration, including preview, import, export, and progress synchronisation where configured.
- **Extension integrations:** Extension manifests and related service endpoints.
- **News ingestion:** RSS-based news collection and integration with a configured bot account.
- **Airing reminders:** Background jobs for airing-related notifications.
- **Dynamic Open Graph images:** Generated share cards for supported pages.
- **Caching:** Redis and in-memory caching strategies.
- **Security controls:** Configurable rate limits, request timeouts, body-size limits, CORS restrictions, and administrative authentication.
- **Monitoring and telemetry:** Logging, crash reporting, and operational endpoints.

---

## Technology Stack

| Layer                               | Technology                   |
| ----------------------------------- | ---------------------------- |
| HTTP framework                      | Hono and `@hono/node-server` |
| Language                            | TypeScript (ES modules)      |
| Runtime                             | Node.js                      |
| Database ORM                        | Prisma                       |
| Database                            | PostgreSQL                   |
| Authentication and application data | Supabase                     |
| Caching                             | Redis and in-memory caching  |
| GraphQL                             | Pothos and GraphQL           |
| Rate limiting                       | Bottleneck                   |
| Image generation                    | Satori and resvg             |
| Validation                          | Zod and Envalid              |
| Logging                             | Pino and Pino Pretty         |

---

## Project Structure

```text
src/
├── config/       # Environment configuration and logging
├── lib/          # Shared utilities, cache, Supabase, and responses
├── middleware/   # Authentication, rate limiting, and security
├── mirror/       # AniList-compatible catalog mirror
├── providers/    # AniList and Jikan integrations
├── routes/       # API endpoints and administrative routes
├── services/     # Catalog, mapping, news, and synchronisation
├── jobs/         # Background processing and refresh workers
└── types/        # Shared TypeScript types

prisma/           # Prisma schema
scripts/          # Database, import, scraping, and refresh utilities
tests/            # Automated tests
```

---

## API Overview

The API includes endpoints for the following areas:

| Area                    | Functionality                                                        |
| ----------------------- | -------------------------------------------------------------------- |
| Catalog                 | Anime metadata, countries, and providers                             |
| Manga                   | Manga catalog and ID mapping                                         |
| Account synchronisation | MyAnimeList and AniList integrations                                 |
| Extensions              | Extension registry and related integrations                          |
| Sharing                 | Public share functionality and Open Graph images                     |
| Proxy and relay         | Configured proxy and relay services                                  |
| Telemetry               | Crash reporting and security-related endpoints                       |
| News                    | News collection and delivery                                         |
| Administration          | Protected catalog, mapping, extension, news, and provider management |
| Pairing                 | TV pairing and related functionality                                 |

The exact routes and available functionality depend on the deployed API version and configuration.

---

## Getting Started

### Prerequisites

- Node.js 20 or later
- npm
- A PostgreSQL database
- A configured Supabase project
- Redis, if using Redis-backed caching
- Credentials for any third-party integrations you enable

### Installation

Clone the repository using an account authorised by Fate Technologies:

```bash
git clone https://github.com/Fate-Technologies/WeebCityAPI-main.git
cd WeebCityAPI-main
```

Install dependencies:

```bash
npm install
```

Configure the environment variables described below. Then generate the Prisma client:

```bash
npm run prisma:generate
```

Start the development server:

```bash
npm run dev
```

The development server is configured to use port `4001` by default, unless overridden by the application configuration.

### Production

Build the application:

```bash
npm run build
```

Start the production server:

```bash
npm start
```

Refer to the deployment configuration and package scripts for the required production setup.

**Windows note:** Stop the development server before running the build if Prisma reports that its Windows query-engine DLL is locked.

---

## Environment Configuration

Create a local `.env` file containing the credentials and settings required by your deployment.

**Never commit `.env` files, production credentials, private keys, or API secrets to Git.**

The following variables are referenced by the application configuration and integrations:

| Variable                                      | Purpose                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `PORT`                                        | HTTP server port                                                         |
| `SUPABASE_URL`                                | Supabase project URL                                                     |
| `SUPABASE_SERVICE_ROLE_KEY`                   | Server-side Supabase service-role credential                             |
| `DATABASE_URL`                                | PostgreSQL connection string                                             |
| `ANILIST_TOKEN`                               | Optional AniList API token                                               |
| `ANILIST_USE_MIRROR`                          | Controls catalog mirror usage                                            |
| `ENABLE_LIVE_FALLBACK`                        | Controls live metadata fallbacks                                         |
| `REDIS_URL`                                   | Optional Redis connection                                                |
| `CORS_ALLOWED_ORIGINS`                        | Allowed request origins                                                  |
| `RATE_LIMIT_*`                                | Rate-limiting configuration                                              |
| `REQUEST_TIMEOUT_MS`                          | Request timeout                                                          |
| `MAX_BODY_BYTES`                              | Maximum request body size                                                |
| `TATAKAI_ADMIN_API_SECRET`                    | Legacy-named administrative secret, if still required by the application |
| `TURNSTILE_SECRET_KEY`                        | Cloudflare Turnstile verification                                        |
| `MAL_CLIENT_ID` / `MAL_CLIENT_SECRET`         | MyAnimeList OAuth credentials                                            |
| `ANILIST_CLIENT_ID` / `ANILIST_CLIENT_SECRET` | AniList OAuth credentials                                                |
| `TOKO_API_URL`                                | Toko integration base URL                                                |
| `NEWS_BOT_USER_ID` / `NEWS_BOT_EMAIL`         | News ingestion bot configuration                                         |
| `CRASH_DISCORD_WEBHOOK`                       | Optional crash-report webhook                                            |
| `PUBLIC_SITE_ORIGIN` / `PUBLIC_API_ORIGIN`    | Public site and API origins                                              |
| `RELAY_TICKET_SECRET`                         | Relay ticket signing secret, if required                                 |

This list is based on the existing project documentation and should be checked against the current source code before deployment. Some variables may be optional depending on the enabled features.

---

## Background Jobs

The project includes scripts for background processing, such as catalog ingestion, feed refreshes, ID mapping, news ingestion, and airing reminders.

Where configured, these jobs can be run using the corresponding npm scripts:

```bash
npm run job:ingest
npm run job:feeds
npm run job:mappings
npm run job:news
npm run job:news-bootstrap
npm run job:airing
```

Check `package.json` for the currently supported script names before running them.

---

## Security

WeebCity API is intended to run in a controlled server environment.

- Store secrets in environment variables or an appropriate secrets manager.
- Keep administrative endpoints protected.
- Restrict CORS to trusted origins where possible.
- Configure appropriate rate limits and request timeouts.
- Use HTTPS for production traffic.
- Keep Node.js and dependencies updated.
- Do not expose database credentials or service-role keys to frontend clients.
- Review third-party API terms before enabling integrations.

---

## Third-Party Services and Attribution

WeebCity API may integrate with third-party services, including AniList, Jikan, MyAnimeList, Supabase, and other configured providers.

Weeb City and Fate Technologies are independent projects and are not necessarily affiliated with, endorsed by, or sponsored by these services. Third-party names, logos, APIs, and content remain subject to their respective owners' rights and terms.

---

## Legal Notice

**WeebCity API is proprietary software owned or controlled by Fate Technologies, subject to applicable third-party rights and licences.**

- The source code is not offered under an open-source licence.
- Access to the repository does not grant permission to redistribute, publish, resell, sublicense, or commercially exploit the software.
- Modification, deployment, and integration rights require appropriate authorisation from Fate Technologies.
- Third-party services and metadata remain subject to their respective terms, licences, and usage restrictions.
- Operators are responsible for ensuring that their deployment complies with applicable laws and third-party service requirements.

Nothing in this notice claims ownership of third-party content or intellectual property.

For licensing, commercial use, or permission requests, contact Fate Technologies through its official communication channels.

---

## Contact and Support

For WeebCity API support, licensing enquiries, or business enquiries, contact Fate Technologies through its official channels.

**GitHub repository:** [Fate-Technologies/WeebCityAPI-main](https://github.com/Fate-Technologies/WeebCityAPI-main)

---

## Copyright

Copyright © Fate Technologies. All rights reserved.

Unless expressly authorised in writing, no permission is granted to copy, redistribute, modify, sublicense, or commercially exploit this software.
