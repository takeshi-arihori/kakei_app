import type {
  ProtectedRecordCodec,
  ProtectedRecordEnvelope,
  ProtectedRecordHeader,
} from '@kakei/protected-record';
import { randomUUID } from 'node:crypto';
import type { Client, QueryResultRow } from 'pg';

import {
  actorAccessIndexDigestInput,
  type GroupPolicyDigestPort,
} from '../../application/group-access-policy.js';
import type {
  CommitGroupRequest,
  GroupCloseChange,
  InvitationChange,
  MembershipChange,
} from '../../application/group-repository.js';
import type { Group } from '../../domain/group.js';
import { encodeGroupRecordPayload } from './group-record-payload.js';

type SqlTransaction = Pick<Client, 'query'>;

export type GroupStateWriteOutcome =
  | Readonly<{ kind: 'Committed'; version: number }>
  | Readonly<{ kind: 'Conflict' }>
  | Readonly<{ kind: 'AlreadyExists' }>
  | Readonly<{ kind: 'Unavailable' }>;

type ProtectedRecordKind = Extract<
  ProtectedRecordHeader['recordKind'],
  | 'group'
  | 'participant'
  | 'invitation'
  | 'membership-history'
  | 'invitation-history'
  | 'group-close-history'
>;

type ProtectedRow = Readonly<{
  logicalRecordId: string;
  aggregateVersion: number;
  recordKind: ProtectedRecordKind;
  envelope: ProtectedRecordEnvelope;
  createdAt: Date;
}>;

type AccessIndexEntry = Readonly<{
  actorDigest: Uint8Array;
  digestKeyVersion: string;
}>;

const encoder = new TextEncoder();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9._:-]+$/;

const validVersion = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1;

const encodeParticipant = (participant: Group['participants'][number]) =>
  encoder.encode(
    JSON.stringify({
      payloadVersion: 1,
      id: participant.id.value,
      subject: participant.subject.value,
      joinedAt: participant.joinedAt.value,
      joinOrder: participant.joinOrder,
      status: participant.status,
      leftAt: participant.leftAt?.value ?? null,
    }),
  );

const encodeInvitation = (invitation: Group['invitations'][number]) =>
  encoder.encode(
    JSON.stringify({
      payloadVersion: 1,
      id: invitation.id.value,
      targetSubject: invitation.targetSubject.value,
      issuerParticipantId: invitation.issuerParticipantId.value,
      createdAt: invitation.createdAt.value,
      expiryAt: invitation.expiryAt.value,
      status: invitation.status,
      resultingParticipantId: invitation.resultingParticipantId?.value ?? null,
    }),
  );

const encodeMembershipChange = (change: MembershipChange) =>
  encoder.encode(
    JSON.stringify({
      payloadVersion: 1,
      kind: change.kind,
      participantId: change.participantId.value,
      at: change.at.value,
    }),
  );

const encodeInvitationChange = (change: InvitationChange) =>
  encoder.encode(
    JSON.stringify(
      change.kind === 'Created'
        ? {
            payloadVersion: 1,
            kind: change.kind,
            invitationId: change.invitationId.value,
            targetSubject: change.targetSubject.value,
            issuerParticipantId: change.issuerParticipantId.value,
            createdAt: change.createdAt.value,
            expiryAt: change.expiryAt.value,
          }
        : change.kind === 'Cancelled'
          ? {
              payloadVersion: 1,
              kind: change.kind,
              invitationId: change.invitationId.value,
              at: change.at.value,
            }
          : {
              payloadVersion: 1,
              kind: change.kind,
              invitationId: change.invitationId.value,
              participantId: change.participantId.value,
              at: change.at.value,
            },
    ),
  );

const encodeGroupCloseChange = (change: GroupCloseChange) => {
  const value = (instant: { value: string }) => instant.value;
  if (change.kind === 'ClosingStarted') {
    return encoder.encode(
      JSON.stringify({
        payloadVersion: 1,
        kind: change.kind,
        closeIntentId: change.closeIntentId.value,
        cutoff: value(change.cutoff),
        startedBy: change.startedBy.value,
        startedFromVersion: change.startedFromVersion,
      }),
    );
  }
  if (change.kind === 'CloseFenceReceiptRecorded') {
    const item = change.receipt;
    return encoder.encode(
      JSON.stringify({
        payloadVersion: 1,
        kind: change.kind,
        receipt: {
          kind: item.kind,
          groupId: item.groupId.value,
          closeIntentId: item.closeIntentId.value,
          context: item.context,
          cutoff: value(item.cutoff),
          fenceVersion: item.fenceVersion,
          completedAt: value(item.completedAt),
          eligible: item.eligible,
        },
      }),
    );
  }
  if (change.kind === 'CloseUnfenceReceiptRecorded') {
    const item = change.receipt;
    return encoder.encode(
      JSON.stringify({
        payloadVersion: 1,
        kind: change.kind,
        receipt: {
          kind: item.kind,
          groupId: item.groupId.value,
          closeIntentId: item.closeIntentId.value,
          context: item.context,
          cutoff: value(item.cutoff),
          fenceVersion: item.fenceVersion,
          completedAt: value(item.completedAt),
        },
      }),
    );
  }
  if (
    change.kind === 'ClosingCancellationReserved' ||
    change.kind === 'ClosingCancelled'
  ) {
    return encoder.encode(
      JSON.stringify({
        payloadVersion: 1,
        kind: change.kind,
        closeIntentId: change.closeIntentId.value,
      }),
    );
  }
  return encoder.encode(
    JSON.stringify({
      payloadVersion: 1,
      kind: change.kind,
      closeIntentId: change.closeIntentId.value,
      ownerAtArchiveParticipantId: change.ownerAtArchiveParticipantId.value,
      archivedAt: value(change.archivedAt),
      deleteEligibleAt: value(change.deleteEligibleAt),
      archivedFromVersion: change.archivedFromVersion,
      receiptVersions: change.receiptVersions,
    }),
  );
};

