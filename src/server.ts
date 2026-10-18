import {profileImagesRouter} from './routes/profileImages.js';
import { tvPairingRouter } from './routes/tvPairing.js';
import { startTVPairingCleanup } from './services/tvPairingCleanup.js';
import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { env } from "./config/env.js";
import { log } from "./config/logger.js";
import { corsMiddleware } from "./config/cors.js";
import { onError, notFound } from "./config/errorHandler.js";
import { logging } from "./middleware/logging.js";
import { cacheControl } from "./middleware/cacheControl.js";
import { securityHeaders } from "./middleware/securityHeaders.js";
import { requestTimeout } from "./middleware/timeout.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { optionalCatalogAuth } from "./middleware/auth.js";
import { jsonError } from "./lib/envelope.js";
import { contentRouter } from "./routes/content.js";
import { playbackRouter } from "./routes/playback.js";
import { extensionsRouter } from "./routes/extensions.js";
import { countriesRouter } from "./routes/countries.js";
import { providersRouter } from "./routes/providers.js";
import { mangaRouter } from "./routes/manga.js";
import { mappingRouter } from "./routes/mapping.js";
import { proxyRouter } from "./routes/proxy.js";
import { relayRouter } from "./routes/relay.js";
import { syncRouter } from "./routes/sync.js";
import { anilistProxyRouter } from "./routes/anilistProxy.js";
import { adminCountriesRouter } from "./routes/admin/countries.js";
import { adminProvidersRouter } from "./routes/admin/providers.js";
import { adminExtensionsRouter } from "./routes/admin/extensions.js";
import { adminMappingsRouter } from "./routes/admin/mappings.js";
import { adminNewsRouter } from "./routes/admin/news.js";
import { adminContentRouter } from "./routes/admin/content.js";
import { tokoRouter } from "./routes/toko.js";
import { newsRouter } from "./routes/news.js";
import { crashRouter } from "./routes/crash.js";
import { securityRouter } from "./routes/security.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { publicRouter } from "./routes/publicShare.js";
import { ogRouter } from "./routes/og.js";
import { sitemapRouter } from "./routes/sitemap.js";
import { metricsText } from "./lib/metrics.js";
import { cacheReady } from "./lib/cacheStore.js";
import { timingSafeEqual } from "node:crypto";

const app = new Hono();
const stopTVPairingCleanup = startTVPairingCleanup();

app.use(logging);
app.use(securityHeaders);
app.use(corsMiddleware);
// Bound every request: a hung upstream (sidecar down, slow DB) used to hold
// connections forever and exhaust the single Node process. 504s instead.
app.use(requestTimeout);
app.use(bodyLimit({
  maxSize: env.MAX_BODY_BYTES,
  onError: (c) => c.json(jsonError("Payload too large"), 413),
}));
app.use(cacheControl);

app.get("/health", (c) => c.text("ok", 200));
app.get("/health/ready", async (c) => {
  if (shuttingDown || !(await cacheReady())) return c.json({ ready: false }, 503);
  try {
    if (env.SUPABASE_URL) {
      const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/health`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY }, signal: AbortSignal.timeout(2500) });
      if (!response.ok) throw new Error("Auth unavailable");
    }
    if (env.DATABASE_URL) {
      const { prisma } = await import("./mirror/db.js");
      await prisma.$queryRaw`SELECT 1`;
    }
    return c.json({ ready: true });
  } catch { return c.json({ ready: false }, 503); }
});
app.get("/metrics", (c) => {
  const received = Buffer.from(c.req.header("authorization") || "");
  const expected = Buffer.from(`Bearer ${env.METRICS_TOKEN}`);
  if (!env.METRICS_TOKEN || received.length !== expected.length || !timingSafeEqual(received, expected)) return c.text("Unauthorized", 401);
  c.header("Content-Type", "text/plain; version=0.0.4");
  return c.body(metricsText());
});

const v3 = new Hono();
v3.route('/tv/pairing', tvPairingRouter);
v3.use("*", optionalCatalogAuth);
// Generous global bucket across the whole catalog API.
v3.use("*", rateLimit("api", env.RATE_LIMIT_MAX));

// Strict bucket on the outward-facing proxy / GraphQL surfaces (each upstream
// hop is expensive and the most abusable). Runs after the generous bucket.
const strictProxy = rateLimit("proxy", env.RATE_LIMIT_PROXY_MAX);
v3.use("/anilist/*", strictProxy);
v3.use("/toko/*", strictProxy);

v3.route("/images", profileImagesRouter);
v3.route("/content", contentRouter);
v3.route("/manga", mangaRouter);
v3.route("/mapping", mappingRouter);
v3.route("/playback", playbackRouter);
v3.route("/relay", relayRouter);
v3.route("/extensions", extensionsRouter);
v3.route("/countries", countriesRouter);
v3.route("/providers", providersRouter);
v3.route("/sync", syncRouter);
v3.route("/anilist", anilistProxyRouter);
v3.route("/admin/countries", adminCountriesRouter);
v3.route("/admin/providers", adminProvidersRouter);
v3.route("/admin/extensions", adminExtensionsRouter);
v3.route("/admin/mappings", adminMappingsRouter);
v3.route("/admin/news", adminNewsRouter);
v3.route("/admin/content", adminContentRouter);
v3.route("/toko", tokoRouter);
v3.route("/news", newsRouter);
v3.route("/crash", crashRouter);
v3.route("/security", securityRouter);
v3.route("/webhooks", webhooksRouter);

app.route("/api/v3", v3);
app.use("/api/proxy/*", strictProxy);
app.route("/api/proxy", proxyRouter);

// Public share-meta + generated OG cards for social crawlers. No auth (crawlers
// send none); own generous rate-limit bucket. Every read filters to public
// rows and never touches view-count RPCs.
const publicShare = new Hono();
publicShare.use("*", rateLimit("public-share", env.RATE_LIMIT_MAX));
publicShare.route("/public", publicRouter);
publicShare.route("/public", sitemapRouter);
publicShare.route("/og", ogRouter);
app.route("/api", publicShare);

app.notFound(notFound);
app.onError(onError);

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port }, "TatakaiV5 listening");
});

// ---- Graceful shutdown -----------------------------------------------------
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopTVPairingCleanup();
  log.info({ signal }, "shutting down — draining connections");
  const forcedExit = setTimeout(() => process.exit(1), 15_000);
  forcedExit.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    const { prisma } = await import("./mirror/db.js");
    await prisma.$disconnect();
  } catch (err) {
    log.warn({ err: (err as Error).message }, "prisma disconnect failed");
  }
  try {
    const { closeCacheStore } = await import("./lib/cacheStore.js");
    await closeCacheStore();
  } catch (err) {
    log.warn({ err: (err as Error).message }, "cache store close failed");
  }
  log.info("shutdown complete");
  clearTimeout(forcedExit);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

export default app;
