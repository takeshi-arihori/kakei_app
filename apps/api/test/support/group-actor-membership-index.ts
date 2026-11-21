import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { GroupActorMembershipIndexKeyPort } from '../../src/group-management/application/group-access-policy.js';
import type { SqlMigration } from '../../src/group-management/infrastructure/postgres/sql-migration.js';
import { importPurposeSeparatedDigest } from '../../src/shared/infrastructure/protected-record/index.js';

/** Actor単位Group索引のMigration 0012（#309）。既存TestのMigration列へ加える。 */
export const groupActorMembershipIndexMigration =
  async (): Promise<SqlMigration> => ({
    version: 12,
    name: 'group-actor-membership-index',
    sql: await readFile(
      new URL(
        '../../migrations/group-management/0012_group_actor_membership_index.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  });

/**
 * Test専用のContext単位HMAC。他用途の鍵Materialと共有しない。
 * @param version 現行鍵版。読取候補も同じ1世代だけを返す。
 * @returns 書込・読取の両方を満たすFake Port。
 */
export const createTestGroupActorMembershipIndexKeys = (
  version = 'membership-v1',
): GroupActorMembershipIndexKeyPort => {
  const material = randomBytes(32);
  const currentDigest: GroupActorMembershipIndexKeyPort['currentDigest'] = (
    input,
  ) =>
    Promise.resolve({
      digest: importPurposeSeparatedDigest(
        createHmac('sha256', material)
          .update(input.purpose)
          .update(input.canonicalInput)
          .digest(),
      ),
      digestKeyVersion: version,
    });
  return {
    currentDigest,
    candidateDigests: async (input) => [await currentDigest(input)],
  };
};
