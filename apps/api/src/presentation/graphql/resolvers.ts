import {
  createGroupManagementResolvers,
  type GroupManagementGraphQLUseCases,
} from '../../group-management/presentation/graphql/group-management-resolvers.js';
import type { GraphQLContext } from './authenticated-operation.js';
import type { Resolvers } from './generated/resolvers.js';

/** Context Resolverへ渡す、Compositionが注入したUse Case。 */
export interface GraphQLResolverOptions {
  /** Group Management。未注入ならそのfieldを`SERVICE_UNAVAILABLE`で封鎖する。 */
  readonly groupManagement?: GroupManagementGraphQLUseCases;
}

/**
 * Transport共通のResolverとContext Resolverを集約する。業務Ruleを持たない。
 * @param options Compositionが注入したUse Case。
 * @returns Schemaへ渡すResolver。
 */
export const createResolvers = (options: GraphQLResolverOptions = {}) => {
  const groupManagement = createGroupManagementResolvers(
    options.groupManagement,
  );
  return {
    Query: {
      apiStatus: () => ({ status: 'ok' }),
      ...groupManagement.Query,
    },
    Mutation: {
      ...groupManagement.Mutation,
    },
  } satisfies Resolvers<GraphQLContext>;
};
