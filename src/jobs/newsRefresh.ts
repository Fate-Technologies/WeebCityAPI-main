/**
 * News ingestion job — aggregates anime/manga headlines and upserts them as
 * forum_posts authored by the "Tatakai News" bot (NEWS_BOT_USER_ID).
 *
 *   npm run job:news --workspace @tatakai/api-v3
 *
 * Run by an external scheduler (cron/CI) — this is a plain tsx entrypoint, it
 * does NOT self-schedule. The actual work lives in services/news/ingest.ts so
 * the admin on-demand refresh route shares the exact same behavior. Dedup is
 * on the normalized article link stored at metadata.news_link.
 */
import "dotenv/config";
import { env, hasSupabase } from "../config/env.js";
import { getSupabase } from "../lib/supabase.js";
import { ingestNews } from "../services/news/ingest.js";

async function main(): Promise<void> {
  if (!hasSupabase) {
    console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required");
    process.exit(1);
  }
  const botId = env.NEWS_BOT_USER_ID.trim();
  if (!botId) {
    console.error("NEWS_BOT_USER_ID required — run job:news-bootstrap first, then set it in .env");
    process.exit(1);
  }
  const supa = getSupabase();
  if (!supa) {
    console.error("Supabase client unavailable (need a service_role key)");
    process.exit(1);
  }

  const { aggregated, inserted, existing, purged } = await ingestNews(supa, botId);
  console.log(`Aggregated ${aggregated} articles`);
  if (purged) console.log(`✓ Removed ${purged} retired-source posts.`);
  if (inserted === 0) console.log("No new articles — nothing to insert.");
  else console.log(`✓ Inserted ${inserted} new news posts (${existing} already present).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
