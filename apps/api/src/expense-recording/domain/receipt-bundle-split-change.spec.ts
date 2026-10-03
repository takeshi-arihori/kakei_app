import { describe, expect, it } from 'vitest';
import { GroupExpense, type ExpenseParticipantInput } from './group-expense.js';
import { ExpenseInvariantViolation } from './expense-invariant-violation.js';
import { Receipt, type CheckReceiptBundleEditing } from './receipt.js';
import { ReceiptInvariantViolation } from './receipt-invariant-violation.js';
import type { ChangeReceiptBundleSplit } from './receipt-bundle-split-change.js';
import type { ReceiptBundleEditingFacts } from './receipt-bundle-editing-facts.js';

const groupId = '11111111-1111-4111-8111-111111111111';
const participants: readonly ExpenseParticipantInput[] = [
  { participantId: 'a', joinOrder: 1, percentage: 50 },
  { participantId: 'b', joinOrder: 7, percentage: 50 },
  { participantId: 'c', joinOrder: 9, percentage: 0 },
];
const policy = (
  overrides: Partial<CheckReceiptBundleEditing> = {},
): CheckReceiptBundleEditing => ({
  expectedVersion: 3,
  actorSubject: 'uploader',
  bundleId: 'bundle',
  ...overrides,
});
const pair = (amount = 101, members = participants) => {
  const items = [{ id: 'item', name: 'Tea', amount, categoryId: 'food' }];
  const draft = Receipt.createDraft({
    id: 'receipt',
    uploaderSubject: 'uploader',
    occurredOn: '2026-10-01',
    declaredTotal: amount,
    items,
    adjustments: [],
  });
  const expense = GroupExpense.register({
    id: 'expense',
    groupId,
    sourceOwnerSubject: 'uploader',
    occurredOn: '2026-10-01',
    amount,
    payerParticipantId: members[0].participantId,
    participants: members,
  });
  const confirmed = draft.confirm({
    expectedVersion: 1,
    actorSubject: 'uploader',
    confirmedAt: new Date('2026-10-02T00:00:00Z'),
    occurredOn: '2026-10-01',
    declaredTotal: amount,
    items,
    adjustments: [],
  });
  const receipt = confirmed.registerBundle({
    expectedVersion: 2,
    actorSubject: 'uploader',
    registeredAt: new Date('2026-10-02T00:00:00Z'),
    bundleId: 'bundle',
    itemIds: ['item'],
    expense,
  });
  return { draft, receipt, expense };
};
const change = (
  receipt: Receipt,
  overrides: Partial<ChangeReceiptBundleSplit> = {},
): ChangeReceiptBundleSplit => ({
  expectedExpenseVersion: 1,
  expectedReceiptVersion: receipt.version,
  actorSubject: 'uploader',
  changedAt: new Date('2026-10-02T09:00:00+09:00'),
  bundleFact: receipt.bundleEditingFacts(
    policy({ expectedVersion: receipt.version }),
  ),
  payerParticipantId: 'b',
  percentages: [
    { participantId: 'a', percentage: 50 },
    { participantId: 'b', percentage: 50 },
    { participantId: 'c', percentage: 0 },
  ],
  ...overrides,
});
const rejectExpense = (operation: () => unknown, code: string): void => {
  let error: unknown;
  try {
    operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ExpenseInvariantViolation);
  expect(error).toMatchObject({ code });
  expect((error as Error).message).not.toContain('uploader');
};
const rejectReceipt = (operation: () => unknown, code: string): void => {
  let error: unknown;
  try {
    operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ReceiptInvariantViolation);
  expect(error).toMatchObject({ code });
};
const burdens = (expense: GroupExpense) =>
  expense.snapshot().allocations.map((a) => a.burden.amount);

