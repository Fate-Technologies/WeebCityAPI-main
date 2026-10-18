/** GraphQL document strings for AniList */

export const MEDIA_FIELDS = `
fragment MediaFields on Media {
  id
  idMal
  title { romaji english native userPreferred }
  coverImage { extraLarge large medium }
  bannerImage
  description(asHtml: false)
  episodes
  chapters
  volumes
  duration
  format
  status
  season
  seasonYear
  averageScore
  meanScore
  popularity
  favourites
  genres
  synonyms
  isAdult
  countryOfOrigin
  source
  startDate { year month day }
  endDate { year month day }
  nextAiringEpisode { episode airingAt timeUntilAiring }
  trailer { id site thumbnail }
  externalLinks { url site }
  rankings { id rank type format year season allTime context }
  tags { id name rank isGeneralSpoiler isMediaSpoiler isAdult }
  studios { edges { isMain node { id name siteUrl } } }
  characters(sort: [ROLE, FAVOURITES_DESC], perPage: 8) {
    edges { role node { id name { full } image { large } } }
  }
  staff(perPage: 10) {
    edges { role node { id name { full } image { large } } }
  }
  relations {
    edges {
      relationType
      node {
        ... on Media {
          id
          title { romaji english }
          coverImage { large }
          format
          status
        }
      }
    }
  }
  streamingEpisodes { title thumbnail url site }
}
`;

export const QUERY_PAGE = `
${MEDIA_FIELDS}
query Page($page: Int, $perPage: Int, $sort: [MediaSort], $season: MediaSeason, $seasonYear: Int, $status: MediaStatus, $format: MediaFormat) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total perPage currentPage lastPage hasNextPage }
    media(sort: $sort, season: $season, seasonYear: $seasonYear, status: $status, format: $format, type: ANIME) {
      ...MediaFields
    }
  }
}
`;

export const QUERY_TRENDING = `
${MEDIA_FIELDS}
query Trending($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total perPage currentPage lastPage hasNextPage }
    media(sort: TRENDING_DESC, type: ANIME) { ...MediaFields }
  }
}
`;

const SEARCH_MEDIA_FIELDS = `
fragment SearchMediaFields on Media {
  id
  idMal
  title { romaji english native userPreferred }
  coverImage { extraLarge large medium }
  bannerImage
  description(asHtml: false)
  episodes
  chapters
  volumes
  duration
  format
  status
  season
  seasonYear
  averageScore
  meanScore
  popularity
  favourites
  genres
  synonyms
  isAdult
  countryOfOrigin
  source
  startDate { year month day }
  endDate { year month day }
  nextAiringEpisode { episode airingAt timeUntilAiring }
  trailer { id site thumbnail }
  externalLinks { url site }
  studios { edges { isMain node { id name siteUrl } } }
}
`;

export const QUERY_SEARCH = `
${SEARCH_MEDIA_FIELDS}
query Search($page: Int, $perPage: Int, $search: String, $genres: [String], $tags: [String], $studioId: Int, $season: MediaSeason, $seasonYear: Int, $format: [MediaFormat], $status: [MediaStatus], $isAdult: Boolean, $sort: [MediaSort], $averageScoreGreater: Int, $averageScoreLesser: Int, $episodesGreater: Int, $episodesLesser: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total perPage currentPage lastPage hasNextPage }
    media(
      search: $search
      genre_in: $genres
      tag_in: $tags
      studioId: $studioId
      season: $season
      seasonYear: $seasonYear
      format_in: $format
      status_in: $status
      isAdult: $isAdult
      sort: $sort
      averageScore_greater: $averageScoreGreater
      averageScore_lesser: $averageScoreLesser
      episodes_greater: $episodesGreater
      episodes_lesser: $episodesLesser
      type: ANIME
    ) { ...SearchMediaFields }
  }
}
`;

export const QUERY_SUGGESTIONS = `
query Suggestions($page: Int, $search: String, $tags: [String], $animePerPage: Int, $mangaPerPage: Int) {
  anime: Page(page: $page, perPage: $animePerPage) {
    media(search: $search, tag_in: $tags, type: ANIME) {
      id title { romaji english native } coverImage { extraLarge large medium } format countryOfOrigin startDate { year } seasonYear episodes averageScore status
    }
  }
  manga: Page(page: $page, perPage: $mangaPerPage) {
    media(search: $search, tag_in: $tags, type: MANGA) {
      id title { romaji english native } coverImage { extraLarge large medium } format countryOfOrigin startDate { year } chapters averageScore status
    }
  }
}
`;

export const QUERY_TAG_COLLECTION = `
query TagCollection {
  MediaTagCollection {
    id
    name
    description
    category
    isAdult
  }
}
`;

export const QUERY_STUDIO_SEARCH = `
query StudioSearch($search: String) {
  Studio(search: $search, sort: SEARCH_MATCH) {
    id
    name
  }
}
`;

export const QUERY_MANGA_BY_ID = `
${MEDIA_FIELDS}
query MangaById($id: Int!) {
  Media(id: $id, type: MANGA) { ...MediaFields }
}
`;

