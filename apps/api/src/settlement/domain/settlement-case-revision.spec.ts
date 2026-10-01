import { describe, expect, it } from 'vitest';
import { SettlementCase } from './settlement-case.js';
import { SettlementCaseInvariantViolation } from './settlement-case-invariant-violation.js';
import { SettlementSnapshotContent } from './value-objects/settlement-snapshot-content.js';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const groupId = uuid(1),
  caseId = uuid(2),
  r1 = uuid(3),
  r2 = uuid(4);
const time = () => new Date('2026-10-01T00:00:00Z');
const content = (amount = 100n) =>
  SettlementSnapshotContent.from(groupId, [
    {
      expenseId: 'expense-1',
      groupId,
      amount,
      payerParticipantId: 'a',
      allocations: [
        {
          participantId: 'a',
          joinOrder: 1,
          percentage: 50,
          burden: amount / 2n,
        },
        {
          participantId: 'b',
          joinOrder: 2,
          percentage: 50,
          burden: amount / 2n,
        },
      ],
    },
  ]);
const initial = () =>
  SettlementCase.start({
    caseId,
    snapshotId: r1,
    content: content(),
    applicant: { actorSubject: 'actor-a', participantId: 'a' },
    submittedAt: time(),
    instructionIds: [uuid(20)],
  });
const rejected = () =>
  initial().reject({
    expectedVersion: 1,
    snapshotId: r1,
    participantId: 'b',
    decidedAt: time(),
    reason: '金額の訂正',
  });
const resubmitInput = () => ({
  caseId,
  snapshotId: r2,
  currentSnapshotId: r1,
  expectedVersion: 2,
  content: content(200n),
  applicant: { actorSubject: 'actor-b', participantId: 'b' },
  currentOwnerSubject: 'actor-b',
  submittedAt: time(),
  instructionIds: [uuid(21)],
});

describe('SCR-POST1: revision chain after rejection', () => {
  it('starts a new immutable revision of the same case without carrying old approval', () => {
    const old = rejected();
    const next = old.resubmit(resubmitInput());
    expect(next.snapshot.ordinal).toBe(2);
    expect(next.snapshot.previousSnapshotId).toBe(r1);
    expect(next.caseId).toBe(old.caseId);
    expect(next.snapshot.content.expenses[0].amount).toBe(200n);
    expect(old.snapshot.ordinal).toBe(1);
    expect(old.snapshot.content.expenses[0].amount).toBe(100n);
  });
});

const vote = (root: SettlementCase, participantId = 'a') => ({
  expectedVersion: root.version,
  snapshotId: root.snapshot.snapshotId,
  participantId,
  decidedAt: time(),
});
const actorA = () => ({
  applicant: { actorSubject: 'actor-a', participantId: 'a' },
  currentOwnerSubject: 'actor-current-owner',
});
const withdrawInput = (root: SettlementCase) => ({
  ...actorA(),
  expectedVersion: root.version,
  snapshotId: root.snapshot.snapshotId,
  reason: '  継続不要  ',
  withdrawnAt: time(),
});
const expectViolation = (operation: () => unknown, code: string) => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SettlementCaseInvariantViolation);
    expect(error).toMatchObject({
      code,
      message: 'Settlement case invariant violated',
    });
    return;
  }
  throw new Error(`Expected ${code}`);
};

