/**
 * Thin axios wrapper for the news aggregator. Every outbound request carries a
 * browser User-Agent (several sources 403 the default axios UA) and a bounded
 * timeout. Returns the response body as a string, or throws.
 */
import axios from "axios";
import { USER_AGENT, REQUEST_TIMEOUT } from "./constants.js";

export async function httpGet(
  url: string,
  timeout: number = REQUEST_TIMEOUT,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  const { data } = await axios.get<string>(url, {
    headers: { "User-Agent": USER_AGENT, ...extraHeaders },
    timeout,
    responseType: "text",
    // Some feeds return non-2xx with a usable body; let callers decide.
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return typeof data === "string" ? data : String(data ?? "");
}
