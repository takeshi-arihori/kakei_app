import { describe, expect, it } from 'vitest';

import {
  ActorSubject,
  CloseIntentId,
  Group,
  GroupId,
  GroupInvariantViolation,
  InvitationId,
  ParticipantId,
  UtcInstant,
  type CloseFenceReceipt,
  type CloseUnfenceReceipt,
  type GroupSnapshot,
} from './group.js';

const instant = (value: string): UtcInstant => UtcInstant.from(new Date(value));
const owner = ParticipantId.from('participant-owner');
const ownerSubject = ActorSubject.from('owner-subject');
const groupId = GroupId.from('00000000-0000-4000-8000-000000000001');
const intentId = CloseIntentId.from('close-intent-a');
const cutoff = instant('2026-09-21T00:00:00.000Z');

const activeSnapshot = (): GroupSnapshot => ({
  id: groupId,
  status: 'Active',
  ownerParticipantId: owner,
  participants: [
    {
      id: owner,
      subject: ownerSubject,
      joinedAt: instant('2026-09-01T00:00:00.000Z'),
      joinOrder: 1,
      status: 'Active',
      leftAt: null,
    },
  ],
  invitations: [],
  accessPolicyVersion: 1,
  closing: null,
  ownerAtArchiveParticipantId: null,
  archivedAt: null,
  deleteEligibleAt: null,
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

const startClosing = (): Group =>
  Group.restore(activeSnapshot()).startClosing({
    actorSubject: ownerSubject,
    closeIntentId: intentId,
    cutoff,
  }).group;

const fenceReceipt = (
  context: CloseFenceReceipt['context'],
  overrides: Partial<CloseFenceReceipt> = {},
): CloseFenceReceipt => ({
  kind: 'CloseFenceInstalled',
  groupId,
  closeIntentId: intentId,
  context,
  cutoff,
  fenceVersion: 1,
  eligible: true,
  completedAt: instant('2026-09-21T00:01:00.000Z'),
  ...overrides,
});

const unfenceReceipt = (
  context: CloseUnfenceReceipt['context'],
  overrides: Partial<CloseUnfenceReceipt> = {},
): CloseUnfenceReceipt => ({
  kind: 'CloseFenceRemoved',
  groupId,
  closeIntentId: intentId,
  context,
  cutoff,
  fenceVersion: 1,
  completedAt: instant('2026-09-21T00:02:00.000Z'),
  ...overrides,
});

describe('Group close lifecycle', () => {
  it('current OwnerだけがActive GroupをClosingへ遷移させる', () => {
    const original = Group.restore(activeSnapshot());
    const started = original.startClosing({
      actorSubject: ownerSubject,
      closeIntentId: intentId,
      cutoff,
    }).group;

    expect(started.status).toBe('Closing');
    expect(started.closing).toMatchObject({
      closeIntentId: intentId,
      cutoff,
      phase: 'Fencing',
      fenceReceipts: [],
      unfenceReceipts: [],
    });
    expect(started.accessPolicyVersion).toBe(2);
    expect(original.toSnapshot()).toEqual(activeSnapshot());

    expectViolation(
      () =>
        original.startClosing({
          actorSubject: ActorSubject.from('member-subject'),
          closeIntentId: intentId,
          cutoff,
        }),
      'NOT_CURRENT_OWNER',
    );
  });

  it('Groupへ束縛された両Contextのclear ReceiptだけでArchiveする', () => {
    const closing = startClosing();

    expectViolation(
      () =>
        closing.recordCloseFenceReceipt(
          fenceReceipt('ExpenseRecording', {
            groupId: GroupId.from('00000000-0000-4000-8000-00000000000a'),
          }),
        ),
      'CLOSE_RECEIPT_MISMATCH',
    );

    const expenseRecorded = closing.recordCloseFenceReceipt(
      fenceReceipt('ExpenseRecording'),
    ).group;
    expect(expenseRecorded.accessPolicyVersion).toBe(3);
    expectViolation(
      () =>
        expenseRecorded.archive({
          actorSubject: ownerSubject,
          closeIntentId: intentId,
          archivedAt: instant('2026-09-21T03:00:00.000Z'),
        }),
      'CLOSE_RECEIPT_MISSING',
    );

    const ready = expenseRecorded.recordCloseFenceReceipt(
      fenceReceipt('Settlement'),
    ).group;
    const archived = ready.archive({
      actorSubject: ownerSubject,
      closeIntentId: intentId,
      archivedAt: instant('2026-09-21T03:00:00.000Z'),
    }).group;

    expect(archived.status).toBe('Archived');
    expect(archived.ownerParticipantId).toBeNull();
    expect(archived.ownerAtArchiveParticipantId).toEqual(owner);
    expect(archived.archivedAt?.value).toBe('2026-09-21T03:00:00.000Z');
    expect(archived.deleteEligibleAt?.value).toBe('2027-09-21T03:00:00.000Z');
    expect(archived.accessPolicyVersion).toBe(5);
  });

  it.each([
    {
      label: '別Intent',
      receipt: fenceReceipt('ExpenseRecording', {
        closeIntentId: CloseIntentId.from('another-intent'),
      }),
    },
    {
      label: '別cutoff',
      receipt: fenceReceipt('ExpenseRecording', {
        cutoff: instant('2026-09-21T00:00:00.001Z'),
      }),
    },
    {
      label: '不正なfence version',
      receipt: fenceReceipt('ExpenseRecording', { fenceVersion: 0 }),
    },
  ])('$label のReceiptを拒否する', ({ receipt }) => {
    const closing = startClosing();
    const before = closing.toSnapshot();

    expectViolation(
      () => closing.recordCloseFenceReceipt(receipt),
      'CLOSE_RECEIPT_MISMATCH',
    );
    expect(closing.toSnapshot()).toEqual(before);
  });

  it('終了不可ReceiptではArchiveせず状態を維持する', () => {
    const closing = startClosing()
      .recordCloseFenceReceipt(
        fenceReceipt('ExpenseRecording', { eligible: false }),
      )
      .group.recordCloseFenceReceipt(fenceReceipt('Settlement')).group;
    const before = closing.toSnapshot();

    expectViolation(
      () =>
        closing.archive({
          actorSubject: ownerSubject,
          closeIntentId: intentId,
          archivedAt: instant('2026-09-21T03:00:00.000Z'),
        }),
      'CLOSE_NOT_ELIGIBLE',
    );
    expect(closing.toSnapshot()).toEqual(before);
  });

  it('unfence前にCancelingを予約し、両Receipt後だけActiveへ戻す', () => {
    const fenced = startClosing()
      .recordCloseFenceReceipt(fenceReceipt('ExpenseRecording'))
      .group.recordCloseFenceReceipt(fenceReceipt('Settlement')).group;
    const cancelling = fenced.reserveClosingCancellation({
      actorSubject: ownerSubject,
      closeIntentId: intentId,
    }).group;

    expect(cancelling.closing?.phase).toBe('Canceling');
    expect(cancelling.accessPolicyVersion).toBe(5);
    expectViolation(
      () =>
        cancelling.archive({
          actorSubject: ownerSubject,
          closeIntentId: intentId,
          archivedAt: instant('2026-09-21T03:00:00.000Z'),
        }),
      'CLOSE_STATE_INVALID',
    );

    const expenseRemoved = cancelling.recordCloseUnfenceReceipt(
      unfenceReceipt('ExpenseRecording'),
    ).group;
    expectViolation(
      () =>
        expenseRemoved.completeClosingCancellation({
          actorSubject: ownerSubject,
          closeIntentId: intentId,
        }),
      'CLOSE_RECEIPT_MISSING',
    );

    const bothRemoved = expenseRemoved.recordCloseUnfenceReceipt(
      unfenceReceipt('Settlement'),
    ).group;
    const active = bothRemoved.completeClosingCancellation({
      actorSubject: ownerSubject,
      closeIntentId: intentId,
    }).group;

    expect(active.status).toBe('Active');
    expect(active.closing).toBeNull();
    expect(active.accessPolicyVersion).toBe(8);
  });

  it('対応するfenceがない・version不一致・fence完了前のunfence Receiptを拒否する', () => {
    const unfencedCancellation = startClosing().reserveClosingCancellation({
      actorSubject: ownerSubject,
      closeIntentId: intentId,
    }).group;
    expectViolation(
      () =>
        unfencedCancellation.recordCloseUnfenceReceipt(
          unfenceReceipt('ExpenseRecording'),
        ),
      'CLOSE_RECEIPT_MISMATCH',
    );

    const cancelling = startClosing()
      .recordCloseFenceReceipt(fenceReceipt('ExpenseRecording'))
      .group.recordCloseFenceReceipt(fenceReceipt('Settlement'))
      .group.reserveClosingCancellation({
        actorSubject: ownerSubject,
        closeIntentId: intentId,
      }).group;
    expectViolation(
      () =>
        cancelling.recordCloseUnfenceReceipt(
          unfenceReceipt('ExpenseRecording', { fenceVersion: 2 }),
        ),
      'CLOSE_RECEIPT_MISMATCH',
    );
    expectViolation(
      () =>
        cancelling.recordCloseUnfenceReceipt(
          unfenceReceipt('ExpenseRecording', {
            completedAt: instant('2026-09-21T00:00:30.000Z'),
          }),
        ),
      'CLOSE_RECEIPT_MISMATCH',
    );
  });

  it.each([
    {
      label: '対応fence欠落',
      fenceReceipts: [fenceReceipt('Settlement')],
      unfenceReceipt: unfenceReceipt('ExpenseRecording'),
    },
    {
      label: 'fence version不一致',
      fenceReceipts: [
        fenceReceipt('ExpenseRecording'),
        fenceReceipt('Settlement'),
      ],
      unfenceReceipt: unfenceReceipt('ExpenseRecording', { fenceVersion: 2 }),
    },
    {
      label: 'fence完了前の時刻',
      fenceReceipts: [
        fenceReceipt('ExpenseRecording'),
        fenceReceipt('Settlement'),
      ],
      unfenceReceipt: unfenceReceipt('ExpenseRecording', {
        completedAt: instant('2026-09-21T00:00:30.000Z'),
      }),
    },
  ])('Canceling snapshotの$labelを復元時に拒否する', (input) => {
    expectViolation(
      () =>
        Group.restore({
          ...activeSnapshot(),
          status: 'Closing',
          closing: {
            closeIntentId: intentId,
            cutoff,
            phase: 'Canceling',
            fenceReceipts: input.fenceReceipts,
            unfenceReceipts: [input.unfenceReceipt],
          },
        }),
      'CLOSE_RECEIPT_MISMATCH',
    );
  });

  it('ClosingとCancelingでは既存のaccess-affecting mutationを拒否する', () => {
    const closing = startClosing();
    const cancelling = closing.reserveClosingCancellation({
      actorSubject: ownerSubject,
      closeIntentId: intentId,
    }).group;

    for (const group of [closing, cancelling]) {
      expectViolation(
        () =>
          group.transferOwnership({
            actorSubject: ownerSubject,
            targetParticipantId: owner,
          }),
        'GROUP_NOT_ACTIVE',
      );
      expectViolation(
        () =>
          group.inviteParticipant({
            actorSubject: ownerSubject,
            invitationId: InvitationId.from('unused'),
            targetSubject: ActorSubject.from('new-subject'),
            createdAt: cutoff,
          }),
        'GROUP_NOT_ACTIVE',
      );
    }
  });
});

describe('Asia/Tokyo基準の1暦年後', () => {
  it.each([
    ['通常年', '2025-03-15T01:30:00.000Z', '2026-03-15T01:30:00.000Z'],
    ['2月29日clamp', '2024-02-29T03:00:00.000Z', '2025-02-28T03:00:00.000Z'],
    ['UTC日付跨ぎ', '2026-02-28T15:30:00.000Z', '2027-02-28T15:30:00.000Z'],
    ['翌年が閏年', '2027-02-27T15:30:00.000Z', '2028-02-27T15:30:00.000Z'],
  ])('%sを決定的に計算する', (_label, archivedAt, expected) => {
    expect(instant(archivedAt).plusCalendarYearInTokyo().value).toBe(expected);
  });
});
