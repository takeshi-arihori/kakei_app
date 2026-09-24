import type {
  ProtectedRecordCodec,
  ProtectedRecordHeader,
} from '@kakei/protected-record';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import {
  actorAccessIndexDigestInput,
  canReadSnapshot,
  type ExclusiveMutationResult,
  permitsNewBusinessOrAccessMutation,
  type FixedGroupAccessPolicy,
  type FixedSnapshotReadAccess,
  type GroupAccessPolicyPort,
  type GroupPolicyDigestPort,
  type ExpectedGroupAccessPolicyVersion,
  type SnapshotReadCallbackResult,
  type SnapshotReadResult,
} from '../../application/group-access-policy.js';
import type { ActorSubject, GroupId } from '../../domain/group.js';
import type { CommitGroupRequest } from '../../application/group-repository.js';
import { PostgresGroupReadRepository } from './group-read-repository.js';
import { PostgresGroupStateWriter } from './group-state-writer.js';

type LockedGroupRow = QueryResultRow & {
  aggregate_version: string;
  access_policy_version: string;
};

const keyVersionPattern = /^[A-Za-z0-9._:-]+$/;

const safeVersion = (value: string): number => {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('Invalid stored Group version');
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('Invalid stored Group version');
  }
  return version;
};

const toPolicy = (
  groupId: GroupId,
  groupVersion: number,
  accessPolicyVersion: number,
  group: NonNullable<
    Awaited<ReturnType<PostgresGroupReadRepository['load']>>
  >['group'],
): FixedGroupAccessPolicy =>
  Object.freeze({
    groupId,
    groupVersion,
    accessPolicyVersion,
    status: group.status,
    ownerParticipantId: group.ownerParticipantId,
    ownerAtArchiveParticipantId: group.ownerAtArchiveParticipantId,
    memberships: Object.freeze(
      group.participants.map((participant) =>
        Object.freeze({
          participantId: participant.id,
          actorSubject: participant.subject,
          status: participant.status,
        }),
      ),
    ),
  });

/** PostgreSQL locks and persists the Group Management policy in one transaction. */
export class PostgresGroupAccessPolicy implements GroupAccessPolicyPort {
  constructor(
    private readonly options: Readonly<{
      pool: Pick<Pool, 'connect'>;
      stateWriter: Pick<PostgresGroupStateWriter, 'persist'>;
      codec: Pick<ProtectedRecordCodec, 'open'>;
      encodeAad: (header: ProtectedRecordHeader) => Uint8Array;
      accessIndexDigests: GroupPolicyDigestPort;
      onUnavailable?: () => void;
    }>,
  ) {}

  async withSnapshotRead<T>(input: {
    groupId: GroupId;
    actorSubject: ActorSubject;
    callback: (
      access: FixedSnapshotReadAccess,
    ) => Promise<SnapshotReadCallbackResult<T>>;
  }): Promise<SnapshotReadResult<T>> {
    let client: PoolClient | undefined;
    let transactionOpen = false;
    try {
      client = await this.options.pool.connect();
      await client.query('BEGIN');
      transactionOpen = true;

      const digest = await this.options.accessIndexDigests.digest(
        actorAccessIndexDigestInput(input.groupId, input.actorSubject),
      );
      if (!this.validDigest(digest)) {
        return await this.rollbackUnavailable(client);
      }

      const indexed = await client.query(
        `SELECT 1
           FROM group_actor_access_index
          WHERE group_id = $1
            AND actor_digest = $2
            AND digest_key_version = $3`,
        [
          input.groupId.value,
          Buffer.from(digest.digest),
          digest.digestKeyVersion,
        ],
      );
      if (indexed.rowCount !== 1) {
        return await this.rollbackUnavailable(client);
      }

      const locked = await client.query<LockedGroupRow>(
        `SELECT aggregate_version, access_policy_version
           FROM group_aggregate_record
          WHERE group_id = $1
          FOR SHARE`,
        [input.groupId.value],
      );
      if (locked.rowCount !== 1) {
        return await this.rollbackUnavailable(client);
      }
      const fixed = locked.rows[0];
      if (fixed === undefined) {
        return await this.rollbackUnavailable(client);
      }

      const loaded = await this.readRepository(client).load(input.groupId);
      if (loaded === null) {
        return await this.rollbackUnavailable(client);
      }
      const policy = toPolicy(
        input.groupId,
        safeVersion(fixed.aggregate_version),
        safeVersion(fixed.access_policy_version),
        loaded.group,
      );
      if (
        loaded.version !== policy.groupVersion ||
        loaded.group.accessPolicyVersion !== policy.accessPolicyVersion
      ) {
        return await this.rollbackUnavailable(client);
      }

      let result: SnapshotReadCallbackResult<T>;
      try {
        result = await input.callback({
          groupVersion: policy.groupVersion,
          accessPolicyVersion: policy.accessPolicyVersion,
          canReadSnapshot: (involvement) =>
            canReadSnapshot(policy, input.actorSubject, involvement),
        });
      } catch {
        return await this.rollbackUnavailable(client);
      }
      if (
        result.kind !== 'Allowed' ||
        !canReadSnapshot(policy, input.actorSubject, result.involvement)
      ) {
        return await this.rollbackUnavailable(client);
      }

      await client.query('COMMIT');
      transactionOpen = false;
      return { kind: 'Allowed', value: result.value };
    } catch {
      if (client !== undefined && transactionOpen) {
        await this.rollback(client);
      }
      this.reportUnavailable();
      return { kind: 'Unavailable' };
    } finally {
      client?.release();
    }
  }

