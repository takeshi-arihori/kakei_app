import { describe, expect, it } from 'vitest';
import { GroupExpense } from './group-expense.js';
import { ExpenseInvariantViolation } from './expense-invariant-violation.js';
import type { CorrectExpenseAmount } from './expense-amount-correction.js';

const groupId = '00000000-0000-0000-0000-000000000001';
const caseId = '00000000-0000-0000-0000-000000000002';
const registered = () =>
  GroupExpense.register({
    id: 'expense',
    groupId,
    sourceOwnerSubject: 'source',
    occurredOn: '2026-10-01',
    amount: 1000,
    payerParticipantId: 'a',
    participants: [
      { participantId: 'a', joinOrder: 1, percentage: 50 },
      { participantId: 'b', joinOrder: 2, percentage: 50 },
    ],
  });
const input = (): CorrectExpenseAmount => ({
  expectedExpenseVersion: 1,
  expectedCaseVersion: 2,
  caseFact: {
    groupId,
    expenseId: 'expense',
    caseId,
    version: 2,
    lifecycle: 'Rejected',
    allTargetsReleased: false,
  },
  actorSubject: 'source',
  currentOwnerSubject: 'owner',
  amount: 1201,
  reason: '金額の誤入力',
  correctedAt: new Date('2026-10-02T00:00:00Z'),
});

