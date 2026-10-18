/**
 * Object refs declared up-front so types can reference each other circularly
 * (Media -> characters -> Character -> media -> Media). Backing types are the
 * Prisma row types; connection/edge shapes are declared inline.
 */
import type {
  Media, Character, Staff, Studio, Tag,
  MediaRelation, MediaRecommendation, Prisma,
} from '@prisma/client';
import { builder } from '../builder.js';
import type { CharacterEdge, StaffEdge, StudioEdge, TagEdge } from '../loaders.js';

export const MediaRef = builder.objectRef<Media>('Media');
export const CharacterRef = builder.objectRef<Character>('Character');
export const StaffRef = builder.objectRef<Staff>('Staff');
export const StudioRef = builder.objectRef<Studio>('Studio');

export const MediaTitleRef = builder.objectRef<Media>('MediaTitle');
export const MediaCoverImageRef = builder.objectRef<Media>('MediaCoverImage');
export const MediaTrailerRef = builder.objectRef<Media>('MediaTrailer');
export const FuzzyDateRef = builder.objectRef<{ year: number | null; month: number | null; day: number | null }>('FuzzyDate');

export const CharacterNameRef = builder.objectRef<Character>('CharacterName');
export const CharacterImageRef = builder.objectRef<Character>('CharacterImage');
export const StaffNameRef = builder.objectRef<Staff>('StaffName');
export const StaffImageRef = builder.objectRef<Staff>('StaffImage');

export const MediaTagRef = builder.objectRef<TagEdge>('MediaTag');
export type { Tag };

export const CharacterEdgeRef = builder.objectRef<CharacterEdge>('CharacterEdge');
export const CharacterConnectionRef = builder.objectRef<{ mediaId: number; edges: CharacterEdge[] }>('CharacterConnection');
export const StaffEdgeRef = builder.objectRef<StaffEdge>('StaffEdge');
export const StaffConnectionRef = builder.objectRef<{ mediaId: number; edges: StaffEdge[] }>('StaffConnection');
export const StudioEdgeRef = builder.objectRef<StudioEdge>('StudioEdge');
export const StudioConnectionRef = builder.objectRef<{ edges: StudioEdge[] }>('StudioConnection');

export const MediaEdgeRef = builder.objectRef<MediaRelation>('MediaEdge');
export const MediaConnectionRef = builder.objectRef<{ relations: MediaRelation[] }>('MediaConnection');
export const RecommendationRef = builder.objectRef<MediaRecommendation>('Recommendation');
export const RecommendationConnectionRef = builder.objectRef<{ recs: MediaRecommendation[] }>('RecommendationConnection');

export const PageInfoRef = builder.objectRef<{
  total: number; currentPage: number; perPage: number;
}>('PageInfo');
export const PageRef = builder.objectRef<{
  page: number; perPage: number; mediaWhere?: Prisma.MediaWhereInput;
}>('Page');

// ---- Typed objects over stored JSON blobs ---------------------------------
// TatakaiAPI's documents select subfields on these (e.g. `nextAiringEpisode {
// episode airingAt }`), which is invalid against a JSON scalar, so each blob
// gets a named object type. Backing shapes are loose (the columns are Json?).

export interface AiringScheduleShape {
  id?: number | null; episode?: number | null; airingAt?: number | null;
  timeUntilAiring?: number | null; mediaId?: number | null;
}
export interface ExternalLinkShape {
  id?: number | null; url?: string | null; site?: string | null; type?: string | null;
  language?: string | null; color?: string | null; icon?: string | null; notes?: string | null;
}
export interface MediaRankingShape {
  id?: number | null; rank?: number | null; type?: string | null; format?: string | null;
  year?: number | null; season?: string | null; allTime?: boolean | null; context?: string | null;
}
export interface StreamingEpisodeShape {
  title?: string | null; thumbnail?: string | null; url?: string | null; site?: string | null;
}

export const AiringScheduleRef = builder.objectRef<AiringScheduleShape>('AiringSchedule');
export const ExternalLinkRef = builder.objectRef<ExternalLinkShape>('MediaExternalLink');
export const MediaRankingRef = builder.objectRef<MediaRankingShape>('MediaRank');
export const StreamingEpisodeRef = builder.objectRef<StreamingEpisodeShape>('MediaStreamingEpisode');

// GenreCollection is `[String]` on real AniList, but TatakaiAPI's document
// selects `GenreCollection { genre }`, so the mirror returns objects instead.
export const GenreEntryRef = builder.objectRef<{ genre: string }>('GenreEntry');
