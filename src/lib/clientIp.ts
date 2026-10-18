import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { isIP } from "node:net";
import { env } from "../config/env.js";

export function clientIp(c: Context): string {
  if (env.TRUST_PROXY) {
    const address = c.req.header("x-real-ip")?.trim();
    if (address && isIP(address)) return address;
  }
  try { return getConnInfo(c).remote.address || "unknown"; }
  catch { return "unknown"; }
}
