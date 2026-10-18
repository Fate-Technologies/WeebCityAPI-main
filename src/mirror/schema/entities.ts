import { builder } from '../builder.js';
import {
  CharacterRef, CharacterNameRef, CharacterImageRef,
  StaffRef, StaffNameRef, StaffImageRef,
  StudioRef, MediaRef,
} from './refs.js';

// ---- Character -------------------------------------------------------------

builder.objectType(CharacterNameRef, {
  fields: (t) => ({
    full: t.exposeString('nameFull', { nullable: true }),
    native: t.exposeString('nameNative', { nullable: true }),
    alternative: t.exposeStringList('nameAlternative'),
  }),
});
builder.objectType(CharacterImageRef, {
  fields: (t) => ({
    large: t.exposeString('imageLarge', { nullable: true }),
    medium: t.exposeString('imageMedium', { nullable: true }),
  }),
});
builder.objectType(CharacterRef, {
  fields: (t) => ({
    id: t.exposeInt('id'),
    name: t.field({ type: CharacterNameRef, resolve: (c) => c }),
    image: t.field({ type: CharacterImageRef, resolve: (c) => c }),
    description: t.exposeString('description', { nullable: true }),
    media: t.field({
      type: [MediaRef],
      resolve: async (c, _a, ctx) => {
        const rows = await ctx.loaders.mediaByCharacter.load(c.id);
        return rows.map((r) => r.media);
      },
    }),
  }),
});

// ---- Staff -----------------------------------------------------------------

builder.objectType(StaffNameRef, {
  fields: (t) => ({
    full: t.exposeString('nameFull', { nullable: true }),
    native: t.exposeString('nameNative', { nullable: true }),
  }),
});
builder.objectType(StaffImageRef, {
  fields: (t) => ({
    large: t.exposeString('imageLarge', { nullable: true }),
    medium: t.exposeString('imageMedium', { nullable: true }),
  }),
});
builder.objectType(StaffRef, {
  fields: (t) => ({
    id: t.exposeInt('id'),
    name: t.field({ type: StaffNameRef, resolve: (s) => s }),
    languageV2: t.exposeString('languageV2', { nullable: true }),
    image: t.field({ type: StaffImageRef, resolve: (s) => s }),
    staffMedia: t.field({
      type: [MediaRef],
      resolve: async (s, _a, ctx) => {
        const rows = await ctx.loaders.mediaByStaff.load(s.id);
        return rows.map((r) => r.media);
      },
    }),
  }),
});

// ---- Studio ----------------------------------------------------------------

builder.objectType(StudioRef, {
  fields: (t) => ({
    id: t.exposeInt('id'),
    name: t.exposeString('name', { nullable: true }),
    isAnimationStudio: t.exposeBoolean('isAnimationStudio'),
    // No siteUrl column; AniList's is deterministic from the id.
    siteUrl: t.string({ nullable: true, resolve: (s) => `https://anilist.co/studio/${s.id}` }),
    media: t.field({
      type: [MediaRef],
      resolve: async (s, _a, ctx) => {
        const rows = await ctx.loaders.mediaByStudio.load(s.id);
        return rows.map((r) => r.media);
      },
    }),
  }),
});
