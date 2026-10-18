/**
 * Persists a MappedMedia (from ingest.normalizeMedia) into Postgres.
 * Used by the live-fallback path for a single media. The bulk CSV importer
 * has its own batched writer in scripts/import.ts for speed.
 */
import type { PrismaClient } from '@prisma/client';
import type { MappedMedia } from './ingest.js';

export async function persistMedia(prisma: PrismaClient, mapped: MappedMedia): Promise<void> {
  const mediaId = mapped.media.id as number;

  // Admin-curated rows are locked (see services/contentAdmin.ts). A re-sync,
  // live-fallback refetch or trending refresh must NOT clobber an editor's
  // values — only bump fetchedAt so staleness checks stop re-fetching it.
  // (The bulk CSV importer in scripts/import.ts has its own writer and does not
  // pass through here; a full re-import would still need to respect isLocked.)
  const existing = await prisma.media.findUnique({
    where: { id: mediaId },
    select: { isLocked: true },
  });
  if (existing?.isLocked) {
    await prisma.media.update({ where: { id: mediaId }, data: { fetchedAt: new Date() } });
    return;
  }

  await prisma.$transaction(async (tx) => {
    // Parent entities first (referenced by join rows).
    await tx.media.upsert({
      where: { id: mediaId },
      create: { ...(mapped.media as any), fetchedAt: new Date() },
      update: { ...(mapped.media as any), fetchedAt: new Date() },
    });

    if (mapped.characters.length)
      await tx.character.createMany({ data: mapped.characters, skipDuplicates: true });
    if (mapped.staff.length)
      await tx.staff.createMany({ data: mapped.staff, skipDuplicates: true });
    if (mapped.studios.length)
      await tx.studio.createMany({ data: mapped.studios, skipDuplicates: true });
    if (mapped.tags.length)
      await tx.tag.createMany({ data: mapped.tags, skipDuplicates: true });

    // Replace this media's join rows so re-fetch stays consistent.
    await tx.mediaCharacter.deleteMany({ where: { mediaId } });
    await tx.mediaStaff.deleteMany({ where: { mediaId } });
    await tx.mediaStudio.deleteMany({ where: { mediaId } });
    await tx.mediaTag.deleteMany({ where: { mediaId } });
    await tx.mediaRelation.deleteMany({ where: { mediaId } });
    await tx.mediaRecommendation.deleteMany({ where: { mediaId } });

    if (mapped.mediaCharacters.length)
      await tx.mediaCharacter.createMany({ data: mapped.mediaCharacters as any, skipDuplicates: true });
    if (mapped.mediaStaff.length)
      await tx.mediaStaff.createMany({ data: mapped.mediaStaff, skipDuplicates: true });
    if (mapped.mediaStudios.length)
      await tx.mediaStudio.createMany({ data: mapped.mediaStudios, skipDuplicates: true });
    if (mapped.mediaTags.length)
      await tx.mediaTag.createMany({ data: mapped.mediaTags, skipDuplicates: true });
    if (mapped.relations.length)
      await tx.mediaRelation.createMany({ data: mapped.relations as any, skipDuplicates: true });
    if (mapped.recommendations.length)
      await tx.mediaRecommendation.createMany({ data: mapped.recommendations as any, skipDuplicates: true });
  }, { timeout: 30000 });
}
