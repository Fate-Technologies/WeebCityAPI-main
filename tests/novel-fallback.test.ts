import { describe, test, expect } from 'bun:test';
import { NovelFallback, isNovelCatalogQuery, normalizeNovelVariables } from '../src/lib/novelFallback';
import { RateLimiter } from '../src/lib/rateLimiter';

describe('novel outage handling', () => {
  test('empty optional filters do not erase search results; selected filters remain intact', () => {
    const query = 'query($tags:[String],$states:[MediaStatus]) { Page { media(format:NOVEL,tag_in:$tags,status_in:$states) { id } } }';
    const original = { tags: [], states: ['FINISHED'], search: 'high school dxd' };
    expect(normalizeNovelVariables(query, original)).toEqual({ states: ['FINISHED'], search: 'high school dxd' });
    expect(original.tags).toEqual([]);
    expect(normalizeNovelVariables(query, { tags: ['Fantasy'] }).tags).toEqual(['Fantasy']);
  });
  test('recognizes literal and variable formats but excludes account and volatile queries', () => {
    expect(isNovelCatalogQuery('query { Page { media(format:NOVEL) { id } } }', {})).toBe(true);
    expect(isNovelCatalogQuery('query($f:MediaFormat) { Page { media(format:$f) { id } } }', { f: 'NOVEL' })).toBe(true);
    expect(isNovelCatalogQuery('query { Viewer { id } Page { media(format:NOVEL) { id } } }', {})).toBe(false);
    expect(isNovelCatalogQuery('mutation { Media(format:NOVEL) { id } }', {})).toBe(false);
    expect(isNovelCatalogQuery('query { Media { nextAiringEpisode { id } } }', {})).toBe(false);
  });
  test('429 fallback is explicit, coalesces concurrent work and pauses upstream attempts', async () => {
    const fallback = new NovelFallback(); let calls = 0; let mirrors = 0;
    const upstream = async () => { calls++; await new Promise(r => setTimeout(r, 10)); throw new Error('429'); };
    const mirror = async () => { mirrors++; return { data: { Page: { media: [{ id: 42 }] } } }; };
    const results = await Promise.all(Array.from({ length: 8 }, () => fallback.query('same', upstream, mirror)));
    expect(calls).toBe(1); expect(mirrors).toBe(1);
    expect(results[0].extensions).toMatchObject({ source: 'mirror', partial: true });
    await fallback.query('different', upstream, mirror);
    expect(calls).toBe(1); expect(mirrors).toBe(2);
  });
  test('never caches failed mirror execution', async () => {
    const fallback = new NovelFallback(); let mirrors = 0;
    const upstream = async () => { throw new Error('offline'); };
    const mirror = async () => { mirrors++; return { errors: ['unavailable'] }; };
    await expect(fallback.query('x', upstream, mirror)).rejects.toThrow();
    await expect(fallback.query('x', upstream, mirror)).rejects.toThrow();
    expect(mirrors).toBe(2);
  });
  test('queued limiter work stops at its deadline without consuming a future token', async () => {
    const limiter = new RateLimiter(1, 500);
    await limiter.acquire();
    const start = Date.now();
    await expect(limiter.acquire(1, AbortSignal.timeout(20))).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(200);
  });
});
