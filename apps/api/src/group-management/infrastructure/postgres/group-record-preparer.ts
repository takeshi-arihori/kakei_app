import type {
  ProtectedRecordCodec,
  ProtectedRecordEnvelope,
  ProtectedRecordHeader,
} from '@kakei/protected-record';
import { randomUUID } from 'node:crypto';

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

export type ProtectedGroupRecordKind = Extract<
  ProtectedRecordHeader['recordKind'],
  | 'group'
  | 'participant'
  | 'invitation'
  | 'membership-history'
  | 'invitation-history'
  | 'group-close-history'
>;

export type PreparedProtectedRow = Readonly<{
  logicalRecordId: string;
  aggregateVersion: number;
  recordKind: ProtectedGroupRecordKind;
  envelope: ProtectedRecordEnvelope;
  createdAt: Date;
}>;

export type PreparedAccessIndexEntry = Readonly<{
  actorDigest: Uint8Array;
  digestKeyVersion: string;
}>;

export type PreparedGroupRecords = Readonly<{
  aggregate: PreparedProtectedRow;
  participants: readonly PreparedProtectedRow[];
  invitations: readonly PreparedProtectedRow[];
  membershipHistory: readonly PreparedProtectedRow[];
  invitationHistory: readonly PreparedProtectedRow[];
  closeHistory: readonly PreparedProtectedRow[];
  accessIndex: readonly PreparedAccessIndexEntry[];
}>;

export type GroupRecordPreparerOptions = Readonly<{
  codec: Pick<ProtectedRecordCodec, 'seal'>;
  accessIndexDigests: Pick<GroupPolicyDigestPort, 'digest'>;
  now?: () => Date;
  nextRecordId?: () => string;
}>;

const encoder = new TextEncoder();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9._:-]+$/;

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

export class GroupRecordPreparer {
  constructor(private readonly options: GroupRecordPreparerOptions) {}

  async prepare(
    request: CommitGroupRequest,
    version: number,
  ): Promise<PreparedGroupRecords> {
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
    recordKind: ProtectedGroupRecordKind,
    plaintext: Uint8Array,
    createdAt: Date,
  ): Promise<PreparedProtectedRow> {
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
