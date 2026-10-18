import type { MiddlewareHandler } from "hono";

export const cacheControl: MiddlewareHandler = async (c, next) => {
  await next();
  const publicPaths = /^\/api\/(?:public\/(?:anime|manga|novel|profile|playlist|sitemap)(?:\/|$)|og\/|v3\/(?:images|content|manga|mapping|countries|providers|news)(?:\/|$))/;
  const privateRequest = !!c.req.header("authorization") || !!c.req.header("cookie");
  if (privateRequest || !publicPaths.test(c.req.path) || c.req.method !== "GET" || c.res.status !== 200 || c.res.headers.has("set-cookie")) {
    c.header("Cache-Control", "private, no-store");
  } else if (!c.res.headers.has("Cache-Control")) {
    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  }
};
