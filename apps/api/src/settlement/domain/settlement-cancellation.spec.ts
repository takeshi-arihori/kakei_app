import { describe, expect, it } from 'vitest';
import { SettlementCase } from './settlement-case.js';
import { SettlementSnapshotContent } from './value-objects/settlement-snapshot-content.js';
import { SettlementCaseInvariantViolation } from './settlement-case-invariant-violation.js';
import { SettlementCancellationRequest } from './entities/settlement-cancellation-request.js';
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const now = () => new Date('2026-10-01T00:00:00Z');
const groupId = uuid(1),
  snapshotId = uuid(3);
const initial = () =>
  SettlementCase.start({
    caseId: uuid(2),
    snapshotId,
    content: SettlementSnapshotContent.from(groupId, [
      {
        expenseId: 'expense-1',
        groupId,
        amount: 100n,
        payerParticipantId: 'a',
        allocations: [
          { participantId: 'a', joinOrder: 1, percentage: 50, burden: 50n },
          { participantId: 'b', joinOrder: 2, percentage: 50, burden: 50n },
        ],
      },
    ]),
    applicant: { actorSubject: 'actor-a', participantId: 'a' },
    submittedAt: now(),
    instructionIds: [uuid(20)],
  });
const active = () =>
  initial().approve({
    expectedVersion: 1,
    snapshotId,
    participantId: 'b',
    decidedAt: now(),
  });
const request = (root: SettlementCase, cancellationId = uuid(100)) => ({
  expectedVersion: root.version,
  snapshotId: root.snapshot.snapshotId,
  cancellationId,
  applicant: { actorSubject: 'actor-a', participantId: 'a' },
  currentOwnerSubject: 'owner',
  reason: '  取消希望  ',
  requestedAt: now(),
});
describe('SC-POST1: stop payment while cancellation is pending', () => {
  it('requires all explicit cancellation agreements after the original applicant requests cancellation', () => {
    const root = active(),
      next = root.requestCancellation(request(root));
    expect(next.status).toBe('CancellationPending');
    expect(next.activePaymentInstructions).toEqual([]);
    expect(root.status).toBe('PaymentActive');
  });
});

