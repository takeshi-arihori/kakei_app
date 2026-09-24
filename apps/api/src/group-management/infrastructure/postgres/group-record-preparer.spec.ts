import type { ProtectedRecordCodec } from '@kakei/protected-record';
import { describe, expect, it, vi } from 'vitest';

import {
  CommandFingerprint,
  OperationId,
  type CommitGroupRequest,
} from '../../application/group-repository.js';
import {
  ActorSubject,
  Group,
  GroupId,
  ParticipantId,
  UtcInstant,
} from '../../domain/group.js';
import { GroupRecordPreparer } from './group-record-preparer.js';

const request = (): CommitGroupRequest => {
  const groupId = GroupId.from('0194a8aa-3d44-7cc1-8ea0-2c76e48131aa');
  const actor = ActorSubject.from('actor:record-preparer-test');
  const participantId = ParticipantId.from(
    '0194a8aa-3d44-7cc1-8ea0-2c76e48131ab',
  );
  const createdAt = UtcInstant.from(new Date('2026-09-23T02:00:00.000Z'));
  const group = Group.create({
    id: groupId,
    creatorSubject: actor,
    initialParticipantId: participantId,
    createdAt,
  });

  return {
    group,
    expectedVersion: 3,
    stateChanged: true,
    membershipChanges: [],
    invitationChanges: [],
    groupCloseChanges: [],
    operation: {
      actorSubject: actor,
      operationId: OperationId.from('operation:record-preparer-test'),
      fingerprint: CommandFingerprint.from('fingerprint:record-preparer-test'),
    },
    result: {
      kind: 'OwnershipTransferNoOp',
      groupId,
      ownerParticipantId: participantId,
    },
  };
};

describe('GroupRecordPreparer', () => {
  it('protected recordとaccess indexをDB書込から独立して準備する', async () => {
    const seal = vi.fn<ProtectedRecordCodec['seal']>(async ({ header }) => ({
      header: { ...header, keyVersion: 'key-v1' },
      aad: Uint8Array.from([1]),
      nonce: Uint8Array.from([2]),
      ciphertext: Uint8Array.from([3]),
      authenticationTag: Uint8Array.from([4]),
    }));
    const digest = vi.fn().mockResolvedValue({
      digest: Uint8Array.from([9]),
      digestKeyVersion: 'digest-v1',
    });
    const ids = [
      '0194a8aa-3d44-7cc1-8ea0-2c76e48131ac',
      '0194a8aa-3d44-7cc1-8ea0-2c76e48131ad',
    ];
    let nextId = 0;
    const at = new Date('2026-09-23T03:00:00.000Z');
    const preparer = new GroupRecordPreparer({
      codec: { seal },
      accessIndexDigests: { digest },
      now: () => at,
      nextRecordId: () => ids[nextId++] ?? ids[ids.length - 1]!,
    });

    const prepared = await preparer.prepare(request(), 4);

    expect(prepared.aggregate.recordKind).toBe('group');
    expect(prepared.aggregate.aggregateVersion).toBe(4);
    expect(prepared.aggregate.createdAt).toBe(at);
    expect(prepared.participants).toHaveLength(1);
    expect(prepared.participants[0]?.recordKind).toBe('participant');
    expect(prepared.invitations).toEqual([]);
    expect(prepared.membershipHistory).toEqual([]);
    expect(prepared.invitationHistory).toEqual([]);
    expect(prepared.closeHistory).toEqual([]);
    expect(prepared.accessIndex).toEqual([
      {
        actorDigest: Uint8Array.from([9]),
        digestKeyVersion: 'digest-v1',
      },
    ]);
    expect(seal).toHaveBeenCalledTimes(2);
    expect(digest).toHaveBeenCalledTimes(1);
  });
});
