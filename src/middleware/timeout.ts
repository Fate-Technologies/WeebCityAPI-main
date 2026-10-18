import type { MiddlewareHandler } from "hono";
import { env } from "../config/env.js";
import { jsonError } from "../lib/envelope.js";
import { log } from "../config/logger.js";

/**
 * Fail a request with 504 if the handler runs past REQUEST_TIMEOUT_MS. The slow
 * work can't be cancelled (no AbortController plumbed through the handlers), so
 * it continues in the background — this only bounds the client's wait.
 */
export const requestTimeout: MiddlewareHandler = async (c, next) => {
  const ms = env.REQUEST_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((resolve) => {
    timer = setTimeout(() => {
      log.warn({ path: c.req.path, ms }, "request timed out");
      resolve(c.json(jsonError("Request timed out"), 504));
    }, ms);
  });
  try {
    return await Promise.race([
      (async () => {
        await next();
        return c.res;
      })(),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
