import { parse, visit, valueFromASTUntyped } from 'graphql';

/** Empty optional filter selections mean no filter, not "match no tags". */
export function normalizeNovelVariables(query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...variables };
  visit(parse(query), { Argument(node) {
    if (!['tag_in', 'status_in', 'genre_in'].includes(node.name.value) || node.value.kind !== 'Variable') return;
    const name = node.value.name.value;
    if (Array.isArray(normalized[name]) && normalized[name].length === 0) delete normalized[name];
  }});
  return normalized;
}

/** Only public catalog documents qualify; never cache account roots or mutations. */
export function isNovelCatalogQuery(query: string, variables: Record<string, unknown>): boolean {
  try {
    const document = parse(query);
    let novel = false;
    for (const def of document.definitions) {
      if (def.kind !== 'OperationDefinition') continue;
      if (def.operation !== 'query') return false;
      if (def.selectionSet.selections.some(node => node.kind !== 'Field' || !['Page', 'Media'].includes(node.name.value))) return false;
    }
    visit(document, { Field(node) {
      if (!['media', 'Media'].includes(node.name.value)) return;
      const format = node.arguments?.find(arg => arg.name.value === 'format');
      if (format && valueFromASTUntyped(format.value, variables) === 'NOVEL') novel = true;
    }});
    return novel;
  } catch { return false; }
}

type Result = { data?: unknown; errors?: readonly unknown[]; extensions?: Record<string, unknown> };

/** Bounded public-only cache and shared work; upstream outages do not multiply retries. */
export class NovelFallback {
  private cache = new Map<string, { expires: number; result: Result }>();
  private pending = new Map<string, Promise<Result>>();
  private unavailableUntil = 0;

  async query(key: string, upstream: () => Promise<Result>, mirror: () => Promise<Result>): Promise<Result> {
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.result;
    const existing = this.pending.get(key);
    if (existing) return existing;
    if (this.pending.size >= 32) throw new Error('Catalog request capacity reached');
    const work = (async () => {
      let result: Result | undefined;
      if (Date.now() >= this.unavailableUntil) {
        try {
          result = await upstream();
          if (result.errors?.length || result.data == null) throw new Error('Upstream unavailable');
        } catch {
          this.unavailableUntil = Date.now() + 60_000;
        }
      }
      if (!result || result.errors?.length || result.data == null) {
        result = await mirror();
        if (result.errors?.length || result.data == null) throw new Error('Novel catalog unavailable');
        result = { data: result.data, extensions: { source: 'mirror', partial: true, reason: 'upstream_unavailable' } };
      }
      // Cap both entry count and payload size; private responses never reach this class.
      if (JSON.stringify(result).length <= 256_000) {
        if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { expires: Date.now() + 60_000, result });
      }
      return result;
    })();
    this.pending.set(key, work);
    try { return await work; } finally { this.pending.delete(key); }
  }
}