  async withExclusiveMutation<T>(input: {
    expectedPolicies: readonly ExpectedGroupAccessPolicyVersion[];
    callback: (
      policies: readonly FixedGroupAccessPolicy[],
    ) => Promise<ExclusiveMutationResult<T>>;
  }): Promise<SnapshotReadResult<T>> {
    const ids = input.expectedPolicies.map(({ groupId }) => groupId.value);
    if (
      ids.length === 0 ||
      ids.some((id, index) => index > 0 && ids[index - 1] >= id)
    ) {
      return { kind: 'Unavailable' };
    }

    let client: PoolClient | undefined;
    let transactionOpen = false;
    try {
      client = await this.options.pool.connect();
      await client.query('BEGIN');
      transactionOpen = true;

      const rows: Array<{
        groupId: GroupId;
        groupVersion: number;
        accessPolicyVersion: number;
      }> = [];
      for (const expected of input.expectedPolicies) {
        const locked = await client.query<LockedGroupRow>(
          `SELECT aggregate_version, access_policy_version
             FROM group_aggregate_record
            WHERE group_id = $1
            FOR UPDATE`,
          [expected.groupId.value],
        );
        if (locked.rowCount !== 1 || locked.rows[0] === undefined) {
          await this.rollback(client);
          return { kind: 'Unavailable' };
        }
        const row = locked.rows[0];
        const groupVersion = safeVersion(row.aggregate_version);
        const accessPolicyVersion = safeVersion(row.access_policy_version);
        if (
          groupVersion !== expected.groupVersion ||
          accessPolicyVersion !== expected.accessPolicyVersion
        ) {
          await this.rollback(client);
          return { kind: 'Unavailable' };
        }
        rows.push({
          groupId: expected.groupId,
          groupVersion,
          accessPolicyVersion,
        });
      }

      const readRepository = this.readRepository(client);
      const policies: FixedGroupAccessPolicy[] = [];
      for (const row of rows) {
        const loaded = await readRepository.load(row.groupId);
        if (
          loaded === null ||
          loaded.version !== row.groupVersion ||
          loaded.group.accessPolicyVersion !== row.accessPolicyVersion
        ) {
          await this.rollback(client);
          return { kind: 'Unavailable' };
        }
        const policy = toPolicy(
          row.groupId,
          row.groupVersion,
          row.accessPolicyVersion,
          loaded.group,
        );
        if (!permitsNewBusinessOrAccessMutation(policy)) {
          await this.rollback(client);
          return { kind: 'Unavailable' };
        }
        policies.push(policy);
      }

      const result: ExclusiveMutationResult<T> = await input.callback(
        Object.freeze(policies),
      );
      if (!Array.isArray(result.mutations)) {
        await this.rollback(client);
        return { kind: 'Unavailable' };
      }
      const mutations: readonly CommitGroupRequest[] = result.mutations;
      if (
        mutations.some((mutation) => {
          const policy = policies.find(({ groupId }) =>
            groupId.equals(mutation.group.id),
          );
          return (
            policy === undefined ||
            mutation.expectedVersion !== policy.groupVersion ||
            !mutation.stateChanged ||
            mutation.group.accessPolicyVersion <= policy.accessPolicyVersion
          );
        }) ||
        new Set(mutations.map(({ group }) => group.id.value)).size !==
          mutations.length
      ) {
        await this.rollback(client);
        return { kind: 'Unavailable' };
      }

      for (const mutation of mutations) {
        const written = await this.options.stateWriter.persist(
          client,
          mutation,
        );
        const policy = policies.find(({ groupId }) =>
          groupId.equals(mutation.group.id),
        );
        if (
          written.kind !== 'Committed' ||
          policy === undefined ||
          written.version !== policy.groupVersion + 1
        ) {
          await this.rollback(client);
          return { kind: 'Unavailable' };
        }
      }

      await client.query('COMMIT');
      transactionOpen = false;
      return { kind: 'Allowed', value: result.value };
    } catch {
      if (client !== undefined && transactionOpen) {
        await this.rollback(client);
      }
      this.reportUnavailable();
      return { kind: 'Unavailable' };
    } finally {
      client?.release();
    }
  }

  private readRepository(database: PoolClient): PostgresGroupReadRepository {
    return new PostgresGroupReadRepository({
      database,
      codec: this.options.codec,
      encodeAad: this.options.encodeAad,
      locatorKeys: {
        currentDigest: () =>
          Promise.reject(
            new Error('Operation locator is not used by Group policy reads'),
          ),
        candidateDigests: () => Promise.resolve([]),
      },
    });
  }

  private validDigest(candidate: {
    digest: Uint8Array;
    digestKeyVersion: string;
  }): boolean {
    return (
      candidate.digest.length > 0 &&
      keyVersionPattern.test(candidate.digestKeyVersion)
    );
  }

  private async rollbackUnavailable(
    client: PoolClient,
  ): Promise<{ kind: 'Unavailable' }> {
    await this.rollback(client);
    return { kind: 'Unavailable' };
  }

  private async rollback(client: PoolClient): Promise<void> {
    try {
      await client.query('ROLLBACK');
    } catch {
      this.reportUnavailable();
    }
  }

  private reportUnavailable(): void {
    try {
      this.options.onUnavailable?.();
    } catch {
      // Reporting failure cannot replace the generic fail-closed result.
    }
  }
}
