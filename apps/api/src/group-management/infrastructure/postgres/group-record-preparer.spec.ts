import type { ProtectedRecordCodec } from '../../../shared/infrastructure/protected-record/index.js';
import { describe, expect, it, vi } from 'vitest';

import {
  CommandFingerprint,
  OperationId,
  type CommitGroupRequest,
} from '../../application/group-repository.js';
import {
  actorMembershipIndexDigestInput,
  type GroupActorMembershipIndexKeyPort,
} from '../../application/group-policy-digest.js';
import {
  ActorSubject,
  Group,
  GroupId,
  ParticipantId,
  UtcInstant,
  type GroupSnapshot,
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
    const seal = vi.fn<ProtectedRecordCodec['seal']>(({ header }) =>
      Promise.resolve({
        header: { ...header, keyVersion: 'key-v1' },
        aad: Uint8Array.from([1]),
        nonce: Uint8Array.from([2]),
        ciphertext: Uint8Array.from([3]),
        authenticationTag: Uint8Array.from([4]),
      }),
    );
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
    const currentDigest = vi.fn().mockResolvedValue({
      digest: Uint8Array.from([7]),
      digestKeyVersion: 'membership-v1',
    });
    const preparer = new GroupRecordPreparer({
      codec: { seal },
      accessIndexDigests: { digest },
      membershipIndexKeys: { currentDigest },
      now: () => at,
      nextRecordId: () => ids[nextId++] ?? ids[ids.length - 1],
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
    expect(prepared.membershipIndex).toEqual([
      {
        actorDigest: Uint8Array.from([7]),
        digestKeyVersion: 'membership-v1',
      },
    ]);
    expect(seal).toHaveBeenCalledTimes(2);
    expect(digest).toHaveBeenCalledTimes(1);
    expect(currentDigest).toHaveBeenCalledTimes(1);
  });
});

const instant = (value: string): UtcInstant => UtcInstant.from(new Date(value));
const owner = ParticipantId.from('00000000-0000-4000-8000-000000003091');
const member = ParticipantId.from('00000000-0000-4000-8000-000000003092');
const departed = ParticipantId.from('00000000-0000-4000-8000-000000003093');
const rejoined = ParticipantId.from('00000000-0000-4000-8000-000000003094');
const ownerSubject = ActorSubject.from('owner-309');
const memberSubject = ActorSubject.from('member-309');
const departedSubject = ActorSubject.from('departed-309');

const snapshot = (overrides: Partial<GroupSnapshot> = {}): GroupSnapshot => ({
  id: GroupId.from('00000000-0000-4000-8000-000000003090'),
  status: 'Active',
  ownerParticipantId: owner,
  participants: [
    {
      id: owner,
      subject: ownerSubject,
      joinedAt: instant('2026-11-01T00:00:00.000Z'),
      joinOrder: 1,
      status: 'Active',
      leftAt: null,
    },
    {
      id: member,
      subject: memberSubject,
      joinedAt: instant('2026-11-02T00:00:00.000Z'),
      joinOrder: 2,
      status: 'Left',
      leftAt: instant('2026-11-02T12:00:00.000Z'),
    },
    {
      id: departed,
      subject: departedSubject,
      joinedAt: instant('2026-11-03T00:00:00.000Z'),
      joinOrder: 3,
      status: 'Left',
      leftAt: instant('2026-11-04T00:00:00.000Z'),
    },
    {
      id: rejoined,
      subject: memberSubject,
      joinedAt: instant('2026-11-05T00:00:00.000Z'),
      joinOrder: 4,
      status: 'Active',
      leftAt: null,
    },
  ],
  invitations: [],
  accessPolicyVersion: 4,
  closing: null,
  ownerAtArchiveParticipantId: null,
  archivedAt: null,
  deleteEligibleAt: null,
  ...overrides,
});

const planFor = (group: Group): CommitGroupRequest => ({
  ...request(),
  group,
  result: {
    kind: 'OwnershipTransferNoOp',
    groupId: group.id,
    ownerParticipantId: owner,
  },
});

