import { describe, expect, it } from 'vitest';

import {
  GroupExpense,
  type RegisterGroupExpenseInput,
} from './group-expense.js';
import { Receipt, type RegisterReceiptBundle } from './receipt.js';
import { ReceiptInvariantViolation } from './receipt-invariant-violation.js';
import { ReceiptBundleId } from './value-objects/receipt-bundle-id.js';

const groupId = '11111111-1111-4111-8111-111111111111';
const items = [
  { id: 'a', name: 'Tea', amount: 110, categoryId: 'food' },
  { id: 'b', name: 'Cup', amount: 240, categoryId: 'tools' },
  { id: 'c', name: 'Bread', amount: 200, categoryId: 'food' },
];
const draft = (): Receipt =>
  Receipt.createDraft({
    id: 'receipt-1',
    uploaderSubject: 'uploader',
    occurredOn: '2026-10-01',
    declaredTotal: 500,
    items,
    adjustments: [],
  });
const confirmed = (): Receipt =>
  draft().confirm({
    expectedVersion: 1,
    actorSubject: 'uploader',
    confirmedAt: new Date('2026-10-02T00:00:00Z'),
    occurredOn: '2026-10-01',
    declaredTotal: 500,
    items,
    adjustments: [
      { kind: 'Discount', amount: -50, target: { scope: 'Receipt' } },
    ],
  });
const expense = (
  overrides: Partial<RegisterGroupExpenseInput> = {},
): GroupExpense =>
  GroupExpense.register({
    id: 'expense-1',
    groupId,
    sourceOwnerSubject: 'uploader',
    occurredOn: '2026-10-01',
    amount: 318,
    payerParticipantId: 'payer',
    participants: [
      { participantId: 'payer', joinOrder: 1, percentage: 50 },
      { participantId: 'other', joinOrder: 2, percentage: 50 },
      { participantId: 'zero', joinOrder: 3, percentage: 0 },
    ],
    ...overrides,
  });
const registration = (
  overrides: Partial<RegisterReceiptBundle> = {},
): RegisterReceiptBundle => ({
  expectedVersion: 2,
  actorSubject: 'uploader',
  registeredAt: new Date('2026-10-02T09:00:00+09:00'),
  bundleId: 'bundle-1',
  itemIds: ['a', 'b'],
  expense: expense(),
  ...overrides,
});
const snapshot = (receipt: Receipt) => {
  const result = receipt.snapshot();
  if (result.status !== 'Confirmed') throw new Error('Expected Confirmed');
  return result;
};
const failure = (action: () => unknown, code: string): void => {
  try {
    action();
    throw new Error('Expected ReceiptInvariantViolation');
  } catch (error) {
    expect(error).toBeInstanceOf(ReceiptInvariantViolation);
    expect((error as ReceiptInvariantViolation).code).toBe(code);
    expect((error as Error).message).toBe('Receipt invariant violated');
  }
};