export const QUERY_MANGA_BY_MAL = `
${MEDIA_FIELDS}
query MangaByMal($idMal: Int!) {
  Media(idMal: $idMal, type: MANGA) { ...MediaFields }
}
`;

export const QUERY_MANGA_SEARCH = `
${MEDIA_FIELDS}
query MangaSearch(
  $page: Int
  $perPage: Int
  $search: String
  $isAdult: Boolean
  $sort: [MediaSort]
  $genres: [String]
  $tags: [String]
  $countryOfOrigin: CountryCode
  $formats: [MediaFormat], $format: MediaFormat
  $status: MediaStatus
) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total perPage currentPage lastPage hasNextPage }
    media(
      type: MANGA
      search: $search
      sort: $sort
      isAdult: $isAdult
      genre_in: $genres
      tag_in: $tags
      countryOfOrigin: $countryOfOrigin
      format_in: $formats, format: $format
      status: $status
    ) {
      ...MediaFields
    }
  }
}
`;

export const QUERY_MANGA_PAGE = `
${MEDIA_FIELDS}
query MangaPage($page: Int, $perPage: Int, $sort: [MediaSort], $countryOfOrigin: CountryCode, $isAdult: Boolean, $formats: [MediaFormat], $format: MediaFormat) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total perPage currentPage lastPage hasNextPage }
    media(type: MANGA, sort: $sort, countryOfOrigin: $countryOfOrigin, isAdult: $isAdult, format_in: $formats, format: $format) {
      ...MediaFields
    }
  }
}
`;

/**
 * The subset of `MediaFields` a poster card can actually render.
 *
 * `MediaFields` pulls `characters`, `staff`, `relations`, `tags`, `rankings` and
 * `streamingEpisodes` — six nested connections nothing on a shelf reads. Asking
 * for them on a list of 20 costs AniList query complexity and ships tens of
 * kilobytes per lane, which is most of why the manga home feed was slow. Detail
 * routes keep using `MediaFields`; list feeds use this.
 *
 * `anilistToTatakaiMedia` already tolerates every omitted field (`?.`/`??`
 * throughout), so the normalized media just carries empty studios/tags and no
 * characters — exactly what a card needs.
 */
export const MEDIA_CARD_FIELDS = `
fragment MediaCardFields on Media {
  id
  idMal
  title { romaji english native userPreferred }
  coverImage { extraLarge large medium }
  bannerImage
  description(asHtml: false)
  format
  status
  chapters
  volumes
  averageScore
  meanScore
  popularity
  favourites
  genres
  isAdult
  countryOfOrigin
  startDate { year month day }
}
`;

export const QUERY_MANGA_CARD_PAGE = `
${MEDIA_CARD_FIELDS}
query MangaCardPage($page: Int, $perPage: Int, $sort: [MediaSort], $countryOfOrigin: CountryCode, $isAdult: Boolean, $formats: [MediaFormat], $format: MediaFormat) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total perPage currentPage lastPage hasNextPage }
    media(type: MANGA, sort: $sort, countryOfOrigin: $countryOfOrigin, isAdult: $isAdult, format_in: $formats, format: $format) {
      ...MediaCardFields
    }
  }
}
`;

export const QUERY_MANGA_CARD_SEARCH = `
${MEDIA_CARD_FIELDS}
query MangaCardSearch(
  $page: Int
  $perPage: Int
  $search: String
  $isAdult: Boolean
  $sort: [MediaSort]
  $genres: [String]
  $countryOfOrigin: CountryCode
  $formats: [MediaFormat], $format: MediaFormat
  $status: MediaStatus
) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total perPage currentPage lastPage hasNextPage }
    media(
      type: MANGA
      search: $search
      sort: $sort
      isAdult: $isAdult
      genre_in: $genres
      countryOfOrigin: $countryOfOrigin
      format_in: $formats, format: $format
      status: $status
    ) {
      ...MediaCardFields
    }
  }
}
`;

export const QUERY_MEDIA = `
${MEDIA_FIELDS}
query MediaById($id: Int) {
  Media(id: $id, type: ANIME) { ...MediaFields }
}
`;

export const QUERY_MEDIA_BY_MAL = `
${MEDIA_FIELDS}
query MediaByMal($idMal: Int) {
  Media(idMal: $idMal, type: ANIME) { ...MediaFields }
}
`;

export const QUERY_GENRE_COLLECTION = `
query GenreCollection {
  GenreCollection { genre }
}
`;

/**
 * Live next-airing lookup — deliberately NOT served from the mirror/DB.
 *
 * The anime info page must show the *real* next-episode countdown, so this is
 * always run with `forceUpstream: true` against real AniList. Kept minimal so
 * the upstream call is cheap (no MediaFields fan-out).
 */
export const QUERY_NEXT_AIRING = `
query NextAiring($id: Int!) {
  Media(id: $id, type: ANIME) {
    id
    status
    episodes
    nextAiringEpisode { episode airingAt timeUntilAiring }
  }
}
`;
