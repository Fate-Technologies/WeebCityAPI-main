import { GraphQLScalarType, GraphQLInt, Kind, type ValueNode } from 'graphql';

/** Minimal JSON scalar (pass-through) for AniList blob fields like nextAiringEpisode, stats, rankings. */
function parseLiteral(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(ast.value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return ast.values.map(parseLiteral);
    case Kind.OBJECT: {
      const obj: Record<string, unknown> = {};
      for (const field of ast.fields) obj[field.name.value] = parseLiteral(field.value);
      return obj;
    }
    default:
      return null;
  }
}

export const GraphQLJSON = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON value',
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral,
});

/**
 * ISO 3166-1 alpha-2 country code — AniList exposes `countryOfOrigin` and the
 * `$countryOfOrigin: CountryCode` filter variable as this named scalar. It
 * behaves like a plain string; the named type only exists so TatakaiAPI's
 * manga documents (which declare `$countryOfOrigin: CountryCode`) validate.
 */
export const GraphQLCountryCode = new GraphQLScalarType({
  name: 'CountryCode',
  description: 'ISO 3166-1 alpha-2 country code',
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral: (ast) => (ast.kind === Kind.STRING ? ast.value : null),
});

/** AniList dates use a named integer scalar, including optional filter variables. */
export const GraphQLFuzzyDateInt = new GraphQLScalarType({
  name: 'FuzzyDateInt',
  description: 'Integer date in YYYYMMDD form; zero components represent unknown dates',
  serialize: GraphQLInt.serialize,
  parseValue: GraphQLInt.parseValue,
  parseLiteral: GraphQLInt.parseLiteral,
});
