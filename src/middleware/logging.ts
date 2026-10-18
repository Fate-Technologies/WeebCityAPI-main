import type { MiddlewareHandler } from "hono";
import { log } from "../config/logger.js";
import { env } from "../config/env.js";
import { recordRequest } from "../lib/metrics.js";
import { captureApiTiming } from "../lib/posthog.js";

export const logging: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  recordRequest(c.req.routePath || "unmatched", ms / 1000, c.res.status);
  captureApiTiming(c.req.routePath || "unmatched", ms / 1000, c.res.status);
  const reqId = c.res.headers.get("x-request-id") ?? undefined;
  if (c.res.status >= 400 || ms > 1000 || Math.random() < env.REQUEST_LOG_SAMPLE_RATE) {
    log.info({ reqId, method: c.req.method, route: c.req.routePath || "unmatched", status: c.res.status, ms });
  }
};
