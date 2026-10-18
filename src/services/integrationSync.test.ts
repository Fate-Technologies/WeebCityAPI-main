import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { applySyncActions, buildSyncProposal, resolveAniListLocalRows, uniqueAniListEntries } from './integrationSync.js';
import { anilistLimiter } from '../lib/rateLimiter.js';

const originalFetch = globalThis.fetch;
const originalAcquire = anilistLimiter.acquire;
afterEach(() => { globalThis.fetch = originalFetch; anilistLimiter.acquire = originalAcquire; });

function remote(id = 1, progress = 24, status = 'COMPLETED', title = 'Vinland Saga') {
  return { mediaId: id, progress, status, media: { id, idMal: id + 100, title: { english: title, romaji: title }, coverImage: {} } };
}

function database(watchlist: any[] = [], history: any[] = [], readlist: any[] = []) {
  const tables: Record<string, any[]> = { profiles: [{ user_id: 'user', id: 'profile', anilist_access_token: 'fixture', anilist_user_id: 1 }], watchlist, watch_history: history, manga_readlist: readlist };
  const writes: string[] = [];
  let failTable = '';
  return {
    tables, writes, fail: (table: string) => { failTable = table; },
    from(table: string) {
      let mode = 'select'; let payload: any; let keys = ''; let start = 0; let end = Infinity;
      const filters: Array<[string, any]> = [];
      const query: any = {
        select: () => query,
        eq: (key: string, value: any) => { filters.push([key, value]); return query; },
        order: () => query,
        range: (a: number, b: number) => { start = a; end = b; return query; },
        update: (data: any) => { mode = 'update'; payload = data; return query; },
        upsert: (data: any, options: any) => { mode = 'upsert'; payload = data; keys = options.onConflict; return query; },
        maybeSingle: async () => ({ data: tables[table].find(row => filters.every(([key, value]) => row[key] === value)) || null }),
        then(resolve: any, reject: any) {
          return Promise.resolve().then(() => {
            if (mode === 'select') return { data: tables[table].filter(row => filters.every(([key, value]) => row[key] === value)).slice(start, end + 1), error: null };
            writes.push(table);
            if (failTable === table) return { error: { message: 'fixture write failure' } };
            if (mode === 'update') tables[table].filter(row => filters.every(([key, value]) => row[key] === value)).forEach(row => Object.assign(row, payload));
            else for (const row of Array.isArray(payload) ? payload : [payload]) {
              const existing = tables[table].find(old => keys.split(',').every(key => old[key] === row[key]));
              if (existing) Object.assign(existing, row); else tables[table].push({ ...row });
            }
            return { error: null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

function tracker(entries: any[], error = false) {
  let mutations = 0;
  anilistLimiter.acquire = async () => {};
  globalThis.fetch = (async (_url: any, options: any) => {
    const body = JSON.parse(options.body);
    if (body.query.includes('SaveMediaListEntry')) {
      mutations++;
      if (error) return Response.json({ errors: [{ message: 'fixture tracker failure' }] });
      const entry = entries.find(entry => entry.media.id === body.variables.mediaId);
      Object.assign(entry!, { progress: body.variables.progress, status: body.variables.status });
      return Response.json({ data: { SaveMediaListEntry: entry } });
    }
    return Response.json({ data: { MediaListCollection: { lists: [{ entries }, { entries }] } } });
  }) as typeof fetch;
  return () => mutations;
}

test('custom lists collapse to one entry per AniList media ID', () => {
  const entry = remote();
  assert.deepEqual(uniqueAniListEntries([entry, entry, remote(2), entry]), [entry, remote(2)]);
});

test('matches missing identities through MAL IDs and exact titles without merging seasons', async () => {
  const rows = [
    { anime_id: 'provider-one', anime_name: 'localized', mal_id: 101 },
    { anime_id: 'provider-two', anime_name: 'Vinland Saga' },
    { anime_id: 'provider-season-two', anime_name: 'Vinland Saga', anilist_id: 2 },
  ];
  await resolveAniListLocalRows(rows, [remote()], 'anime', async () => null);
  assert.deepEqual(rows.map(row => row.anilist_id), [1, 1, 2]);
});

test('ambiguous titles are not matched and native titles remain distinct', async () => {
  const rows: any[] = [{ anime_id: 'provider', anime_name: 'Same title' }, { anime_id: 'native', anime_name: '進撃の巨人' }];
  await resolveAniListLocalRows(rows, [remote(1, 1, 'CURRENT', 'Same title'), remote(2, 1, 'CURRENT', 'Same title'), remote(3, 1, 'CURRENT', '進撃の巨人'), remote(4, 1, 'CURRENT', '鬼滅の刃')], 'anime', async () => null);
  assert.equal(rows[0].anilist_id, undefined);
  assert.equal(rows[1].anilist_id, 3);
});

test('duplicate remote lists and local aliases yield one import and converge after applying', async () => {
  const db = database([
    { user_id: 'user', anime_id: 'provider', anime_name: 'Vinland Saga', status: 'completed', mal_id: 101 },
    { user_id: 'user', anime_id: 'anilist:1', anime_name: 'Vinland Saga', status: 'watching', anilist_id: 1 },
  ], [{ user_id: 'user', anime_id: 'provider', episode_number: 3, watched_at: '2026-01-01T00:00:00Z' }]);
  tracker([remote()]);
  const preview = await buildSyncProposal(db, 'user', 'anilist', 'anime');
  assert.equal(preview.length, 1);
  assert.equal(preview[0].direction, 'import');
  assert.equal(preview[0].localProgress, 3);
  assert.deepEqual(preview[0].localMediaIds, ['provider', 'anilist:1']);
  await applySyncActions(db, 'user', 'anilist', preview);
  assert.deepEqual(await buildSyncProposal(db, 'user', 'anilist', 'anime'), []);
  assert.ok(db.tables.watchlist.every(row => row.status === 'completed'));
  const newest = db.tables.watch_history.filter(row => row.anime_id === 'provider').sort((a, b) => String(b.watched_at).localeCompare(String(a.watched_at)))[0];
  assert.equal(newest.episode_number, 24);
  assert.equal(newest.anilist_id, 1);
});

test('progress beyond the first 1000 history rows is included in the next preview', async () => {
  const db = database([{ user_id: 'user', anime_id: 'anilist:1', status: 'completed', anilist_id: 1 }], [
    ...Array.from({ length: 1000 }, () => ({ user_id: 'user', anime_id: 'other', episode_number: 1 })),
    { user_id: 'user', anime_id: 'anilist:1', episode_number: 24 },
  ]);
  tracker([remote()]);
  assert.deepEqual(await buildSyncProposal(db, 'user', 'anilist', 'anime'), []);
});

test('a synced alias does not conceal stale progress in another local alias', async () => {
  const db = database([
    { user_id: 'user', anime_id: 'provider', anime_name: 'Vinland Saga', status: 'watching', anilist_id: 1 },
    { user_id: 'user', anime_id: 'anilist:1', anime_name: 'Vinland Saga', status: 'completed', anilist_id: 1 },
  ], [{ user_id: 'user', anime_id: 'provider', episode_number: 3 }, { user_id: 'user', anime_id: 'anilist:1', episode_number: 24 }]);
  tracker([remote()]);
  const preview = await buildSyncProposal(db, 'user', 'anilist', 'anime');
  assert.equal(preview.length, 1);
  assert.equal(preview[0].direction, 'import');
  await applySyncActions(db, 'user', 'anilist', preview);
  assert.deepEqual(await buildSyncProposal(db, 'user', 'anilist', 'anime'), []);
  assert.equal(db.tables.watchlist[0].status, 'completed');
});

test('local aliases produce one export with the highest local progress', async () => {
  const db = database([
    { user_id: 'user', anime_id: 'low', status: 'watching', anilist_id: 1 },
    { user_id: 'user', anime_id: 'high', status: 'watching', anilist_id: 1 },
  ], [{ user_id: 'user', anime_id: 'low', episode_number: 10 }, { user_id: 'user', anime_id: 'high', episode_number: 12 }]);
  const mutations = tracker([remote(1, 8, 'CURRENT')]);
  const preview = await buildSyncProposal(db, 'user', 'anilist', 'anime');
  assert.equal(preview.length, 1);
  assert.equal(preview[0].localProgress, 12);
  await applySyncActions(db, 'user', 'anilist', preview);
  assert.equal(mutations(), 1);
  assert.deepEqual(await buildSyncProposal(db, 'user', 'anilist', 'anime'), []);
});

test('duplicate manga aliases import chapters and volumes once and converge', async () => {
  const db = database([], [], [
    { user_id: 'user', manga_id: 'provider', manga_title: 'Vinland Saga', status: 'reading', last_chapter_number: 3, mal_id: 101 },
    { user_id: 'user', manga_id: 'anilist:1', manga_title: 'Vinland Saga', status: 'reading', anilist_id: 1 },
  ]);
  tracker([{ ...remote(), progressVolumes: 8 }]);
  const preview = await buildSyncProposal(db, 'user', 'anilist', 'manga');
  assert.equal(preview.length, 1);
  await applySyncActions(db, 'user', 'anilist', preview);
  assert.deepEqual(await buildSyncProposal(db, 'user', 'anilist', 'manga'), []);
  assert.ok(db.tables.manga_readlist.every(row => row.last_chapter_number === 24 && row.last_volume_number === 8));
});

test('failed local progress writes are reported and remain retryable', async () => {
  const db = database(); tracker([remote()]);
  const preview = await buildSyncProposal(db, 'user', 'anilist', 'anime');
  db.fail('watch_history');
  await assert.rejects(applySyncActions(db, 'user', 'anilist', preview), /History save failed/);
  assert.equal((await buildSyncProposal(db, 'user', 'anilist', 'anime'))[0].remoteProgress, 24);
});

test('AniList GraphQL errors fail Apply even with HTTP 200', async () => {
  const db = database(); tracker([remote()], true);
  await assert.rejects(applySyncActions(db, 'user', 'anilist', [{ id: 'export', mediaId: 'local', anilistId: 1, type: 'anime', direction: 'export', title: 'Vinland Saga', poster: null, actionText: '', localProgress: 12 }]), /fixture tracker failure/);
});

test('contradictory actions are rejected before any writes', async () => {
  const db = database(); const mutations = tracker([remote()]);
  const action: any = { id: 'import', mediaId: 'local', anilistId: 1, type: 'anime', direction: 'import', title: 'Vinland Saga', poster: null, remoteProgress: 24 };
  await assert.rejects(applySyncActions(db, 'user', 'anilist', [action, { ...action, id: 'export', direction: 'export', localProgress: 3 }]), /Conflicting sync actions/);
  assert.deepEqual(db.writes, []);
  assert.equal(mutations(), 0);
});
