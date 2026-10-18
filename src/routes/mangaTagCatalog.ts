import { Hono } from 'hono';

// Fixed upstream and paths: this is a catalog adapter, never an arbitrary URL proxy.
export const mangaTagCatalogRouter = new Hono();
const cache = new Map<string, { expires: number; body: string }>();
const pending = new Map<string, Promise<{ status: number; body: string }>>();
const allowed = new Set(['page', 'limit', 'tag', 'tag_mode', 'q', 'genre', 'type', 'content_rating', 'sort_by']);

mangaTagCatalogRouter.get('/:kind', async c => {
  const kind = c.req.param('kind');
  if (kind !== 'tags' && kind !== 'search') return c.json({ error: 'Unknown catalog operation' }, 404);
  const url = new URL(`https://api.mangabaka.org/v1/${kind === 'tags' ? 'tags' : 'series/search'}`);
  if (kind === 'search') {
    const incoming = new URL(c.req.url).searchParams;
    for (const [key, value] of incoming) if (allowed.has(key)) url.searchParams.append(key, value);
    const page = Number(incoming.get('page') || 1);
    const limit = Number(incoming.get('limit') || 20);
    if (!Number.isInteger(page) || !Number.isInteger(limit) || page < 1 || limit < 1 || limit > 100 || page * limit > 12000) {
      return c.json({ error: 'Invalid catalog page' }, 400);
    }
    const tags = incoming.getAll('tag');
    if (!tags.length || tags.length > 20 || tags.some(tag => !/^\d+$/.test(tag))) return c.json({ error: 'Exact numeric tag IDs are required' }, 400);
  }
  url.searchParams.sort();
  const key = url.toString();
  const cached = cache.get(key);
  c.header('Content-Type', 'application/json');
  c.header('Cache-Control', 'public, max-age=300');
  if (cached && cached.expires > Date.now()) return c.body(cached.body);
  try {
    let request = pending.get(key);
    if (!request) {
      request = (async () => {
        const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000), redirect: 'error' });
        const body = await response.text();
        if (response.ok) {
          // Cache only successful JSON; errors must remain retryable.
          JSON.parse(body);
          if (cache.size >= 200) cache.delete(cache.keys().next().value!);
          cache.set(key, { body, expires: Date.now() + (kind === 'tags' ? 3600_000 : 300_000) });
        }
        return { status: response.status, body };
      })().finally(() => pending.delete(key));
      pending.set(key, request);
    }
    const result = await request;
    if (result.status !== 200) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'MangaBaka is temporarily unavailable' }, result.status === 429 ? 429 : 502);
    }
    return c.body(result.body);
  } catch {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'Could not reach MangaBaka' }, 502);
  }
});
