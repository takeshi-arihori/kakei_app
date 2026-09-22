import { describe, expect, it } from 'vitest';

import {
  ActorSubject,
  Group,
  GroupId,
  GroupInvariantViolation,
  InvitationId,
  ParticipantId,
  UtcInstant,
  type GroupSnapshot,
  type InvitationSnapshot,
  type ParticipantSnapshot,
} from './group.js';

const instant = (value: string): UtcInstant => UtcInstant.from(new Date(value));
const createdAt = instant('2026-09-13T00:00:00.000Z');
const acceptedAt = instant('2026-09-14T00:00:00.000Z');
const deleteEligibleAt = acceptedAt.plusCalendarYearInTokyo();

const active = (
  id: string,
  subject: string,
  joinOrder: number,
): ParticipantSnapshot => ({
  id: ParticipantId.from(id),
  subject: ActorSubject.from(subject),
  joinedAt: createdAt,
  joinOrder,
  status: 'Active',
  leftAt: null,
});

const left = (
  id: string,
  subject: string,
  joinOrder: number,
): ParticipantSnapshot => ({
  ...active(id, subject, joinOrder),
  status: 'Left',
  leftAt: acceptedAt,
});

const invitation = (
  status: InvitationSnapshot['status'] = 'Pending',
  overrides: Partial<InvitationSnapshot> = {},
): InvitationSnapshot => ({
  id: InvitationId.from('invitation-a'),
  targetSubject: ActorSubject.from('new-subject'),
  issuerParticipantId: ParticipantId.from('p-owner'),
  createdAt,
  expiryAt: instant('2026-09-20T00:00:00.000Z'),
  status,
  resultingParticipantId: null,
  ...overrides,
});

