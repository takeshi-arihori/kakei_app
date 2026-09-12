import { describe, expect, it } from 'vitest';

import {
  ActorSubject,
  Group,
  GroupId,
  GroupInvariantViolation,
  ParticipantId,
  UtcInstant,
  type GroupSnapshot,
  type ParticipantSnapshot,
} from './group.js';

const joinedAt = UtcInstant.from(new Date('2026-09-07T00:00:00.000Z'));

const participant = (
  id: string,
  subject: string,
  joinOrder: number,
): ParticipantSnapshot => ({
  id: ParticipantId.from(id),
  subject: ActorSubject.from(subject),
  joinedAt,
  joinOrder,
});

const groupSnapshot = (
  participants: readonly ParticipantSnapshot[],
  ownerParticipantId: ParticipantId | null = participants[0]?.id ?? null,
): GroupSnapshot => ({
  id: GroupId.from('group-a'),
  ownerParticipantId,
  participants,
});

const expectViolation = (
  action: () => unknown,
  code: GroupInvariantViolation['code'],
): void => {
  try {
    action();
    expect.fail(`Expected ${code}`);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(GroupInvariantViolation);
    expect((error as GroupInvariantViolation).code).toBe(code);
  }
};

describe('Group', () => {
  it('作成者1人を参加順1の唯一のOwnerとしてGroupを生成する', () => {
    const group = Group.create({
      id: GroupId.from('group-a'),
      initialParticipantId: ParticipantId.from('participant-a'),
      creatorSubject: ActorSubject.from('subject-a'),
      createdAt: joinedAt,
    });

    expect(group.id.value).toBe('group-a');
    expect(group.ownerParticipantId.value).toBe('participant-a');
    expect(group.participants).toEqual([
      {
        id: ParticipantId.from('participant-a'),
        subject: ActorSubject.from('subject-a'),
        joinedAt,
        joinOrder: 1,
      },
    ]);
    expect(group.activeParticipantCount).toBe(1);
  });

  it('同じ利用者が異なるGroupをそれぞれ作成できる', () => {
    const subject = ActorSubject.from('subject-a');

    const first = Group.create({
      id: GroupId.from('group-a'),
      initialParticipantId: ParticipantId.from('participant-a'),
      creatorSubject: subject,
      createdAt: joinedAt,
    });
    const second = Group.create({
      id: GroupId.from('group-b'),
      initialParticipantId: ParticipantId.from('participant-b'),
      creatorSubject: subject,
      createdAt: joinedAt,
    });

    expect(first.id.value).toBe('group-a');
    expect(second.id.value).toBe('group-b');
    expect(first.participants[0]?.subject.equals(subject)).toBe(true);
    expect(second.participants[0]?.subject.equals(subject)).toBe(true);
  });

  it('Owner不在の復元を拒否する', () => {
    expectViolation(
      () => Group.restore(groupSnapshot([participant('p-1', 's-1', 1)], null)),
      'OWNER_MISSING',
    );
  });

  it('Ownerを表すParticipantが重複した復元を拒否する', () => {
    const owner = participant('p-1', 's-1', 1);

    expectViolation(
      () => Group.restore(groupSnapshot([owner, { ...owner }], owner.id)),
      'OWNER_DUPLICATED',
    );
  });

  it('Ownerが同じGroupのParticipantでない復元を拒否する', () => {
    expectViolation(
      () =>
        Group.restore(
          groupSnapshot(
            [participant('p-1', 's-1', 1)],
            ParticipantId.from('participant-from-another-group'),
          ),
        ),
      'OWNER_MEMBERSHIP_MISMATCH',
    );
  });

  it.each([
    { label: '0人', participants: [] },
    {
      label: '5人',
      participants: [
        participant('p-1', 's-1', 1),
        participant('p-2', 's-2', 2),
        participant('p-3', 's-3', 3),
        participant('p-4', 's-4', 4),
        participant('p-5', 's-5', 5),
      ],
    },
  ])('Active Participantが$labelの復元を拒否する', ({ participants }) => {
    expectViolation(
      () => Group.restore(groupSnapshot(participants)),
      'ACTIVE_PARTICIPANT_COUNT_OUT_OF_RANGE',
    );
  });

  it('上限の4人を持つGroupを復元する', () => {
    const restored = Group.restore(
      groupSnapshot([
        participant('p-1', 's-1', 1),
        participant('p-2', 's-2', 2),
        participant('p-3', 's-3', 3),
        participant('p-4', 's-4', 4),
      ]),
    );

    expect(restored.activeParticipantCount).toBe(4);
    expect(restored.ownerParticipantId.value).toBe('p-1');
    expect(restored.participants.map(({ joinOrder }) => joinOrder)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('Owner以外のParticipant ID重複を拒否する', () => {
    expectViolation(
      () =>
        Group.restore(
          groupSnapshot([
            participant('p-1', 's-1', 1),
            participant('p-2', 's-2', 2),
            participant('p-2', 's-3', 3),
          ]),
        ),
      'PARTICIPANT_DUPLICATED',
    );
  });

  it('同じ利用者のActive Participant重複を拒否する', () => {
    expectViolation(
      () =>
        Group.restore(
          groupSnapshot([
            participant('p-1', 'same-subject', 1),
            participant('p-2', 'same-subject', 2),
          ]),
        ),
      'ACTIVE_SUBJECT_DUPLICATED',
    );
  });

  it('参加順の重複を拒否する', () => {
    expectViolation(
      () =>
        Group.restore(
          groupSnapshot([
            participant('p-1', 's-1', 1),
            participant('p-2', 's-2', 1),
          ]),
        ),
      'JOIN_ORDER_DUPLICATED',
    );
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    '不正な参加順 %s を拒否する',
    (joinOrder) => {
      expectViolation(
        () =>
          Group.restore(groupSnapshot([participant('p-1', 's-1', joinOrder)])),
        'JOIN_ORDER_INVALID',
      );
    },
  );

  it('不正な復元を拒否しても入力と既存Groupを変更しない', () => {
    const existing = Group.create({
      id: GroupId.from('existing-group'),
      initialParticipantId: ParticipantId.from('existing-participant'),
      creatorSubject: ActorSubject.from('existing-subject'),
      createdAt: joinedAt,
    });
    const duplicateOwner = participant('p-1', 's-1', 1);
    const invalid = groupSnapshot([duplicateOwner, { ...duplicateOwner }]);
    const beforeInput = invalid.participants.map((value) => ({
      id: value.id.value,
      subject: value.subject.value,
      joinedAt: value.joinedAt.value,
      joinOrder: value.joinOrder,
    }));
    const beforeExisting = existing.toSnapshot();

    expectViolation(() => Group.restore(invalid), 'OWNER_DUPLICATED');

    expect(
      invalid.participants.map((value) => ({
        id: value.id.value,
        subject: value.subject.value,
        joinedAt: value.joinedAt.value,
        joinOrder: value.joinOrder,
      })),
    ).toEqual(beforeInput);
    expect(existing.toSnapshot()).toEqual(beforeExisting);
  });
});

describe('Groupの値', () => {
  it.each([
    ['GroupId', () => GroupId.from('   ')],
    ['ParticipantId', () => ParticipantId.from('')],
    ['ActorSubject', () => ActorSubject.from('\t')],
  ])('%sの空値を拒否する', (_label, action) => {
    expectViolation(action, 'IDENTIFIER_EMPTY');
  });

  it('注入された時刻をUTCの標準形式で保持する', () => {
    expect(UtcInstant.from(new Date('2026-09-07T09:00:00+09:00')).value).toBe(
      '2026-09-07T00:00:00.000Z',
    );
  });

  it('不正な時刻を拒否する', () => {
    expectViolation(
      () => UtcInstant.from(new Date('invalid')),
      'UTC_INSTANT_INVALID',
    );
  });
});