describe('SCR-INV1/POST1: fixed case and new approvals', () => {
  it('retains all old decisions but requires original A to approve again after Owner B resubmits', () => {
    const old = rejected();
    const next = old.resubmit(resubmitInput());
    expect(next.status).toBe('AwaitingApproval');
    expect(next.version).toBe(3);
    expect(next.originalApplicant).toEqual({
      actorSubject: 'actor-a',
      participantId: 'a',
    });
    expect(next.snapshot.applicant).toEqual({
      actorSubject: 'actor-b',
      participantId: 'b',
    });
    expect(next.targetExpenseIds).toEqual(old.targetExpenseIds);
    expect(next.revisions).toHaveLength(2);
    expect(next.revisions[0]).toBe(old.snapshot);
    expect(
      next.approvals.map((a) => [a.snapshotId, a.participantId, a.decision]),
    ).toEqual([
      [r1, 'a', 'Approved'],
      [r1, 'b', 'Rejected'],
      [r2, 'b', 'Approved'],
    ]);
    expect(next.approvals[1].reason).toBe('金額の訂正');
    expect(next.currentRevisionApprovals.map((a) => a.participantId)).toEqual([
      'b',
    ]);
    expect(next.activePaymentInstructions).toEqual([]);
    const approved = next.approve(vote(next));
    expect(approved.status).toBe('PaymentActive');
    expect(approved.activePaymentInstructions).toEqual([
      {
        instructionId: uuid(21),
        payerParticipantId: 'b',
        payeeParticipantId: 'a',
        amount: 100n,
        currency: 'JPY',
      },
    ]);
    expect(old.status).toBe('Rejected');
    expect(old.approvals).toHaveLength(2);
  });
  it('maintains previous IDs and immutable reasons over three revisions', () => {
    const one = rejected();
    const two = one.resubmit(resubmitInput()).reject({
      expectedVersion: 3,
      snapshotId: r2,
      participantId: 'a',
      decidedAt: time(),
      reason: 'もう一度確認',
    });
    const three = two.resubmit({
      ...resubmitInput(),
      ...actorA(),
      snapshotId: uuid(5),
      currentSnapshotId: r2,
      expectedVersion: 4,
      content: content(300n),
      instructionIds: [uuid(22)],
    });
    expect(three.version).toBe(5);
    expect(
      three.revisions.map((r) => [
        r.ordinal,
        r.snapshotId,
        r.previousSnapshotId,
        r.content.expenses[0].amount,
      ]),
    ).toEqual([
      [1, r1, null, 100n],
      [2, r2, r1, 200n],
      [3, uuid(5), r2, 300n],
    ]);
    expect(three.currentRevisionApprovals.map((a) => a.participantId)).toEqual([
      'a',
    ]);
    expect(
      three.approvals
        .filter((a) => a.decision === 'Rejected')
        .map((a) => a.reason),
    ).toEqual(['金額の訂正', 'もう一度確認']);
    expect(three.originalApplicant).toBe(one.originalApplicant);
    expect(two.revisions).toHaveLength(2);
  });
  it('permits a left original actor by stable subject, while rejoin PID does not approve old PID', () => {
    const old = rejected();
    const next = old.resubmit({
      ...resubmitInput(),
      ...actorA(),
      applicant: { actorSubject: 'actor-a', participantId: 'a-rejoined' },
    });
    expect(next.status).toBe('AwaitingApproval');
    expect(next.currentRevisionApprovals).toEqual([]);
    expect(next.originalApplicant.participantId).toBe('a');
    expect(next.snapshot.applicant.participantId).toBe('a-rejoined');
    expectViolation(
      () => next.approve(vote(next, 'a-rejoined')),
      'PARTICIPANT_NOT_REQUIRED',
    );
    const a = next.approve(vote(next, 'a'));
    expect(a.status).toBe('AwaitingApproval');
    expect(a.approve(vote(a, 'b')).status).toBe('PaymentActive');
    const left = old.resubmit({ ...resubmitInput(), ...actorA() });
    expect(left.currentRevisionApprovals.map((a) => a.participantId)).toEqual([
      'a',
    ]);
  });
  it('new required approvers are fixed from revised percentages, without copying old votes', () => {
    const changed = SettlementSnapshotContent.from(groupId, [
      {
        ...content().expenses[0],
        allocations: [
          { participantId: 'a', joinOrder: 1, percentage: 100, burden: 100n },
          { participantId: 'b', joinOrder: 2, percentage: 0, burden: 0n },
        ],
      },
    ]);
    const next = rejected().resubmit({
      ...resubmitInput(),
      content: changed,
      instructionIds: [],
    });
    expect(next.snapshot.content.requiredApproverIds).toEqual(['a']);
    expect(next.currentRevisionApprovals).toEqual([]);
    expect(next.status).toBe('AwaitingApproval');
    const archived = next.approve(vote(next));
    expect(archived.status).toBe('Archived');
    expect(archived.archiveReason).toBe('NoPaymentRequired');
    expect(archived.revisions[0].content.requiredApproverIds).toEqual([
      'a',
      'b',
    ]);
  });
  it('a zero yen revision still waits for all new approvals and archives at the latest decision time', () => {
    const next = rejected().resubmit({
      ...resubmitInput(),
      content: content(0n),
      instructionIds: [],
    });
    expect(next.status).toBe('AwaitingApproval');
    expect(next.currentRevisionApprovals.map((a) => a.participantId)).toEqual([
      'b',
    ]);
    const date = new Date('2026-10-02T09:00:00+09:00');
    const archived = next.approve({ ...vote(next), decidedAt: date });
    date.setUTCFullYear(2030);
    expect(archived.status).toBe('Archived');
    expect(archived.archiveReason).toBe('NoPaymentRequired');
    expect(archived.archivedAt).toBe('2026-10-02T00:00:00.000Z');
    expect(archived.activePaymentInstructions).toEqual([]);
    expect(archived.revisions[0].content.expenses[0].amount).toBe(100n);
  });
  it('records a UTC copy and real applicant separately from immutable original applicant', () => {
    const input = {
      ...resubmitInput(),
      submittedAt: new Date('2026-10-02T10:00:00+09:00'),
    };
    const next = rejected().resubmit(input);
    input.submittedAt.setUTCFullYear(2030);
    input.applicant.actorSubject = 'changed';
    input.applicant.participantId = 'changed';
    input.instructionIds[0] = uuid(99);
    expect(next.snapshot.submittedAt).toBe('2026-10-02T01:00:00.000Z');
    expect(next.snapshot.applicant).toEqual({
      actorSubject: 'actor-b',
      participantId: 'b',
    });
    expect(next.originalApplicant.actorSubject).toBe('actor-a');
    expect(next.snapshot.paymentInstructionCandidates[0].instructionId).toBe(
      uuid(21),
    );
  });
  it('keeps the entire initially selected expense set even when source order is reversed', () => {
    const one = content().expenses[0],
      two = { ...one, expenseId: 'expense-2' };
    const firstContent = SettlementSnapshotContent.from(groupId, [one, two]);
    const old = SettlementCase.start({
      caseId,
      snapshotId: r1,
      content: firstContent,
      applicant: { actorSubject: 'actor-a', participantId: 'a' },
      submittedAt: time(),
      instructionIds: [uuid(20)],
    }).reject({
      expectedVersion: 1,
      snapshotId: r1,
      participantId: 'b',
      decidedAt: time(),
      reason: '確認',
    });
    const next = old.resubmit({
      ...resubmitInput(),
      content: SettlementSnapshotContent.from(groupId, [two, one]),
    });
    expect(next.targetExpenseIds).toEqual(['expense-1', 'expense-2']);
    expect(next.snapshot.content.expenses.map((x) => x.expenseId)).toEqual(
      next.targetExpenseIds,
    );
  });
});

