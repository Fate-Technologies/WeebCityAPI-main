import { Hono } from "hono";
import { env } from "../config/env.js";
import { ProxyBalancer } from "../lib/proxyBalancer.js";

// No dead default: when STREAM_PROXY_URLS is unset the balancer would spend
// 9s timing out against a localhost nobody runs before falling back to direct.
// Empty => hasNodes is false => direct fetch immediately (fastest path).
const configuredProxyUrls = (env.STREAM_PROXY_URLS || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean)
  .filter((v) => !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?\//i.test(v) || process.env.ALLOW_LOCAL_PROXY === '1');
const balancer = new ProxyBalancer(configuredProxyUrls);
const proxyRouter = new Hono();

const DEFAULT_REFERER = "https://megacloud.club/";
const RAW_GITHUB_HOSTS = new Set([
  "raw.githubusercontent.com",
  "raw.github.com",
  "gist.githubusercontent.com",
  "cdn.jsdelivr.net",
  "github.com",
  // GitHub release asset hosts (required for following release download redirects)
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

// Host allowlist for /api/proxy/extension — extension bundle downloads
// Uses env var EXTENSION_DOWNLOAD_HOSTS (comma-separated, supports exact hosts only)
// Default: known marketplace origins + GitHub release service + GitHub raw hosts
const DEFAULT_EXTENSION_HOSTS = [
  "pjhzenlefvoamckbptjt.supabase.co",
  "images.unsplash.com",
  "avatars.githubusercontent.com",
];
const EXTENSION_DOWNLOAD_HOSTS = (() => {
  const env = process.env.EXTENSION_DOWNLOAD_HOSTS || "";
  const hosts = new Set(RAW_GITHUB_HOSTS);
  for (const h of DEFAULT_EXTENSION_HOSTS) {
    hosts.add(h);
  }
  if (env) {
    for (const h of env.split(",")) {
      const trimmed = h.trim();
      if (trimmed) hosts.add(trimmed);
    }
  }
  return hosts;
})();

const resolveUrl = (target: string, base: string) => {
  try { return new URL(target, base).toString(); } catch { return target; }
};

const isAllowedRawGithubUrl = (value: string) => {
  try {
    const url = new URL(value);
    return RAW_GITHUB_HOSTS.has(url.hostname.toLowerCase()) && (url.protocol === "https:" || url.protocol === "http:");
  } catch {
    return false;
  }
};

const isAllowedExtensionDownload = (value: string) => {
  try {
    const url = new URL(value);
    return EXTENSION_DOWNLOAD_HOSTS.has(url.hostname.toLowerCase()) && (url.protocol === "https:" || url.protocol === "http:");
  } catch {
    return false;
  }
};

// Host allowlist for /api/proxy/json — small public JSON APIs the renderer would
// otherwise hit cross-origin (waifu.im / nekosia.cat / nekos.best return
// 403/CORS from browsers). Proxying server-side keeps the live image and stops
// the console spam. Kept tight on purpose: this is not a general-purpose open
// proxy.
const JSON_PROXY_HOSTS = new Set([
  "api.mangadex.org",
  "api.waifu.im",
  "api.nekosia.cat",
  "nekos.best",
]);

const isAllowedJsonProxy = (value: string) => {
  try {
    const url = new URL(value);
    return JSON_PROXY_HOSTS.has(url.hostname.toLowerCase()) && url.protocol === "https:";
  } catch {
    return false;
  }
};

const copyProxyHeaders = (upstream: Response, extra: Record<string, string> = {}) => {
  const headers = new Headers(extra);
  const headerNames = ["content-type", "content-range", "accept-ranges", "content-length", "etag", "last-modified"];

  for (const headerName of headerNames) {
    // Node fetch decompresses the body but retains the upstream compressed
    // length. Sending that length with decoded bytes truncates JSON/packages.
    if (headerName === "content-length" && upstream.headers.has("content-encoding")) continue;
    const value = upstream.headers.get(headerName);
    if (value) headers.set(headerName, value);
  }

  return headers;
};

const rewritePlaylistUrls = (
  playlistText: string,
  baseUrl: string,
  proxyEndpointPath: string,
  referer: string,
  userAgent?: string,
  proxyPassword?: string,
) => {
  return playlistText.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    const rewrite = (targetUrl: string) => {
      const resolved = resolveUrl(targetUrl, baseUrl);
      const params = new URLSearchParams({ url: resolved });
      if (referer) params.set("referer", referer);
      if (userAgent) params.set("userAgent", userAgent);
      if (proxyPassword) params.set("password", proxyPassword);
      params.set("type", "video");
      return `${proxyEndpointPath}?${params.toString()}`;
    };

    if (trimmed.startsWith("#")) {
      return trimmed.replace(/URI="([^"]+)"/g, (_m, p1) => `URI="${rewrite(p1)}"`);
    }

    return rewrite(trimmed);
  }).join("\n");
};