const group = (
  participants: readonly ParticipantSnapshot[] = [
    active('p-owner', 'owner-subject', 1),
    active('p-member', 'member-subject', 2),
    active('p-third', 'third-subject', 3),
  ],
  invitations: readonly InvitationSnapshot[] = [],
  status: GroupSnapshot['status'] = 'Active',
): Group =>
  Group.restore({
    id: GroupId.from('00000000-0000-4000-8000-000000000001'),
    status,
    ownerParticipantId:
      status === 'Active' ? ParticipantId.from('p-owner') : null,
    participants,
    invitations,
    accessPolicyVersion: 1,
    closing: null,
    ownerAtArchiveParticipantId:
      status === 'Archived' ? (participants[0]?.id ?? null) : null,
    archivedAt: status === 'Archived' ? acceptedAt : null,
    deleteEligibleAt: status === 'Archived' ? deleteEligibleAt : null,
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

const invite = (source: Group, id = 'invitation-a', target = 'new-subject') =>
  source.inviteParticipant({
    actorSubject: ActorSubject.from('owner-subject'),
    invitationId: InvitationId.from(id),
    targetSubject: ActorSubject.from(target),
    createdAt,
  });

describe('Invitation lifecycleの復元', () => {
  it.each(['Pending', 'Cancelled', 'Expired'] as const)(
    '%s状態を未消費のInvitationとして復元する',
    (status) => {
      const restored = group(undefined, [invitation(status)]);

      expect(restored.invitations[0]?.status).toBe(status);
      expect(restored.invitations[0]?.resultingParticipantId).toBeNull();
    },
  );

  it('Consumedは宛先本人の有効期間内に作られたParticipantへ束縛する', () => {
    const participants = [
      active('p-owner', 'owner-subject', 1),
      active('p-result', 'new-subject', 2),
    ];
    const consumed = invitation('Consumed', {
      resultingParticipantId: ParticipantId.from('p-result'),
    });

    expect(group(participants, [consumed]).invitations[0]).toEqual(consumed);

    expectViolation(
      () =>
        group(participants, [
          invitation('Consumed', {
            targetSubject: ActorSubject.from('different-subject'),
            resultingParticipantId: ParticipantId.from('p-result'),
          }),
        ]),
      'INVITATION_RESULT_INVALID',
    );
  });

  it('作成時に在籍していないissuerと不正な消費結果を拒否する', () => {
    expectViolation(
      () =>
        group(undefined, [
          invitation('Pending', {
            issuerParticipantId: ParticipantId.from('missing-participant'),
          }),
        ]),
      'INVITATION_ISSUER_NOT_FOUND',
    );
    expectViolation(
      () =>
        group(undefined, [
          invitation('Consumed', { resultingParticipantId: null }),
        ]),
      'INVITATION_RESULT_INVALID',
    );
  });

  it.each([
    instant('2026-09-19T00:00:00.000Z'),
    instant('2026-09-21T00:00:00.000Z'),
  ])('7日未満・超のexpiryAtを復元せず期限延長を許さない', (expiryAt) => {
    expectViolation(
      () => group(undefined, [invitation('Pending', { expiryAt })]),
      'INVITATION_EXPIRY_INVALID',
    );
  });
});

describe('Group.inviteParticipant', () => {
  it('Ownerが宛先に束縛した7日期限のPending Invitationを作る', () => {
    const original = group();

    const result = invite(original);

    expect(result.invitation).toEqual({
      id: InvitationId.from('invitation-a'),
      targetSubject: ActorSubject.from('new-subject'),
      issuerParticipantId: ParticipantId.from('p-owner'),
      createdAt,
      expiryAt: instant('2026-09-20T00:00:00.000Z'),
      status: 'Pending',
      resultingParticipantId: null,
    });
    expect(result.group.invitations).toEqual([result.invitation]);
    expect(result.group.accessPolicyVersion).toBe(
      original.accessPolicyVersion + 1,
    );
    expect(result.group.activeParticipantCount).toBe(3);
    expect(original.invitations).toEqual([]);
  });

  it('3人Groupでは複数Pendingを作っても人数枠を予約しない', () => {
    const first = invite(group());
    const second = first.group.inviteParticipant({
      actorSubject: ActorSubject.from('owner-subject'),
      invitationId: InvitationId.from('invitation-b'),
      targetSubject: ActorSubject.from('another-subject'),
      createdAt,
    });

    expect(second.group.invitations).toHaveLength(2);
    expect(second.group.activeParticipantCount).toBe(3);
  });

  it('4人・非Owner・Active重複・Archivedでは作成しない', () => {
    const fourPeople = group([
      active('p-owner', 'owner-subject', 1),
      active('p-2', 's-2', 2),
      active('p-3', 's-3', 3),
      active('p-4', 's-4', 4),
    ]);
    expectViolation(() => invite(fourPeople), 'GROUP_CAPACITY_REACHED');

    expectViolation(
      () =>
        group().inviteParticipant({
          actorSubject: ActorSubject.from('member-subject'),
          invitationId: InvitationId.from('invitation-a'),
          targetSubject: ActorSubject.from('new-subject'),
          createdAt,
        }),
      'NOT_CURRENT_OWNER',
    );

    expectViolation(
      () => invite(group(), 'invitation-a', 'member-subject'),
      'ACTIVE_SUBJECT_DUPLICATED',
    );

    expectViolation(
      () =>
        invite(group([active('p-owner', 'owner-subject', 1)], [], 'Archived')),
      'GROUP_NOT_ACTIVE',
    );
  });
});

describe('Group.cancelInvitation', () => {
  it('Owner譲渡後もPendingを維持し現在Ownerだけが取消す', () => {
    const invited = invite(group()).group;
    const transferred = invited.transferOwnership({
      actorSubject: ActorSubject.from('owner-subject'),
      targetParticipantId: ParticipantId.from('p-member'),
    }).group;

    expectViolation(
      () =>
        transferred.cancelInvitation({
          actorSubject: ActorSubject.from('owner-subject'),
          invitationId: InvitationId.from('invitation-a'),
          cancelledAt: acceptedAt,
        }),
      'NOT_CURRENT_OWNER',
    );

    const cancelled = transferred.cancelInvitation({
      actorSubject: ActorSubject.from('member-subject'),
      invitationId: InvitationId.from('invitation-a'),
      cancelledAt: acceptedAt,
    });
    expect(cancelled.invitation.status).toBe('Cancelled');
    expect(cancelled.group.accessPolicyVersion).toBe(
      transferred.accessPolicyVersion + 1,
    );
    expect(cancelled.group.invitations[0]?.status).toBe('Cancelled');
    expect(transferred.invitations[0]?.status).toBe('Pending');
  });
});

describe('Group.acceptInvitation', () => {
  it('宛先本人の受諾でInvitation消費と新Participantを同じGroup結果にする', () => {
    const invited = invite(group()).group;

    const result = invited.acceptInvitation({
      actorSubject: ActorSubject.from('new-subject'),
      invitationId: InvitationId.from('invitation-a'),
      participantId: ParticipantId.from('p-new'),
      acceptedAt,
    });

    expect(result.participant).toEqual({
      id: ParticipantId.from('p-new'),
      subject: ActorSubject.from('new-subject'),
      joinedAt: acceptedAt,
      joinOrder: 4,
      status: 'Active',
      leftAt: null,
    });
    expect(result.invitation.status).toBe('Consumed');
    expect(result.invitation.resultingParticipantId).toEqual(
      ParticipantId.from('p-new'),
    );
    expect(result.group.activeParticipantCount).toBe(4);
    expect(result.group.accessPolicyVersion).toBe(
      invited.accessPolicyVersion + 1,
    );
    expect(invited.activeParticipantCount).toBe(3);
    expect(invited.invitations[0]?.status).toBe('Pending');
  });

  it('Left Actorの再参加は旧Participantを残して新IDと過去最大+1のjoinOrderを使う', () => {
    const previous = left('p-old', 'returning-subject', 5);
    const invited = invite(
      group([
        active('p-owner', 'owner-subject', 1),
        active('p-member', 'member-subject', 3),
        previous,
      ]),
      'invitation-return',
      'returning-subject',
    ).group;

    const accepted = invited.acceptInvitation({
      actorSubject: ActorSubject.from('returning-subject'),
      invitationId: InvitationId.from('invitation-return'),
      participantId: ParticipantId.from('p-return'),
      acceptedAt: instant('2026-09-15T00:00:00.000Z'),
    });

    expect(accepted.group.participants).toContainEqual(previous);
    expect(accepted.participant.id.value).toBe('p-return');
    expect(accepted.participant.joinOrder).toBe(6);
  });

  it('別Actor・期限到達・取消済み・消費済みを拒否して元状態を変えない', () => {
    const invited = invite(group()).group;
    const before = invited.toSnapshot();

    expectViolation(
      () =>
        invited.acceptInvitation({
          actorSubject: ActorSubject.from('another-subject'),
          invitationId: InvitationId.from('invitation-a'),
          participantId: ParticipantId.from('p-other'),
          acceptedAt,
        }),
      'INVITATION_TARGET_MISMATCH',
    );
    expectViolation(
      () =>
        invited.acceptInvitation({
          actorSubject: ActorSubject.from('new-subject'),
          invitationId: InvitationId.from('invitation-a'),
          participantId: ParticipantId.from('p-new'),
          acceptedAt: instant('2026-09-20T00:00:00.000Z'),
        }),
      'INVITATION_EXPIRED',
    );

    const cancelled = invited.cancelInvitation({
      actorSubject: ActorSubject.from('owner-subject'),
      invitationId: InvitationId.from('invitation-a'),
      cancelledAt: acceptedAt,
    }).group;
    expectViolation(
      () =>
        cancelled.acceptInvitation({
          actorSubject: ActorSubject.from('new-subject'),
          invitationId: InvitationId.from('invitation-a'),
          participantId: ParticipantId.from('p-new'),
          acceptedAt,
        }),
      'INVITATION_NOT_PENDING',
    );

    const consumed = invited.acceptInvitation({
      actorSubject: ActorSubject.from('new-subject'),
      invitationId: InvitationId.from('invitation-a'),
      participantId: ParticipantId.from('p-new'),
      acceptedAt,
    }).group;
    expectViolation(
      () =>
        consumed.acceptInvitation({
          actorSubject: ActorSubject.from('new-subject'),
          invitationId: InvitationId.from('invitation-a'),
          participantId: ParticipantId.from('p-next'),
          acceptedAt,
        }),
      'INVITATION_NOT_PENDING',
    );
    expect(invited.toSnapshot()).toEqual(before);
  });

  it('受諾時に4人なら空き枠を再検証して拒否する', () => {
    const pending = invite(group()).invitation;
    const full = group(
      [
        active('p-owner', 'owner-subject', 1),
        active('p-2', 's-2', 2),
        active('p-3', 's-3', 3),
        active('p-4', 's-4', 4),
      ],
      [pending],
    );

    expectViolation(
      () =>
        full.acceptInvitation({
          actorSubject: ActorSubject.from('new-subject'),
          invitationId: InvitationId.from('invitation-a'),
          participantId: ParticipantId.from('p-new'),
          acceptedAt,
        }),
      'GROUP_CAPACITY_REACHED',
    );
  });

  it('発行後に宛先Actorが別InvitationでActiveになった場合は重複受諾を拒否する', () => {
    const twoPeople = group([
      active('p-owner', 'owner-subject', 1),
      active('p-member', 'member-subject', 2),
    ]);
    const first = invite(twoPeople, 'invitation-a', 'new-subject').group;
    const second = invite(first, 'invitation-b', 'new-subject').group;
    const activated = second.acceptInvitation({
      actorSubject: ActorSubject.from('new-subject'),
      invitationId: InvitationId.from('invitation-b'),
      participantId: ParticipantId.from('p-new'),
      acceptedAt,
    }).group;
    const before = activated.toSnapshot();

    expectViolation(
      () =>
        activated.acceptInvitation({
          actorSubject: ActorSubject.from('new-subject'),
          invitationId: InvitationId.from('invitation-a'),
          participantId: ParticipantId.from('p-duplicate'),
          acceptedAt,
        }),
      'ACTIVE_SUBJECT_DUPLICATED',
    );
    expect(activated.toSnapshot()).toEqual(before);
  });

  it('Pendingを保持していてもArchived Groupでは受諾しない', () => {
    const invited = invite(group()).group;
    const archived = Group.restore({
      ...invited.toSnapshot(),
      status: 'Archived',
      ownerParticipantId: null,
      ownerAtArchiveParticipantId: ParticipantId.from('p-owner'),
      archivedAt: acceptedAt,
      deleteEligibleAt,
    });
    const before = archived.toSnapshot();

    expectViolation(
      () =>
        archived.acceptInvitation({
          actorSubject: ActorSubject.from('new-subject'),
          invitationId: InvitationId.from('invitation-a'),
          participantId: ParticipantId.from('p-new'),
          acceptedAt,
        }),
      'GROUP_NOT_ACTIVE',
    );
    expect(archived.toSnapshot()).toEqual(before);
  });
});