const rejected = (operation: () => unknown, code: string) => {
  let error: unknown;
  try {
    operation();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ExpenseInvariantViolation);
  expect(error).toMatchObject({ code });
};
describe('EC-PRE2/INV1/POST2: eligibility, identity and history', () => {
  it.each(['Rejected', 'Withdrawn', 'Cancelled'])(
    'corrects %s with the full-release precondition for released cases',
    (lifecycle) => {
      const root = registered(),
        i = input();
      const next = root.correctAmount({
        ...i,
        caseFact: {
          ...i.caseFact,
          lifecycle,
          allTargetsReleased: lifecycle !== 'Rejected',
        },
      });
      expect(root.version).toBe(1);
      expect(root.corrections).toEqual([]);
      expect(next.version).toBe(2);
      expect(next.initialSnapshot).toBe(root.snapshot());
      expect(next.corrections).toHaveLength(1);
      expect(next.corrections[0]).toMatchObject({
        actorSubject: 'source',
        reason: '金額の誤入力',
        correctedAt: '2026-10-02T00:00:00.000Z',
        previousVersion: 1,
        version: 2,
        caseFact: { caseId, version: 2, lifecycle },
      });
      expect(next.corrections[0].before).toBe(root.snapshot());
      expect(next.corrections[0].after).toBe(next.snapshot());
      for (const key of [
        'id',
        'groupId',
        'sourceOwnerSubject',
        'occurredOn',
        'payerParticipantId',
      ] as const)
        expect(next.snapshot()[key]).toBe(root.snapshot()[key]);
      expect(
        next
          .snapshot()
          .allocations.map((a) => [a.participantId, a.joinOrder, a.percentage]),
      ).toEqual(
        root
          .snapshot()
          .allocations.map((a) => [a.participantId, a.joinOrder, a.percentage]),
      );
    },
  );
  it('allows the current owner without replacing the source owner', () => {
    const root = registered(),
      next = root.correctAmount({
        ...input(),
        actorSubject: 'new-owner',
        currentOwnerSubject: 'new-owner',
      });
    expect(next.snapshot().sourceOwnerSubject).toBe('source');
    expect(next.corrections[0].actorSubject).toBe('new-owner');
    expect(root.snapshot().total.amount).toBe(1000);
  });
  it('keeps stable source qualification across participant lifetimes and retains all corrections', () => {
    const root = registered(),
      second = root.correctAmount(input());
    const third = second.correctAmount({
      ...input(),
      expectedExpenseVersion: 2,
      expectedCaseVersion: 3,
      caseFact: { ...input().caseFact, version: 3 },
      currentOwnerSubject: 'new-owner',
      amount: 1303,
      reason: '再確認',
    });
    expect(third.version).toBe(3);
    expect(third.corrections[0]).toBe(second.corrections[0]);
    expect(third.corrections[1].before).toBe(second.snapshot());
    expect(third.initialSnapshot).toBe(root.snapshot());
    expect(third.snapshot().allocations.map((a) => a.participantId)).toEqual([
      'a',
      'b',
    ]);
    expect(second.snapshot().total.amount).toBe(1201);
    expect(
      third.corrections.map((c) => [c.previousVersion, c.version]),
    ).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });
  it('records an explicit same-value correction without claiming operation replay semantics', () => {
    const root = registered(),
      next = root.correctAmount({ ...input(), amount: 1000 });
    expect(next.version).toBe(2);
    expect(next.corrections).toHaveLength(1);
    expect(next.snapshot().total.amount).toBe(1000);
  });
  it.each([0, 1, 2, 1001, Number.MAX_SAFE_INTEGER])(
    'preserves allocation total for corrected amount %s',
    (amount) => {
      const next = registered().correctAmount({ ...input(), amount });
      expect(
        next
          .snapshot()
          .allocations.reduce((sum, a) => sum + BigInt(a.burden.amount), 0n),
      ).toBe(BigInt(amount));
      const halves = next.snapshot().allocations;
      expect(halves[0].burden.amount).toBe(Math.ceil(amount / 2));
      expect(halves[1].burden.amount).toBe(Math.floor(amount / 2));
    },
  );
  it('keeps zero percentage and uses historical join order when the payer is outside the remainder tie', () => {
    const root = GroupExpense.register({
      id: 'expense',
      groupId,
      sourceOwnerSubject: 'source',
      occurredOn: '2026-10-01',
      amount: 1000,
      payerParticipantId: 'a',
      participants: [
        { participantId: 'a', joinOrder: 1, percentage: 0 },
        { participantId: 'b', joinOrder: 9, percentage: 50 },
        { participantId: 'c', joinOrder: 7, percentage: 50 },
      ],
    });
    const next = root.correctAmount({ ...input(), amount: 1001 });
    expect(
      next
        .snapshot()
        .allocations.map((a) => [a.participantId, a.burden.amount]),
    ).toEqual([
      ['a', 0],
      ['c', 501],
      ['b', 500],
    ]);
  });
});
describe('EC-FAIL1: typed refusal and no partial mutation', () => {
  it.each([
    'AwaitingApproval',
    'Approved',
    'PaymentActive',
    'CancellationPending',
    'Archived',
    'Unselected',
    '',
  ])('refuses lifecycle %s', (lifecycle) => {
    const root = registered(),
      i = input();
    rejected(
      () =>
        root.correctAmount({
          ...i,
          caseFact: { ...i.caseFact, lifecycle, allTargetsReleased: true },
        }),
      'EXPENSE_NOT_CORRECTABLE',
    );
    expect(root.version).toBe(1);
    expect(root.corrections).toEqual([]);
  });
  it.each(['Withdrawn', 'Cancelled'])(
    'requires source confirmation of whole release for %s',
    (lifecycle) => {
      const root = registered(),
        i = input();
      rejected(
        () =>
          root.correctAmount({
            ...i,
            caseFact: { ...i.caseFact, lifecycle, allTargetsReleased: false },
          }),
        'EXPENSE_NOT_CORRECTABLE',
      );
    },
  );
  it.each([
    'approver',
    'old-owner',
    'other-participant',
    'source-rejoined-participant-id',
  ])(
    'refuses %s who is not either stable authorized subject',
    (actorSubject) => {
      rejected(
        () =>
          registered().correctAmount({
            ...input(),
            actorSubject,
            currentOwnerSubject: 'new-owner',
          }),
        'ACTOR_NOT_SOURCE_OWNER_OR_OWNER',
      );
    },
  );
  it.each(['actorSubject', 'currentOwnerSubject'] as const)(
    'requires a nonempty %s',
    (key) => {
      rejected(
        () => registered().correctAmount({ ...input(), [key]: '  ' }),
        'IDENTIFIER_EMPTY',
      );
    },
  );
  it.each([0, 2, NaN, 1.5, Infinity])(
    'refuses stale or invalid Expense version %s',
    (expectedExpenseVersion) => {
      rejected(
        () =>
          registered().correctAmount({ ...input(), expectedExpenseVersion }),
        'EXPENSE_VERSION_CONFLICT',
      );
    },
  );
  it.each([0, 1, NaN, 1.5, Infinity])(
    'refuses Case expected version %s',
    (expectedCaseVersion) => {
      rejected(
        () => registered().correctAmount({ ...input(), expectedCaseVersion }),
        'CASE_VERSION_CONFLICT',
      );
    },
  );
  it.each([0, -1, NaN, 1.5, Infinity])(
    'refuses invalid current Case version %s',
    (version) => {
      const i = input();
      rejected(
        () =>
          registered().correctAmount({
            ...i,
            expectedCaseVersion: version,
            caseFact: { ...i.caseFact, version },
          }),
        'CASE_VERSION_CONFLICT',
      );
    },
  );
  it.each([{ groupId: 'other' }, { expenseId: 'other' }])(
    'does not correct another source target %j',
    (change) => {
      const i = input();
      rejected(
        () =>
          registered().correctAmount({
            ...i,
            caseFact: { ...i.caseFact, ...change },
          }),
        'CASE_FACT_MISMATCH',
      );
    },
  );
  it.each(['', 'not-canonical', '00000000-0000-0000-0000-00000000000A'])(
    'rejects Case reference %s',
    (caseId) => {
      const i = input();
      rejected(
        () =>
          registered().correctAmount({
            ...i,
            caseFact: { ...i.caseFact, caseId },
          }),
        'CASE_REFERENCE_INVALID',
      );
    },
  );
  it.each([
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '100' as unknown as number,
  ])('refuses invalid corrected amount %s', (amount) => {
    const root = registered();
    rejected(
      () => root.correctAmount({ ...input(), amount }),
      'AMOUNT_INVALID',
    );
    expect(root.snapshot().total.amount).toBe(1000);
    expect(root.corrections).toEqual([]);
  });
  it.each(['', '  ', null as unknown as string])(
    'requires a nonempty correction reason %s',
    (reason) => {
      rejected(
        () => registered().correctAmount({ ...input(), reason }),
        'CORRECTION_REASON_EMPTY',
      );
    },
  );
  it('rejects invalid time without introducing a time-order business rule', () => {
    const root = registered();
    rejected(
      () =>
        root.correctAmount({ ...input(), correctedAt: new Date('invalid') }),
      'UTC_INSTANT_INVALID',
    );
    expect(
      root.correctAmount({
        ...input(),
        correctedAt: new Date('2000-01-01T00:00:00Z'),
      }).corrections[0].correctedAt,
    ).toBe('2000-01-01T00:00:00.000Z');
  });
  it('copies caller facts and freezes all nested results, retaining previous snapshots', () => {
    const root = registered(),
      i = input(),
      next = root.correctAmount({ ...i, reason: '  金額確認  ' });
    i.correctedAt.setUTCFullYear(2000);
    Reflect.set(i.caseFact, 'version', 99);
    expect(next.corrections[0].correctedAt).toBe('2026-10-02T00:00:00.000Z');
    expect(next.corrections[0].caseFact.version).toBe(2);
    expect(next.corrections[0].reason).toBe('  金額確認  ');
    const c = next.corrections[0];
    for (const x of [
      next,
      next.initialSnapshot,
      next.corrections,
      c,
      c.caseFact,
      c.before,
      c.after,
      c.after.total,
      c.after.allocations,
      c.after.allocations[0],
      c.after.allocations[0].burden,
    ])
      expect(Object.isFrozen(x)).toBe(true);
    expect(Reflect.set(c.after.total, 'amount', 9)).toBe(false);
    expect(Reflect.set(c.caseFact, 'caseId', 'other')).toBe(false);
    expect(root.snapshot().total.amount).toBe(1000);
    expect(root.corrections).toEqual([]);
  });
  it('creates alternative local corrections from one version without claiming a storage winner or replay result', () => {
    const root = registered(),
      first = root.correctAmount(input()),
      second = root.correctAmount({ ...input(), amount: 1400 });
    expect(first.version).toBe(second.version);
    expect(first.snapshot().total.amount).toBe(1201);
    expect(second.snapshot().total.amount).toBe(1400);
    rejected(() => first.correctAmount(input()), 'EXPENSE_VERSION_CONFLICT');
    expect(root.version).toBe(1);
  });
});
describe('EC-POST1: amount correction', () => {
  it('recalculates burdens at the same Expense ID without changing the previous facts', () => {
    const old = registered(),
      next = old.correctAmount(input());
    expect(next.snapshot().total.amount).toBe(1201);
    expect(next.snapshot().allocations.map((a) => a.burden.amount)).toEqual([
      601, 600,
    ]);
    expect(next.id.equals(old.id)).toBe(true);
    expect(old.snapshot().total.amount).toBe(1000);
  });
});
