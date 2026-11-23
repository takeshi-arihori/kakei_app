import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { GroupCommandService } from '../src/group-management/application/group-command-service.js';
import { MyGroupQueryService } from '../src/group-management/application/use-cases/list-my-groups.js';
import {
  CloseIntentId,
  GroupId,
  InvitationId,
  ParticipantId,
  UtcInstant,
} from '../src/group-management/domain/group.js';
import {
  createMyGroupListIntegrityAlert,
  type MyGroupListIntegritySignal,
} from '../src/group-management/infrastructure/my-group-list-integrity-alert.js';
import { PostgresGroupRepository } from '../src/group-management/infrastructure/postgres/group-repository.js';
import { PostgresGroupStateWriter } from '../src/group-management/infrastructure/postgres/group-state-writer.js';
import { PostgresMyGroupListReader } from '../src/group-management/infrastructure/postgres/my-group-list-reader.js';
import type { GroupManagementGraphQLUseCases } from '../src/group-management/presentation/graphql/group-management-resolvers.js';
import {
  createProtectedRecordCodec,
  encodeCanonicalAad,
} from '../src/shared/infrastructure/protected-record/index.js';
import type { GroupManagementDevelopmentKeys } from './group-management-development-keys.js';

/**
 * 開発用Compositionが`createApp`へ注入するGroup ManagementのUse Caseを組み立てる
 * （#307 Decision 1〜3）。保存・読取とも業務Poolだけを使い、認証Poolを渡さない。
 * @param options 業務Pool、使い捨てGroup鍵、一覧の索引不整合の通知先。
 * @returns `createGroup`と`listMyGroups`だけを公開するUse Case。
 */
export const createGroupManagementDevelopmentUseCases = (
  options: Readonly<{
    pool: Pool;
    keys: GroupManagementDevelopmentKeys;
    onIntegrityAlert: (signal: MyGroupListIntegritySignal) => void;
  }>,
): GroupManagementGraphQLUseCases => {
  const { pool, keys } = options;
  const codec = createProtectedRecordCodec({ keyPort: keys.recordKeys });
  const repository = new PostgresGroupRepository({
    pool,
    stateWriter: new PostgresGroupStateWriter({
      codec,
      accessIndexDigests: keys.policyDigests,
      membershipIndexKeys: keys.membershipIndexKeys,
    }),
    codec,
    encodeAad: encodeCanonicalAad,
    locatorKeys: keys.locatorKeys,
    accessIndexDigests: keys.policyDigests,
  });
  // IDはServerがCSPRNGのUUIDv4で生成し、Clientに選ばせない。
  const commands = new GroupCommandService(repository, {
    nextGroupId: () => GroupId.from(randomUUID()),
    nextParticipantId: () => ParticipantId.from(randomUUID()),
    nextInvitationId: () => InvitationId.from(randomUUID()),
    nextCloseIntentId: () => CloseIntentId.from(randomUUID()),
    now: () => UtcInstant.from(new Date()),
  });
  const queries = new MyGroupQueryService(
    new PostgresMyGroupListReader({
      pool,
      codec,
      encodeAad: encodeCanonicalAad,
      membershipIndexKeys: keys.membershipIndexKeys,
    }),
    createMyGroupListIntegrityAlert(options.onIntegrityAlert),
  );
  return Object.freeze({
    commands: Object.freeze({
      createGroup: commands.createGroup.bind(commands),
    }),
    queries: Object.freeze({
      listMyGroups: queries.listMyGroups.bind(queries),
    }),
  });
};
