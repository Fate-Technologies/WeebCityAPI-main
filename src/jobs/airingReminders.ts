/**
 * Cron: episode airing reminders.
 * Run: npm run job:airing   (from TatakaiAPI/)
 *
 * Replaces the former supabase/functions/airing-reminders edge function. This
 * project has no pg_cron / pg_net, so recurring work runs as TatakaiAPI jobs
 * (see contentRefresh / mappingsRefresh) scheduled by the host — schedule this
 * hourly the same way the other jobs are scheduled.
 *
 * Each run:
 *   1. reads the distinct AniList ids users pinned via `tracked_shows`,
 *   2. asks AniList for each show's nextAiringEpisode (batched 50/request,
 *      through the shared rate-limited anilistClient),
 *   3. for every show airing within AIRING_LOOKAHEAD_SECONDS, inserts a
 *      `type:'airing'` notification for each user tracking it — once per
 *      (user, anilist_id, episode), guarded by `airing_reminders_sent`.
 */
import "dotenv/config";
import { anilistClient } from "../providers/anilist/client.js";
import { getSupabase } from "../lib/supabase.js";
import { hasSupabase } from "../config/env.js";

// How far ahead of airing to notify. Defaults to ~1h to pair with an hourly
// schedule; override with the AIRING_LOOKAHEAD_SECONDS env var.
const LOOKAHEAD_SECONDS = Number(process.env.AIRING_LOOKAHEAD_SECONDS ?? "3600");

const QUERY_AIRING = `
query ($ids: [Int]) {
  Page(perPage: 50) {
    media(id_in: $ids, type: ANIME) {
      id
      title { romaji english }
      nextAiringEpisode { episode airingAt timeUntilAiring }
    }
  }
}`;

interface AiringMedia {
  id: number;
  title: string;
  episode: number;
  airingAt: number;
  timeUntilAiring: number;
}

async function fetchAiring(ids: number[]): Promise<AiringMedia[]> {
  const out: AiringMedia[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const data = await anilistClient.query<{ Page: { media: any[] } }>(QUERY_AIRING, { ids: chunk });
    for (const m of data?.Page?.media ?? []) {
      const nae = m?.nextAiringEpisode;
      const id = Number(m?.id);
      if (!Number.isFinite(id) || !nae) continue;
      out.push({
        id,
        title: m?.title?.english || m?.title?.romaji || "Your tracked show",
        episode: Number(nae.episode),
        airingAt: Number(nae.airingAt),
        timeUntilAiring: Number(nae.timeUntilAiring),
      });
    }
  }
  return out;
}

async function main() {
  if (!hasSupabase) {
    console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required");
    process.exit(1);
  }
  const supabase = getSupabase()!;

  // Step 1: every distinct AniList id anyone is tracking.
  const { data: trackedRows, error: trackedError } = await supabase
    .from("tracked_shows")
    .select("anilist_id")
    .not("anilist_id", "is", null);
  if (trackedError) throw new Error(`read tracked_shows: ${trackedError.message}`);

  const ids = [
    ...new Set(
      (trackedRows ?? [])
        .map((r: { anilist_id: number | null }) => Number(r.anilist_id))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];
  if (ids.length === 0) {
    console.log("airingReminders: no tracked shows — nothing to do");
    return;
  }

  // Step 2: AniList nextAiringEpisode for each, keep those airing soon.
  const airing = (await fetchAiring(ids)).filter(
    (m) => m.timeUntilAiring > 0 && m.timeUntilAiring <= LOOKAHEAD_SECONDS,
  );

  let notified = 0;

  // Step 3: fan each soon-airing show out to the users tracking it.
  for (const show of airing) {
    const { data: trackers, error: trackersError } = await supabase
      .from("tracked_shows")
      .select("user_id")
      .eq("anilist_id", show.id);
    if (trackersError) {
      console.error(`airingReminders: read trackers for ${show.id}:`, trackersError.message);
      continue;
    }

    const userIds = [
      ...new Set((trackers ?? []).map((t: { user_id: string }) => t.user_id).filter(Boolean)),
    ];

    for (const userId of userIds) {
      // Once per (user, show, episode): the UNIQUE on airing_reminders_sent is
      // the source of truth, but check first to avoid a noisy insert per run.
      const { data: already } = await supabase
        .from("airing_reminders_sent")
        .select("id")
        .eq("user_id", userId)
        .eq("anilist_id", show.id)
        .eq("episode", show.episode)
        .maybeSingle();
      if (already) continue;

      // Claim the dedup slot first; if a concurrent run beat us the UNIQUE
      // violation (23505) makes this a no-op and we skip the notification.
      const { error: claimError } = await supabase
        .from("airing_reminders_sent")
        .insert({ user_id: userId, anilist_id: show.id, episode: show.episode });
      if (claimError) {
        if (claimError.code !== "23505") console.error("airingReminders: claim slot:", claimError.message);
        continue;
      }

      const { error: notifyError } = await supabase.from("notifications").insert({
        user_id: userId,
        title: `${show.title} — Ep ${show.episode} airs soon`,
        body: "Your tracked show has a new episode on the way.",
        data: {
          type: "airing",
          anilist_id: show.id,
          episode: show.episode,
          airing_at: show.airingAt,
          link: `/anime/anilist-${show.id}`,
        },
      });
      if (notifyError) {
        console.error("airingReminders: insert notification:", notifyError.message);
        continue;
      }
      notified++;
    }
  }

  console.log(
    `airingReminders: done — tracked ${ids.length}, airingSoon ${airing.length}, notified ${notified}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
