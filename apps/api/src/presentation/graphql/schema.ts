import { readFileSync } from 'node:fs';

import type { GraphQLSchema } from 'graphql';
import { createSchema } from 'graphql-yoga';

import type { GraphQLContext } from './authenticated-operation.js';
import { createResolvers, type GraphQLResolverOptions } from './resolvers.js';

const typeDefs = readFileSync(
  new URL('../../../schema.graphql', import.meta.url),
  'utf8',
);

/**
 * SDL（`apps/api/schema.graphql`）と集約ResolverからSchemaを組み立てる。
 * @param options Compositionが注入したContextのUse Case。未注入のfieldは封鎖される。
 * @returns 実行可能なSchema。
 */
export const createGraphQLSchema = (
  options: GraphQLResolverOptions = {},
): GraphQLSchema =>
  createSchema<GraphQLContext>({
    typeDefs,
    resolvers: createResolvers(options),
  });
