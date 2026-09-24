import type { ProtectedRecordCodec } from '@kakei/protected-record';
import type { Client, QueryResultRow } from 'pg';

import type { GroupPolicyDigestPort } from '../../application/group-access-policy.js';
import type { CommitGroupRequest } from '../../application/group-repository.js';
import {
  GroupRecordPreparer,
  type PreparedAccessIndexEntry,
  type PreparedGroupRecords,
  type PreparedProtectedRow,
} from './group-record-preparer.js';

type SqlTransaction = Pick<Client, 'query'>;

export type GroupStateWriteOutcome =
  | Readonly<{ kind: 'Committed'; version: number }>
  | Readonly<{ kind: 'Conflict' }>
  | Readonly<{ kind: 'AlreadyExists' }>
  | Readonly<{ kind: 'Unavailable' }>;

const validVersion = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1;

export class PostgresGroupStateWriter {
  private readonly recordPreparer: GroupRecordPreparer;

  constructor(
    private readonly options: Readonly<{
      codec: Pick<ProtectedRecordCodec, 'seal'>;
      accessIndexDigests: Pick<GroupPolicyDigestPort, 'digest'>;
      now?: () => Date;
      nextRecordId?: () => string;
      onUnavailable?: () => void;
    }>,
  ) {
    this.recordPreparer = new GroupRecordPreparer(options);
  }

  /**
   * Writes only through the caller's transaction. The caller owns its
   * BEGIN/COMMIT/ROLLBACK boundary so a later operation-result write can be
   * composed atomically without this adapter hiding a commit.
   */
  async persist(
    transaction: SqlTransaction,
    request: CommitGroupRequest,
  ): Promise<GroupStateWriteOutcome> {
    try {
      if (!this.isValidRequest(request)) {
        return { kind: 'Unavailable' };
      }

      if (request.expectedVersion === 'Absent') {
        return await this.create(transaction, request);
      }

      const current = await transaction.query<
        QueryResultRow & {
          aggregate_version: string;
        }
      >(
        `SELECT aggregate_version
           FROM group_aggregate_record
          WHERE group_id = $1
          FOR UPDATE`,
        [request.group.id.value],
      );
      if (current.rows.length !== 1) {
        return { kind: 'Conflict' };
      }
      const storedVersion = Number(current.rows[0]?.aggregate_version);
      if (
        !validVersion(storedVersion) ||
        storedVersion !== request.expectedVersion
      ) {
        return { kind: 'Conflict' };
      }
      if (!request.stateChanged) {
        return { kind: 'Committed', version: storedVersion };
      }

      const nextVersion = storedVersion + 1;
      if (!validVersion(nextVersion)) {
        return { kind: 'Unavailable' };
      }
      const prepared = await this.recordPreparer.prepare(request, nextVersion);
      const updated = await transaction.query(
        `UPDATE group_aggregate_record
            SET logical_record_id = $2,
                aggregate_version = $3,
                access_policy_version = $4,
                envelope_version = $5,
                algorithm_id = $6,
                schema_version = $7,
                key_version = $8,
                ciphertext = $9,
                nonce = $10,
                authentication_tag = $11,
                updated_at = $12
          WHERE group_id = $1
            AND aggregate_version = $13`,
        [
          request.group.id.value,
          prepared.aggregate.logicalRecordId,
          nextVersion,
          request.group.accessPolicyVersion,
          ...this.envelopeValues(prepared.aggregate),
          prepared.aggregate.createdAt,
          storedVersion,
        ],
      );
      if (updated.rowCount !== 1) {
        return { kind: 'Conflict' };
      }
      await this.replaceCurrentRows(
        transaction,
        request.group.id.value,
        prepared,
      );
      await this.replaceAccessIndex(
        transaction,
        request.group.id.value,
        prepared.accessIndex,
        prepared.aggregate.createdAt,
      );
      await this.appendHistory(transaction, request.group.id.value, prepared);
      return { kind: 'Committed', version: nextVersion };
    } catch {
      try {
        this.options.onUnavailable?.();
      } catch {
        // Reporting failure cannot reveal or replace the generic result.
      }
      return { kind: 'Unavailable' };
    }
  }

