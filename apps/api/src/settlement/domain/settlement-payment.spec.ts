import { describe, expect, it } from 'vitest';
import { SettlementCase } from './settlement-case.js';
import { SettlementSnapshotContent } from './value-objects/settlement-snapshot-content.js';
import { SettlementCaseInvariantViolation } from './settlement-case-invariant-violation.js';
import { PaymentAttempt } from './entities/payment-attempt.js';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const now = () => new Date('2026-10-01T00:00:00Z');
const groupId = uuid(1),
  snapshotId = uuid(3);
const initial = (two = false, zero = false) =>
  SettlementCase.start({
    caseId: uuid(2),
    snapshotId,
    content: SettlementSnapshotContent.from(groupId, [
      {
        expenseId: 'expense-1',
        groupId,
        amount: two ? 300n : 100n,
        payerParticipantId: 'a',
        allocations: zero
          ? [
              {
                participantId: 'a',
                joinOrder: 1,
                percentage: 100,
                burden: 100n,
              },
            ]
          : two
            ? [
                { participantId: 'a', joinOrder: 1, percentage: 0, burden: 0n },
                {
                  participantId: 'b',
                  joinOrder: 2,
                  percentage: 50,
                  burden: 150n,
                },
                {
                  participantId: 'c',
                  joinOrder: 3,
                  percentage: 50,
                  burden: 150n,
                },
              ]
            : [
                {
                  participantId: 'a',
                  joinOrder: 1,
                  percentage: 50,
                  burden: 50n,
                },
                {
                  participantId: 'b',
                  joinOrder: 2,
                  percentage: 50,
                  burden: 50n,
                },
              ],
      },
    ]),
    applicant: { actorSubject: 'actor-a', participantId: 'a' },
    submittedAt: now(),
    instructionIds: zero ? [] : two ? [uuid(20), uuid(21)] : [uuid(20)],
  });

const receipt = (root: SettlementCase, index = 0) => {
  const instruction = root.snapshot.paymentInstructionCandidates[index];
  const attempt = root.paymentAttempts.findLast(
    (a) => a.instructionId === instruction.instructionId,
  )!;
  return {
    expectedVersion: root.version,
    snapshotId: root.snapshot.snapshotId,
    instructionId: instruction.instructionId,
    attemptId: attempt.attemptId,
    participantId: instruction.payeeParticipantId,
    decidedAt: now(),
  };
};
const reported = (two = false) => {
  const root = active(two);
  return root.reportPayment(report(root));
};
const returned = () => {
  const root = reported();
  return root.returnPayment({
    ...receipt(root),
    reason: '  まだ受領していない  ',
  });
};
const violation = (operation: () => unknown, code: string) => {
  expect(operation).toThrowError(SettlementCaseInvariantViolation);
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({
      code,
      message: 'Settlement case invariant violated',
    });
  }
};

describe('SP-POST1/INV1: fixed full payment report', () => {
  it('binds report facts and exposes reported status without changing content or approvals', () => {
    const root = active(),
      input = report(root),
      next = root.reportPayment(input);
    expect(next.paymentAttempts[0]).toMatchObject({
      attemptId: uuid(100),
      snapshotId,
      instructionId: uuid(20),
      ordinal: 1,
      payerParticipantId: 'b',
      payeeParticipantId: 'a',
      amount: 50n,
      reportedAt: '2026-10-01T00:00:00.000Z',
      receipt: null,
      status: 'Reported',
    });
    expect(next.version).toBe(root.version + 1);
    expect(next.paymentInstructions[0]).toMatchObject({
      status: 'Reported',
      latestAttemptId: uuid(100),
    });
    expect(next.snapshot).toBe(root.snapshot);
    expect(next.approvals).toBe(root.approvals);
    expect(next.archivedAt).toBeNull();
  });
  it.each([
    0n,
    -1n,
    1n,
    49n,
    51n,
    100n,
    50 as unknown as bigint,
    '50' as unknown as bigint,
  ])('refuses partial or altered report amount %s', (amount) => {
    const root = active();
    violation(
      () => root.reportPayment({ ...report(root), amount }),
      'PAYMENT_AMOUNT_MISMATCH',
    );
    expect(root.paymentAttempts).toEqual([]);
  });
  it.each(['a', 'owner', 'b-rejoined', '', 'outsider'])(
    'refuses payment by another participant %s',
    (participantId) => {
      const root = active();
      violation(
        () => root.reportPayment({ ...report(root), participantId }),
        'ACTOR_NOT_PAYMENT_PAYER',
      );
    },
  );
  it('retains the old participant responsibility instead of replacing it on rejoin', () => {
    const root = active();
    expect(
      root.reportPayment({ ...report(root), participantId: 'b' })
        .paymentAttempts[0].payerParticipantId,
    ).toBe('b');
  });
  it('does not expose approval candidates as active payment states', () => {
    expect(initial().paymentInstructions).toEqual([]);
    expect(active().paymentInstructions[0].status).toBe('Unpaid');
  });
});