proxyRouter.get("/status", (c) => {
  return c.json({ success: true, nodes: balancer.getStats() });
});

proxyRouter.get("/m3u8-streaming-proxy", async (c) => {
  const targetUrl = String(c.req.query("url") || "").trim();
  if (!targetUrl) return c.json({ success: false, message: "Missing url query param" }, 400);

  const referer = String(c.req.query("referer") || DEFAULT_REFERER).trim();
  const userAgent = String(c.req.query("userAgent") || "").trim() ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    Referer: referer,
    Accept: "*/*",
    // Ask for raw bytes so content-length / content-range stay truthful
    // through the relay (a gzipped byte-range breaks hls.js seeks).
    "Accept-Encoding": "identity",
  };
  // Forward the player's byte-range so MP4 seeks and HLS byte-range segments
  // work through the relay (previously dropped => seeks stalled/retried).
  const range = c.req.header("range") || c.req.header("Range");
  if (range) headers.Range = range;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let upstream: Response;
  try {
    upstream = balancer.hasNodes
      ? await balancer.fetch(targetUrl, { method: "GET", headers, signal: controller.signal }, 7000, {
          referer,
          userAgent,
          type: "video",
          password: env.STREAM_PROXY_PASSWORD,
        })
      : await fetch(targetUrl, { method: "GET", headers, signal: controller.signal });
  } catch (error) {
    clearTimeout(timeout);
    return c.json({ success: false, message: (error as Error).message }, 502);
  }
  clearTimeout(timeout);

  const contentType = upstream.headers.get("content-type") || "";
  const isPlaylist = contentType.includes("mpegurl") || targetUrl.includes(".m3u8");

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
  };

  if (isPlaylist) {
    const playlist = await upstream.text();
    const rewritten = rewritePlaylistUrls(
      playlist,
      targetUrl,
      "/api/proxy/m3u8-streaming-proxy",
      referer,
      userAgent,
      env.STREAM_PROXY_PASSWORD,
    );

    return new Response(rewritten, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "application/vnd.apple.mpegurl",
        // VOD playlists are static for seconds: short edge cache cuts manifest
        // latency without staleness (was no-store => every manifest refetched).
        "Cache-Control": "public, max-age=2",
      },
    });
  }

  // Segments / progressive: stream through with range headers preserved and
  // immutable segments edge-cached (was no-store + dropped range headers).
  return new Response(upstream.body, {
    status: upstream.status,
    headers: copyProxyHeaders(upstream, {
      ...cors,
      "Content-Type": contentType || "application/octet-stream",
      "Cache-Control": upstream.status === 206 || range
        ? "private, max-age=0, no-store"
        : "public, max-age=86400",
    }),
  });
});

proxyRouter.get("/subtitle", async (c) => {
  const targetUrl = String(c.req.query("url") || "").trim();
  if (!targetUrl) return c.json({ success: false, message: "Missing url query param" }, 400);

  // Only allow http/https URLs
  if (!/^https?:\/\//i.test(targetUrl)) {
    return c.json({ success: false, message: "Only http/https URLs are allowed" }, 400);
  }

  const referer = String(c.req.query("referer") || DEFAULT_REFERER).trim();
  const userAgent = String(c.req.query("userAgent") || "").trim() ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    "Referer": referer,
    "Accept": "text/vtt, text/plain, text/x-ass, application/octet-stream, */*",
  };

  let upstream: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    upstream = await fetch(targetUrl, { method: "GET", headers, signal: controller.signal });
    clearTimeout(timeout);
  } catch (error) {
    return c.json({ success: false, message: (error as Error).message }, 502);
  }

  if (!upstream.ok) {
    return c.json({ success: false, message: `Upstream error: ${upstream.status}` }, upstream.status as any);
  }

  const upstreamContentType = upstream.headers.get("content-type") || "";
  let contentType = upstreamContentType;
  if (!contentType || contentType.includes("octet-stream")) {
    if (targetUrl.includes(".vtt")) contentType = "text/vtt; charset=utf-8";
    else if (targetUrl.includes(".ass") || targetUrl.includes(".ssa")) contentType = "text/plain; charset=utf-8";
    else if (targetUrl.includes(".srt")) contentType = "text/plain; charset=utf-8";
    else contentType = "text/plain; charset=utf-8";
  }

  const body = await upstream.arrayBuffer();

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600",
      "Content-Length": String(body.byteLength),
    },
  });
});

