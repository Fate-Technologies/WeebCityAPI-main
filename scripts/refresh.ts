/**
 * Freshness CLI: refresh trending + currently-airing titles from AniList.
 *
 * Usage:
 *   npm run refresh                    # one pass (airing + trending)
 *   npm run refresh -- --loop          # repeat every REFRESH_INTERVAL_MIN minutes
 *   npm run refresh -- --interval 15   # loop every 15 minutes
 *   npm run refresh -- --trending 100 --airing 3000
 */
import 'dotenv/config';
import { prisma } from '../src/mirror/db.js';
import { refreshAll } from '../src/mirror/anilist/refresh.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (name: string) => process.argv.includes(`--${name}`);

const TRENDING = Number(arg('trending') || process.env.TRENDING_REFRESH_COUNT || 100);
const AIRING = Number(arg('airing') || 5000);
const INTERVAL_MIN = Number(arg('interval') || process.env.REFRESH_INTERVAL_MIN || 30);

async function once() {
  const t0 = Date.now();
  const { airing, trending } = await refreshAll(TRENDING, AIRING);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`[${new Date().toISOString()}] refreshed airing=${airing} trending=${trending} in ${secs}s`);
}

async function main() {
  if (!has('loop')) { await once(); return; }
  console.log(`Refresh loop every ${INTERVAL_MIN} min (Ctrl-C to stop). trending=${TRENDING} airing<=${AIRING}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await once(); } catch (e) { console.error('refresh pass failed:', (e as Error).message); }
    await new Promise((r) => setTimeout(r, INTERVAL_MIN * 60 * 1000));
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => { if (!has('loop')) prisma.$disconnect(); });