describe('SP-POST2: receipt and returned attempt history', () => {
  it('records receipt by the payee without rewriting original report facts', () => {
    const root = reported(),
      next = root.confirmReceipt(receipt(root));
    expect(next.paymentAttempts[0]).toMatchObject({
      attemptId: uuid(100),
      amount: 50n,
      reportedAt: '2026-10-01T00:00:00.000Z',
      status: 'Received',
      receipt: {
        participantId: 'a',
        decision: 'Received',
        reason: null,
        decidedAt: '2026-10-01T00:00:00.000Z',
      },
    });
    expect(root.paymentAttempts[0].status).toBe('Reported');
    expect(next.version).toBe(root.version + 1);
  });
  it('keeps returned facts and reason while a new attempt is added to the same instruction', () => {
    const root = returned(),
      next = root.reportPayment(report(root, 0, uuid(101)));
    expect(root.paymentInstructions[0]).toMatchObject({
      status: 'Unpaid',
      latestAttemptId: uuid(100),
    });
    expect(root.paymentAttempts[0].receipt?.reason).toBe(
      '  まだ受領していない  ',
    );
    expect(next.paymentAttempts).toHaveLength(2);
    expect(next.paymentAttempts[0]).toBe(root.paymentAttempts[0]);
    expect(next.paymentAttempts[1]).toMatchObject({
      ordinal: 2,
      attemptId: uuid(101),
      instructionId: uuid(20),
      amount: 50n,
      status: 'Reported',
    });
    expect(next.snapshot).toBe(root.snapshot);
    expect(next.status).toBe('PaymentActive');
  });
  it('preserves three reports and both return reasons before final receipt', () => {
    let root = returned();
    root = root.reportPayment(report(root, 0, uuid(101)));
    root = root.returnPayment({ ...receipt(root), reason: 'もう一度確認' });
    root = root.reportPayment(report(root, 0, uuid(102)));
    root = root.confirmReceipt(receipt(root));
    expect(
      root.paymentAttempts.map((a) => [a.ordinal, a.status, a.receipt?.reason]),
    ).toEqual([
      [1, 'Returned', '  まだ受領していない  '],
      [2, 'Returned', 'もう一度確認'],
      [3, 'Received', null],
    ]);
    expect(root.archiveReason).toBe('AllPaymentsReceived');
  });
  it.each(['b', 'owner', 'a-rejoined', '', 'outsider'])(
    'rejects receipt or return by non-payee %s',
    (participantId) => {
      const root = reported(),
        input = { ...receipt(root), participantId };
      violation(() => root.confirmReceipt(input), 'ACTOR_NOT_PAYMENT_PAYEE');
      violation(
        () => root.returnPayment({ ...input, reason: '未受領' }),
        'ACTOR_NOT_PAYMENT_PAYEE',
      );
    },
  );
  it.each(['', '  ', null as unknown as string])(
    'requires a nonempty return reason %s',
    (reason) => {
      const root = reported();
      violation(
        () => root.returnPayment({ ...receipt(root), reason }),
        'PAYMENT_RETURN_REASON_EMPTY',
      );
    },
  );
  it('rejects a late decision on an earlier returned attempt after re-report', () => {
    const root = returned(),
      next = root.reportPayment(report(root, 0, uuid(101))),
      input = { ...receipt(next), attemptId: uuid(100) };
    violation(() => next.confirmReceipt(input), 'ATTEMPT_MISMATCH');
    violation(
      () => next.returnPayment({ ...input, reason: '古い報告' }),
      'ATTEMPT_MISMATCH',
    );
  });
  it('refuses receipt of a different instruction attempt', () => {
    let root = reported(true);
    root = root.reportPayment(report(root, 1, uuid(101)));
    violation(
      () => root.confirmReceipt({ ...receipt(root), attemptId: uuid(101) }),
      'ATTEMPT_MISMATCH',
    );
  });
  it('requires an existing report before receipt', () => {
    const root = active();
    violation(
      () =>
        root.confirmReceipt({
          ...report(root),
          decidedAt: now(),
          participantId: 'a',
        }),
      'ATTEMPT_MISMATCH',
    );
  });
  it('refuses to judge a returned attempt twice', () => {
    const root = returned();
    violation(() => root.confirmReceipt(receipt(root)), 'ATTEMPT_NOT_REPORTED');
    violation(
      () => root.returnPayment({ ...receipt(root), reason: '再判断' }),
      'ATTEMPT_NOT_REPORTED',
    );
  });
  it('refuses to report again while the latest report awaits receipt', () => {
    const root = reported();
    violation(
      () => root.reportPayment(report(root, 0, uuid(101))),
      'INSTRUCTION_NOT_UNPAID',
    );
  });
});

