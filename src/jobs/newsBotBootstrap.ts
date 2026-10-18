/**
 * One-time bootstrap for the "Tatakai News" bot account.
 *
 * Run once, AFTER the community_phase_b migration is applied:
 *   npm run job:news-bootstrap --workspace @tatakai/api-v3
 *
 * It creates (or finds) an auth user via the service-role Admin API — the
 * handle_new_user trigger auto-creates the bare profiles row — then reconciles
 * the profile (username=news, display name, avatar/banner, is_official). Copy
 * the printed id into TatakaiAPI/.env as NEWS_BOT_USER_ID for the ingest job.
 *
 * Idempotent: re-running only reconciles fields on the existing account.
 */
import "dotenv/config";
import { env, hasSupabase } from "../config/env.js";
import { getSupabase } from "../lib/supabase.js";

const PROFILE = {
  username: "news",
  display_name: "Tatakai News",
  bio: "Anime & manga headlines, aggregated from trusted sources across the web.",
  avatar_url: process.env.NEWS_BOT_AVATAR_URL || "",
  banner_url: process.env.NEWS_BOT_BANNER_URL || "",
};

type Supa = NonNullable<ReturnType<typeof getSupabase>>;

/** Paginate the Admin API to find an existing auth user by email. */
async function findUserIdByEmail(supa: Supa, email: string): Promise<string | null> {
  const target = email.trim().toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supa.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const users = data?.users ?? [];
    const match = users.find((u) => (u.email || "").toLowerCase() === target);
    if (match) return match.id;
    if (users.length < 200) break; // last page
  }
  return null;
}

/** Resolve the bot's auth id: existing profile → existing auth user → create. */
async function resolveUserId(supa: Supa, email: string): Promise<string> {
  const { data: existing } = await supa
    .from("profiles")
    .select("user_id, id")
    .eq("username", PROFILE.username)
    .maybeSingle();
  if (existing) {
    const id = (existing as { user_id?: string; id?: string }).user_id ?? existing.id;
    if (id) {
      console.log(`Found existing "news" profile → ${id}`);
      return id;
    }
  }

  const byEmail = await findUserIdByEmail(supa, email);
  if (byEmail) {
    console.log(`Found existing auth user for ${email} → ${byEmail}`);
    return byEmail;
  }

  const { data, error } = await supa.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { username: PROFILE.username, display_name: PROFILE.display_name },
  });
  if (error || !data?.user) throw new Error(`createUser failed: ${error?.message ?? "no user"}`);
  console.log(`Created auth user ${data.user.id} (${email})`);
  return data.user.id;
}

/** Reconcile the auto-created profiles row (keyed across both id spaces). */
async function reconcileProfile(supa: Supa, userId: string): Promise<void> {
  const base: Record<string, unknown> = {
    username: PROFILE.username,
    display_name: PROFILE.display_name,
    bio: PROFILE.bio,
    is_public: true,
  };
  if (PROFILE.avatar_url) base.avatar_url = PROFILE.avatar_url;
  if (PROFILE.banner_url) base.banner_url = PROFILE.banner_url;

  const orFilter = `user_id.eq.${userId},id.eq.${userId}`;
  const { data, error } = await supa
    .from("profiles")
    .update(base)
    .or(orFilter)
    .select("id");
  if (error) throw new Error(`profile update failed: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error(
      "profile update matched 0 rows — the handle_new_user trigger may not have " +
        "created the row, or service-role lacks column UPDATE grants on profiles.",
    );
  }

  // is_official ships with the community_phase_b migration; tolerate its absence.
  const { error: offErr } = await supa.from("profiles").update({ is_official: true }).or(orFilter);
  if (offErr) {
    console.warn(
      `⚠ could not set is_official (apply community_phase_b migration first): ${offErr.message}`,
    );
  }
}

async function main(): Promise<void> {
  if (!hasSupabase) {
    console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required");
    process.exit(1);
  }
  const supa = getSupabase();
  if (!supa) {
    console.error("Supabase client unavailable (need a service_role key)");
    process.exit(1);
  }

  const email = env.NEWS_BOT_EMAIL;
  const userId = await resolveUserId(supa, email);
  await reconcileProfile(supa, userId);

  console.log("\n✓ News bot ready. Add this to tatakaiapi/.env:\n");
  console.log(`NEWS_BOT_USER_ID=${userId}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
