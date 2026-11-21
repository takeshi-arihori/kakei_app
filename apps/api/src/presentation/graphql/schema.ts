import { readFileSync } from 'node:fs';

import { createSchema } from 'graphql-yoga';

import type { GraphQLContext } from './authenticated-operation.js';
import { resolvers } from './resolvers.js';

const typeDefs = readFileSync(
  new URL('../../../schema.graphql', import.meta.url),
  'utf8',
);

export const schema = createSchema<GraphQLContext>({ typeDefs, resolvers });
