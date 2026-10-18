/**
 * Named enums that AniList's real schema exposes. TatakaiAPI's GraphQL documents
 * declare variables of these types (e.g. `$season: MediaSeason`, `$format: [MediaFormat]`)
 * and pass unquoted enum literals (`type: ANIME`, `sort: TRENDING_DESC`), so the
 * mirror must register the same named types for those documents to validate + execute.
 *
 * Resolvers read the runtime value as a plain string, so the DB layer is unchanged —
 * these types exist purely so variable/literal coercion succeeds.
 */
import { builder } from '../builder.js';

export const MediaType = builder.enumType('MediaType', {
  values: ['ANIME', 'MANGA'] as const,
});

export const MediaSeason = builder.enumType('MediaSeason', {
  values: ['WINTER', 'SPRING', 'SUMMER', 'FALL'] as const,
});

export const MediaStatus = builder.enumType('MediaStatus', {
  values: ['FINISHED', 'RELEASING', 'NOT_YET_RELEASED', 'CANCELLED', 'HIATUS'] as const,
});

export const MediaFormat = builder.enumType('MediaFormat', {
  values: [
    'TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC',
    'MANGA', 'NOVEL', 'ONE_SHOT',
  ] as const,
});

// Full AniList MediaSort value set — TatakaiAPI passes several of these as
// runtime values into `$sort: [MediaSort]`, and enum values are validated at
// execute time, so every value it can send must exist here.
export const MediaSort = builder.enumType('MediaSort', {
  values: [
    'ID', 'ID_DESC',
    'TITLE_ROMAJI', 'TITLE_ROMAJI_DESC',
    'TITLE_ENGLISH', 'TITLE_ENGLISH_DESC',
    'TITLE_NATIVE', 'TITLE_NATIVE_DESC',
    'TYPE', 'TYPE_DESC',
    'FORMAT', 'FORMAT_DESC',
    'START_DATE', 'START_DATE_DESC',
    'END_DATE', 'END_DATE_DESC',
    'SCORE', 'SCORE_DESC',
    'MEAN_SCORE', 'MEAN_SCORE_DESC',
    'POPULARITY', 'POPULARITY_DESC',
    'TRENDING', 'TRENDING_DESC',
    'EPISODES', 'EPISODES_DESC',
    'DURATION', 'DURATION_DESC',
    'CHAPTERS', 'CHAPTERS_DESC',
    'VOLUMES', 'VOLUMES_DESC',
    'UPDATED_AT', 'UPDATED_AT_DESC',
    'FAVOURITES', 'FAVOURITES_DESC',
    'SEARCH_MATCH',
  ] as const,
});

export const CharacterSort = builder.enumType('CharacterSort', {
  values: [
    'ID', 'ID_DESC', 'ROLE', 'ROLE_DESC', 'SEARCH_MATCH',
    'FAVOURITES', 'FAVOURITES_DESC', 'RELEVANCE',
  ] as const,
});

export const StaffSort = builder.enumType('StaffSort', {
  values: [
    'ID', 'ID_DESC', 'ROLE', 'ROLE_DESC', 'LANGUAGE', 'LANGUAGE_DESC',
    'SEARCH_MATCH', 'FAVOURITES', 'FAVOURITES_DESC', 'RELEVANCE',
  ] as const,
});

export const StudioSort = builder.enumType('StudioSort', {
  values: [
    'ID', 'ID_DESC', 'NAME', 'NAME_DESC', 'SEARCH_MATCH',
    'FAVOURITES', 'FAVOURITES_DESC',
  ] as const,
});