describe('SP-POST3: only all receipts archive the case', () => {
  it('waits for every instruction even when one instruction was already received', () => {
    let root = reported(true);
    root = root.confirmReceipt(receipt(root));
    expect(root.status).toBe('PaymentActive');
    expect(root.archivedAt).toBeNull();
    expect(root.paymentInstructions.map((i) => i.status)).toEqual([
      'Received',
      'Unpaid',
    ]);
    violation(
      () => root.reportPayment(report(root, 0, uuid(101))),
      'INSTRUCTION_NOT_UNPAID',
    );
    violation(() => root.confirmReceipt(receipt(root)), 'ATTEMPT_NOT_REPORTED');
    root = root.reportPayment(report(root, 1, uuid(101)));
    const before = root,
      date = new Date('2026-10-31T16:00:00Z');
    root = root.confirmReceipt({ ...receipt(root, 1), decidedAt: date });
    date.setUTCFullYear(2000);
    expect(root.status).toBe('Archived');
    expect(root.archivedAt).toBe('2026-10-31T16:00:00.000Z');
    expect(root.archiveReason).toBe('AllPaymentsReceived');
    expect(root.paymentInstructions.map((i) => i.status)).toEqual([
      'Received',
      'Received',
    ]);
    expect(root.activePaymentInstructions).toEqual([]);
    expect(root.expenseIdsToRelease).toEqual([]);
    expect(root.revisions).toBe(before.revisions);
    expect(root.approvals).toBe(before.approvals);
    expect(root.targetExpenseIds).toEqual(before.targetExpenseIds);
    expect(before.status).toBe('PaymentActive');
  });
  it('keeps no-payment archive free of fabricated reports and receipts', () => {
    const root = initial(false, true);
    expect(root.status).toBe('Archived');
    expect(root.archiveReason).toBe('NoPaymentRequired');
    expect(root.paymentAttempts).toEqual([]);
    expect(root.paymentInstructions).toEqual([]);
    expect(root.archivedAt).toBe('2026-10-01T00:00:00.000Z');
  });
  it('keeps prior rejected revisions and approvals unchanged when a new revision settles', () => {
    const old = initial().reject({
      expectedVersion: 1,
      snapshotId,
      participantId: 'b',
      reason: '金額確認',
      decidedAt: now(),
    });
    const fresh = initial().snapshot.content;
    let root = old.resubmit({
      expectedVersion: old.version,
      currentSnapshotId: snapshotId,
      snapshotId: uuid(4),
      content: fresh,
      applicant: { actorSubject: 'actor-a', participantId: 'a' },
      currentOwnerSubject: 'owner',
      submittedAt: now(),
      instructionIds: [uuid(22)],
    });
    root = root.approve({
      expectedVersion: root.version,
      snapshotId: uuid(4),
      participantId: 'b',
      decidedAt: now(),
    });
    root = root.reportPayment(report(root));
    root = root.confirmReceipt(receipt(root));
    expect(root.snapshot.snapshotId).toBe(uuid(4));
    expect(root.revisions[0]).toBe(old.snapshot);
    expect(root.approvals.slice(0, 2)).toEqual(old.approvals);
    expect(root.paymentAttempts[0].instructionId).toBe(uuid(22));
    expect(root.status).toBe('Archived');
    expect(old.status).toBe('Rejected');
  });
  it('makes all mutating operations unavailable after paid archive', () => {
    const before = reported(),
      root = before.confirmReceipt(receipt(before));
    violation(
      () => root.reportPayment(report(root, 0, uuid(101))),
      'CASE_NOT_PAYMENT_ACTIVE',
    );
    violation(
      () => root.confirmReceipt(receipt(root)),
      'CASE_NOT_PAYMENT_ACTIVE',
    );
    violation(
      () => root.returnPayment({ ...receipt(root), reason: '再開' }),
      'CASE_NOT_PAYMENT_ACTIVE',
    );
    violation(
      () =>
        root.approve({
          expectedVersion: root.version,
          snapshotId,
          participantId: 'b',
          decidedAt: now(),
        }),
      'CASE_NOT_AWAITING_APPROVAL',
    );
    violation(
      () =>
        root.reject({
          expectedVersion: root.version,
          snapshotId,
          participantId: 'b',
          decidedAt: now(),
          reason: '再開',
        }),
      'CASE_NOT_AWAITING_APPROVAL',
    );
    violation(
      () =>
        root.withdraw({
          expectedVersion: root.version,
          snapshotId,
          applicant: { actorSubject: 'actor-a', participantId: 'a' },
          currentOwnerSubject: 'owner',
          reason: '取り下げ',
          withdrawnAt: now(),
        }),
      'CASE_CANNOT_BE_WITHDRAWN',
    );
    violation(
      () =>
        root.resubmit({
          expectedVersion: root.version,
          currentSnapshotId: snapshotId,
          snapshotId: uuid(4),
          content: root.snapshot.content,
          applicant: { actorSubject: 'actor-a', participantId: 'a' },
          currentOwnerSubject: 'owner',
          submittedAt: now(),
          instructionIds: [uuid(22)],
        }),
      'CASE_NOT_REJECTED',
    );
  });
});

