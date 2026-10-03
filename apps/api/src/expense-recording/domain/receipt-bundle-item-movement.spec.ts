import { describe, expect, it } from 'vitest';
import { GroupExpense } from './group-expense.js';
import { Receipt, type MoveReceiptBundleItems } from './receipt.js';
import { ExpenseInvariantViolation } from './expense-invariant-violation.js';
import { ReceiptInvariantViolation } from './receipt-invariant-violation.js';
import type { ReflectReceiptBundleItemMovement } from './receipt-bundle-item-movement.js';

const groupId = '11111111-1111-4111-8111-111111111111';
const at = () => new Date('2026-10-03T09:00:00+09:00');
const fixture = (zero = false, partial = false, extra = false) => {
  const items = [
    { id: 'a', name: 'Tea', amount: 110, categoryId: 'food' },
    { id: 'b', name: 'Cup', amount: zero ? 0 : 51, categoryId: 'tools' },
    { id: 'c', name: 'Bread', amount: 100, categoryId: 'food' },
    { id: 'd', name: 'Milk', amount: 20, categoryId: 'food' },
    ...(extra
      ? [{ id: 'e', name: 'Snack', amount: 10, categoryId: 'food' }]
      : []),
  ];
  const total = (zero ? 220 : 271) + (extra ? 10 : 0);
  const draft = Receipt.createDraft({
    id: 'receipt',
    uploaderSubject: 'uploader',
    occurredOn: '2026-10-01',
    declaredTotal: total,
    items,
    adjustments: [],
  });
  const adjustments = [
    {
      kind: 'Discount' as const,
      amount: -10,
      target: { scope: 'Item' as const, itemId: 'a' },
    },
  ];
  const confirmed = draft.confirm({
    expectedVersion: 1,
    actorSubject: 'uploader',
    confirmedAt: at(),
    occurredOn: '2026-10-01',
    declaredTotal: total,
    items,
    adjustments,
  });
  const expense = (
    id: string,
    amount: number,
    payerParticipantId = 'a',
    percentages = [50, 50],
  ) =>
    GroupExpense.register({
      id,
      groupId,
      sourceOwnerSubject: 'uploader',
      occurredOn: '2026-10-01',
      amount,
      payerParticipantId,
      participants: [
        { participantId: 'a', joinOrder: 2, percentage: percentages[0] },
        { participantId: 'b', joinOrder: 7, percentage: percentages[1] },
      ],
    });
  const fromExpense = expense(
      'expense-from',
      (zero ? 100 : 151) + (extra ? 10 : 0),
    ),
    toExpense = expense('expense-to', 100, 'b', [80, 20]),
    otherExpense = expense('expense-other', 20);
  let receipt = confirmed
    .registerBundle({
      expectedVersion: 2,
      actorSubject: 'uploader',
      registeredAt: at(),
      bundleId: 'from',
      itemIds: extra ? ['a', 'b', 'e'] : ['a', 'b'],
      expense: fromExpense,
    })
    .registerBundle({
      expectedVersion: 3,
      actorSubject: 'uploader',
      registeredAt: at(),
      bundleId: 'to',
      itemIds: ['c'],
      expense: toExpense,
    });
  if (!partial)
    receipt = receipt.registerBundle({
      expectedVersion: 4,
      actorSubject: 'uploader',
      registeredAt: at(),
      bundleId: 'other',
      itemIds: ['d'],
      expense: otherExpense,
    });
  return { draft, receipt, fromExpense, toExpense, otherExpense };
};
const move = (
  receipt: Receipt,
  overrides: Partial<MoveReceiptBundleItems> = {},
): MoveReceiptBundleItems => ({
  expectedVersion: receipt.version,
  actorSubject: 'uploader',
  movedAt: at(),
  fromBundleId: 'from',
  toBundleId: 'to',
  itemIds: ['b'],
  ...overrides,
});
const confirmed = (receipt: Receipt) => {
  const s = receipt.snapshot();
  if (s.status !== 'Confirmed') throw new Error('Expected Confirmed');
  return s;
};
const fact = (receipt: Receipt, bundleId: string) =>
  receipt.bundleEditingFacts({
    expectedVersion: receipt.version,
    actorSubject: 'uploader',
    bundleId,
  });