  private async create(
    transaction: SqlTransaction,
    request: CommitGroupRequest,
  ): Promise<GroupStateWriteOutcome> {
    const version = 1;
    const prepared = await this.recordPreparer.prepare(request, version);
    const inserted = await transaction.query(
      `INSERT INTO group_aggregate_record (
         group_id, logical_record_id, aggregate_version, access_policy_version,
         envelope_version, algorithm_id, schema_version, key_version,
         ciphertext, nonce, authentication_tag, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
       ON CONFLICT (group_id) DO NOTHING`,
      [
        request.group.id.value,
        prepared.aggregate.logicalRecordId,
        version,
        request.group.accessPolicyVersion,
        ...this.envelopeValues(prepared.aggregate),
        prepared.aggregate.createdAt,
      ],
    );
    if (inserted.rowCount !== 1) {
      return { kind: 'AlreadyExists' };
    }
    await this.replaceCurrentRows(
      transaction,
      request.group.id.value,
      prepared,
    );
    await this.replaceAccessIndex(
      transaction,
      request.group.id.value,
      prepared.accessIndex,
      prepared.aggregate.createdAt,
    );
    await this.appendHistory(transaction, request.group.id.value, prepared);
    return { kind: 'Committed', version };
  }

  private isValidRequest(request: CommitGroupRequest): boolean {
    if (
      request.expectedVersion !== 'Absent' &&
      !validVersion(request.expectedVersion)
    ) {
      return false;
    }
    if (request.expectedVersion === 'Absent' && !request.stateChanged) {
      return false;
    }
    if (
      !request.stateChanged &&
      (request.membershipChanges.length > 0 ||
        request.invitationChanges.length > 0 ||
        request.groupCloseChanges.length > 0)
    ) {
      return false;
    }
    if (
      !Number.isSafeInteger(request.group.accessPolicyVersion) ||
      request.group.accessPolicyVersion < 1
    ) {
      return false;
    }
    return request.result.groupId.equals(request.group.id);
  }

  private envelopeValues(record: PreparedProtectedRow): readonly unknown[] {
    return [
      Number(record.envelope.header.envelopeVersion),
      record.envelope.header.algorithmId,
      Number(record.envelope.header.schemaVersion),
      record.envelope.header.keyVersion,
      Buffer.from(record.envelope.ciphertext),
      Buffer.from(record.envelope.nonce),
      Buffer.from(record.envelope.authenticationTag),
    ];
  }

  private async replaceCurrentRows(
    transaction: SqlTransaction,
    groupId: string,
    prepared: PreparedGroupRecords,
  ): Promise<void> {
    await transaction.query(
      'DELETE FROM group_participant_record WHERE group_id = $1',
      [groupId],
    );
    await transaction.query(
      'DELETE FROM group_invitation_record WHERE group_id = $1',
      [groupId],
    );
    for (const record of prepared.participants) {
      await this.insertProtected(
        transaction,
        'group_participant_record',
        groupId,
        record,
      );
    }
    for (const record of prepared.invitations) {
      await this.insertProtected(
        transaction,
        'group_invitation_record',
        groupId,
        record,
      );
    }
  }

  private async replaceAccessIndex(
    transaction: SqlTransaction,
    groupId: string,
    entries: readonly PreparedAccessIndexEntry[],
    at: Date,
  ): Promise<void> {
    await transaction.query(
      'DELETE FROM group_actor_access_index WHERE group_id = $1',
      [groupId],
    );
    for (const entry of entries) {
      await transaction.query(
        `INSERT INTO group_actor_access_index (
           group_id, actor_digest, digest_key_version, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $4)`,
        [groupId, Buffer.from(entry.actorDigest), entry.digestKeyVersion, at],
      );
    }
  }

  private async appendHistory(
    transaction: SqlTransaction,
    groupId: string,
    prepared: PreparedGroupRecords,
  ): Promise<void> {
    for (const record of prepared.membershipHistory) {
      await this.insertProtected(
        transaction,
        'group_membership_history_record',
        groupId,
        record,
      );
    }
    for (const record of prepared.invitationHistory) {
      await this.insertProtected(
        transaction,
        'group_invitation_history_record',
        groupId,
        record,
      );
    }
    for (const record of prepared.closeHistory) {
      await this.insertProtected(
        transaction,
        'group_close_history_record',
        groupId,
        record,
      );
    }
  }

  private async insertProtected(
    transaction: SqlTransaction,
    table:
      | 'group_participant_record'
      | 'group_invitation_record'
      | 'group_membership_history_record'
      | 'group_invitation_history_record'
      | 'group_close_history_record',
    groupId: string,
    record: PreparedProtectedRow,
  ): Promise<void> {
    const timestampColumns =
      table === 'group_participant_record' ||
      table === 'group_invitation_record'
        ? ', created_at, updated_at'
        : ', created_at';
    const placeholders =
      timestampColumns === ', created_at, updated_at' ? '$11, $11' : '$11';
    await transaction.query(
      `INSERT INTO ${table} (
         logical_record_id, group_id, aggregate_version, envelope_version,
         algorithm_id, schema_version, key_version, ciphertext, nonce,
         authentication_tag${timestampColumns}
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${placeholders})`,
      [
        record.logicalRecordId,
        groupId,
        record.aggregateVersion,
        ...this.envelopeValues(record),
        record.createdAt,
      ],
    );
  }
}