describe('SCR-POST2: whole-case withdrawal', () => {
  it.each(['AwaitingApproval', 'Rejected'] as const)(
    'withdraws %s without activating or approving its immutable revision',
    (state) => {
      const old = state === 'Rejected' ? rejected() : initial();
      const withdrawn = old.withdraw(withdrawInput(old));
      expect(withdrawn.status).toBe('Withdrawn');
      expect(withdrawn.version).toBe(old.version + 1);
      expect(withdrawn.revisionStatus).toBe(state);
      expect(withdrawn.revisions).toBe(old.revisions);
      expect(withdrawn.snapshot).toBe(old.snapshot);
      expect(withdrawn.approvals).toBe(old.approvals);
      expect(withdrawn.activePaymentInstructions).toEqual([]);
      expect(withdrawn.expenseIdsToRelease).toBe(withdrawn.targetExpenseIds);
      expect(withdrawn.expenseIdsToRelease).toEqual(['expense-1']);
      expect(old.expenseIdsToRelease).toEqual([]);
      expect(withdrawn.withdrawal).toMatchObject({
        snapshotId: r1,
        applicant: actorA().applicant,
        reason: '  継続不要  ',
        withdrawnAt: '2026-10-01T00:00:00.000Z',
      });
      expect(withdrawn.archiveReason).toBeNull();
      expect(withdrawn.archivedAt).toBeNull();
      expect(old.status).toBe(state);
    },
  );
  it('retains two revisions, all approvals, and releases every target after Owner withdrawal', () => {
    const first = content().expenses[0],
      second = { ...first, expenseId: 'expense-2' };
    const snapshot = SettlementSnapshotContent.from(groupId, [first, second]);
    const old = SettlementCase.start({
      ...resubmitInput(),
      caseId,
      snapshotId: r1,
      content: snapshot,
      applicant: actorA().applicant,
      instructionIds: [uuid(20)],
    }).reject({
      expectedVersion: 1,
      snapshotId: r1,
      participantId: 'b',
      decidedAt: time(),
      reason: 'R1却下',
    });
    const revised = old.resubmit({ ...resubmitInput(), content: snapshot });
    const withdrawal = revised.withdraw({
      ...withdrawInput(revised),
      applicant: { actorSubject: 'actor-new-owner', participantId: 'owner' },
      currentOwnerSubject: 'actor-new-owner',
    });
    expect(withdrawal.revisions).toHaveLength(2);
    expect(withdrawal.approvals).toHaveLength(3);
    expect(withdrawal.approvals[1].reason).toBe('R1却下');
    expect(withdrawal.expenseIdsToRelease).toEqual(['expense-1', 'expense-2']);
    expect(withdrawal.withdrawal?.applicant.actorSubject).toBe(
      'actor-new-owner',
    );
    expect(withdrawal.snapshot.applicant.actorSubject).toBe('actor-b');
    expect(withdrawal.originalApplicant.actorSubject).toBe('actor-a');
  });
  it('keeps a withdrawal of the currently rejected revision and corrected earlier content immutable', () => {
    const old = rejected().resubmit(resubmitInput()).reject({
      expectedVersion: 3,
      snapshotId: r2,
      participantId: 'a',
      decidedAt: time(),
      reason: 'R2却下',
    });
    const withdrawn = old.withdraw(withdrawInput(old));
    expect(withdrawn.revisionStatus).toBe('Rejected');
    expect(
      withdrawn.revisions.map((x) => x.content.expenses[0].amount),
    ).toEqual([100n, 200n]);
    expect(withdrawn.expenseIdsToRelease).toEqual(['expense-1']);
    expect(
      withdrawn.approvals
        .filter((a) => a.decision === 'Rejected')
        .map((a) => a.reason),
    ).toEqual(['金額の訂正', 'R2却下']);
  });
  it('copies actual requester and UTC instant without storing mutable owner facts', () => {
    const root = initial();
    const input = withdrawInput(root);
    input.withdrawnAt = new Date('2026-10-01T10:00:00+09:00');
    const withdrawn = root.withdraw(input);
    input.applicant.actorSubject = 'changed';
    input.applicant.participantId = 'changed';
    input.currentOwnerSubject = 'changed';
    input.withdrawnAt.setUTCFullYear(2030);
    input.reason = 'changed';
    expect(withdrawn.withdrawal).toMatchObject({
      applicant: { actorSubject: 'actor-a', participantId: 'a' },
      withdrawnAt: '2026-10-01T01:00:00.000Z',
      reason: '  継続不要  ',
    });
  });
  it('can compute competing decisions but does not claim a successful persistence commit', () => {
    const root = rejected();
    const revision = root.resubmit(resubmitInput());
    const withdrawal = root.withdraw(withdrawInput(root));
    expect(revision.version).toBe(3);
    expect(withdrawal.version).toBe(3);
    expect(root.version).toBe(2);
    expect(root.status).toBe('Rejected');
    expect(revision.status).toBe('AwaitingApproval');
    expect(withdrawal.status).toBe('Withdrawn');
  });
});

