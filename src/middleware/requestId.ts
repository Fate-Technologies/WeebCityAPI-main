import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";

/**
 * Attach a request id (honouring an inbound `x-request-id` from a proxy/LB, else
 * a fresh UUID) and echo it on the response. The logging middleware and error
 * handler read it back off the response header so every log line and error body
 * can be correlated to one request.
 */
export const requestId: MiddlewareHandler = async (c, next) => {
  const id = c.req.header("x-request-id")?.slice(0, 128) || randomUUID();
  c.header("x-request-id", id);
  await next();
};