describe('BS-P1: Receipt supplies editing facts through its permanent policy', () => {
  it('projects the registered Bundle adjusted sum rather than the whole Receipt total without changing source facts', () => {
    const { expense } = pair();
    const items = [
      { id: 'a', name: 'Tea', amount: 60, categoryId: 'food' },
      { id: 'b', name: 'Cup', amount: 51, categoryId: 'tools' },
      { id: 'c', name: 'Bread', amount: 20, categoryId: 'food' },
    ];
    const draft = Receipt.createDraft({
      id: 'receipt',
      uploaderSubject: 'uploader',
      occurredOn: '2026-10-01',
      declaredTotal: 121,
      items,
      adjustments: [],
    });
    const receipt = draft
      .confirm({
        expectedVersion: 1,
        actorSubject: 'uploader',
        confirmedAt: new Date('2026-10-02T00:00:00Z'),
        occurredOn: '2026-10-01',
        declaredTotal: 121,
        items,
        adjustments: [
          {
            kind: 'Discount',
            amount: -10,
            target: { scope: 'Item', itemId: 'a' },
          },
        ],
      })
      .registerBundle({
        expectedVersion: 2,
        actorSubject: 'uploader',
        registeredAt: new Date('2026-10-02T00:00:00Z'),
        bundleId: 'bundle',
        itemIds: ['a', 'b'],
        expense,
      });
    const before = receipt.snapshot(),
      history = receipt.changes;
    const fact = receipt.bundleEditingFacts(policy());
    expect(fact).toEqual({
      receiptId: 'receipt',
      bundleId: 'bundle',
      expenseId: 'expense',
      groupId,
      receiptVersion: 3,
      uploaderSubject: 'uploader',
      occurredOn: '2026-10-01',
      adjustedAmount: 101,
    });
    expect(Object.isFrozen(fact)).toBe(true);
    expect(Reflect.set(fact, 'adjustedAmount', 0)).toBe(false);
    expect(receipt.snapshot()).toBe(before);
    expect(receipt.changes).toBe(history);
    expect(receipt.version).toBe(3);
  });
  it.each(['owner', 'other'])(
    'rejects %s who is not Uploader',
    (actorSubject) => {
      rejectReceipt(
        () => pair().receipt.bundleEditingFacts(policy({ actorSubject })),
        'ACTOR_NOT_UPLOADER',
      );
    },
  );
  it.each([2, 4, NaN, 3.5])(
    'rejects stale or invalid Receipt version %s',
    (expectedVersion) => {
      rejectReceipt(
        () => pair().receipt.bundleEditingFacts(policy({ expectedVersion })),
        'VERSION_CONFLICT',
      );
    },
  );
  it('rejects Draft, unknown Bundle, invalid Actor and selected Bundle', () => {
    const { draft, receipt } = pair();
    rejectReceipt(
      () => draft.bundleEditingFacts(policy({ expectedVersion: 1 })),
      'RECEIPT_NOT_CONFIRMED',
    );
    rejectReceipt(
      () => receipt.bundleEditingFacts(policy({ bundleId: 'missing' })),
      'BUNDLE_NOT_FOUND',
    );
    rejectReceipt(
      () => receipt.bundleEditingFacts(policy({ bundleId: ' ' })),
      'BUNDLE_ID_INVALID',
    );
    rejectReceipt(
      () => receipt.bundleEditingFacts(policy({ actorSubject: ' ' })),
      'ACTOR_REFERENCE_INVALID',
    );
    const selected = receipt.recordBundleSnapshotSelection({
      expectedVersion: 3,
      selection: {
        bundleId: 'bundle',
        expenseId: 'expense',
        groupId,
        caseId: '22222222-2222-4222-8222-222222222222',
        snapshotId: '33333333-3333-4333-8333-333333333333',
        actorSubject: 'owner',
        selectedAt: new Date('2026-10-02T00:00:00Z'),
      },
    });
    rejectReceipt(
      () => selected.bundleEditingFacts(policy({ expectedVersion: 4 })),
      'BUNDLE_EDITING_LOCKED',
    );
  });
});