describe('SCR-FAIL1: guards without partial changes', () => {
  it.each([
    'AwaitingApproval',
    'PaymentActive',
    'Archived',
    'Withdrawn',
  ] as const)('cannot resubmit a case in %s', (state) => {
    const root =
      state === 'AwaitingApproval'
        ? initial()
        : state === 'PaymentActive'
          ? initial().approve(vote(initial(), 'b'))
          : state === 'Withdrawn'
            ? initial().withdraw(withdrawInput(initial()))
            : SettlementCase.start({
                ...resubmitInput(),
                caseId,
                snapshotId: r1,
                content: content(0n),
                applicant: actorA().applicant,
                instructionIds: [],
              }).approve({
                expectedVersion: 1,
                snapshotId: r1,
                participantId: 'b',
                decidedAt: time(),
              });
    expect(root.status).toBe(state);
    expectViolation(
      () =>
        root.resubmit({ ...resubmitInput(), expectedVersion: root.version }),
      'CASE_NOT_REJECTED',
    );
  });
  it.each(['PaymentActive', 'Archived', 'Withdrawn'] as const)(
    'cannot withdraw after %s',
    (state) => {
      const root =
        state === 'PaymentActive'
          ? initial().approve(vote(initial(), 'b'))
          : state === 'Withdrawn'
            ? initial().withdraw(withdrawInput(initial()))
            : SettlementCase.start({
                ...resubmitInput(),
                caseId,
                snapshotId: r1,
                content: content(0n),
                applicant: actorA().applicant,
                instructionIds: [],
              }).approve({
                expectedVersion: 1,
                snapshotId: r1,
                participantId: 'b',
                decidedAt: time(),
              });
      expectViolation(
        () => root.withdraw(withdrawInput(root)),
        'CASE_CANNOT_BE_WITHDRAWN',
      );
    },
  );
  it('Withdrawn remains terminal for approve, reject, resubmit and repeated withdraw', () => {
    const root = rejected().withdraw(withdrawInput(rejected()));
    expectViolation(
      () => root.approve(vote(root, 'b')),
      'CASE_NOT_AWAITING_APPROVAL',
    );
    expectViolation(
      () => root.reject({ ...vote(root, 'b'), reason: '変更' }),
      'CASE_NOT_AWAITING_APPROVAL',
    );
    expectViolation(
      () =>
        root.resubmit({ ...resubmitInput(), expectedVersion: root.version }),
      'CASE_NOT_REJECTED',
    );
    expectViolation(
      () => root.withdraw(withdrawInput(root)),
      'CASE_CANNOT_BE_WITHDRAWN',
    );
    expect(root.revisionStatus).toBe('Rejected');
  });
  it.each(['actor-outsider', 'actor-previous-owner', 'actor-source-owner'])(
    'rejects %s unless stable original applicant or current owner',
    (actorSubject) => {
      const root = rejected();
      const applicant = { actorSubject, participantId: 'b' };
      expectViolation(
        () =>
          root.resubmit({
            ...resubmitInput(),
            applicant,
            currentOwnerSubject: 'actor-current-owner',
          }),
        'ACTOR_NOT_CASE_APPLICANT_OR_OWNER',
      );
      expectViolation(
        () => root.withdraw({ ...withdrawInput(root), applicant }),
        'ACTOR_NOT_CASE_APPLICANT_OR_OWNER',
      );
      expect(root.revisions).toHaveLength(1);
      expect(root.approvals).toHaveLength(2);
    },
  );
  it('allows original applicant after ownership changed, but not a different actor reusing original PID', () => {
    const root = rejected();
    expect(root.resubmit({ ...resubmitInput(), ...actorA() }).status).toBe(
      'AwaitingApproval',
    );
    expectViolation(
      () =>
        root.resubmit({
          ...resubmitInput(),
          applicant: { actorSubject: 'different', participantId: 'a' },
          currentOwnerSubject: 'actor-owner',
        }),
      'ACTOR_NOT_CASE_APPLICANT_OR_OWNER',
    );
  });
  it.each([0, 1, 3, NaN, 1.5])(
    'rejects mismatched expected Case version %s for both operations',
    (expectedVersion) => {
      const root = rejected();
      expectViolation(
        () => root.resubmit({ ...resubmitInput(), expectedVersion }),
        'CASE_VERSION_CONFLICT',
      );
      expectViolation(
        () => root.withdraw({ ...withdrawInput(root), expectedVersion }),
        'CASE_VERSION_CONFLICT',
      );
    },
  );
  it('rejects current snapshot mismatch on resubmission and withdrawal', () => {
    const root = rejected();
    expectViolation(
      () => root.resubmit({ ...resubmitInput(), currentSnapshotId: uuid(99) }),
      'SNAPSHOT_MISMATCH',
    );
    expectViolation(
      () => root.withdraw({ ...withdrawInput(root), snapshotId: uuid(99) }),
      'SNAPSHOT_MISMATCH',
    );
  });
  it.each(['extra', 'missing', 'replacement'] as const)(
    'does not change fixed selected set: %s',
    (kind) => {
      const base = content().expenses[0];
      const root =
        kind === 'missing'
          ? SettlementCase.start({
              ...resubmitInput(),
              caseId,
              snapshotId: r1,
              content: SettlementSnapshotContent.from(groupId, [
                base,
                { ...base, expenseId: 'expense-2' },
              ]),
              applicant: actorA().applicant,
              instructionIds: [uuid(20)],
            }).reject({
              expectedVersion: 1,
              snapshotId: r1,
              participantId: 'b',
              decidedAt: time(),
              reason: '確認',
            })
          : rejected();
      const facts =
        kind === 'extra'
          ? [base, { ...base, expenseId: 'later-expense' }]
          : kind === 'replacement'
            ? [{ ...base, expenseId: 'different' }]
            : [base];
      expectViolation(
        () =>
          root.resubmit({
            ...resubmitInput(),
            content: SettlementSnapshotContent.from(groupId, facts),
          }),
        'TARGET_EXPENSE_SET_MISMATCH',
      );
      expect(root.revisions).toHaveLength(1);
    },
  );
  it('rejects a valid snapshot from a different group', () => {
    const other = uuid(99);
    const facts = content().expenses.map((e) => ({ ...e, groupId: other }));
    expectViolation(
      () =>
        rejected().resubmit({
          ...resubmitInput(),
          content: SettlementSnapshotContent.from(other, facts),
        }),
      'REVISION_GROUP_MISMATCH',
    );
  });
  it('rejects snapshot and instruction ID reuse across every earlier revision', () => {
    const root = rejected();
    expectViolation(
      () => root.resubmit({ ...resubmitInput(), snapshotId: r1 }),
      'SNAPSHOT_ID_REUSED',
    );
    expectViolation(
      () => root.resubmit({ ...resubmitInput(), instructionIds: [uuid(20)] }),
      'INSTRUCTION_ID_REUSED',
    );
    const r2Rejected = root.resubmit(resubmitInput()).reject({
      expectedVersion: 3,
      snapshotId: r2,
      participantId: 'a',
      decidedAt: time(),
      reason: '確認',
    });
    expectViolation(
      () =>
        r2Rejected.resubmit({
          ...resubmitInput(),
          ...actorA(),
          expectedVersion: 4,
          currentSnapshotId: r2,
          snapshotId: r1,
          instructionIds: [uuid(22)],
        }),
      'SNAPSHOT_ID_REUSED',
    );
    expectViolation(
      () =>
        r2Rejected.resubmit({
          ...resubmitInput(),
          ...actorA(),
          expectedVersion: 4,
          currentSnapshotId: r2,
          snapshotId: uuid(5),
          instructionIds: [uuid(20)],
        }),
      'INSTRUCTION_ID_REUSED',
    );
  });
  it.each(['', ' \n\t'])(
    'rejects empty withdrawal reason %j without consuming state',
    (reason) => {
      const root = rejected();
      expectViolation(
        () => root.withdraw({ ...withdrawInput(root), reason }),
        'WITHDRAWAL_REASON_EMPTY',
      );
      expect(root.resubmit(resubmitInput()).status).toBe('AwaitingApproval');
    },
  );
  it.each([
    {
      applicant: { actorSubject: '', participantId: 'a' },
      code: 'ACTOR_SUBJECT_EMPTY',
    },
    {
      applicant: { actorSubject: 'actor-a', participantId: ' ' },
      code: 'PARTICIPANT_ID_EMPTY',
    },
    { currentOwnerSubject: ' ', code: 'CURRENT_OWNER_SUBJECT_EMPTY' },
  ])(
    'requires nonempty trusted actor/owner references: $code',
    ({ code, ...override }) => {
      const root = rejected();
      expectViolation(
        () => root.resubmit({ ...resubmitInput(), ...override }),
        code,
      );
      expectViolation(
        () => root.withdraw({ ...withdrawInput(root), ...override }),
        code,
      );
    },
  );
  it('rejects invalid times in both operations without appending history', () => {
    const root = rejected();
    expectViolation(
      () => root.resubmit({ ...resubmitInput(), submittedAt: new Date(NaN) }),
      'UTC_INSTANT_INVALID',
    );
    expectViolation(
      () =>
        root.withdraw({ ...withdrawInput(root), withdrawnAt: new Date(NaN) }),
      'UTC_INSTANT_INVALID',
    );
    expect(root.revisions).toHaveLength(1);
    expect(root.withdrawal).toBeNull();
  });
  it('inherits initial ID/content/count checks for each revision', () => {
    const root = rejected();
    expectViolation(
      () => root.resubmit({ ...resubmitInput(), snapshotId: 'invalid' }),
      'SNAPSHOT_ID_INVALID',
    );
    expectViolation(
      () => root.resubmit({ ...resubmitInput(), instructionIds: [] }),
      'INSTRUCTION_COUNT_MISMATCH',
    );
    expectViolation(
      () => root.resubmit({ ...resubmitInput(), instructionIds: ['invalid'] }),
      'INSTRUCTION_ID_INVALID',
    );
    const forged = {
      ...content(),
      equals: () => true,
      requiredApproverIds: [],
    };
    expectViolation(
      () => root.resubmit({ ...resubmitInput(), content: forged }),
      'SNAPSHOT_CONTENT_INVALID',
    );
  });
  it('does not let a late R1 decision or repeated new vote change R2', () => {
    const root = rejected().resubmit(resubmitInput());
    expectViolation(
      () => root.approve({ ...vote(root), snapshotId: r1 }),
      'SNAPSHOT_MISMATCH',
    );
    expectViolation(
      () => root.approve(vote(root, 'b')),
      'APPROVAL_ALREADY_RECORDED',
    );
    expect(root.approvals).toHaveLength(3);
    expect(root.status).toBe('AwaitingApproval');
  });
  it('freezes old/new history, each approval, current decision arrays and withdrawal result', () => {
    const original = rejected();
    const revised = original.resubmit(resubmitInput());
    const root = revised.withdraw(withdrawInput(revised));
    for (const value of [
      root,
      root.revisions,
      ...root.revisions,
      root.approvals,
      ...root.approvals,
      root.originalApplicant,
      root.snapshot.applicant,
      root.currentRevisionApprovals,
      root.withdrawal,
      root.withdrawal?.applicant,
      root.expenseIdsToRelease,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(root.originalApplicant, 'actorSubject', 'changed')).toBe(
      false,
    );
    expect(Reflect.set(root.revisions[0], 'ordinal', 99)).toBe(false);
    expect(Reflect.set(root.withdrawal!, 'reason', 'changed')).toBe(false);
    expect(() => (root.revisions as unknown[]).push({})).toThrow(TypeError);
    expect(original.revisions).toHaveLength(1);
    expect(revised.revisions).toHaveLength(2);
    expect(root.revisions[0].content.expenses[0].amount).toBe(100n);
  });
});
