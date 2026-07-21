import type { Resolvers } from './generated/resolvers.js';

export const resolvers = {
  Query: {
    apiStatus: () => ({ status: 'ok' }),
  },
} satisfies Resolvers;