describe('BS-O1/I1: payer and Split changes preserve registration identity', () => {
  it('changes the payer tie-break at the same Expense ID and preserves immutable source and participant facts', () => {
    const { receipt, expense } = pair(),
      source = receipt.snapshot(),
      before = expense.snapshot();
    const next = expense.changeBundleSplit(change(receipt));
    expect(burdens(expense)).toEqual([51, 50, 0]);
    expect(burdens(next)).toEqual([50, 51, 0]);
    expect(next.snapshot().payerParticipantId).toBe('b');
    for (const key of [
      'id',
      'groupId',
      'sourceOwnerSubject',
      'occurredOn',
      'total',
    ] as const)
      expect(next.snapshot()[key]).toBe(before[key]);
    expect(
      next.snapshot().allocations.map((a) => [a.participantId, a.joinOrder]),
    ).toEqual(before.allocations.map((a) => [a.participantId, a.joinOrder]));
    expect(next.initialSnapshot).toBe(before);
    expect(next.version).toBe(2);
    expect(next.corrections).toEqual([]);
    expect(receipt.snapshot()).toBe(source);
    expect(receipt.version).toBe(3);
    expect(receipt.changes).toHaveLength(2);
  });
  it('changes percentages independently of payer and ignores caller array order', () => {
    const { receipt, expense } = pair();
    const percentages = [
      { participantId: 'c', percentage: 0 },
      { participantId: 'b', percentage: 20 },
      { participantId: 'a', percentage: 80 },
    ];
    const next = expense.changeBundleSplit(
      change(receipt, { percentages, payerParticipantId: 'a' }),
    );
    expect(
      next
        .snapshot()
        .allocations.map((a) => [
          a.participantId,
          a.percentage,
          a.burden.amount,
        ]),
    ).toEqual([
      ['a', 80, 81],
      ['b', 20, 20],
      ['c', 0, 0],
    ]);
    expect(
      expense
        .changeBundleSplit(
          change(receipt, {
            percentages: [...percentages].reverse(),
            payerParticipantId: 'a',
          }),
        )
        .snapshot(),
    ).toEqual(next.snapshot());
  });
  it('uses historical joinOrder when a zero-percent payer is outside the remainder tie', () => {
    const { receipt, expense } = pair(101, [
      participants[0],
      { ...participants[1], joinOrder: 9 },
      { ...participants[2], joinOrder: 7 },
    ]);
    const next = expense.changeBundleSplit(
      change(receipt, {
        payerParticipantId: 'a',
        percentages: [
          { participantId: 'a', percentage: 0 },
          { participantId: 'b', percentage: 50 },
          { participantId: 'c', percentage: 50 },
        ],
      }),
    );
    expect(
      next
        .snapshot()
        .allocations.map((a) => [
          a.participantId,
          a.joinOrder,
          a.burden.amount,
        ]),
    ).toEqual([
      ['a', 1, 0],
      ['c', 7, 51],
      ['b', 9, 50],
    ]);
  });
  it.each([0, 1, Number.MAX_SAFE_INTEGER])(
    'keeps exact JPY sum at amount %s',
    (amount) => {
      const { receipt, expense } = pair(amount);
      const next = expense.changeBundleSplit(change(receipt));
      expect(
        next
          .snapshot()
          .allocations.reduce((sum, a) => sum + BigInt(a.burden.amount), 0n),
      ).toBe(BigInt(amount));
      expect(next.snapshot().allocations[2].burden.amount).toBe(0);
      expect(next.version).toBe(2);
    },
  );
  it.each([1, 2, 3, 4])(
    'keeps the full fixed set of %s participants',
    (count) => {
      const members = Array.from({ length: count }, (_, n) => ({
        participantId: String(n),
        joinOrder: n + 1,
        percentage: n === 0 ? 100 : 0,
      }));
      const { receipt, expense } = pair(101, members);
      const next = expense.changeBundleSplit(
        change(receipt, {
          payerParticipantId: String(count - 1),
          percentages: members.map((m) => ({
            participantId: m.participantId,
            percentage: m.participantId === String(count - 1) ? 100 : 0,
          })),
        }),
      );
      expect(
        next.snapshot().allocations.map((a) => [a.participantId, a.joinOrder]),
      ).toEqual(members.map((m) => [m.participantId, m.joinOrder]));
      expect(burdens(next)).toEqual(
        members.map((m) => (m.participantId === String(count - 1) ? 101 : 0)),
      );
      expect(next.version).toBe(count === 1 ? 1 : 2);
    },
  );
});