const actorsAllowedByCurrentGroupState = (group: Group) => {
  const participants =
    group.status === 'Archived'
      ? group.participants.filter((participant) =>
          participant.id.equals(group.ownerAtArchiveParticipantId!),
        )
      : group.participants.filter(({ status }) => status === 'Active');
  return [
    ...new Map(
      participants.map((participant) => [
        participant.subject.value,
        participant.subject,
      ]),
    ).values(),
  ];
};

export class PostgresGroupStateWriter {
  constructor(
    private readonly options: Readonly<{
      codec: Pick<ProtectedRecordCodec, 'seal'>;
      accessIndexDigests: Pick<GroupPolicyDigestPort, 'digest'>;
      now?: () => Date;
      nextRecordId?: () => string;
      onUnavailable?: () => void;
    }>,
  ) {}

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
      const prepared = await this.prepareRecords(request, nextVersion);
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
    const prepared = await this.prepareRecords(request, version);
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

  private async prepareRecords(
    request: CommitGroupRequest,
    version: number,
  ): Promise<{
    aggregate: ProtectedRow;
    participants: readonly ProtectedRow[];
    invitations: readonly ProtectedRow[];
    membershipHistory: readonly ProtectedRow[];
    invitationHistory: readonly ProtectedRow[];
    closeHistory: readonly ProtectedRow[];
    accessIndex: readonly AccessIndexEntry[];
  }> {
    const createdAt = this.timestamp();
    const groupId = request.group.id.value;
    const aggregate = await this.protect(
      groupId,
      version,
      'group',
      encodeGroupRecordPayload(request.group),
      createdAt,
    );
    const participants = await Promise.all(
      request.group.participants.map((participant) =>
        this.protect(
          groupId,
          version,
          'participant',
          encodeParticipant(participant),
          createdAt,
        ),
      ),
    );
    const invitations = await Promise.all(
      request.group.invitations.map((invitation) =>
        this.protect(
          groupId,
          version,
          'invitation',
          encodeInvitation(invitation),
          createdAt,
        ),
      ),
    );
    const membershipHistory = await Promise.all(
      request.membershipChanges.map((change) =>
        this.protect(
          groupId,
          version,
          'membership-history',
          encodeMembershipChange(change),
          createdAt,
        ),
      ),
    );
    const invitationHistory = await Promise.all(
      request.invitationChanges.map((change) =>
        this.protect(
          groupId,
          version,
          'invitation-history',
          encodeInvitationChange(change),
          createdAt,
        ),
      ),
    );
    const closeHistory = await Promise.all(
      request.groupCloseChanges.map((change) =>
        this.protect(
          groupId,
          version,
          'group-close-history',
          encodeGroupCloseChange(change),
          createdAt,
        ),
      ),
    );
    const accessIndex = await Promise.all(
      actorsAllowedByCurrentGroupState(request.group).map(
        async (actorSubject) => {
          const digest = await this.options.accessIndexDigests.digest({
            ...actorAccessIndexDigestInput(request.group.id, actorSubject),
          });
          if (
            digest.digest.length === 0 ||
            !KEY_VERSION_PATTERN.test(digest.digestKeyVersion)
          ) {
            throw new TypeError('Invalid access-index digest');
          }
          return {
            actorDigest: digest.digest,
            digestKeyVersion: digest.digestKeyVersion,
          };
        },
      ),
    );
    return {
      aggregate,
      participants,
      invitations,
      membershipHistory,
      invitationHistory,
      closeHistory,
      accessIndex,
    };
  }

  private async protect(
    groupId: string,
    aggregateVersion: number,
    recordKind: ProtectedRecordKind,
    plaintext: Uint8Array,
    createdAt: Date,
  ): Promise<ProtectedRow> {
    const logicalRecordId = this.recordId();
    const envelope = await this.options.codec.seal({
      header: {
        envelopeVersion: 1n,
        algorithmId: 'AES-256-GCM',
        app: 'kakei_app',
        contextName: 'group-management',
        recordKind,
        groupId,
        logicalRecordId,
        schemaVersion: 1n,
        aggregateVersion: BigInt(aggregateVersion),
        revisionOrdinal: null,
      },
      plaintext,
    });
    return {
      logicalRecordId,
      aggregateVersion,
      recordKind,
      envelope,
      createdAt,
    };
  }

  private envelopeValues(record: ProtectedRow): readonly unknown[] {
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
    prepared: Awaited<ReturnType<PostgresGroupStateWriter['prepareRecords']>>,
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
    entries: readonly AccessIndexEntry[],
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
    prepared: Awaited<ReturnType<PostgresGroupStateWriter['prepareRecords']>>,
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
    record: ProtectedRow,
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

  private timestamp(): Date {
    const value = this.options.now?.() ?? new Date();
    if (Number.isNaN(value.getTime())) {
      throw new TypeError('Invalid storage timestamp');
    }
    return value;
  }

  private recordId(): string {
    const value = (this.options.nextRecordId ?? randomUUID)();
    if (!UUID_PATTERN.test(value)) {
      throw new TypeError('Invalid protected record ID');
    }
    return value;
  }
}
