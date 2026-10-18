/** Rate-limited client for the public AniList GraphQL API. */
import Bottleneck from 'bottleneck';

const ENDPOINT = process.env.ANILIST_ENDPOINT || 'https://graphql.anilist.co';
const MAX_RPM = Number(process.env.ANILIST_MAX_RPM || 60);

// Token-bucket: spread requests evenly, small burst allowance.
const limiter = new Bottleneck({
  reservoir: MAX_RPM,
  reservoirRefreshAmount: MAX_RPM,
  reservoirRefreshInterval: 60 * 1000,
  maxConcurrent: 2,
  minTime: Math.ceil(60000 / MAX_RPM),
});

class AniListError extends Error {}

async function rawRequest<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'self-hosted-anilist-cache/1.0 (personal GraphQL mirror)',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') || 60);
    throw Object.assign(new AniListError('rate limited'), { retryAfter, is429: true });
  }
  // A nonexistent/deleted id returns 404 (sometimes as HTTP status, sometimes as
  // a GraphQL error below). Treat it as "not found", not a failure.
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new AniListError(`AniList HTTP ${res.status}`);
  }

  const json = (await res.json()) as { data?: T; errors?: { message: string; status?: number }[] };
  if (json.errors?.length) {
    // A 404-style "not found" comes back as an error; treat as null, not a throw.
    const notFound = json.errors.some((e) => e.status === 404 || /not found/i.test(e.message));
    if (notFound) return null;
    throw new AniListError(json.errors.map((e) => e.message).join('; '));
  }
  return json.data ?? null;
}

/** Schedule a request through the limiter, retrying once on 429 using Retry-After. */
export async function anilistRequest<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  return limiter.schedule(async () => {
    try {
      return await rawRequest<T>(query, variables);
    } catch (err) {
      const e = err as { is429?: boolean; retryAfter?: number };
      if (e.is429) {
        await new Promise((r) => setTimeout(r, (e.retryAfter ?? 60) * 1000));
        return rawRequest<T>(query, variables);
      }
      throw err;
    }
  });
}
