/**
 * In-process GraphQL execution against the mirror's compiled schema — no HTTP,
 * no graphql-yoga. TatakaiAPI calls `executeMirror(document, variables)` to read
 * catalog data straight from the mirror's Postgres via the same schema the old
 * standalone server exposed.
 *
 * Fresh DataLoaders per call: the mirror's resolvers assume a per-request loader
 * set (batching/caching must not leak across unrelated queries).
 */
import {
  parse, validate, execute, type DocumentNode, type ExecutionResult, type GraphQLError,
} from 'graphql';
import { schema } from './schema/index.js';
import { createLoaders } from './loaders.js';

// Parsing + validating the same document strings on every request is wasteful;
// TatakaiAPI sends a small fixed set of documents, so cache by source string.
const parsedCache = new Map<string, DocumentNode>();
const validatedDocs = new WeakSet<DocumentNode>();

function toDocument(document: string | DocumentNode): DocumentNode {
  if (typeof document !== 'string') return document;
  let doc = parsedCache.get(document);
  if (!doc) {
    doc = parse(document);
    if (parsedCache.size >= 256) parsedCache.delete(parsedCache.keys().next().value!);
    parsedCache.set(document, doc);
  }
  return doc;
}

export async function executeMirror<T = unknown>(
  document: string | DocumentNode,
  variables?: Record<string, unknown>,
): Promise<ExecutionResult<T>> {
  let doc: DocumentNode;
  try {
    doc = toDocument(document);
  } catch (err) {
    // Malformed document → surface as a GraphQL error, matching execute()'s shape.
    return { errors: [err as GraphQLError] };
  }

  if (!validatedDocs.has(doc)) {
    const validationErrors = validate(schema, doc);
    if (validationErrors.length > 0) {
      return { errors: validationErrors as GraphQLError[] };
    }
    validatedDocs.add(doc);
  }

  return execute({
    schema,
    document: doc,
    variableValues: variables,
    contextValue: { loaders: createLoaders() },
  }) as Promise<ExecutionResult<T>>;
}