describe('SP-FAIL1: identity, versions, dates and immutable history', () => {
  it.each([0, 1, 3, NaN, 1.5])(
    'rejects stale or malformed case version %s for reports',
    (expectedVersion) => {
      const root = active();
      violation(
        () => root.reportPayment({ ...report(root), expectedVersion }),
        'CASE_VERSION_CONFLICT',
      );
    },
  );
  it('rejects stale version on both kinds of receipt decision', () => {
    const root = reported(),
      input = { ...receipt(root), expectedVersion: 2 };
    violation(() => root.confirmReceipt(input), 'CASE_VERSION_CONFLICT');
    violation(
      () => root.returnPayment({ ...input, reason: '未受領' }),
      'CASE_VERSION_CONFLICT',
    );
  });
  it('rejects another revision or instruction for every payment operation', () => {
    const root = reported();
    for (const change of [
      { snapshotId: uuid(99) },
      { instructionId: uuid(99) },
    ]) {
      const code =
        'snapshotId' in change ? 'SNAPSHOT_MISMATCH' : 'INSTRUCTION_NOT_FOUND';
      violation(() => root.reportPayment({ ...report(root), ...change }), code);
      violation(
        () => root.confirmReceipt({ ...receipt(root), ...change }),
        code,
      );
      violation(
        () =>
          root.returnPayment({ ...receipt(root), ...change, reason: '未受領' }),
        code,
      );
    }
  });
  it.each([
    '',
    uuid(100).toUpperCase().replace('000000000064', '0000000000AF'),
    'not-a-uuid',
  ])('rejects noncanonical attempt ID %s', (attemptId) => {
    const root = active();
    violation(
      () => root.reportPayment({ ...report(root), attemptId }),
      'ATTEMPT_ID_INVALID',
    );
  });
  it('does not reuse a returned attempt ID or an ID belonging to another instruction', () => {
    const root = returned();
    violation(() => root.reportPayment(report(root)), 'ATTEMPT_ID_REUSED');
    const two = reported(true);
    violation(() => two.reportPayment(report(two, 1)), 'ATTEMPT_ID_REUSED');
  });
  it('rejects invalid caller dates for report and both receipt judgments', () => {
    const root = active(),
      invalid = new Date('invalid');
    violation(
      () => root.reportPayment({ ...report(root), reportedAt: invalid }),
      'UTC_INSTANT_INVALID',
    );
    const next = root.reportPayment(report(root));
    violation(
      () => next.confirmReceipt({ ...receipt(next), decidedAt: invalid }),
      'UTC_INSTANT_INVALID',
    );
    violation(
      () =>
        next.returnPayment({
          ...receipt(next),
          decidedAt: invalid,
          reason: '未受領',
        }),
      'UTC_INSTANT_INVALID',
    );
  });
  it('requires PaymentActive even when a fixed candidate exists', () => {
    const awaiting = initial(),
      rejected = awaiting.reject({
        expectedVersion: 1,
        snapshotId,
        participantId: 'b',
        reason: '確認',
        decidedAt: now(),
      });
    const withdrawn = awaiting.withdraw({
      expectedVersion: 1,
      snapshotId,
      applicant: { actorSubject: 'actor-a', participantId: 'a' },
      currentOwnerSubject: 'owner',
      reason: '不要',
      withdrawnAt: now(),
    });
    for (const root of [awaiting, rejected, withdrawn]) {
      violation(
        () => root.reportPayment(report(root)),
        'CASE_NOT_PAYMENT_ACTIVE',
      );
      const input = { ...report(root), decidedAt: now() };
      violation(() => root.confirmReceipt(input), 'CASE_NOT_PAYMENT_ACTIVE');
      violation(
        () => root.returnPayment({ ...input, reason: '未受領' }),
        'CASE_NOT_PAYMENT_ACTIVE',
      );
    }
  });
  it('copies dates and input values, and freezes nested attempts and receipt records', () => {
    const root = active(),
      input = report(root),
      next = root.reportPayment(input);
    input.reportedAt.setUTCFullYear(2000);
    input.amount = 1n;
    input.participantId = 'other';
    const decision = { ...receipt(next), reason: '  未受領  ' },
      result = next.returnPayment(decision);
    decision.reason = '改変';
    decision.decidedAt.setUTCFullYear(2000);
    expect(result.paymentAttempts[0]).toMatchObject({
      amount: 50n,
      payerParticipantId: 'b',
      reportedAt: '2026-10-01T00:00:00.000Z',
      receipt: { reason: '  未受領  ', decidedAt: '2026-10-01T00:00:00.000Z' },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.paymentAttempts)).toBe(true);
    expect(Object.isFrozen(result.paymentAttempts[0])).toBe(true);
    expect(Object.isFrozen(result.paymentAttempts[0].receipt)).toBe(true);
    expect(Object.isFrozen(result.paymentInstructions)).toBe(true);
    expect(Object.isFrozen(result.paymentInstructions[0])).toBe(true);
    expect(() =>
      Reflect.set(result.paymentAttempts[0], 'amount', 1n),
    ).not.toThrow();
    expect(result.paymentAttempts[0].amount).toBe(50n);
    expect(next.paymentAttempts[0].receipt).toBeNull();
    expect(root.paymentAttempts).toEqual([]);
  });
  it('only produces alternative immutable results for a local race; storage chooses the committed winner later', () => {
    const root = reported(),
      received = root.confirmReceipt(receipt(root)),
      sentBack = root.returnPayment({ ...receipt(root), reason: '未受領' });
    expect(received.version).toBe(sentBack.version);
    expect(received.status).toBe('Archived');
    expect(sentBack.status).toBe('PaymentActive');
    expect(root.paymentAttempts[0].status).toBe('Reported');
  });
  it('guards child entity ordinal and fixed parties against invalid internal construction', () => {
    const root = active(),
      instruction = root.snapshot.paymentInstructionCandidates[0],
      input = report(root);
    violation(
      () =>
        PaymentAttempt.report(root.snapshot.snapshotId, instruction, input, 0),
      'ATTEMPT_ORDINAL_INVALID',
    );
    violation(
      () =>
        PaymentAttempt.report(
          root.snapshot.snapshotId,
          { ...instruction, payeeParticipantId: 'b' },
          input,
          1,
        ),
      'INSTRUCTION_PARTICIPANTS_INVALID',
    );
    violation(
      () =>
        PaymentAttempt.report(
          root.snapshot.snapshotId,
          { ...instruction, amount: 0n },
          { ...input, amount: 0n },
          1,
        ),
      'PAYMENT_AMOUNT_MISMATCH',
    );
  });
});
const active = (two = false) => {
  let root = initial(two);
  for (const participantId of two ? ['b', 'c'] : ['b'])
    root = root.approve({
      expectedVersion: root.version,
      snapshotId,
      participantId,
      decidedAt: now(),
    });
  return root;
};
const report = (root: SettlementCase, index = 0, attemptId = uuid(100)) => {
  const instruction = root.snapshot.paymentInstructionCandidates[index];
  return {
    expectedVersion: root.version,
    snapshotId: root.snapshot.snapshotId,
    instructionId: instruction.instructionId,
    participantId: instruction.payerParticipantId,
    amount: instruction.amount,
    attemptId,
    reportedAt: now(),
  };
};

describe('SP-POST1: payer reports the full instruction', () => {
  it('records an attempt but keeps the settlement awaiting receipt', () => {
    const old = active();
    const next = old.reportPayment(report(old));
    expect(next.paymentAttempts).toHaveLength(1);
    expect(next.status).toBe('PaymentActive');
    expect(old.paymentAttempts).toEqual([]);
  });
});