const reflection = (
  before: Receipt,
  after: Receipt,
  bundleId: string,
  expense: GroupExpense,
  overrides: Partial<ReflectReceiptBundleItemMovement> = {},
): ReflectReceiptBundleItemMovement => ({
  expectedExpenseVersion: expense.version,
  expectedReceiptVersion: before.version,
  beforeBundleFact: fact(before, bundleId),
  afterBundleFact: fact(after, bundleId),
  actorSubject: 'uploader',
  changedAt: at(),
  ...overrides,
});
const refused = (
  operation: () => unknown,
  type: typeof ReceiptInvariantViolation | typeof ExpenseInvariantViolation,
  code: string,
): void => {
  let error: unknown;
  try {
    operation();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(type);
  expect(error).toMatchObject({ code });
};
const selection = (receipt: Receipt, bundleId: string) =>
  receipt.recordBundleSnapshotSelection({
    expectedVersion: receipt.version,
    selection: {
      bundleId,
      expenseId: fact(receipt, bundleId).expenseId,
      groupId,
      caseId: '22222222-2222-4222-8222-222222222222',
      snapshotId: '33333333-3333-4333-8333-333333333333',
      actorSubject: 'owner',
      selectedAt: at(),
    },
  });
const amounts = (expense: GroupExpense) =>
  expense.snapshot().allocations.map((a) => a.burden.amount);

describe('BM-O1/I1: move Item ownership and reflect both existing Expenses', () => {
  it('moves the adjusted Item once and updates both Expense amounts and burdens preserving all financial identity facts', () => {
    const { receipt, fromExpense, toExpense } = fixture();
    const after = receipt.moveBundleItems(move(receipt));
    const updatedFrom = fromExpense.reflectBundleItemMovement(
      reflection(receipt, after, 'from', fromExpense),
    );
    const updatedTo = toExpense.reflectBundleItemMovement(
      reflection(receipt, after, 'to', toExpense),
    );
    expect(
      confirmed(after).bundles.map((b) => [
        b.id.value,
        b.itemIds,
        b.expenseId.value,
      ]),
    ).toEqual([
      ['from', ['a'], 'expense-from'],
      ['to', ['b', 'c'], 'expense-to'],
      ['other', ['d'], 'expense-other'],
    ]);
    expect(updatedFrom.snapshot().total.amount).toBe(100);
    expect(amounts(updatedFrom)).toEqual([50, 50]);
    expect(updatedTo.snapshot().total.amount).toBe(151);
    expect(amounts(updatedTo)).toEqual([121, 30]);
    expect(
      updatedFrom.snapshot().total.amount + updatedTo.snapshot().total.amount,
    ).toBe(251);
    for (const [old, next] of [
      [fromExpense, updatedFrom],
      [toExpense, updatedTo],
    ]) {
      for (const k of [
        'id',
        'groupId',
        'sourceOwnerSubject',
        'occurredOn',
        'payerParticipantId',
      ] as const)
        expect(next.snapshot()[k]).toBe(old.snapshot()[k]);
      expect(
        next
          .snapshot()
          .allocations.map((a) => [a.participantId, a.joinOrder, a.percentage]),
      ).toEqual(
        old
          .snapshot()
          .allocations.map((a) => [a.participantId, a.joinOrder, a.percentage]),
      );
      expect(next.initialSnapshot).toBe(old.snapshot());
      expect(next.version).toBe(2);
      expect(next.bundleItemMovements).toHaveLength(1);
    }
    expect(after.version).toBe(receipt.version + 1);
    expect(after.id).toBe(receipt.id);
    expect(after.changes.slice(0, -1)).toEqual(receipt.changes);
    for (const k of [
      'items',
      'adjustments',
      'allocations',
      'bundleSnapshotSelections',
      'occurredOn',
      'declaredTotal',
    ] as const)
      expect(confirmed(after)[k]).toBe(confirmed(receipt)[k]);
    expect(confirmed(after).bundles[2]).toBe(confirmed(receipt).bundles[2]);
    expect(after.hasCompleteBundleRegistration()).toBe(true);
    expect(fromExpense.snapshot().total.amount).toBe(151);
    expect(toExpense.snapshot().total.amount).toBe(100);
  });
  it('uses the adjusted amount of a discounted Item rather than its original amount', () => {
    const { receipt, fromExpense, toExpense } = fixture();
    const after = receipt.moveBundleItems(move(receipt, { itemIds: ['a'] }));
    expect(
      fromExpense
        .reflectBundleItemMovement(
          reflection(receipt, after, 'from', fromExpense),
        )
        .snapshot().total.amount,
    ).toBe(51);
    expect(
      toExpense
        .reflectBundleItemMovement(reflection(receipt, after, 'to', toExpense))
        .snapshot().total.amount,
    ).toBe(200);
  });
  it('retains incomplete registration and never captures an unassigned Item', () => {
    const { receipt } = fixture(false, true);
    const after = receipt.moveBundleItems(move(receipt));
    expect(after.hasCompleteBundleRegistration()).toBe(false);
    expect(confirmed(after).bundles.flatMap((b) => b.itemIds)).not.toContain(
      'd',
    );
    refused(
      () => receipt.moveBundleItems(move(receipt, { itemIds: ['d'] })),
      ReceiptInvariantViolation,
      'BUNDLE_ITEMS_INVALID',
    );
  });
  it('records both Expense effects even when moving a zero-yen Item changes no amount', () => {
    const { receipt, fromExpense, toExpense } = fixture(true);
    const after = receipt.moveBundleItems(move(receipt));
    for (const [bundleId, old] of [
      ['from', fromExpense],
      ['to', toExpense],
    ] as const) {
      const next = old.reflectBundleItemMovement(
        reflection(receipt, after, bundleId, old),
      );
      expect(next.version).toBe(2);
      expect(next.bundleItemMovements).toHaveLength(1);
      expect(next.snapshot().total.amount).toBe(old.snapshot().total.amount);
      expect(amounts(next)).toEqual(amounts(old));
    }
    expect(after.version).toBe(6);
    expect(confirmed(after).bundles[0].itemIds).toEqual(['a']);
  });
  it('preserves prior history across reverse movements and subsequent payer / amount-only changes', () => {
    const { receipt, fromExpense } = fixture();
    const after = receipt.moveBundleItems(move(receipt));
    const reflected = fromExpense.reflectBundleItemMovement(
      reflection(receipt, after, 'from', fromExpense),
    );
    const split = reflected.changeBundleSplit({
      expectedExpenseVersion: 2,
      expectedReceiptVersion: 6,
      bundleFact: fact(after, 'from'),
      actorSubject: 'uploader',
      changedAt: at(),
      payerParticipantId: 'b',
      percentages: [
        { participantId: 'a', percentage: 50 },
        { participantId: 'b', percentage: 50 },
      ],
    });
    const corrected = split.correctAmount({
      expectedExpenseVersion: 3,
      expectedCaseVersion: 1,
      caseFact: {
        groupId,
        expenseId: 'expense-from',
        caseId: '22222222-2222-4222-8222-222222222222',
        version: 1,
        lifecycle: 'Rejected',
        allTargetsReleased: false,
      },
      actorSubject: 'uploader',
      currentOwnerSubject: 'owner',
      amount: 100,
      reason: '金額確認',
      correctedAt: at(),
    });
    const back = after.moveBundleItems(
      move(after, { fromBundleId: 'to', toBundleId: 'from' }),
    );
    const next = corrected.reflectBundleItemMovement(
      reflection(after, back, 'from', corrected),
    );
    expect(next.version).toBe(5);
    expect(next.bundleItemMovements[0]).toBe(reflected.bundleItemMovements[0]);
    expect(next.bundleSplitChanges[0]).toBe(split.bundleSplitChanges[0]);
    expect(next.corrections[0]).toBe(corrected.corrections[0]);
    expect(next.initialSnapshot).toBe(fromExpense.snapshot());
    expect(next.snapshot().payerParticipantId).toBe('b');
    expect(amounts(next)).toEqual([75, 76]);
    expect(confirmed(back).bundles.map((b) => b.itemIds)).toEqual([
      ['a', 'b'],
      ['c'],
      ['d'],
    ]);
  });
  it('copies and freezes history, Item arrays, timestamps and caller facts', () => {
    const { receipt, fromExpense } = fixture();
    const input = move(receipt);
    const after = receipt.moveBundleItems(input);
    input.movedAt.setTime(0);
    Reflect.set(input.itemIds, '0', 'a');
    const change = after.changes[after.changes.length - 1];
    expect(change).toMatchObject({
      action: 'BundleItemsMoved',
      actorSubject: 'uploader',
      at: '2026-10-03T00:00:00.000Z',
      previousVersion: 5,
      version: 6,
      itemIds: ['b'],
    });
    const supplied = reflection(receipt, after, 'from', fromExpense);
    const mutable = {
      ...supplied,
      beforeBundleFact: { ...supplied.beforeBundleFact },
      afterBundleFact: { ...supplied.afterBundleFact },
    };
    const next = fromExpense.reflectBundleItemMovement(mutable),
      record = next.bundleItemMovements[0];
    mutable.changedAt.setTime(0);
    Reflect.set(mutable.beforeBundleFact, 'receiptVersion', 99);
    Reflect.set(mutable.afterBundleFact, 'adjustedAmount', 0);
    expect(record).toMatchObject({
      actorSubject: 'uploader',
      at: '2026-10-03T00:00:00.000Z',
      previousVersion: 1,
      version: 2,
      beforeBundleFact: { receiptVersion: 5 },
      afterBundleFact: { receiptVersion: 6, adjustedAmount: 100 },
    });
    expect(record.before).toBe(fromExpense.snapshot());
    expect(record.after).toBe(next.snapshot());
    for (const value of [
      after,
      confirmed(after),
      confirmed(after).bundles,
      ...confirmed(after).bundles,
      ...confirmed(after).bundles.map((b) => b.itemIds),
      after.changes,
      change,
      next,
      next.bundleItemMovements,
      record,
      record.beforeBundleFact,
      record.afterBundleFact,
      record.after,
      record.after.total,
      record.after.allocations,
      ...record.after.allocations,
      ...record.after.allocations.map((a) => a.burden),
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(record.afterBundleFact, 'bundleId', 'other')).toBe(
      false,
    );
    expect(Reflect.set(confirmed(after).bundles[0].itemIds, '0', 'x')).toBe(
      false,
    );
    expect(confirmed(receipt).bundles[0].itemIds).toEqual(['a', 'b']);
  });
  it('orders transferred Items by Receipt order independently of command array order', () => {
    const { receipt } = fixture(false, false, true);
    const after = receipt.moveBundleItems(
      move(receipt, { itemIds: ['e', 'b'] }),
    );
    const reversed = receipt.moveBundleItems(
      move(receipt, { itemIds: ['b', 'e'] }),
    );
    expect(after.snapshot()).toEqual(reversed.snapshot());
    expect(after.changes).toEqual(reversed.changes);
    expect(confirmed(after).bundles[1].itemIds).toEqual(['b', 'c', 'e']);
  });
  it('keeps the safe JPY upper boundary exact while transferring one yen', () => {
    const amount = Number.MAX_SAFE_INTEGER;
    const items = [
      { id: 'a', name: 'Boundary', amount: amount - 1, categoryId: 'food' },
      { id: 'b', name: 'One', amount: 1, categoryId: 'food' },
      { id: 'c', name: 'Zero', amount: 0, categoryId: 'food' },
    ];
    const draft = Receipt.createDraft({
      id: 'receipt',
      uploaderSubject: 'uploader',
      occurredOn: '2026-10-01',
      declaredTotal: amount,
      items,
      adjustments: [],
    });
    const expense = (id: string, total: number) =>
      GroupExpense.register({
        id,
        groupId,
        sourceOwnerSubject: 'uploader',
        occurredOn: '2026-10-01',
        amount: total,
        payerParticipantId: 'a',
        participants: [
          { participantId: 'a', joinOrder: 1, percentage: 50 },
          { participantId: 'b', joinOrder: 2, percentage: 50 },
        ],
      });
    const from = expense('expense-from', amount),
      to = expense('expense-to', 0);
    const receipt = draft
      .confirm({
        expectedVersion: 1,
        actorSubject: 'uploader',
        confirmedAt: at(),
        occurredOn: '2026-10-01',
        declaredTotal: amount,
        items,
        adjustments: [],
      })
      .registerBundle({
        expectedVersion: 2,
        actorSubject: 'uploader',
        registeredAt: at(),
        bundleId: 'from',
        itemIds: ['a', 'b'],
        expense: from,
      })
      .registerBundle({
        expectedVersion: 3,
        actorSubject: 'uploader',
        registeredAt: at(),
        bundleId: 'to',
        itemIds: ['c'],
        expense: to,
      });
    const after = receipt.moveBundleItems(move(receipt));
    const nextFrom = from.reflectBundleItemMovement(
        reflection(receipt, after, 'from', from),
      ),
      nextTo = to.reflectBundleItemMovement(
        reflection(receipt, after, 'to', to),
      );
    expect(
      BigInt(nextFrom.snapshot().total.amount) +
        BigInt(nextTo.snapshot().total.amount),
    ).toBe(BigInt(amount));
    expect(
      nextFrom
        .snapshot()
        .allocations.reduce((sum, a) => sum + BigInt(a.burden.amount), 0n),
    ).toBe(BigInt(amount - 1));
    expect(amounts(nextTo)).toEqual([1, 0]);
  });
});

describe('BM-P1/F1: Receipt movement rejects invalid or permanently locked requests', () => {
  it.each(['from', 'to'])(
    'rejects a first-selected %s side forever',
    (bundleId) => {
      const { receipt } = fixture();
      const locked = selection(receipt, bundleId);
      refused(
        () => locked.moveBundleItems(move(locked)),
        ReceiptInvariantViolation,
        'BUNDLE_EDITING_LOCKED',
      );
    },
  );
  it.each(['owner', 'other', 'a'])(
    'rejects non-Uploader %s',
    (actorSubject) => {
      const { receipt } = fixture();
      refused(
        () => receipt.moveBundleItems(move(receipt, { actorSubject })),
        ReceiptInvariantViolation,
        'ACTOR_NOT_UPLOADER',
      );
    },
  );
  it.each([4, 6, NaN, 5.5, Infinity])(
    'rejects Receipt version %s',
    (expectedVersion) => {
      const { receipt } = fixture();
      refused(
        () => receipt.moveBundleItems(move(receipt, { expectedVersion })),
        ReceiptInvariantViolation,
        'VERSION_CONFLICT',
      );
    },
  );
  it.each(
    [[], ['a', 'a'], ['unknown'], ['d'], ['c'], [' ']].map((itemIds) => ({
      itemIds,
    })),
  )('rejects invalid Item selection %j', ({ itemIds }) => {
    const { receipt } = fixture();
    const before = receipt.snapshot();
    refused(
      () => receipt.moveBundleItems(move(receipt, { itemIds })),
      ReceiptInvariantViolation,
      'BUNDLE_ITEMS_INVALID',
    );
    expect(receipt.snapshot()).toBe(before);
  });
  it('rejects Draft, same or unknown Bundle, final Item, bad time and blank actor', () => {
    const { receipt, draft } = fixture();
    refused(
      () => draft.moveBundleItems(move(draft)),
      ReceiptInvariantViolation,
      'RECEIPT_NOT_CONFIRMED',
    );
    refused(
      () => receipt.moveBundleItems(move(receipt, { toBundleId: 'from' })),
      ReceiptInvariantViolation,
      'BUNDLE_MOVE_TARGET_INVALID',
    );
    refused(
      () => receipt.moveBundleItems(move(receipt, { toBundleId: 'missing' })),
      ReceiptInvariantViolation,
      'BUNDLE_NOT_FOUND',
    );
    refused(
      () => receipt.moveBundleItems(move(receipt, { itemIds: ['a', 'b'] })),
      ReceiptInvariantViolation,
      'BUNDLE_WOULD_BE_EMPTY',
    );
    refused(
      () => receipt.moveBundleItems(move(receipt, { movedAt: new Date(NaN) })),
      ReceiptInvariantViolation,
      'UTC_INSTANT_INVALID',
    );
    refused(
      () => receipt.moveBundleItems(move(receipt, { actorSubject: ' ' })),
      ReceiptInvariantViolation,
      'ACTOR_REFERENCE_INVALID',
    );
  });
  it('rejects stale replay and overflow rather than adding another movement', () => {
    const { receipt } = fixture();
    const after = receipt.moveBundleItems(move(receipt));
    refused(
      () => after.moveBundleItems(move(receipt)),
      ReceiptInvariantViolation,
      'VERSION_CONFLICT',
    );
    const last = Reflect.construct(Receipt, [
      receipt.snapshot(),
      Number.MAX_SAFE_INTEGER,
      receipt.changes,
    ]) as Receipt;
    refused(
      () => last.moveBundleItems(move(last)),
      ReceiptInvariantViolation,
      'VERSION_OVERFLOW',
    );
  });
});

describe('BM-P2/F2: Expense reflection validates before and after facts without selecting a storage winner', () => {
  it.each([
    'expenseId',
    'groupId',
    'uploaderSubject',
    'occurredOn',
    'adjustedAmount',
  ] as const)('rejects mismatched before fact %s', (key) => {
    const { receipt, fromExpense } = fixture();
    const after = receipt.moveBundleItems(move(receipt)),
      i = reflection(receipt, after, 'from', fromExpense);
    const beforeBundleFact = {
      ...i.beforeBundleFact,
      [key]: key === 'adjustedAmount' ? 150 : 'other',
    };
    refused(
      () => fromExpense.reflectBundleItemMovement({ ...i, beforeBundleFact }),
      ExpenseInvariantViolation,
      'BUNDLE_FACT_MISMATCH',
    );
  });
  it.each([
    'receiptId',
    'bundleId',
    'expenseId',
    'groupId',
    'uploaderSubject',
    'occurredOn',
  ] as const)('rejects inconsistent after pair reference %s', (key) => {
    const { receipt, fromExpense } = fixture();
    const after = receipt.moveBundleItems(move(receipt)),
      i = reflection(receipt, after, 'from', fromExpense);
    refused(
      () =>
        fromExpense.reflectBundleItemMovement({
          ...i,
          afterBundleFact: { ...i.afterBundleFact, [key]: 'other' },
        }),
      ExpenseInvariantViolation,
      'BUNDLE_FACT_MISMATCH',
    );
  });
  it.each([0, 5, 7, NaN, Infinity])(
    'rejects invalid after Receipt version %s',
    (receiptVersion) => {
      const { receipt, fromExpense } = fixture();
      const after = receipt.moveBundleItems(move(receipt)),
        i = reflection(receipt, after, 'from', fromExpense);
      refused(
        () =>
          fromExpense.reflectBundleItemMovement({
            ...i,
            afterBundleFact: { ...i.afterBundleFact, receiptVersion },
          }),
        ExpenseInvariantViolation,
        'RECEIPT_VERSION_CONFLICT',
      );
    },
  );
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid after amount %s',
    (adjustedAmount) => {
      const { receipt, fromExpense } = fixture();
      const after = receipt.moveBundleItems(move(receipt)),
        i = reflection(receipt, after, 'from', fromExpense);
      refused(
        () =>
          fromExpense.reflectBundleItemMovement({
            ...i,
            afterBundleFact: { ...i.afterBundleFact, adjustedAmount },
          }),
        ExpenseInvariantViolation,
        'BUNDLE_FACT_INVALID',
      );
    },
  );
  it('rejects actor, time, stale Expense / Receipt versions, incomplete facts and overflow', () => {
    const { receipt, fromExpense } = fixture();
    const after = receipt.moveBundleItems(move(receipt)),
      i = reflection(receipt, after, 'from', fromExpense);
    refused(
      () =>
        fromExpense.reflectBundleItemMovement({ ...i, actorSubject: 'owner' }),
      ExpenseInvariantViolation,
      'ACTOR_NOT_UPLOADER',
    );
    refused(
      () =>
        fromExpense.reflectBundleItemMovement({
          ...i,
          changedAt: new Date(NaN),
        }),
      ExpenseInvariantViolation,
      'UTC_INSTANT_INVALID',
    );
    refused(
      () =>
        fromExpense.reflectBundleItemMovement({
          ...i,
          expectedExpenseVersion: 2,
        }),
      ExpenseInvariantViolation,
      'EXPENSE_VERSION_CONFLICT',
    );
    refused(
      () =>
        fromExpense.reflectBundleItemMovement({
          ...i,
          expectedReceiptVersion: 4,
        }),
      ExpenseInvariantViolation,
      'RECEIPT_VERSION_CONFLICT',
    );
    refused(
      () =>
        fromExpense.reflectBundleItemMovement({
          ...i,
          afterBundleFact: { ...i.afterBundleFact, bundleId: ' ' },
        }),
      ExpenseInvariantViolation,
      'BUNDLE_FACT_INVALID',
    );
    const next = fromExpense.reflectBundleItemMovement(i);
    refused(
      () => next.reflectBundleItemMovement(i),
      ExpenseInvariantViolation,
      'EXPENSE_VERSION_CONFLICT',
    );
    const last = Reflect.construct(GroupExpense, [
      fromExpense.snapshot(),
      fromExpense.initialSnapshot,
      Number.MAX_SAFE_INTEGER,
    ]) as GroupExpense;
    refused(
      () =>
        last.reflectBundleItemMovement({
          ...i,
          expectedExpenseVersion: Number.MAX_SAFE_INTEGER,
        }),
      ExpenseInvariantViolation,
      'VERSION_OVERFLOW',
    );
  });
  it('leaves all old Roots unchanged when one candidate reflection fails; Caller discards candidates before atomic commit', () => {
    const { receipt, fromExpense, toExpense } = fixture();
    const originals = [
      receipt.snapshot(),
      fromExpense.snapshot(),
      toExpense.snapshot(),
    ];
    const after = receipt.moveBundleItems(move(receipt));
    fromExpense.reflectBundleItemMovement(
      reflection(receipt, after, 'from', fromExpense),
    );
    refused(
      () =>
        toExpense.reflectBundleItemMovement(
          reflection(receipt, after, 'to', toExpense, {
            expectedExpenseVersion: 2,
          }),
        ),
      ExpenseInvariantViolation,
      'EXPENSE_VERSION_CONFLICT',
    );
    expect([
      receipt.snapshot(),
      fromExpense.snapshot(),
      toExpense.snapshot(),
    ]).toEqual(originals);
    expect([receipt.version, fromExpense.version, toExpense.version]).toEqual([
      5, 1, 1,
    ]);
  });
});