/** Actor subjectを復元できるFake digest。入力の用途とByte列をそのまま観測する。 */
const echoKeys = (version = 'membership-v1') => {
  const calls: { purpose: string; canonicalInput: Uint8Array }[] = [];
  const port: Pick<GroupActorMembershipIndexKeyPort, 'currentDigest'> = {
    currentDigest(input) {
      calls.push(input);
      return Promise.resolve({
        digest: Uint8Array.from(input.canonicalInput) as never,
        digestKeyVersion: version,
      });
    },
  };
  return { calls, port };
};

const preparerWith = (
  membershipIndexKeys: Pick<GroupActorMembershipIndexKeyPort, 'currentDigest'>,
) =>
  new GroupRecordPreparer({
    codec: {
      seal: ({ header }) =>
        Promise.resolve({
          header: { ...header, keyVersion: 'key-v1' },
          aad: Uint8Array.from([1]),
          nonce: Uint8Array.from([2]),
          ciphertext: Uint8Array.from([3]),
          authenticationTag: Uint8Array.from([4]),
        }),
    },
    accessIndexDigests: {
      digest: () =>
        Promise.resolve({
          digest: Uint8Array.from([9]) as never,
          digestKeyVersion: 'access-v1',
        }),
    },
    membershipIndexKeys,
    now: () => new Date('2026-11-21T00:00:00.000Z'),
    nextRecordId: () => '0194a8aa-3d44-7cc1-8ea0-2c76e48131ac',
  });

const expectedDigests = (...subjects: ActorSubject[]) =>
  subjects.map((subject) => ({
    actorDigest: actorMembershipIndexDigestInput(subject).canonicalInput,
    digestKeyVersion: 'membership-v1',
  }));

describe('GroupRecordPreparerのActor単位Group索引（#309）', () => {
  it('IX-INV-1: Archived以外はActive ParticipantのActorだけを、既存索引と同じ件数で1回ずつ載せる', async () => {
    const { calls, port } = echoKeys();
    const prepared = await preparerWith(port).prepare(
      planFor(Group.restore(snapshot())),
      5,
    );

    expect(prepared.membershipIndex).toEqual(
      expectedDigests(ownerSubject, memberSubject),
    );
    expect(prepared.membershipIndex).toHaveLength(prepared.accessIndex.length);
    expect(calls.map(({ purpose }) => purpose)).toEqual([
      'group-actor-membership-index/v1',
      'group-actor-membership-index/v1',
    ]);
  });

  it('IX-INV-1: ArchivedはownerAtArchiveのActorだけを載せる', async () => {
    const { port } = echoKeys();
    const archived = Group.restore(
      snapshot({
        status: 'Archived',
        ownerParticipantId: null,
        ownerAtArchiveParticipantId: owner,
        archivedAt: instant('2026-11-10T00:00:00.000Z'),
        deleteEligibleAt: instant('2027-11-10T00:00:00.000Z'),
      }),
    );

    const prepared = await preparerWith(port).prepare(planFor(archived), 6);

    expect(prepared.membershipIndex).toEqual(expectedDigests(ownerSubject));
    expect(prepared.accessIndex).toHaveLength(1);
  });

  it.each([
    {
      label: 'Portの例外',
      currentDigest: () => Promise.reject(new Error('provider unavailable')),
    },
    {
      label: '空digest',
      currentDigest: () =>
        Promise.resolve({
          digest: new Uint8Array() as never,
          digestKeyVersion: 'membership-v1',
        }),
    },
    {
      label: '不正な鍵版',
      currentDigest: () =>
        Promise.resolve({
          digest: Uint8Array.from([1]) as never,
          digestKeyVersion: 'bad version',
        }),
    },
    {
      label: '準備中の現行鍵版の切替（1 Groupで鍵版が混在）',
      currentDigest: (() => {
        let calls = 0;
        return () =>
          Promise.resolve({
            digest: Uint8Array.from([1]) as never,
            digestKeyVersion: calls++ === 0 ? 'membership-v1' : 'membership-v2',
          });
      })(),
    },
    {
      label: 'Uint8Array以外のdigest',
      currentDigest: () =>
        Promise.resolve({
          digest: [1] as never,
          digestKeyVersion: 'membership-v1',
        }),
    },
  ])('IX-FAIL-1: $labelは準備全体を失敗させる', async ({ currentDigest }) => {
    await expect(
      preparerWith({ currentDigest }).prepare(
        planFor(Group.restore(snapshot())),
        5,
      ),
    ).rejects.toThrow();
  });
});
