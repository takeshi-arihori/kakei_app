import type { GraphQLContext } from '../../../presentation/graphql/authenticated-operation.js';
import type {
  MutationResolvers,
  QueryResolvers,
} from '../../../presentation/graphql/generated/resolvers.js';
import { PublicGraphQLError } from '../../../presentation/graphql/public-graphql-error.js';
import type { GroupCommandService } from '../../application/group-command-service.js';
import {
  createGroupCommandFrom,
  listMyGroupsQueryFrom,
} from '../../application/use-case-inputs.js';
import type { MyGroupQueryService } from '../../application/use-cases/list-my-groups.js';
import {
  isCanonicalOperationId,
  toCreateGroupOutput,
  toMyGroupListOutput,
} from './group-graphql-mapping.js';
import { toPublicGroupError } from './group-public-error.js';

/** Compositionが注入する、GraphQLで公開するGroup ManagementのUse Case。 */
export interface GroupManagementGraphQLUseCases {
  /** Group作成（#305 §1）。再送の収束はUse Caseが行う。 */
  readonly commands: Pick<GroupCommandService, 'createGroup'>;
  /** 自分のGroup一覧（#305 §2〜§4、#308）。 */
  readonly queries: Pick<MyGroupQueryService, 'listMyGroups'>;
}

/** Group Managementが公開するroot fieldのResolver。 */
export interface GroupManagementResolvers {
  readonly Query: Required<Pick<QueryResolvers<GraphQLContext>, 'myGroups'>>;
  readonly Mutation: Required<
    Pick<MutationResolvers<GraphQLContext>, 'createGroup'>
  >;
}

/**
 * Use Caseを認証lease内で呼ぶ。業務Errorと写像の失敗は公開Errorへ写像し、
 * 認証側へは公開Errorだけを返す（認証はcommitし、業務の結果は返さない）。
 */
const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw toPublicGroupError(error);
  }
};

/**
 * Group ManagementのContext Resolverを作る。本人性・Origin・CSRFは共通GraphQLの
 * `AuthenticatedOperation`に委ね、ここでは入力検査・Command／Query変換・結果と公開Errorの
 * 写像だけを行う。Actorはleaseの`actorSubject`だけから得て、Client値を使わない。
 * @param useCases Compositionが注入するUse Case。未注入なら両fieldを認証leaseを開かずに
 *   `SERVICE_UNAVAILABLE`で封鎖する。
 * @returns `Query.myGroups`と`Mutation.createGroup`のResolver。
 */
export const createGroupManagementResolvers = (
  useCases: GroupManagementGraphQLUseCases | undefined,
): GroupManagementResolvers => ({
  Query: {
    myGroups: (_parent, _args, context, info) => {
      if (useCases === undefined)
        throw new PublicGraphQLError('SERVICE_UNAVAILABLE');
      return context.authenticated.run(info, ({ actorSubject }) =>
        guarded(async () =>
          toMyGroupListOutput(
            await useCases.queries.listMyGroups(
              listMyGroupsQueryFrom({ actorSubject }),
            ),
          ),
        ),
      );
    },
  },
  Mutation: {
    createGroup: (_parent, { input }, context, info) => {
      if (useCases === undefined)
        throw new PublicGraphQLError('SERVICE_UNAVAILABLE');
      return context.authenticated.run(info, async ({ actorSubject }) => {
        // 本人性とCSRFを確かめた後に入力を検査し、違反ではUse Caseを呼ばない。
        if (!isCanonicalOperationId(input.operationId))
          throw new PublicGraphQLError('INVALID_INPUT');
        return guarded(async () =>
          toCreateGroupOutput(
            await useCases.commands.createGroup(
              createGroupCommandFrom({
                actorSubject,
                operationId: input.operationId,
              }),
            ),
          ),
        );
      });
    },
  },
});