const pending = () => {
  const root = active();
  return root.requestCancellation(request(root));
};
const vote = (root: SettlementCase, participantId = 'a') => ({
  expectedVersion: root.version,
  snapshotId: root.snapshot.snapshotId,
  cancellationId: root.latestCancellation!.cancellationId,
  participantId,
  decidedAt: now(),
});
const fail = (operation: () => unknown, code: string) => {
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
const report = (root: SettlementCase) => ({
  expectedVersion: root.version,
  snapshotId: root.snapshot.snapshotId,
  instructionId: uuid(20),
  attemptId: uuid(200),
  participantId: 'b',
  amount: 50n,
  reportedAt: now(),
});
const receipt = (root: SettlementCase) => ({
  ...report(root),
  participantId: 'a',
  decidedAt: now(),
});
const three = () => {
  const root = SettlementCase.start({
    caseId: uuid(2),
    snapshotId,
    applicant: { actorSubject: 'actor-a', participantId: 'a' },
    submittedAt: now(),
    instructionIds: [uuid(20)],
    content: SettlementSnapshotContent.from(groupId, [
      {
        expenseId: 'e1',
        groupId,
        amount: 100n,
        payerParticipantId: 'a',
        allocations: [
          { participantId: 'a', joinOrder: 1, percentage: 50, burden: 50n },
          { participantId: 'b', joinOrder: 2, percentage: 40, burden: 40n },
          { participantId: 'c', joinOrder: 3, percentage: 10, burden: 10n },
        ],
      },
      {
        expenseId: 'e2',
        groupId,
        amount: 20n,
        payerParticipantId: 'c',
        allocations: [
          { participantId: 'b', joinOrder: 2, percentage: 50, burden: 10n },
          { participantId: 'c', joinOrder: 3, percentage: 50, burden: 10n },
        ],
      },
    ]),
  });
  const second = root.approve({
    expectedVersion: root.version,
    snapshotId,
    participantId: 'b',
    decidedAt: now(),
  });
  return second.approve({
    expectedVersion: second.version,
    snapshotId,
    participantId: 'c',
    decidedAt: now(),
  });
};

describe('SC-INV1/POST1/POST2: explicit cancellation decisions', () => {
  it('keeps the approved content but does not infer requester agreement', () => {
    const root = active(),
      next = root.requestCancellation(request(root));
    expect(next.latestCancellation).toMatchObject({
      cancellationId: uuid(100),
      snapshotId,
      ordinal: 1,
      reason: '  取消希望  ',
      requestedAt: '2026-10-01T00:00:00.000Z',
      applicant: { actorSubject: 'actor-a', participantId: 'a' },
      requiredApproverIds: ['a', 'b'],
      decisions: [],
      status: 'Pending',
    });
    expect(next.version).toBe(root.version + 1);
    expect(next.snapshot).toBe(root.snapshot);
    expect(next.approvals).toBe(root.approvals);
    expect(next.revisionStatus).toBe('Approved');
    expect(next.cancelledAt).toBeNull();
    expect(next.expenseIdsToRelease).toEqual([]);
    fail(() => next.reportPayment(report(next)), 'CASE_NOT_PAYMENT_ACTIVE');
    const partial = next.agreeCancellation(vote(next, 'b'));
    expect(partial.status).toBe('CancellationPending');
    expect(
      partial.latestCancellation?.decisions.map((d) => d.participantId),
    ).toEqual(['b']);
  });
  it('requires a zero-balance necessary participant in addition to payer and payee before releasing all targets', () => {
    const old = three();
    expect(
      old.snapshot.content.balances.find((b) => b.participantId === 'c')
        ?.amount,
    ).toBe(0n);
    let root = old.requestCancellation(request(old));
    root = root.agreeCancellation(vote(root, 'a'));
    root = root.agreeCancellation(vote(root, 'b'));
    expect(root.status).toBe('CancellationPending');
    expect(root.expenseIdsToRelease).toEqual([]);
    const before = root,
      date = new Date('2026-10-31T16:00:00Z');
    root = root.agreeCancellation({ ...vote(root, 'c'), decidedAt: date });
    date.setUTCFullYear(2000);
    expect(root.status).toBe('Cancelled');
    expect(root.cancelledAt).toBe('2026-10-31T16:00:00.000Z');
    expect(root.expenseIdsToRelease).toEqual(['e1', 'e2']);
    expect(root.archivedAt).toBeNull();
    expect(root.archiveReason).toBeNull();
    expect(root.revisionStatus).toBe('Approved');
    expect(root.revisions).toBe(old.revisions);
    expect(root.approvals).toBe(old.approvals);
    expect(root.activePaymentInstructions).toEqual([]);
    expect(before.status).toBe('CancellationPending');
  });
  it('resumes unchanged payment on one rejection without requiring a rejection reason', () => {
    const root = pending(),
      agreed = root.agreeCancellation(vote(root));
    const resumed = agreed.declineCancellation(vote(agreed, 'b'));
    expect(resumed.status).toBe('PaymentActive');
    expect(resumed.latestCancellation?.status).toBe('Declined');
    expect(
      resumed.latestCancellation?.decisions.map((d) => [
        d.participantId,
        d.decision,
      ]),
    ).toEqual([
      ['a', 'Agreed'],
      ['b', 'Declined'],
    ]);
    expect(resumed.activePaymentInstructions).toEqual(
      root.snapshot.paymentInstructionCandidates,
    );
    expect(resumed.expenseIdsToRelease).toEqual([]);
    const paid = resumed.reportPayment(report(resumed));
    expect(paid.cancellations).toBe(resumed.cancellations);
    expect(paid.paymentAttempts).toHaveLength(1);
    const completed = paid.confirmReceipt(receipt(paid));
    expect(completed.status).toBe('Archived');
    expect(completed.cancellations).toBe(paid.cancellations);
  });
  it('preserves old rejection and starts a fresh request with no carried agreement', () => {
    const first = pending(),
      declined = first.declineCancellation(vote(first, 'b'));
    const next = declined.requestCancellation(request(declined, uuid(101)));
    expect(next.cancellations).toHaveLength(2);
    expect(next.cancellations[0]).toBe(declined.latestCancellation);
    expect(next.latestCancellation).toMatchObject({
      ordinal: 2,
      decisions: [],
      status: 'Pending',
    });
    fail(
      () =>
        next.agreeCancellation({ ...vote(next), cancellationId: uuid(100) }),
      'CANCELLATION_MISMATCH',
    );
  });
  it('allows current owner requests without granting them another participant agreement', () => {
    const root = active(),
      next = root.requestCancellation({
        ...request(root),
        applicant: { actorSubject: 'owner', participantId: 'owner-id' },
      });
    expect(next.latestCancellation?.applicant.participantId).toBe('owner-id');
    expect(next.originalApplicant).toEqual(root.originalApplicant);
    fail(
      () => next.agreeCancellation(vote(next, 'owner-id')),
      'CANCELLATION_PARTICIPANT_NOT_REQUIRED',
    );
  });
  it('keeps original stable actor qualification after leaving or rejoining but does not replace old required ID', () => {
    const root = active(),
      next = root.requestCancellation({
        ...request(root),
        applicant: { actorSubject: 'actor-a', participantId: 'a-rejoined' },
        currentOwnerSubject: 'new-owner',
      });
    expect(next.latestCancellation?.decisions).toEqual([]);
    fail(
      () => next.agreeCancellation(vote(next, 'a-rejoined')),
      'CANCELLATION_PARTICIPANT_NOT_REQUIRED',
    );
    expect(next.agreeCancellation(vote(next, 'a')).status).toBe(
      'CancellationPending',
    );
  });
  it.each(['outsider', 'old-owner', 'source-owner-only'])(
    'does not authorize request by %s',
    (actorSubject) => {
      const root = active();
      fail(
        () =>
          root.requestCancellation({
            ...request(root),
            applicant: { actorSubject, participantId: 'a' },
            currentOwnerSubject: 'new-owner',
          }),
        'ACTOR_NOT_CASE_APPLICANT_OR_OWNER',
      );
    },
  );
});

describe('SC-PRE2/FAIL1: attempt presence and terminal rules', () => {
  it('does not reopen a no-payment archive even though it has no attempts', () => {
    const root = SettlementCase.start({
      caseId: uuid(2),
      snapshotId,
      applicant: { actorSubject: 'actor-a', participantId: 'a' },
      submittedAt: now(),
      instructionIds: [],
      content: SettlementSnapshotContent.from(groupId, [
        {
          expenseId: 'zero',
          groupId,
          amount: 100n,
          payerParticipantId: 'a',
          allocations: [
            { participantId: 'a', joinOrder: 1, percentage: 100, burden: 100n },
          ],
        },
      ]),
    });
    expect(root.archiveReason).toBe('NoPaymentRequired');
    expect(root.paymentAttempts).toEqual([]);
    fail(
      () => root.requestCancellation(request(root)),
      'CASE_NOT_PAYMENT_ACTIVE',
    );
    expect(root.expenseIdsToRelease).toEqual([]);
  });
  it('refuses cancellation when a report exists, including after return', () => {
    const root = active(),
      paid = root.reportPayment(report(root));
    fail(
      () => paid.requestCancellation(request(paid)),
      'CANCELLATION_HAS_ATTEMPTS',
    );
    const returned = paid.returnPayment({ ...receipt(paid), reason: '未受領' });
    fail(
      () => returned.requestCancellation(request(returned)),
      'CANCELLATION_HAS_ATTEMPTS',
    );
  });
  it('refuses cancellation after receipt while another payment is still outstanding', () => {
    let root = SettlementCase.start({
      caseId: uuid(2),
      snapshotId,
      applicant: { actorSubject: 'actor-a', participantId: 'a' },
      submittedAt: now(),
      instructionIds: [uuid(20), uuid(21)],
      content: SettlementSnapshotContent.from(groupId, [
        {
          expenseId: 'e1',
          groupId,
          amount: 300n,
          payerParticipantId: 'a',
          allocations: [
            { participantId: 'a', joinOrder: 1, percentage: 0, burden: 0n },
            { participantId: 'b', joinOrder: 2, percentage: 50, burden: 150n },
            { participantId: 'c', joinOrder: 3, percentage: 50, burden: 150n },
          ],
        },
      ]),
    });
    for (const participantId of ['b', 'c'])
      root = root.approve({
        expectedVersion: root.version,
        snapshotId,
        participantId,
        decidedAt: now(),
      });
    root = root.reportPayment({ ...report(root), amount: 150n });
    root = root.confirmReceipt(receipt(root));
    expect(root.status).toBe('PaymentActive');
    expect(root.paymentAttempts[0].status).toBe('Received');
    fail(
      () => root.requestCancellation(request(root)),
      'CANCELLATION_HAS_ATTEMPTS',
    );
  });
  it('rejects every change after all parties cancelled', () => {
    let root = pending();
    root = root.agreeCancellation(vote(root, 'a'));
    root = root.agreeCancellation(vote(root, 'b'));
    fail(
      () => root.requestCancellation(request(root, uuid(101))),
      'CASE_NOT_PAYMENT_ACTIVE',
    );
    fail(() => root.reportPayment(report(root)), 'CASE_NOT_PAYMENT_ACTIVE');
    fail(() => root.confirmReceipt(receipt(root)), 'CASE_NOT_PAYMENT_ACTIVE');
    fail(
      () => root.returnPayment({ ...receipt(root), reason: '再開' }),
      'CASE_NOT_PAYMENT_ACTIVE',
    );
    fail(
      () => root.agreeCancellation(vote(root)),
      'CASE_NOT_CANCELLATION_PENDING',
    );
    fail(
      () => root.declineCancellation(vote(root)),
      'CASE_NOT_CANCELLATION_PENDING',
    );
    fail(
      () =>
        root.approve({
          expectedVersion: root.version,
          snapshotId,
          participantId: 'b',
          decidedAt: now(),
        }),
      'CASE_NOT_AWAITING_APPROVAL',
    );
    fail(
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
    fail(
      () => root.withdraw({ ...request(root), withdrawnAt: now() }),
      'CASE_CANNOT_BE_WITHDRAWN',
    );
    fail(
      () =>
        root.resubmit({
          ...request(root),
          currentSnapshotId: snapshotId,
          snapshotId: uuid(4),
          content: root.snapshot.content,
          submittedAt: now(),
          instructionIds: [uuid(22)],
        }),
      'CASE_NOT_REJECTED',
    );
  });
  it('rejects a new request or ordinary approval while pending', () => {
    const root = pending();
    fail(
      () => root.requestCancellation(request(root, uuid(101))),
      'CASE_NOT_PAYMENT_ACTIVE',
    );
    fail(
      () =>
        root.approve({
          expectedVersion: root.version,
          snapshotId,
          participantId: 'b',
          decidedAt: now(),
        }),
      'CASE_NOT_AWAITING_APPROVAL',
    );
  });
  it('rejects cancellation requests in awaiting, rejected, withdrawn or archived cases', () => {
    const a = initial(),
      b = a.reject({
        expectedVersion: 1,
        snapshotId,
        participantId: 'b',
        decidedAt: now(),
        reason: '確認',
      });
    const w = a.withdraw({ ...request(a), withdrawnAt: now() });
    const paid = active().reportPayment(report(active()));
    const done = paid.confirmReceipt(receipt(paid));
    for (const root of [a, b, w, done])
      fail(
        () => root.requestCancellation(request(root)),
        'CASE_NOT_PAYMENT_ACTIVE',
      );
  });
  it('requires a pending current request for both kinds of decision', () => {
    const a = active(),
      p = pending(),
      r = p.declineCancellation(vote(p));
    for (const root of [a, r]) {
      const input = {
        expectedVersion: root.version,
        snapshotId,
        cancellationId: uuid(100),
        participantId: 'a',
        decidedAt: now(),
      };
      fail(
        () => root.agreeCancellation(input),
        'CASE_NOT_CANCELLATION_PENDING',
      );
      fail(
        () => root.declineCancellation(input),
        'CASE_NOT_CANCELLATION_PENDING',
      );
    }
  });
});

describe('SC-FAIL1: request and vote validation and immutable history', () => {
  it.each(['', '  ', null as unknown as string])(
    'requires a nonempty request reason %s',
    (reason) => {
      const root = active();
      fail(
        () => root.requestCancellation({ ...request(root), reason }),
        'CANCELLATION_REASON_EMPTY',
      );
    },
  );
  it.each(['', 'not-a-uuid', '00000000-0000-4000-8000-0000000000AF'])(
    'rejects noncanonical request ID %s',
    (cancellationId) => {
      const root = active();
      fail(
        () => root.requestCancellation({ ...request(root), cancellationId }),
        'CANCELLATION_ID_INVALID',
      );
    },
  );
  it('does not reuse a rejected request ID', () => {
    const root = pending(),
      resumed = root.declineCancellation(vote(root));
    fail(
      () => resumed.requestCancellation(request(resumed)),
      'CANCELLATION_ID_REUSED',
    );
  });
  it.each([0, 1, NaN, 1.5, 4])(
    'rejects invalid request version %s',
    (expectedVersion) => {
      const root = active();
      fail(
        () => root.requestCancellation({ ...request(root), expectedVersion }),
        'CASE_VERSION_CONFLICT',
      );
    },
  );
  it('rejects stale votes, snapshot mismatch and old request references', () => {
    const root = pending();
    for (const change of [
      { expectedVersion: 1 },
      { snapshotId: uuid(99) },
      { cancellationId: uuid(99) },
    ]) {
      const code =
        'expectedVersion' in change
          ? 'CASE_VERSION_CONFLICT'
          : 'snapshotId' in change
            ? 'SNAPSHOT_MISMATCH'
            : 'CANCELLATION_MISMATCH';
      fail(() => root.agreeCancellation({ ...vote(root), ...change }), code);
      fail(() => root.declineCancellation({ ...vote(root), ...change }), code);
    }
    const activeRoot = active();
    fail(
      () =>
        activeRoot.requestCancellation({
          ...request(activeRoot),
          snapshotId: uuid(99),
        }),
      'SNAPSHOT_MISMATCH',
    );
  });
  it.each(['owner', 'a-rejoined', 'outsider', ''])(
    'refuses non-required cancellation voter %s',
    (participantId) => {
      const root = pending();
      fail(
        () => root.agreeCancellation(vote(root, participantId)),
        'CANCELLATION_PARTICIPANT_NOT_REQUIRED',
      );
      fail(
        () => root.declineCancellation(vote(root, participantId)),
        'CANCELLATION_PARTICIPANT_NOT_REQUIRED',
      );
    },
  );
  it('allows only one explicit vote by each required participant', () => {
    const root = pending(),
      next = root.agreeCancellation(vote(root));
    fail(
      () => next.agreeCancellation(vote(next)),
      'CANCELLATION_ALREADY_DECIDED',
    );
    fail(
      () => next.declineCancellation(vote(next)),
      'CANCELLATION_ALREADY_DECIDED',
    );
  });
  it('validates dates for the request and both decision kinds', () => {
    const a = active(),
      invalid = new Date('invalid');
    fail(
      () => a.requestCancellation({ ...request(a), requestedAt: invalid }),
      'UTC_INSTANT_INVALID',
    );
    const p = pending();
    fail(
      () => p.agreeCancellation({ ...vote(p), decidedAt: invalid }),
      'UTC_INSTANT_INVALID',
    );
    fail(
      () => p.declineCancellation({ ...vote(p), decidedAt: invalid }),
      'UTC_INSTANT_INVALID',
    );
  });
  it('copies caller data and freezes nested request and decisions', () => {
    const old = active(),
      input = request(old),
      root = old.requestCancellation(input);
    input.applicant.actorSubject = 'changed';
    input.reason = 'changed';
    input.requestedAt.setUTCFullYear(2000);
    const decision = vote(root),
      next = root.agreeCancellation(decision);
    decision.participantId = 'changed';
    decision.decidedAt.setUTCFullYear(2000);
    expect(next.latestCancellation).toMatchObject({
      applicant: { actorSubject: 'actor-a' },
      reason: '  取消希望  ',
      requestedAt: '2026-10-01T00:00:00.000Z',
      decisions: [
        { participantId: 'a', decidedAt: '2026-10-01T00:00:00.000Z' },
      ],
    });
    for (const value of [
      next,
      next.cancellations,
      next.latestCancellation,
      next.latestCancellation!.applicant,
      next.latestCancellation!.requiredApproverIds,
      next.latestCancellation!.decisions,
      next.latestCancellation!.decisions[0],
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(next.latestCancellation!, 'reason', 'changed')).toBe(
      false,
    );
    expect(root.latestCancellation!.decisions).toEqual([]);
    expect(old.cancellations).toEqual([]);
  });
  it('preserves alternative local report and cancellation roots without claiming a storage race winner', () => {
    const root = active(),
      paid = root.reportPayment(report(root)),
      cancel = root.requestCancellation(request(root));
    expect(paid.version).toBe(cancel.version);
    expect(paid.status).toBe('PaymentActive');
    expect(cancel.status).toBe('CancellationPending');
    expect(root.paymentAttempts).toEqual([]);
  });
  it('guards child construction and decisions as well as the root entry point', () => {
    const root = active(),
      input = request(root),
      r = SettlementCancellationRequest.request(
        root.snapshot.snapshotId,
        ['a', 'b'],
        input,
        1,
      );
    fail(
      () =>
        SettlementCancellationRequest.request(
          root.snapshot.snapshotId,
          [],
          input,
          1,
        ),
      'CANCELLATION_APPROVERS_INVALID',
    );
    fail(
      () =>
        SettlementCancellationRequest.request(
          root.snapshot.snapshotId,
          ['a', 'a'],
          input,
          1,
        ),
      'CANCELLATION_APPROVERS_INVALID',
    );
    fail(
      () =>
        SettlementCancellationRequest.request(
          root.snapshot.snapshotId,
          ['a', 'b'],
          input,
          0,
        ),
      'CANCELLATION_ORDINAL_INVALID',
    );
    const decision = {
      expectedVersion: 3,
      snapshotId,
      cancellationId: uuid(100),
      participantId: 'a',
      decidedAt: now(),
    };
    fail(
      () => r.agree({ ...decision, cancellationId: uuid(99) }),
      'CANCELLATION_MISMATCH',
    );
    const finished = r.decline(decision);
    fail(
      () => finished.agree({ ...decision, participantId: 'b' }),
      'CANCELLATION_NOT_PENDING',
    );
  });
});
