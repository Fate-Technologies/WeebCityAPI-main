import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { log } from "./logger.js";
import { jsonError } from "../lib/envelope.js";

export function onError(err: Error, c: Context) {
  const reqId = c.res.headers.get("x-request-id") ?? undefined;
  // Thrown errors bypass the CORS middleware's post-processing, so without
  // these headers the browser reports a CORS failure that masks the real
  // status/message. The API uses Bearer auth (no cookies), so reflecting the
  // request origin here is safe.
  const origin = c.req.header("origin");
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  } else {
    c.header("Access-Control-Allow-Origin", "*");
  }
  if (err instanceof HTTPException) {
    return c.json(jsonError(err.message), err.status);
  }
  log.error({ err, reqId }, "unhandled error");
  return c.json(jsonError("Internal Server Error"), 500);
}

export function notFound(c: Context) {
  return c.json(jsonError("Not Found"), 404);
}