describe('Receipt initial Bundle registration', () => {
  it('records adjusted Item/Expense pairs in stages and reports completion only after every Item is assigned', () => {
    const before = confirmed();
    const supplied = expense();
    const first = before.registerBundle(registration({ expense: supplied }));
    const complete = first.registerBundle(
      registration({
        expectedVersion: 3,
        bundleId: 'bundle-2',
        itemIds: ['c'],
        expense: expense({ id: 'expense-2', amount: 182 }),
      }),
    );
    expect(draft().hasCompleteBundleRegistration()).toBe(false);
    expect(before.hasCompleteBundleRegistration()).toBe(false);
    expect(first.hasCompleteBundleRegistration()).toBe(false);
    expect(complete.hasCompleteBundleRegistration()).toBe(true);
    expect(snapshot(before).items.map((i) => i.adjustedAmount)).toEqual([
      100, 218, 182,
    ]);
    expect(
      snapshot(complete).bundles.map((b) => ({
        id: b.id.value,
        itemIds: b.itemIds,
        expenseId: b.expenseId.value,
        groupId: b.groupId,
      })),
    ).toEqual([
      { id: 'bundle-1', itemIds: ['a', 'b'], expenseId: 'expense-1', groupId },
      { id: 'bundle-2', itemIds: ['c'], expenseId: 'expense-2', groupId },
    ]);
    expect(complete.id).toBe(before.id);
    expect(snapshot(complete).items).toBe(snapshot(before).items);
    expect(snapshot(complete).adjustments).toBe(snapshot(before).adjustments);
    expect(snapshot(complete).allocations).toBe(snapshot(before).allocations);
    expect(complete.changes[0]).toBe(before.changes[0]);
    expect(complete.version).toBe(4);
    expect(complete.changes[2]).toMatchObject({
      action: 'BundleRegistered',
      actorSubject: 'uploader',
      at: '2026-10-02T00:00:00.000Z',
      previousVersion: 3,
      version: 4,
      before: first.snapshot(),
      after: complete.snapshot(),
    });
    expect(supplied.version).toBe(1);
    expect(supplied.snapshot().allocations.map((a) => a.burden.amount)).toEqual(
      [159, 159, 0],
    );
  });

  it('does not treat an empty Confirmed Receipt as a completed pair registration', () => {
    const root = draft().confirm({
      expectedVersion: 1,
      actorSubject: 'uploader',
      confirmedAt: new Date('2026-10-02T00:00:00Z'),
      occurredOn: '2026-10-01',
      declaredTotal: 0,
      items: [],
      adjustments: [],
    });
    expect(root.hasCompleteBundleRegistration()).toBe(false);
  });

  it('accepts a single Bundle covering every Item', () => {
    const root = confirmed().registerBundle(
      registration({
        itemIds: ['a', 'b', 'c'],
        expense: expense({ amount: 500 }),
      }),
    );
    expect(root.hasCompleteBundleRegistration()).toBe(true);
  });

  it('preserves successful pairs after failure and allows a corrected later registration', () => {
    const first = confirmed().registerBundle(registration());
    const before = first.snapshot();
    failure(
      () =>
        first.registerBundle(
          registration({
            expectedVersion: 3,
            bundleId: 'bundle-2',
            itemIds: ['c'],
            expense: expense({ id: 'expense-2', amount: 200 }),
          }),
        ),
      'BUNDLE_EXPENSE_MISMATCH',
    );
    expect(first.snapshot()).toBe(before);
    expect(first.version).toBe(3);
    expect(first.changes).toHaveLength(2);
    const retry = first.registerBundle(
      registration({
        expectedVersion: 3,
        bundleId: 'bundle-2',
        itemIds: ['c'],
        expense: expense({ id: 'expense-2', amount: 182 }),
      }),
    );
    expect(snapshot(retry).bundles[0]).toBe(snapshot(first).bundles[0]);
    expect(retry.hasCompleteBundleRegistration()).toBe(true);
  });

  it.each(['owner', 'other'])(
    'rejects non-Uploader %s even when they are the Group Owner',
    (actorSubject) => {
      failure(
        () => confirmed().registerBundle(registration({ actorSubject })),
        'ACTOR_NOT_UPLOADER',
      );
    },
  );
  it.each(['', '   '])('rejects invalid Actor reference %s', (actorSubject) => {
    failure(
      () => confirmed().registerBundle(registration({ actorSubject })),
      'ACTOR_REFERENCE_INVALID',
    );
  });
  it.each([1, 3, NaN, 2.5])(
    'rejects invalid or stale version %s',
    (expectedVersion) => {
      failure(
        () => confirmed().registerBundle(registration({ expectedVersion })),
        'VERSION_CONFLICT',
      );
    },
  );
  it('rejects registration while Draft', () => {
    failure(
      () => draft().registerBundle(registration({ expectedVersion: 1 })),
      'RECEIPT_NOT_CONFIRMED',
    );
  });
  it.each(
    [[], ['a', 'a'], ['missing'], [''], ['   ']].map((itemIds) => ({
      itemIds,
    })),
  )(
    'rejects empty, duplicate, unknown or invalid Item selection %j',
    ({ itemIds }) => {
      failure(
        () => confirmed().registerBundle(registration({ itemIds })),
        'BUNDLE_ITEMS_INVALID',
      );
    },
  );
  it('rejects moving an already assigned Item through registration', () => {
    const first = confirmed().registerBundle(registration());
    failure(
      () =>
        first.registerBundle(
          registration({
            expectedVersion: 3,
            bundleId: 'bundle-2',
            itemIds: ['b', 'c'],
            expense: expense({ id: 'expense-2', amount: 400 }),
          }),
        ),
      'ITEM_ALREADY_ASSIGNED',
    );
  });
  it('rejects duplicate Bundle and Expense identities independently', () => {
    const first = confirmed().registerBundle(registration());
    const next = registration({
      expectedVersion: 3,
      itemIds: ['c'],
      expense: expense({ id: 'expense-2', amount: 182 }),
    });
    failure(() => first.registerBundle(next), 'BUNDLE_ALREADY_REGISTERED');
    failure(
      () =>
        first.registerBundle({
          ...next,
          bundleId: 'bundle-2',
          expense: expense({ amount: 182 }),
        }),
      'EXPENSE_ALREADY_PAIRED',
    );
  });
  it.each([
    { sourceOwnerSubject: 'other' },
    { occurredOn: '2026-10-02' },
    { amount: 350 },
  ])('rejects mismatched Expense facts %j', (overrides) => {
    failure(
      () =>
        confirmed().registerBundle(
          registration({ expense: expense(overrides) }),
        ),
      'BUNDLE_EXPENSE_MISMATCH',
    );
  });
  it('binds subsequent pairs to the first Expense Group without claiming real Receipt membership', () => {
    const first = confirmed().registerBundle(registration());
    failure(
      () =>
        first.registerBundle(
          registration({
            expectedVersion: 3,
            bundleId: 'bundle-2',
            itemIds: ['c'],
            expense: expense({
              id: 'expense-2',
              amount: 182,
              groupId: '22222222-2222-4222-8222-222222222222',
            }),
          }),
        ),
      'BUNDLE_GROUP_MISMATCH',
    );
  });
  it('rejects a runtime value that is not a GroupExpense Root', () => {
    failure(
      () =>
        confirmed().registerBundle(
          registration({ expense: {} as GroupExpense }),
        ),
      'BUNDLE_EXPENSE_NOT_INITIAL',
    );
  });

  it('rejects an Expense that has already been corrected', () => {
    const supplied = expense();
    const correctedExpense = supplied.correctAmount({
      expectedExpenseVersion: 1,
      expectedCaseVersion: 1,
      caseFact: {
        groupId,
        expenseId: 'expense-1',
        caseId: '33333333-3333-4333-8333-333333333333',
        version: 1,
        lifecycle: 'Rejected',
        allTargetsReleased: true,
      },
      actorSubject: 'uploader',
      currentOwnerSubject: 'owner',
      amount: 318,
      reason: 'review',
      correctedAt: new Date('2026-10-02T00:00:00Z'),
    });
    failure(
      () =>
        confirmed().registerBundle(registration({ expense: correctedExpense })),
      'BUNDLE_EXPENSE_NOT_INITIAL',
    );
  });
  it('copies caller Item selection and time, freezes history and leaves the supplied Expense untouched', () => {
    const input = registration();
    const suppliedSnapshot = input.expense.snapshot();
    const before = confirmed();
    const result = before.registerBundle(input);
    Reflect.set(input.itemIds, '0', 'c');
    input.registeredAt.setTime(0);
    const current = snapshot(result);
    expect(current.bundles[0].itemIds).toEqual(['a', 'b']);
    expect(result.changes[1].at).toBe('2026-10-02T00:00:00.000Z');
    for (const value of [
      result,
      current,
      current.bundles,
      current.bundles[0],
      current.bundles[0].id,
      current.bundles[0].itemIds,
      current.bundles[0].expenseId,
      result.changes,
      result.changes[1],
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(current.bundles[0].itemIds, '0', 'c')).toBe(false);
    expect(Reflect.set(current.bundles[0], 'groupId', 'other')).toBe(false);
    expect(snapshot(before).bundles).toEqual([]);
    expect(input.expense.snapshot()).toBe(suppliedSnapshot);
    expect(input.expense.corrections).toEqual([]);
  });
  it('rejects invalid time and Bundle ID without modifying the old Root', () => {
    const root = confirmed();
    failure(
      () => root.registerBundle(registration({ registeredAt: new Date(NaN) })),
      'UTC_INSTANT_INVALID',
    );
    failure(
      () => root.registerBundle(registration({ bundleId: ' ' })),
      'BUNDLE_ID_INVALID',
    );
    expect(root.version).toBe(2);
    expect(snapshot(root).bundles).toEqual([]);
  });
  it.each([0, Number.MAX_SAFE_INTEGER])(
    'handles JPY boundary %s without floating point summation',
    (amount) => {
      const sourceItems = [
        { id: 'only', name: 'Boundary', amount, categoryId: 'food' },
      ];
      const root = draft().confirm({
        expectedVersion: 1,
        actorSubject: 'uploader',
        confirmedAt: new Date('2026-10-02T00:00:00Z'),
        occurredOn: '2026-10-01',
        declaredTotal: amount,
        items: sourceItems,
        adjustments: [],
      });
      const supplied = expense({ amount });
      const result = root.registerBundle(
        registration({ itemIds: ['only'], expense: supplied }),
      );
      expect(result.hasCompleteBundleRegistration()).toBe(true);
      expect(
        supplied
          .snapshot()
          .allocations.reduce((sum, a) => sum + BigInt(a.burden.amount), 0n),
      ).toBe(BigInt(amount));
    },
  );
  it('rejects stale replay rather than adding another pair to the new Root', () => {
    const input = registration();
    const result = confirmed().registerBundle(input);
    failure(() => result.registerBundle(input), 'VERSION_CONFLICT');
    expect(snapshot(result).bundles).toHaveLength(1);
  });
});

describe('Receipt Bundle identity', () => {
  it('compares opaque identity values without imposing a public ID format', () => {
    expect(
      ReceiptBundleId.from('bundle-1').equals(ReceiptBundleId.from('bundle-1')),
    ).toBe(true);
    expect(
      ReceiptBundleId.from('bundle-1').equals(ReceiptBundleId.from('bundle-2')),
    ).toBe(false);
    expect(Object.isFrozen(ReceiptBundleId.from('bundle-1'))).toBe(true);
  });
  it.each(['', ' ', null, 1])('rejects invalid Bundle ID %s', (value) => {
    failure(() => ReceiptBundleId.from(value as string), 'BUNDLE_ID_INVALID');
  });
});