proxyRouter.get("/raw", async (c) => {
  const targetUrl = String(c.req.query("url") || "").trim();
  if (!targetUrl) return c.json({ success: false, message: "Missing url query param" }, 400);
  if (!isAllowedRawGithubUrl(targetUrl)) {
    return c.json({ success: false, message: "Only raw GitHub URLs are allowed" }, 400);
  }

  const range = String(c.req.header("range") || c.req.header("Range") || "").trim();
  const headers: Record<string, string> = {
    Accept: "*/*",
  };

  if (range) headers.Range = range;

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, { method: "GET", headers });
  } catch (error) {
    return c.json({ success: false, message: (error as Error).message }, 502);
  }

  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  const responseHeaders = copyProxyHeaders(upstream, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
});

proxyRouter.get("/extension", async (c) => {
  const targetUrl = String(c.req.query("url") || "").trim();
  if (!targetUrl) {
    return c.json({ success: false, message: "Missing url query param" }, 400);
  }

  if (!isAllowedExtensionDownload(targetUrl)) {
    return c.json({ success: false, message: "Host not allowed for extension downloads" }, 400);
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: "GET",
      headers: { Accept: "*/*" },
      redirect: "follow",
    });
  } catch (error) {
    return c.json({ success: false, message: (error as Error).message }, 502);
  }

  if (!upstream.ok) {
    return c.json({ success: false, message: `Upstream error: ${upstream.status}` }, upstream.status as any);
  }

  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  const responseHeaders = copyProxyHeaders(upstream, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Extension-Download": "true",
  });

  return new Response(upstream.body, { status: 200, headers: responseHeaders });
});

// GET /api/proxy/json?url=... — server-side passthrough for a tight allowlist of
// public JSON APIs (waifu.im / nekosia.cat). The desktop renderer's direct
// cross-origin fetches to these get blocked (403/CORS) and spam the console;
// proxying moves the request server-side and returns the JSON with a permissive
// CORS header so the renderer can read it. Not a general-purpose open proxy.
proxyRouter.get("/json", async (c) => {
  const targetUrl = String(c.req.query("url") || "").trim();
  if (!targetUrl) return c.json({ success: false, message: "Missing url query param" }, 400);
  if (!isAllowedJsonProxy(targetUrl)) {
    return c.json({ success: false, message: "Host not allowed for JSON proxy" }, 400);
  }

  let upstream: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    upstream = await fetch(targetUrl, {
      method: "GET",
      headers: {
        Accept: "application/json, */*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (error) {
    return c.json({ success: false, message: (error as Error).message }, 502);
  }

  if (!upstream.ok) {
    return c.json({ success: false, message: `Upstream error: ${upstream.status}` }, upstream.status as any);
  }

  const body = await upstream.text();
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// Fixed read-only MangaUpdates operations, including their POST search API.
proxyRouter.get('/mangaupdates', async c => {
  const operation = c.req.query('operation');
  const id = c.req.query('id') || '';
  const title = (c.req.query('title') || '').trim().slice(0, 200);
  const page = Math.min(100, Math.max(1, Number(c.req.query('page')) || 1));
  if (!['series', 'search', 'releases'].includes(operation || '') ||
      (operation !== 'search' && !/^\d{1,16}$/.test(id)) || (operation === 'search' && !title)) {
    return c.json({success:false,message:'Invalid MangaUpdates request'},400);
  }
  const path = operation === 'series' ? `/series/${id}` : operation === 'search' ? '/series/search' : '/releases/search';
  const body = operation === 'search' ? {search:title,perpage:25} : {search:id,search_type:'series',page,perpage:100,orderby:'date',asc:'desc',include_metadata:true};
  try {
    const response = await fetch(`https://api.mangaupdates.com/v1${path}`, {
      method:operation === 'series' ? 'GET' : 'POST',
      headers:{'Content-Type':'application/json','User-Agent':'Tatakai/6 (https://tatakai.me)'},
      ...(operation === 'series' ? {} : {body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000),redirect:'error',
    });
    if (!response.ok) return c.json({success:false,message:`MangaUpdates HTTP ${response.status}`},502);
    return c.json(await response.json());
  } catch { return c.json({success:false,message:'MangaUpdates could not be reached'},502); }
});

export { proxyRouter };
