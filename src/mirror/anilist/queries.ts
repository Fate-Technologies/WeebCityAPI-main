/** GraphQL documents sent to graphql.anilist.co, requesting the fields we store. */

export const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native userPreferred }
  type
  format
  status
  description
  startDate { year month day }
  endDate { year month day }
  season
  seasonYear
  seasonInt
  episodes
  duration
  chapters
  volumes
  countryOfOrigin
  isLicensed
  source
  hashtag
  trailer { id site thumbnail }
  updatedAt
  coverImage { extraLarge large medium color }
  bannerImage
  genres
  synonyms
  averageScore
  meanScore
  popularity
  favourites
  trending
  isAdult
  isLocked
  siteUrl
  rankings { id rank type format year season allTime context }
  externalLinks { id url site type language color icon notes isDisabled }
  streamingEpisodes { title thumbnail url site }
  nextAiringEpisode { id airingAt timeUntilAiring episode mediaId }
  airingSchedule(perPage: 25) { nodes { id airingAt timeUntilAiring episode mediaId } }
  reviews(perPage: 10) { nodes { id summary rating score } }
  stats { scoreDistribution { score amount } statusDistribution { status amount } }
  tags { id name description category rank isGeneralSpoiler isMediaSpoiler isAdult }
  characters(perPage: 25, sort: [ROLE, RELEVANCE]) {
    edges {
      id role
      voiceActors(language: JAPANESE) { id name { full native } language }
      node { id name { full native alternative } image { large medium } description }
    }
  }
  staff(perPage: 25) {
    edges { id role node { id name { full native } languageV2 image { large medium } } }
  }
  studios {
    edges { id isMain node { id name isAnimationStudio } }
  }
  relations {
    edges { id relationType node { id title { romaji english native } type format status } }
  }
  recommendations(perPage: 10, sort: RATING_DESC) {
    nodes { id rating mediaRecommendation { id title { romaji english native } } }
  }
`;

export const MEDIA_BY_ID = `query ($id: Int) { Media(id: $id) { ${MEDIA_FIELDS} } }`;

/**
 * Bulk enumeration for the scraper: fetch up to 50 media by explicit id, filtered
 * to one MediaType. Using id_in keeps every request on page 1, so we never hit
 * AniList's hard "page depth exceeds 5000 entries" cap that blocks deep paging.
 */
export const MEDIA_PAGE_BY_IDS = `
query ($ids: [Int], $type: MediaType) {
  Page(page: 1, perPage: 50) {
    media(id_in: $ids, type: $type, sort: ID) { ${MEDIA_FIELDS} }
  }
}`;

/** Same as above but without a type filter — used to refresh a mix of ids. */
export const MEDIA_PAGE_BY_IDS_ANY = `
query ($ids: [Int]) {
  Page(page: 1, perPage: 50) {
    media(id_in: $ids, sort: ID) { ${MEDIA_FIELDS} }
  }
}`;

/** Trending page, used by the freshness refresher to keep hot titles current. */
export const MEDIA_PAGE_TRENDING = `
query ($page: Int, $perPage: Int, $type: MediaType) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { currentPage hasNextPage }
    media(sort: TRENDING_DESC, type: $type) { ${MEDIA_FIELDS} }
  }
}`;

/**
 * Live search page for background write-through backfill: mirrors the filter set
 * TatakaiAPI's search/Page documents send, so a miss in our Postgres can be
 * satisfied from real AniList and persisted. Only AniList-valid `Page.media` args
 * are declared (no `studioId` — AniList has no such arg on media).
 */
export const MEDIA_PAGE_SEARCH = `
query (
  $page: Int, $perPage: Int, $search: String, $type: MediaType,
  $format: MediaFormat, $format_in: [MediaFormat],
  $status: MediaStatus, $status_in: [MediaStatus],
  $season: MediaSeason, $seasonYear: Int,
  $genre_in: [String], $tag_in: [String],
  $countryOfOrigin: CountryCode, $isAdult: Boolean, $sort: [MediaSort],
  $averageScore_greater: Int, $averageScore_lesser: Int,
  $episodes_greater: Int, $episodes_lesser: Int,
  $startDate_greater: FuzzyDateInt, $startDate_lesser: FuzzyDateInt
) {
  Page(page: $page, perPage: $perPage) {
    media(
      search: $search, type: $type, format: $format, format_in: $format_in,
      status: $status, status_in: $status_in, season: $season, seasonYear: $seasonYear,
      genre_in: $genre_in, tag_in: $tag_in, countryOfOrigin: $countryOfOrigin,
      isAdult: $isAdult, sort: $sort,
      averageScore_greater: $averageScore_greater, averageScore_lesser: $averageScore_lesser,
      episodes_greater: $episodes_greater, episodes_lesser: $episodes_lesser,
      startDate_greater: $startDate_greater, startDate_lesser: $startDate_lesser
    ) { ${MEDIA_FIELDS} }
  }
}`;

/** Highest media id on AniList — the upper bound for a full id-window scan. */
export const MAX_MEDIA_ID = `{ Page(page: 1, perPage: 1) { media(sort: ID_DESC) { id } } }`;


/**
 * Start-date window for the `dates` scrape strategy: one page (50) of a
 * FuzzyDateInt (YYYYMMDD) start-date range, filtered to one type. We recurse on
 * the range and page each slice that holds <=5000 entries, sidestepping the hard
 * page-depth cap without an id cursor AniList doesn't offer.
 */
export const MEDIA_PAGE_BY_DATE = `
query ($type: MediaType, $gt: FuzzyDateInt, $lt: FuzzyDateInt, $page: Int) {
  Page(page: $page, perPage: 50) {
    pageInfo { currentPage hasNextPage }
    media(type: $type, startDate_greater: $gt, startDate_lesser: $lt, sort: ID) { ${MEDIA_FIELDS} }
  }
}`;

/**
 * Cheap overflow probe: does a start-date range hold more than 5000 entries?
 * Page 100 is the deepest AniList allows (5000 entries); hasNextPage there means
 * a 101st page exists, so the range must be bisected. id-only to stay light.
 * (pageInfo.total is unreliable here — it reports 5000 even for tiny ranges.)
 */
export const MEDIA_DATE_PROBE = `
query ($type: MediaType, $gt: FuzzyDateInt, $lt: FuzzyDateInt) {
  Page(page: 100, perPage: 50) {
    pageInfo { hasNextPage }
    media(type: $type, startDate_greater: $gt, startDate_lesser: $lt, sort: ID) { id }
  }
}`;

/** Fetch full media that a given character appears in, so we can hydrate the character too. */
export const CHARACTER_BY_ID = `
query ($id: Int) {
  Character(id: $id) {
    id
    name { full native alternative }
    image { large medium }
    description
    media(perPage: 25, sort: POPULARITY_DESC) { nodes { ${MEDIA_FIELDS} } }
  }
}`;

export const STAFF_BY_ID = `
query ($id: Int) {
  Staff(id: $id) {
    id
    name { full native }
    languageV2
    image { large medium }
    staffMedia(perPage: 25, sort: POPULARITY_DESC) { nodes { ${MEDIA_FIELDS} } }
  }
}`;

export const STUDIO_BY_ID = `
query ($id: Int) {
  Studio(id: $id) {
    id
    name
    isAnimationStudio
    media(perPage: 25, sort: POPULARITY_DESC) { nodes { ${MEDIA_FIELDS} } }
  }
}`;
