import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  createPublicKey,
  publicEncrypt,
  constants,
} from "node:crypto";
import { getSupabase } from "../lib/supabase.js";
import { rateLimit } from "../middleware/rateLimit.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const idSchema = z.string().uuid();
const sealedSchema = z
  .object({
    key: z.string().max(1024),
    iv: z.string().max(32),
    ciphertext: z.string().max(180000),
  })
  .strict();
export function validatePairingKey(key: unknown) {
  const jwk = z
    .object({
      kty: z.literal("RSA"),
      n: z.string().min(340).max(700),
      e: z.literal("AQAB"),
    })
    .passthrough()
    .parse(key);
  if ("d" in jwk) throw new Error("Public key required");
  const native = createPublicKey({ key: jwk, format: "jwk" });
  if ((native.asymmetricKeyDetails?.modulusLength || 0) < 2048)
    throw new Error("RSA key too small");
  return jwk;
}
export function createTvPairingRouter(
  getClient: typeof getSupabase = getSupabase,
  limiter: typeof rateLimit = rateLimit
) {
  const tvPairingRouter = new Hono();
  tvPairingRouter.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  tvPairingRouter.use("*", bodyLimit({ maxSize: 200000 }));
  tvPairingRouter.use("/create", limiter("tv-pair-create", 5));
  tvPairingRouter.use("/lookup", limiter("tv-pair-lookup", 10));
  tvPairingRouter.use("/approve", limiter("tv-pair-approve", 10));
  tvPairingRouter.use("/poll", limiter("tv-pair-poll", 90));
  tvPairingRouter.use("/acknowledge", limiter("tv-pair-ack", 10));
  tvPairingRouter.use("/cancel", limiter("tv-pair-cancel", 10));
  tvPairingRouter.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof z.ZodError
            ? "Invalid pairing request"
            : "Pairing is unavailable. Please retry.",
      },
      error instanceof z.ZodError ? 400 : 503
    )
  );

  tvPairingRouter.post("/create", async (c) => {
    const sb = getClient();
    if (!sb) return c.json({ error: "Pairing unavailable" }, 503);
    const publicKey = validatePairingKey((await c.req.json()).publicKey);
    // Opportunistic database cleanup is safe across API replicas; no process-local pairing state.
    await sb
      .from("tv_pairing_requests")
      .delete()
      .lt("expires_at", new Date().toISOString());
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = randomUUID(),
        pin = String(randomInt(0, 1000000)).padStart(6, "0"),
        pollSecret = randomBytes(32).toString("base64url");
      const phrase = hash(JSON.stringify(publicKey))
        .slice(0, 8)
        .toUpperCase()
        .match(/.{4}/g)!
        .join(" ");
      const expiresAt = new Date(Date.now() + 300000).toISOString();
      const { error } = await sb
        .from("tv_pairing_requests")
        .insert({
          id,
          pin_hash: hash(pin),
          poll_hash: hash(pollSecret),
          public_key: publicKey,
          phrase,
          expires_at: expiresAt,
        });
      if (!error) return c.json({ id, pin, pollSecret, phrase, expiresAt });
      if (error.code !== "23505") throw error;
    }
    return c.json({ error: "Could not reserve a pairing code" }, 503);
  });
  tvPairingRouter.post("/lookup", async (c) => {
    const sb = getClient();
    if (!sb) return c.json({ error: "Pairing unavailable" }, 503);
    const auth =
      c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") || "";
    const { data: session, error: authError } = await sb.auth.getUser(auth);
    if (authError || !session.user)
      return c.json({ error: "Sign in on your companion device first" }, 401);
    const { pin } = z
      .object({ pin: z.string().regex(/^\d{6}$/) })
      .parse(await c.req.json());
    const { data, error } = await sb.rpc("tv_pairing_lookup", {
      p_pin_hash: hash(pin),
    });
    if (error) throw error;
    const row = data?.[0];
    if (!row) return c.json({ error: "Code unavailable or expired" }, 404);
    return c.json({
      id: row.id,
      publicKey: row.public_key,
      phrase: row.phrase,
      expiresAt: row.expires_at,
    });
  });
  tvPairingRouter.post("/approve", async (c) => {
    const sb = getClient();
    if (!sb) return c.json({ error: "Pairing unavailable" }, 503);
    const token =
      c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") || "";
    const { data: userData, error: authError } = await sb.auth.getUser(token);
    if (authError || !userData.user?.email)
      return c.json(
        { error: "An authenticated account with an email is required" },
        401
      );
    // A magic-link exchange confirms email in Auth. Never let pairing turn an
    // unverified/restricted signup into a verified account.
    if (!userData.user.email_confirmed_at)
      return c.json({ error: "Verify your email before linking a TV" }, 403);
    const input = z
      .object({
        id: idSchema,
        phrase: z.string().max(20),
        payload: sealedSchema,
      })
      .parse(await c.req.json());
    const { data: row, error } = await sb
      .from("tv_pairing_requests")
      .update({ status: "approving", approved_by: userData.user.id })
      .eq("id", input.id)
      .eq("status", "pending")
      .eq("phrase", input.phrase)
      .gt("expires_at", new Date().toISOString())
      .select("*")
      .maybeSingle();
    if (error) throw error;
    if (!row)
      return c.json(
        { error: "Pairing already approved, cancelled, or expired" },
        409
      );
    try {
      const { data: link, error: linkError } = await sb.auth.admin.generateLink(
        { type: "magiclink", email: userData.user.email }
      );
      if (linkError || !link.properties?.hashed_token)
        throw new Error("Unable to issue TV login");
      const login = publicEncrypt(
        {
          key: createPublicKey({ key: row.public_key, format: "jwk" }),
          oaepHash: "sha256",
          padding: constants.RSA_PKCS1_OAEP_PADDING,
        },
        Buffer.from(
          JSON.stringify({
            tokenHash: link.properties.hashed_token,
            type: link.properties.verification_type,
          })
        )
      ).toString("base64");
      const { data: saved, error: saveError } = await sb
        .from("tv_pairing_requests")
        .update({
          status: "approved",
          payload: { login, transfer: input.payload },
        })
        .eq("id", input.id)
        .eq("status", "approving")
        .gt("expires_at", new Date().toISOString())
        .select("id")
        .maybeSingle();
      if (saveError || !saved) throw new Error("Approval expired");
      return c.json({ success: true });
    } catch (error) {
      await sb
        .from("tv_pairing_requests")
        .update({ status: "pending", approved_by: null })
        .eq("id", input.id)
        .eq("status", "approving");
      throw error;
    }
  });
  for (const operation of ["poll", "acknowledge", "cancel"] as const)
    tvPairingRouter.post(`/${operation}`, async (c) => {
      const sb = getClient();
      if (!sb) return c.json({ error: "Pairing unavailable" }, 503);
      const { id, pollSecret } = z
        .object({ id: idSchema, pollSecret: z.string().min(40).max(100) })
        .parse(await c.req.json());
      const query = () =>
        sb
          .from("tv_pairing_requests")
          .select("*")
          .eq("id", id)
          .eq("poll_hash", hash(pollSecret))
          .gt("expires_at", new Date().toISOString());
      const { data: row, error } = await query().maybeSingle();
      if (error) throw error;
      if (!row) return c.json({ error: "Pairing expired or unavailable" }, 410);
      if (operation === "poll")
        return c.json({
          status: row.status,
          ...(row.status === "approved" ? { payload: row.payload } : {}),
        });
      if (
        operation === "acknowledge" &&
        !["approved", "consumed"].includes(row.status)
      )
        return c.json({ error: "Pairing not approved" }, 409);
      const status = operation === "cancel" ? "cancelled" : "consumed";
      if (row.status === status || row.status === "consumed")
        return c.json({ success: true });
      const { error: updateError } = await sb
        .from("tv_pairing_requests")
        .update({ status, payload: null })
        .eq("id", id)
        .eq("poll_hash", hash(pollSecret))
        .eq("status", row.status);
      if (updateError) throw updateError;
      return c.json({ success: true });
    });

  return tvPairingRouter;
}
export const tvPairingRouter = createTvPairingRouter();
