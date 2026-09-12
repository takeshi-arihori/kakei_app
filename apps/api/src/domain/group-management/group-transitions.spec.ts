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

const instant = (value: string): UtcInstant => UtcInstant.from(new Date(value));
const joinedAt = instant('2026-09-07T00:00:00.000Z');
const later = instant('2026-09-08T00:00:00.000Z');

const active = (
  id: string,
  subject: string,
  joinOrder: number,
): ParticipantSnapshot => ({
  id: ParticipantId.from(id),
  subject: ActorSubject.from(subject),
  joinedAt,
  joinOrder,
  status: 'Active',
  leftAt: null,
});

const left = (
  id: string,
  subject: string,
  joinOrder: number,
  leftAt = later,
): ParticipantSnapshot => ({
  ...active(id, subject, joinOrder),
  status: 'Left',
  leftAt,
});

const snapshot = (
  participants: readonly ParticipantSnapshot[],
  options: Partial<Pick<GroupSnapshot, 'status' | 'ownerParticipantId'>> = {},
): GroupSnapshot => ({
  id: GroupId.from('group-a'),
  status: options.status ?? 'Active',
  ownerParticipantId:
    options.ownerParticipantId === undefined
      ? (participants.find(({ status }) => status === 'Active')?.id ?? null)
      : options.ownerParticipantId,
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

describe('Groupの復元', () => {
  it('4人のActive Participantと人数に含めないLeft履歴を復元する', () => {
    const group = Group.restore(
      snapshot([
        active('p-1', 's-1', 1),
        active('p-2', 's-2', 2),
        active('p-3', 's-3', 3),
        active('p-4', 's-4', 4),
        left('p-5', 's-5', 5),
      ]),
    );

    expect(group.activeParticipantCount).toBe(4);
    expect(group.participants).toHaveLength(5);
    expect(group.participants[4]).toEqual(left('p-5', 's-5', 5));
  });

  it.each([
    {
      label: '0人',
      participants: [left('p-1', 's-1', 1)],
      ownerParticipantId: null,
    },
    {
      label: '5人',
      participants: [
        active('p-1', 's-1', 1),
        active('p-2', 's-2', 2),
        active('p-3', 's-3', 3),
        active('p-4', 's-4', 4),
        active('p-5', 's-5', 5),
        left('p-6', 's-6', 6),
      ],
      ownerParticipantId: ParticipantId.from('p-1'),
    },
  ])('Active Participantが$labelのActive Groupを拒否する', (input) => {
    expectViolation(
      () =>
        Group.restore(
          snapshot(input.participants, {
            ownerParticipantId: input.ownerParticipantId,
          }),
        ),
      'ACTIVE_PARTICIPANT_COUNT_OUT_OF_RANGE',
    );
  });

  it('Left ParticipantをOwnerとするActive Groupを拒否する', () => {
    expectViolation(
      () =>
        Group.restore(
          snapshot([active('p-1', 's-1', 1), left('p-2', 's-2', 2)], {
            ownerParticipantId: ParticipantId.from('p-2'),
          }),
        ),
      'OWNER_NOT_ACTIVE',
    );
  });

  it('Left履歴とActive在籍のParticipant ID重複を拒否する', () => {
    expectViolation(
      () =>
        Group.restore(
          snapshot([
            active('p-1', 's-1', 1),
            active('p-2', 's-2', 2),
            left('p-2', 's-3', 3),
          ]),
        ),
      'PARTICIPANT_DUPLICATED',
    );
  });

  it('Left履歴とActive在籍のActorSubject重複を再参加未決として拒否する', () => {
    expectViolation(
      () =>
        Group.restore(
          snapshot([
            active('p-1', 'same-subject', 1),
            left('p-2', 'same-subject', 2),
          ]),
        ),
      'REJOIN_NOT_DECIDED',
    );
  });

  it('Left履歴とActive在籍の参加順重複を拒否する', () => {
    expectViolation(
      () =>
        Group.restore(
          snapshot([active('p-1', 's-1', 1), left('p-2', 's-2', 1)]),
        ),
      'JOIN_ORDER_DUPLICATED',
    );
  });

  it('参加時刻より前の脱退時刻を拒否する', () => {
    expectViolation(
      () =>
        Group.restore(
          snapshot([
            active('p-1', 's-1', 1),
            left('p-2', 's-2', 2, instant('2026-09-06T23:59:59.999Z')),
          ]),
        ),
      'LEFT_AT_BEFORE_JOINED_AT',
    );
  });

  it('Active Participantの脱退時刻を拒否する', () => {
    expectViolation(
      () =>
        Group.restore(
          snapshot([
            { ...active('p-1', 's-1', 1), leftAt: later },
            active('p-2', 's-2', 2),
          ]),
        ),
      'LEFT_AT_NOT_ALLOWED',
    );
  });

  it('Left Participantの脱退時刻欠落を拒否する', () => {
    expectViolation(
      () =>
        Group.restore(
          snapshot([
            active('p-1', 's-1', 1),
            { ...left('p-2', 's-2', 2), leftAt: null },
          ]),
        ),
      'LEFT_AT_REQUIRED',
    );
  });

  it('参加と同時刻の脱退履歴を復元する', () => {
    const group = Group.restore(
      snapshot([active('p-1', 's-1', 1), left('p-2', 's-2', 2, joinedAt)]),
    );

    expect(group.participants[1]?.leftAt?.equals(joinedAt)).toBe(true);
  });
});

describe('Group.transferOwnership', () => {
  const activeGroup = (): Group =>
    Group.restore(
      snapshot([
        active('p-owner', 'owner-subject', 1),
        active('p-target', 'target-subject', 2),
        left('p-left', 'left-subject', 3),
      ]),
    );

  it('現在Ownerが同GroupのActive ParticipantへOwnerを譲渡する', () => {
    const original = activeGroup();

    const result = original.transferOwnership({
      actorSubject: ActorSubject.from('owner-subject'),
      targetParticipantId: ParticipantId.from('p-target'),
    });

    expect(result.result).toBe('Transferred');
    expect(result.group.ownerParticipantId?.value).toBe('p-target');
    expect(result.group.activeParticipantCount).toBe(2);
    expect(
      result.group.participants.find(({ id }) => id.value === 'p-owner')
        ?.status,
    ).toBe('Active');
    expect(original.ownerParticipantId?.value).toBe('p-owner');
  });

  it('非Ownerの譲渡を拒否して状態を変えない', () => {
    const group = activeGroup();
    const before = group.toSnapshot();

    expectViolation(
      () =>
        group.transferOwnership({
          actorSubject: ActorSubject.from('target-subject'),
          targetParticipantId: ParticipantId.from('p-target'),
        }),
      'NOT_CURRENT_OWNER',
    );
    expect(group.toSnapshot()).toEqual(before);
  });

  it.each(['p-left', 'participant-from-another-group'])(
    'Leftまたは他Groupの譲渡先 %s を拒否する',
    (targetParticipantId) => {
      expectViolation(
        () =>
          activeGroup().transferOwnership({
            actorSubject: ActorSubject.from('owner-subject'),
            targetParticipantId: ParticipantId.from(targetParticipantId),
          }),
        'TARGET_PARTICIPANT_NOT_ACTIVE',
      );
    },
  );

  it('自己譲渡をNo-opとして状態を変えない', () => {
    const group = activeGroup();
    const before = group.toSnapshot();

    const result = group.transferOwnership({
      actorSubject: ActorSubject.from('owner-subject'),
      targetParticipantId: ParticipantId.from('p-owner'),
    });

    expect(result.result).toBe('NoOp');
    expect(result.group).toBe(group);
    expect(group.toSnapshot()).toEqual(before);
  });
});

describe('Group.leave', () => {
  const activeGroup = (): Group =>
    Group.restore(
      snapshot([
        active('p-owner', 'owner-subject', 1),
        active('p-member', 'member-subject', 2),
      ]),
    );

  it('Active Participant本人が脱退し過去IDと時刻を保持する', () => {
    const original = activeGroup();

    const result = original.leave({
      actorSubject: ActorSubject.from('member-subject'),
      participantId: ParticipantId.from('p-member'),
      leftAt: later,
    });

    expect(result.result).toBe('Left');
    expect(result.group.activeParticipantCount).toBe(1);
    expect(result.group.participants[1]).toEqual({
      ...active('p-member', 'member-subject', 2),
      status: 'Left',
      leftAt: later,
    });
    expect(original.activeParticipantCount).toBe(2);
  });

  it('Ownerの脱退を拒否する', () => {
    expectViolation(
      () =>
        activeGroup().leave({
          actorSubject: ActorSubject.from('owner-subject'),
          participantId: ParticipantId.from('p-owner'),
          leftAt: later,
        }),
      'OWNER_MUST_TRANSFER_OR_END',
    );
  });

  it('ActorSubjectとParticipantが一致しない脱退を拒否する', () => {
    expectViolation(
      () =>
        activeGroup().leave({
          actorSubject: ActorSubject.from('another-subject'),
          participantId: ParticipantId.from('p-member'),
          leftAt: later,
        }),
      'ACTOR_PARTICIPANT_MISMATCH',
    );
  });

  it('Left Participantの再脱退をAlreadyLeftとして拒否する', () => {
    const group = Group.restore(
      snapshot([
        active('p-owner', 'owner-subject', 1),
        left('p-left', 'left-subject', 2),
      ]),
    );

    expectViolation(
      () =>
        group.leave({
          actorSubject: ActorSubject.from('left-subject'),
          participantId: ParticipantId.from('p-left'),
          leftAt: later,
        }),
      'ALREADY_LEFT',
    );
  });

  it('参加時刻より前の時刻での脱退を拒否する', () => {
    const group = activeGroup();
    const before = group.toSnapshot();

    expectViolation(
      () =>
        group.leave({
          actorSubject: ActorSubject.from('member-subject'),
          participantId: ParticipantId.from('p-member'),
          leftAt: instant('2026-09-06T23:59:59.999Z'),
        }),
      'LEFT_AT_BEFORE_JOINED_AT',
    );
    expect(group.toSnapshot()).toEqual(before);
  });
});

describe('Archived Group', () => {
  const archived = (): Group =>
    Group.restore(
      snapshot([left('p-1', 's-1', 1)], {
        status: 'Archived',
        ownerParticipantId: null,
      }),
    );

  it('Owner譲渡をGroupNotActiveとして拒否する', () => {
    expectViolation(
      () =>
        archived().transferOwnership({
          actorSubject: ActorSubject.from('s-1'),
          targetParticipantId: ParticipantId.from('p-1'),
        }),
      'GROUP_NOT_ACTIVE',
    );
  });

  it('脱退をGroupNotActiveとして拒否する', () => {
    expectViolation(
      () =>
        archived().leave({
          actorSubject: ActorSubject.from('s-1'),
          participantId: ParticipantId.from('p-1'),
          leftAt: later,
        }),
      'GROUP_NOT_ACTIVE',
    );
  });
});
