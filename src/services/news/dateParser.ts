/**
 * Date parsing. Ported from temp/AniNewsAPI/utils/dateParser.js.
 * Feeds hand back dates in a dozen shapes (ISO, "Jul 17, 2026", "3 hours ago",
 * MAL's "Jul 17, 12:34 AM"); every fetcher funnels through `parse`, which
 * always returns a valid Date (falling back to `now` when it can't tell).
 */

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
  nov: 10, november: 10, dec: 11, december: 11,
};

/** "3 hours ago", "yesterday", "just now" → a Date relative to `now`. */
function parseRelativeTime(input: string, now: Date): Date | null {
  const s = input.toLowerCase().trim();
  if (/^just now|^moments? ago|^now$/.test(s)) return new Date(now);
  if (/seconds? ago/.test(s)) return new Date(now);
  if (s === "yesterday") return new Date(now.getTime() - 86400000);
  if (s === "today") return new Date(now);
  const m = s.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const ms: Record<string, number> = {
    second: 1000, minute: 60000, hour: 3600000, day: 86400000,
    week: 604800000, month: 2592000000, year: 31536000000,
  };
  return new Date(now.getTime() - n * (ms[unit] || 0));
}

/** Try the common absolute formats in priority order. */
function parseDateString(input: string, now: Date): Date | null {
  const s = input.trim();
  if (!s) return null;

  const iso = new Date(s);
  if (!Number.isNaN(iso.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(s)) return iso;

  const rel = parseRelativeTime(s, now);
  if (rel) return rel;

  // "Month D, Y" or "Month D Y"
  let m = s.match(/([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/i);
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) {
    return new Date(Date.UTC(+m[3], MONTHS[m[1].toLowerCase()], +m[2]));
  }
  // "D Month Y"
  m = s.match(/(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})/i);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
    return new Date(Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1]));
  }
  // YYYY[-/]MM[-/]DD
  m = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  // DD[-/]MM[-/]YYYY
  m = s.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));

  const fallback = new Date(s);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/**
 * Parse any feed date into a valid Date. Returns `fallback` (default now) when
 * the input is empty/unparseable, never an Invalid Date.
 */
export function parse(input: string | Date | undefined | null, fallback: Date = new Date()): Date {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? fallback : input;
  if (!input || typeof input !== "string") return fallback;
  return parseDateString(input, fallback) ?? fallback;
}

/**
 * MyAnimeList date strings: "just now", "3 minutes ago", "2 hours ago",
 * "yesterday", "3 days ago", or "Jul 17, 12:34 AM" (implicit current year).
 */
export function parseMALDate(input: string, now: Date = new Date()): Date {
  const s = (input || "").toLowerCase().trim();
  if (!s) return now;
  const rel = parseRelativeTime(s, now);
  if (rel) return rel;
  // "Jul 17, 12:34 AM" — no year, assume current
  const m = s.match(/([a-z]+)\.?\s+(\d{1,2}),?\s*(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (m && MONTHS[m[1]] !== undefined) {
    let hour = +m[3];
    const ap = m[5];
    if (ap === "pm" && hour < 12) hour += 12;
    if (ap === "am" && hour === 12) hour = 0;
    return new Date(now.getFullYear(), MONTHS[m[1]], +m[2], hour, +m[4]);
  }
  return parseDateString(input, now) ?? now;
}
