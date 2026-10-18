import { Hono } from "hono";
import { jsonOk } from "../lib/envelope.js";
import { insertTelemetryBatch } from "../services/playbackTelemetry.js";

const playback = new Hono();

playback.post("/telemetry", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    events?: {
      tatakaiId?: string;
      anilistId?: number;
      episodeNumber?: number;
      sourceExtensionId?: string;
      event?: string;
      latencyMs?: number;
      errorCode?: string;
      ok?: boolean;
    }[];
  };
  const events = body.events ?? [];
  await insertTelemetryBatch(
    events.map((e) => ({
      tatakaiId: e.tatakaiId,
      anilistId: e.anilistId,
      episodeNumber: e.episodeNumber,
      sourceExtensionId: e.sourceExtensionId,
      event: e.event ?? "unknown",
      latencyMs: e.latencyMs,
      errorCode: e.errorCode,
      ok: e.ok,
    })),
    null,
  );
  return c.json(jsonOk({ ok: true }));
});

playback.post("/session", async (c) => {
  return c.json(jsonOk({ stub: true, message: "Cross-device sync not implemented" }));
});

export { playback as playbackRouter };
