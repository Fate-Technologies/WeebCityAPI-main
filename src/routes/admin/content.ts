import { Hono } from "hono";
import { z } from "zod";
import { jsonOk, jsonError } from "../../lib/envelope.js";
import { requireSupabaseAdmin, type AdminEnv } from "../../middleware/auth.js";
import { log } from "../../config/logger.js";
import * as repo from "../../services/contentRepository.js";
import * as catalog from "../../services/catalog.js";
import { ensureMedia } from "../../mirror/anilist/fallback.js";
import {
  applyContentEdit,
  listOverrides,
  EDITABLE_CONTENT_FIELDS,
} from "../../services/contentAdmin.js";

/**
 * Admin content editor. Lets staff edit a catalog item's title / poster /
 * description / episode counts / etc. and persist to the AniList mirror (Tiger
 * DB) — the single catalog store. The caller is verified staff by
 * requireSupabaseAdmin (Supabase JWT → profiles.is_admin); the write updates
 * the mirror `Media` row (by AniList id) and locks it so re-syncs won't
 * overwrite it. Edits are visitor-visible on next fetch.
 */

const r = new Hono<AdminEnv>();
r.use("*", requireSupabaseAdmin);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const editSchema = z.object({
  reason: z.string().trim().max(500).optional(),
  fields: z.record(z.string(), z.unknown()),
});

/**
 * Resolve the id param (tatakai uuid OR AniList numeric id) to an AniList
 * numeric id — the mirror `Media` primary key. A uuid is looked up in the
 * legacy Supabase catalog to recover its AniList id.
 */
async function resolveAnilistId(id: string): Promise<number | null> {
  const num = Number(id);
  if (Number.isFinite(num) && num > 0) return num;
  if (UUID_RE.test(id)) {
    const existing = await repo.findByTatakaiId(id);
    return existing?.anilistId ?? null;
  }
  return null;
}

r.get("/editable-fields", (c) => c.json(jsonOk(EDITABLE_CONTENT_FIELDS)));

r.get("/:id/overrides", async (c) => {
  const anilistId = await resolveAnilistId(c.req.param("id"));
  if (!anilistId) return c.json(jsonOk([]));
  return c.json(jsonOk(await listOverrides(anilistId)));
});

r.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const parsed = editSchema.safeParse(body);
  if (!parsed.success) return c.json(jsonError("Invalid body: expected { fields: {...} }"), 400);

  const anilistId = await resolveAnilistId(id);
  if (!anilistId) return c.json(jsonError("Content not found or not resolvable to an AniList id"), 404);

  try {
    // Backfill the mirror row from AniList if it isn't stored yet, so the
    // update has a row to write to (no-op / fetchedAt-bump if already locked).
    await ensureMedia(anilistId);

    await applyContentEdit(anilistId, parsed.data.fields, c.get("adminUserId"), parsed.data.reason);

    log.info(
      { anilistId, admin: c.get("adminUserId"), fields: Object.keys(parsed.data.fields) },
      "[admin/content] edit applied",
    );

    // Return the fresh row exactly as visitors will now see it (locked mirror row).
    const hit = await catalog.getMediaByAnilistId(anilistId);
    if (!hit) return c.json(jsonError("Edit saved but reload failed"), 500);
    return c.json(jsonOk(hit.media, { source: "db" }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /not found/i.test(msg) ? 404 : /no editable/i.test(msg) ? 400 : 500;
    return c.json(jsonError(msg), status);
  }
});

export { r as adminContentRouter };
