import { describe, expect, it } from 'vitest';

import {
  CommandFingerprint,
  OperationId,
  type GroupCommandResult,
} from '../../application/group-repository.js';
import {
  ActorSubject,
  CloseIntentId,
  Group,
  GroupId,
  InvitationId,
  ParticipantId,
  UtcInstant,
} from '../../domain/group.js';
import {
  decodeGroupRecordPayload,
  decodeOperationResultPayload,
  encodeGroupRecordPayload,
  encodeOperationResultPayload,
} from './group-record-payload.js';

const groupId = GroupId.from('00000000-0000-4000-8000-000000000194');
const participantId = ParticipantId.from('participant-194');
const actor = ActorSubject.from('actor-194');
const closeIntentId = CloseIntentId.from('close-194');
const at = UtcInstant.from(new Date('2026-09-23T00:00:00.000Z'));

const active = (): Group =>
  Group.create({
    id: groupId,
    initialParticipantId: participantId,
    creatorSubject: actor,
    createdAt: at,
  });

describe('Group protected payload v1', () => {
  it('round-trips Active, Closing with receipts, and Archived state', () => {
    const current = active();
    const cutoff = UtcInstant.from(new Date('2026-09-24T00:00:00.000Z'));
    const completedAt = UtcInstant.from(new Date('2026-09-24T01:00:00.000Z'));
    const fenceReceipt = {
      kind: 'CloseFenceInstalled' as const,
      groupId,
      closeIntentId,
      context: 'ExpenseRecording' as const,
      cutoff,
      fenceVersion: 1,
      completedAt,
      eligible: true,
    };
    const closing = Group.restore({
      id: groupId,
      status: 'Closing',
      ownerParticipantId: participantId,
      participants: current.participants,
      invitations: current.invitations,
      accessPolicyVersion: 2,
      closing: {
        closeIntentId,
        cutoff,
        phase: 'Canceling',
        fenceReceipts: [fenceReceipt],
        unfenceReceipts: [
          {
            kind: 'CloseFenceRemoved',
            groupId,
            closeIntentId,
            context: 'ExpenseRecording',
            cutoff,
            fenceVersion: 1,
            completedAt,
          },
        ],
      },
      ownerAtArchiveParticipantId: null,
      archivedAt: null,
      deleteEligibleAt: null,
    });
    const archived = Group.restore({
      id: groupId,
      status: 'Archived',
      ownerParticipantId: null,
      participants: current.participants,
      invitations: current.invitations,
      accessPolicyVersion: 3,
      closing: null,
      ownerAtArchiveParticipantId: participantId,
      archivedAt: cutoff,
      deleteEligibleAt: cutoff.plusCalendarYearInTokyo(),
    });

    for (const group of [current, closing, archived]) {
      expect(decodeGroupRecordPayload(encodeGroupRecordPayload(group))).toEqual(
        group,
      );
    }
  });

  it('rejects unknown payload versions and extra plaintext fields', () => {
    const plain = JSON.parse(
      new TextDecoder().decode(encodeGroupRecordPayload(active())),
    ) as Record<string, unknown>;
    expect(() =>
      decodeGroupRecordPayload(
        new TextEncoder().encode(
          JSON.stringify({ ...plain, payloadVersion: 2 }),
        ),
      ),
    ).toThrow();
    expect(() =>
      decodeGroupRecordPayload(
        new TextEncoder().encode(
          JSON.stringify({ ...plain, extra: 'not-allowed' }),
        ),
      ),
    ).toThrow();
  });
});

describe('operation result protected payload v1', () => {
  const invitationId = InvitationId.from('invitation-194');
  const common = { groupId, version: 3 };
  const results: GroupCommandResult[] = [
    { ...common, kind: 'GroupCreated', participantId },
    {
      ...common,
      kind: 'OwnershipTransferred',
      ownerParticipantId: participantId,
    },
    {
      ...common,
      kind: 'OwnershipTransferNoOp',
      ownerParticipantId: participantId,
    },
    { ...common, kind: 'ParticipantLeft', participantId },
    { ...common, kind: 'InvitationCreated', invitationId },
    { ...common, kind: 'InvitationCancelled', invitationId },
    { ...common, kind: 'InvitationAccepted', invitationId, participantId },
    { ...common, kind: 'GroupClosingStarted', closeIntentId },
    { ...common, kind: 'GroupCloseFenceReceiptRecorded', closeIntentId },
    { ...common, kind: 'GroupClosingCancellationReserved', closeIntentId },
    { ...common, kind: 'GroupCloseUnfenceReceiptRecorded', closeIntentId },
    { ...common, kind: 'GroupArchived', closeIntentId },
    { ...common, kind: 'GroupClosingCancelled', closeIntentId },
  ];

  it.each(results)('round-trips $kind', (result) => {
    const operation = {
      actorSubject: actor,
      operationId: OperationId.from('operation-194'),
      fingerprint: CommandFingerprint.from('synthetic-fingerprint'),
      result,
    };
    expect(
      decodeOperationResultPayload(encodeOperationResultPayload(operation)),
    ).toEqual(operation);
  });
});
