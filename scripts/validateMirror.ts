/**
 * Faithful drop-in check: run every GraphQL document TatakaiAPI sends to AniList
 * through the in-process mirror and assert none fail schema validation or
 * variable coercion. Resolver/DB errors (unreachable DATABASE_URL) are reported
 * but don't count as drop-in failures — those are the structural/type checks.
 *
 *   bunx tsx scripts/validateMirror.ts
 */
import 'dotenv/config';
import { parse, validate } from 'graphql';
import { schema } from '../src/mirror/schema/index.js';
import { executeMirror } from '../src/mirror/execute.js';
import * as Q from '../src/providers/anilist/queries.js';

interface Case { name: string; doc: string; vars?: Record<string, unknown>; }

const cases: Case[] = [
  { name: 'QUERY_PAGE', doc: Q.QUERY_PAGE, vars: { page: 1, perPage: 2, sort: ['POPULARITY_DESC'], season: 'FALL', seasonYear: 2024, status: 'RELEASING', format: 'TV' } },
  { name: 'QUERY_TRENDING', doc: Q.QUERY_TRENDING, vars: { page: 1, perPage: 2 } },
  { name: 'QUERY_SEARCH', doc: Q.QUERY_SEARCH, vars: { page: 1, perPage: 2, search: 'a', genres: ['Action'], tags: ['Isekai'], studioId: null, season: null, seasonYear: null, format: ['TV'], status: ['FINISHED'], isAdult: false, sort: ['SEARCH_MATCH'], averageScoreGreater: 50, averageScoreLesser: 100, episodesGreater: 1, episodesLesser: 200 } },
  { name: 'QUERY_SUGGESTIONS', doc: Q.QUERY_SUGGESTIONS, vars: { page: 1, search: 'a', tags: ['Isekai'], animePerPage: 2, mangaPerPage: 2 } },
  { name: 'QUERY_TAG_COLLECTION', doc: Q.QUERY_TAG_COLLECTION, vars: {} },
  { name: 'QUERY_STUDIO_SEARCH', doc: Q.QUERY_STUDIO_SEARCH, vars: { search: 'bones' } },
  { name: 'QUERY_MANGA_BY_ID', doc: Q.QUERY_MANGA_BY_ID, vars: { id: 30013 } },
  { name: 'QUERY_MANGA_BY_MAL', doc: Q.QUERY_MANGA_BY_MAL, vars: { idMal: 2 } },
  { name: 'QUERY_MANGA_SEARCH', doc: Q.QUERY_MANGA_SEARCH, vars: { page: 1, perPage: 2, search: 'a', isAdult: false, sort: ['SEARCH_MATCH'], genres: ['Action'], tags: ['Isekai'], countryOfOrigin: 'JP', format: 'MANGA', status: 'RELEASING' } },
  { name: 'QUERY_MANGA_PAGE', doc: Q.QUERY_MANGA_PAGE, vars: { page: 1, perPage: 2, sort: ['POPULARITY_DESC'], countryOfOrigin: 'JP', isAdult: false } },
  { name: 'QUERY_MANGA_CARD_PAGE', doc: Q.QUERY_MANGA_CARD_PAGE, vars: { page: 1, perPage: 2, sort: ['POPULARITY_DESC'], countryOfOrigin: 'JP', isAdult: false } },
  { name: 'QUERY_MANGA_CARD_SEARCH', doc: Q.QUERY_MANGA_CARD_SEARCH, vars: { page: 1, perPage: 2, search: 'a', isAdult: false, sort: ['SEARCH_MATCH'], genres: ['Action'], countryOfOrigin: 'JP', format: 'MANGA', status: 'RELEASING' } },
  { name: 'QUERY_MEDIA', doc: Q.QUERY_MEDIA, vars: { id: 1 } },
  { name: 'QUERY_MEDIA_BY_MAL', doc: Q.QUERY_MEDIA_BY_MAL, vars: { idMal: 1 } },
  { name: 'QUERY_GENRE_COLLECTION', doc: Q.QUERY_GENRE_COLLECTION, vars: {} },
];

// Errors that indicate a NON-faithful schema (structural / type / enum coercion),
// as opposed to a resolver/DB error we tolerate when the mirror DB is unreachable.
function isSchemaError(msg: string): boolean {
  return /Cannot query field|Unknown argument|Unknown type|of required type|got invalid value|must not have a selection|Expected type|Variable "\$\w+"|Enum ".*" cannot represent|Field ".*" argument/.test(msg);
}

async function main() {
  let structuralFail = 0;
  let executed = 0;
  let dbErrors = 0;

  for (const c of cases) {
    // 1) Static validation.
    const validationErrors = validate(schema, parse(c.doc));
    if (validationErrors.length) {
      structuralFail++;
      console.log(`✗ ${c.name} — VALIDATION`);
      for (const e of validationErrors) console.log(`    ${e.message}`);
      continue;
    }

    // 2) Execute (coerces variables first; resolver/DB errors classified apart).
    const res = await executeMirror(c.doc, c.vars);
    const errs = res.errors ?? [];
    const schemaErrs = errs.filter((e) => isSchemaError(e.message));
    if (schemaErrs.length) {
      structuralFail++;
      console.log(`✗ ${c.name} — COERCION/SCHEMA`);
      for (const e of schemaErrs) console.log(`    ${e.message}`);
      continue;
    }

    if (errs.length) {
      dbErrors++;
      console.log(`~ ${c.name} — OK (validates; resolver/DB error: ${errs[0].message.slice(0, 80)})`);
    } else {
      executed++;
      console.log(`✓ ${c.name} — OK (executed, data returned)`);
    }
  }

  console.log(`\n${cases.length} docs — ${executed} executed clean, ${dbErrors} validated (DB error), ${structuralFail} FAILED`);
  process.exit(structuralFail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