describe('BS-O2/I2: versioned immutable history and current-version no-op', () => {
  it('records successive changes and copies time, facts and percentage inputs deeply', () => {
    const { receipt, expense } = pair();
    const supplied = change(receipt, {
      bundleFact: { ...receipt.bundleEditingFacts(policy()) },
    });
    const next = expense.changeBundleSplit(supplied),
      record = next.bundleSplitChanges[0];
    supplied.changedAt.setTime(0);
    Reflect.set(supplied.bundleFact, 'receiptVersion', 99);
    Reflect.set(supplied.percentages[0], 'percentage', 100);
    expect(record).toMatchObject({
      actorSubject: 'uploader',
      at: '2026-10-02T00:00:00.000Z',
      previousVersion: 1,
      version: 2,
      bundleFact: { receiptVersion: 3 },
    });
    expect(record.before).toBe(expense.snapshot());
    expect(record.after).toBe(next.snapshot());
    expect(record.bundleFact).not.toBe(supplied.bundleFact);
    for (const value of [
      next,
      next.initialSnapshot,
      next.bundleSplitChanges,
      record,
      record.bundleFact,
      record.before,
      record.after,
      record.after.total,
      record.after.allocations,
      ...record.after.allocations,
      ...record.after.allocations.map((a) => a.burden),
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(record.bundleFact, 'bundleId', 'other')).toBe(false);
    expect(Reflect.set(record.after.allocations[0], 'percentage', 0)).toBe(
      false,
    );
    const third = next.changeBundleSplit(
      change(receipt, {
        expectedExpenseVersion: 2,
        percentages: [
          { participantId: 'a', percentage: 80 },
          { participantId: 'b', percentage: 20 },
          { participantId: 'c', percentage: 0 },
        ],
      }),
    );
    expect(third.version).toBe(3);
    expect(third.bundleSplitChanges[0]).toBe(record);
    expect(third.bundleSplitChanges[1].before).toBe(next.snapshot());
    expect(third.initialSnapshot).toBe(expense.snapshot());
    expect(expense.bundleSplitChanges).toEqual([]);
  });
  it('preserves both history kinds across amount-only correction and subsequent Split change', () => {
    const { receipt, expense } = pair();
    const split = expense.changeBundleSplit(change(receipt));
    const corrected = split.correctAmount({
      expectedExpenseVersion: 2,
      expectedCaseVersion: 1,
      caseFact: {
        groupId,
        expenseId: 'expense',
        caseId: '22222222-2222-4222-8222-222222222222',
        version: 1,
        lifecycle: 'Rejected',
        allTargetsReleased: false,
      },
      actorSubject: 'uploader',
      currentOwnerSubject: 'owner',
      amount: 101,
      reason: '金額確認',
      correctedAt: new Date('2026-10-02T00:00:00Z'),
    });
    const next = corrected.changeBundleSplit(
      change(receipt, { expectedExpenseVersion: 3, payerParticipantId: 'a' }),
    );
    expect(next.version).toBe(4);
    expect(next.corrections[0]).toBe(corrected.corrections[0]);
    expect(next.bundleSplitChanges[0]).toBe(split.bundleSplitChanges[0]);
    expect(next.bundleSplitChanges[1]).toMatchObject({
      previousVersion: 3,
      version: 4,
    });
    expect(next.initialSnapshot).toBe(expense.snapshot());
  });
  it('returns the same Root for valid unchanged financial facts but rejects stale versions and invalid no-op input', () => {
    const { receipt, expense } = pair();
    const unchanged = change(receipt, { payerParticipantId: 'a' });
    expect(expense.changeBundleSplit(unchanged)).toBe(expense);
    const next = expense.changeBundleSplit(change(receipt));
    expect(
      next.changeBundleSplit(change(receipt, { expectedExpenseVersion: 2 })),
    ).toBe(next);
    rejectExpense(
      () => next.changeBundleSplit(change(receipt)),
      'EXPENSE_VERSION_CONFLICT',
    );
    rejectExpense(
      () => expense.changeBundleSplit({ ...unchanged, actorSubject: 'owner' }),
      'ACTOR_NOT_UPLOADER',
    );
    rejectExpense(
      () =>
        expense.changeBundleSplit({ ...unchanged, expectedReceiptVersion: 2 }),
      'RECEIPT_VERSION_CONFLICT',
    );
    rejectExpense(
      () =>
        expense.changeBundleSplit({ ...unchanged, changedAt: new Date(NaN) }),
      'UTC_INSTANT_INVALID',
    );
  });
  it('does not treat an old Receipt fact or alternative local Root as an actual storage winner', () => {
    const { receipt, expense } = pair(),
      fact = receipt.bundleEditingFacts(policy());
    const selected = receipt.recordBundleSnapshotSelection({
      expectedVersion: 3,
      selection: {
        bundleId: 'bundle',
        expenseId: 'expense',
        groupId,
        caseId: '22222222-2222-4222-8222-222222222222',
        snapshotId: '33333333-3333-4333-8333-333333333333',
        actorSubject: 'owner',
        selectedAt: new Date('2026-10-02T00:00:00Z'),
      },
    });
    rejectReceipt(
      () => selected.bundleEditingFacts(policy({ expectedVersion: 4 })),
      'BUNDLE_EDITING_LOCKED',
    );
    const first = expense.changeBundleSplit(change(receipt));
    const alternative = expense.changeBundleSplit(
      change(receipt, { payerParticipantId: 'c' }),
    );
    expect(first.version).toBe(alternative.version);
    expect(first.snapshot().payerParticipantId).toBe('b');
    expect(alternative.snapshot().payerParticipantId).toBe('c');
    expect(
      expense.changeBundleSplit(change(receipt, { bundleFact: fact })).version,
    ).toBe(2);
  });
});

describe('BS-F1: typed refusals preserve the old Root and inputs', () => {
  it.each([0, 2, NaN, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects Expense expected version %s',
    (expectedExpenseVersion) => {
      const { receipt, expense } = pair();
      rejectExpense(
        () =>
          expense.changeBundleSplit(
            change(receipt, { expectedExpenseVersion }),
          ),
        'EXPENSE_VERSION_CONFLICT',
      );
      expect(expense.version).toBe(1);
      expect(expense.bundleSplitChanges).toEqual([]);
    },
  );
  it.each([0, 2, NaN, 3.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects Receipt expected version %s',
    (expectedReceiptVersion) => {
      const { receipt, expense } = pair();
      rejectExpense(
        () =>
          expense.changeBundleSplit(
            change(receipt, { expectedReceiptVersion }),
          ),
        'RECEIPT_VERSION_CONFLICT',
      );
    },
  );
  it.each([0, -1, NaN, 3.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid fact version even when expected agrees %s',
    (receiptVersion) => {
      const { receipt, expense } = pair(),
        input = change(receipt);
      rejectExpense(
        () =>
          expense.changeBundleSplit({
            ...input,
            expectedReceiptVersion: receiptVersion,
            bundleFact: { ...input.bundleFact, receiptVersion },
          }),
        'RECEIPT_VERSION_CONFLICT',
      );
    },
  );
  it.each([
    { expenseId: 'other' },
    { groupId: '22222222-2222-4222-8222-222222222222' },
    { uploaderSubject: 'owner' },
    { occurredOn: '2026-10-02' },
    { adjustedAmount: 100 },
  ])('rejects mismatched Bundle fact %j', (overrides) => {
    const { receipt, expense } = pair(),
      input = change(receipt),
      before = expense.snapshot();
    rejectExpense(
      () =>
        expense.changeBundleSplit({
          ...input,
          bundleFact: { ...input.bundleFact, ...overrides },
        }),
      'BUNDLE_FACT_MISMATCH',
    );
    expect(expense.snapshot()).toBe(before);
    expect(expense.bundleSplitChanges).toEqual([]);
  });
  it.each([
    'receiptId',
    'bundleId',
    'expenseId',
    'groupId',
    'uploaderSubject',
  ] as const)('rejects empty fact %s', (key) => {
    const { receipt, expense } = pair(),
      input = change(receipt);
    rejectExpense(
      () =>
        expense.changeBundleSplit({
          ...input,
          bundleFact: { ...input.bundleFact, [key]: ' ' },
        }),
      'BUNDLE_FACT_INVALID',
    );
  });
  it.each([-1, NaN, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid fact amount %s',
    (adjustedAmount) => {
      const { receipt, expense } = pair(),
        input = change(receipt);
      rejectExpense(
        () =>
          expense.changeBundleSplit({
            ...input,
            bundleFact: { ...input.bundleFact, adjustedAmount },
          }),
        'BUNDLE_FACT_INVALID',
      );
    },
  );
  it('rejects a missing fact instead of returning a partial result', () => {
    const { receipt, expense } = pair();
    rejectExpense(
      () =>
        expense.changeBundleSplit(
          change(receipt, {
            bundleFact: null as unknown as ReceiptBundleEditingFacts,
          }),
        ),
      'BUNDLE_FACT_INVALID',
    );
  });
  it.each(['owner', 'other', 'a'])(
    'rejects non-Uploader actor %s',
    (actorSubject) => {
      const { receipt, expense } = pair();
      rejectExpense(
        () => expense.changeBundleSplit(change(receipt, { actorSubject })),
        'ACTOR_NOT_UPLOADER',
      );
    },
  );
  it.each(['', ' '])('rejects blank actor %s', (actorSubject) => {
    const { receipt, expense } = pair();
    rejectExpense(
      () => expense.changeBundleSplit(change(receipt, { actorSubject })),
      'IDENTIFIER_EMPTY',
    );
  });
  it('rejects invalid UTC and an external payer', () => {
    const { receipt, expense } = pair();
    rejectExpense(
      () =>
        expense.changeBundleSplit(
          change(receipt, { changedAt: new Date(NaN) }),
        ),
      'UTC_INSTANT_INVALID',
    );
    rejectExpense(
      () =>
        expense.changeBundleSplit(
          change(receipt, { payerParticipantId: 'other' }),
        ),
      'PAYER_NOT_PARTICIPANT',
    );
  });
  it.each(
    [
      [
        { participantId: 'a', percentage: 50 },
        { participantId: 'b', percentage: 50 },
      ],
      [
        ...participants.map((p) => ({
          participantId: p.participantId,
          percentage: p.percentage,
        })),
        { participantId: 'd', percentage: 0 },
      ],
      [
        { participantId: 'a', percentage: 50 },
        { participantId: 'b', percentage: 50 },
        { participantId: 'd', percentage: 0 },
      ],
      [
        { participantId: 'a', percentage: 50 },
        { participantId: 'a', percentage: 50 },
        { participantId: 'c', percentage: 0 },
      ],
    ].map((percentages) => ({ percentages })),
  )(
    'rejects added, removed, substituted or duplicate participants %j',
    ({ percentages }) => {
      const { receipt, expense } = pair(),
        before = expense.snapshot();
      rejectExpense(
        () => expense.changeBundleSplit(change(receipt, { percentages })),
        'PARTICIPANT_SET_MISMATCH',
      );
      expect(expense.snapshot()).toBe(before);
    },
  );
  it.each([-10, 110, 15, 10.5, NaN, Infinity])(
    'rejects percentage %s through the shared allocator',
    (percentage) => {
      const { receipt, expense } = pair();
      rejectExpense(
        () =>
          expense.changeBundleSplit(
            change(receipt, {
              percentages: [
                { participantId: 'a', percentage },
                { participantId: 'b', percentage: 50 },
                { participantId: 'c', percentage: 0 },
              ],
            }),
          ),
        'PERCENTAGE_INVALID',
      );
    },
  );
  it('rejects a percentage total other than 100', () => {
    const { receipt, expense } = pair();
    rejectExpense(
      () =>
        expense.changeBundleSplit(
          change(receipt, {
            percentages: participants.map((p) => ({
              participantId: p.participantId,
              percentage: 0,
            })),
          }),
        ),
      'PERCENTAGE_TOTAL_INVALID',
    );
  });
  it('rejects version overflow for a real change and preserves a valid no-op at the last safe version', () => {
    const { receipt, expense } = pair();
    const last = Reflect.construct(GroupExpense, [
      expense.snapshot(),
      expense.initialSnapshot,
      Number.MAX_SAFE_INTEGER,
    ]) as GroupExpense;
    rejectExpense(
      () =>
        last.changeBundleSplit(
          change(receipt, { expectedExpenseVersion: Number.MAX_SAFE_INTEGER }),
        ),
      'VERSION_OVERFLOW',
    );
    expect(
      last.changeBundleSplit(
        change(receipt, {
          expectedExpenseVersion: Number.MAX_SAFE_INTEGER,
          payerParticipantId: 'a',
        }),
      ),
    ).toBe(last);
  });
});
