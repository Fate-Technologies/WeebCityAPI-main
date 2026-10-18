import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mangaTagCatalogRouter } from './mangaTagCatalog.js';

test('exact tag catalog proxy preserves pagination, validates IDs and does not cache failures', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async input => {
    const url = String(input); calls.push(url);
    if (url.includes('tag=999')) return new Response('rate limited', { status: 429 });
    return Response.json({ data: [{ id: 1 }], pagination: { count: 3229, next: 'page2' } });
  };
  try {
    const request = () => mangaTagCatalogRouter.request('/search?tag=250&page=1&limit=20&content_rating=safe&content_rating=suggestive&url=https://invalid.example');
    const first = await request(); assert.equal(first.status, 200);
    const firstBody = await first.json() as { pagination: { count: number } };
    assert.equal(firstBody.pagination.count, 3229);
    await request(); assert.equal(calls.length, 1);
    const upstream = new URL(calls[0]);
    assert.equal(upstream.origin, 'https://api.mangabaka.org');
    assert.equal(upstream.pathname, '/v1/series/search');
    assert.equal(upstream.searchParams.has('url'), false);
    assert.deepEqual(upstream.searchParams.getAll('content_rating'), ['safe', 'suggestive']);
    assert.equal((await mangaTagCatalogRouter.request('/search?tag=Murder')).status, 400);
    assert.equal((await mangaTagCatalogRouter.request('/search?tag=250&page=601&limit=20')).status, 400);
    await mangaTagCatalogRouter.request('/search?tag=250&page=2&limit=20'); assert.equal(calls.length, 2);
    assert.equal((await mangaTagCatalogRouter.request('/search?tag=999')).status, 429);
    assert.equal((await mangaTagCatalogRouter.request('/search?tag=999')).status, 429);
    assert.equal(calls.length, 4);
  } finally { globalThis.fetch = originalFetch; }
});
