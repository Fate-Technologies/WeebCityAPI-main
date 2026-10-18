/**
 * Per-request DataLoaders. Batch entity-by-id lookups and mediaId-keyed join
 * lookups so a query selecting many nested fields issues few DB round-trips.
 * A fresh set is created per request (see server.ts context factory).
 */
import DataLoader from 'dataloader';
import type {
  Media, Character, Staff, Studio,
  MediaCharacter, MediaStaff, MediaStudio, MediaTag, Tag,
  MediaRelation, MediaRecommendation,
} from '@prisma/client';
import { prisma } from './db.js';

function byId<T extends { id: number }>(rows: T[], ids: readonly number[]): (T | null)[] {
  const map = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => map.get(id) ?? null);
}

function groupBy<T>(rows: T[], key: (r: T) => number, ids: readonly number[]): T[][] {
  const map = new Map<number, T[]>();
  for (const r of rows) {
    const k = key(r);
    (map.get(k) ?? map.set(k, []).get(k)!).push(r);
  }
  return ids.map((id) => map.get(id) ?? []);
}

export type CharacterEdge = MediaCharacter & { character: Character };
export type StaffEdge = MediaStaff & { staff: Staff };
export type StudioEdge = MediaStudio & { studio: Studio };
export type TagEdge = MediaTag & { tag: Tag };

export interface Loaders {
  media: DataLoader<number, Media | null>;
  character: DataLoader<number, Character | null>;
  staff: DataLoader<number, Staff | null>;
  studio: DataLoader<number, Studio | null>;
  charactersByMedia: DataLoader<number, CharacterEdge[]>;
  staffByMedia: DataLoader<number, StaffEdge[]>;
  studiosByMedia: DataLoader<number, StudioEdge[]>;
  tagsByMedia: DataLoader<number, TagEdge[]>;
  relationsByMedia: DataLoader<number, MediaRelation[]>;
  recommendationsByMedia: DataLoader<number, MediaRecommendation[]>;
  mediaByCharacter: DataLoader<number, (MediaCharacter & { media: Media })[]>;
  mediaByStaff: DataLoader<number, (MediaStaff & { media: Media })[]>;
  mediaByStudio: DataLoader<number, (MediaStudio & { media: Media })[]>;
}

export function createLoaders(): Loaders {
  return {
    media: new DataLoader(async (ids) =>
      byId(await prisma.media.findMany({ where: { id: { in: ids as number[] } } }), ids)),
    character: new DataLoader(async (ids) =>
      byId(await prisma.character.findMany({ where: { id: { in: ids as number[] } } }), ids)),
    staff: new DataLoader(async (ids) =>
      byId(await prisma.staff.findMany({ where: { id: { in: ids as number[] } } }), ids)),
    studio: new DataLoader(async (ids) =>
      byId(await prisma.studio.findMany({ where: { id: { in: ids as number[] } } }), ids)),

    charactersByMedia: new DataLoader(async (ids) => {
      const rows = await prisma.mediaCharacter.findMany({
        where: { mediaId: { in: ids as number[] } }, include: { character: true },
      });
      return groupBy(rows, (r) => r.mediaId, ids);
    }),
    staffByMedia: new DataLoader(async (ids) => {
      const rows = await prisma.mediaStaff.findMany({
        where: { mediaId: { in: ids as number[] } }, include: { staff: true },
      });
      return groupBy(rows, (r) => r.mediaId, ids);
    }),
    studiosByMedia: new DataLoader(async (ids) => {
      const rows = await prisma.mediaStudio.findMany({
        where: { mediaId: { in: ids as number[] } }, include: { studio: true },
      });
      return groupBy(rows, (r) => r.mediaId, ids);
    }),
    tagsByMedia: new DataLoader(async (ids) => {
      const rows = await prisma.mediaTag.findMany({
        where: { mediaId: { in: ids as number[] } }, include: { tag: true },
      });
      return groupBy(rows, (r) => r.mediaId, ids);
    }),
    relationsByMedia: new DataLoader(async (ids) => {
      const rows = await prisma.mediaRelation.findMany({ where: { mediaId: { in: ids as number[] } } });
      return groupBy(rows, (r) => r.mediaId, ids);
    }),
    recommendationsByMedia: new DataLoader(async (ids) => {
      const rows = await prisma.mediaRecommendation.findMany({ where: { mediaId: { in: ids as number[] } } });
      return groupBy(rows, (r) => r.mediaId, ids);
    }),

    mediaByCharacter: new DataLoader(async (ids) => {
      const rows = await prisma.mediaCharacter.findMany({
        where: { characterId: { in: ids as number[] } }, include: { media: true },
      });
      return groupBy(rows, (r) => r.characterId, ids);
    }),
    mediaByStaff: new DataLoader(async (ids) => {
      const rows = await prisma.mediaStaff.findMany({
        where: { staffId: { in: ids as number[] } }, include: { media: true },
      });
      return groupBy(rows, (r) => r.staffId, ids);
    }),
    mediaByStudio: new DataLoader(async (ids) => {
      const rows = await prisma.mediaStudio.findMany({
        where: { studioId: { in: ids as number[] } }, include: { media: true },
      });
      return groupBy(rows, (r) => r.studioId, ids);
    }),
  };
}
