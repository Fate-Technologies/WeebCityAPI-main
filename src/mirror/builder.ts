import SchemaBuilder from '@pothos/core';
import { GraphQLJSON, GraphQLCountryCode, GraphQLFuzzyDateInt } from './scalars.js';
import type { Loaders } from './loaders.js';

export interface Context {
  loaders: Loaders;
}

export const builder = new SchemaBuilder<{
  Context: Context;
  Scalars: {
    JSON: { Input: unknown; Output: unknown };
    CountryCode: { Input: string; Output: string };
    FuzzyDateInt: { Input: number; Output: number };
  };
}>({});

builder.addScalarType('JSON', GraphQLJSON);
builder.addScalarType('CountryCode', GraphQLCountryCode);
builder.addScalarType('FuzzyDateInt', GraphQLFuzzyDateInt);

builder.queryType({});
