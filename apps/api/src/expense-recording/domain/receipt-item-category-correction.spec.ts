import { describe, expect, it } from 'vitest';
import { Receipt } from './receipt.js';
import type {
  CorrectReceiptItemCategory,
  ReceiptItemCategoryCaseFact,
} from './receipt-item-category-correction.js';
import { ReceiptInvariantViolation } from './receipt-invariant-violation.js';
import { GroupExpense } from './group-expense.js';
import { SettlementCase } from '../../settlement/domain/settlement-case.js';
import { SettlementSnapshotContent } from '../../settlement/domain/value-objects/settlement-snapshot-content.js';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const groupId = uuid(1);
const at = () => new Date('2026-10-05T00:00:00Z');
const confirmed = (r: Receipt) => {
  const s = r.snapshot();
  if (s.status !== 'Confirmed') throw new Error('Expected Confirmed');
  return s;
};
const fixture = () => {
  const items = [
    { id: 'a', name: 'Tea', amount: 100, categoryId: 'food' },
    { id: 'b', name: 'Cup', amount: 200, categoryId: 'tools' },
    { id: 'c', name: 'Paper', amount: 300, categoryId: 'tools' },
    { id: 'd', name: 'Unassigned', amount: 400, categoryId: 'food' },
  ];
  const adjustments = [
    {
      kind: 'Discount' as const,
      amount: -10,
      target: { scope: 'Item' as const, itemId: 'a' },
    },
  ];
  const draft = Receipt.createDraft({
    id: 'receipt',
    uploaderSubject: 'uploader',
    occurredOn: '2026-10-01',
    declaredTotal: 990,
    items,
    adjustments,
  });
  const expense = (id: string, amount: number) =>
    GroupExpense.register({
      id,
      groupId,
      sourceOwnerSubject: 'uploader',
      occurredOn: '2026-10-01',
      amount,
      payerParticipantId: 'payer',
      participants: [
        { participantId: 'payer', joinOrder: 1, percentage: 50 },
        { participantId: 'other', joinOrder: 2, percentage: 50 },
      ],
    });
  const fromExpense = expense('expense-a', 290),
    otherExpense = expense('expense-b', 300);
  const unregistered = draft.confirm({
    expectedVersion: 1,
    actorSubject: 'uploader',
    confirmedAt: at(),
    occurredOn: '2026-10-01',
    declaredTotal: 990,
    items,
    adjustments,
  });
  const receipt = unregistered
    .registerBundle({
      expectedVersion: 2,
      actorSubject: 'uploader',
      registeredAt: at(),
      bundleId: 'bundle-a',
      itemIds: ['a', 'b'],
      expense: fromExpense,
    })
    .registerBundle({
      expectedVersion: 3,
      actorSubject: 'uploader',
      registeredAt: at(),
      bundleId: 'bundle-b',
      itemIds: ['c'],
      expense: otherExpense,
    });
  return { receipt, draft, unregistered, fromExpense, otherExpense };
};
const input = (
  r: Receipt,
  overrides: Partial<CorrectReceiptItemCategory> = {},
): CorrectReceiptItemCategory => ({
  expectedVersion: r.version,
  actorSubject: 'uploader',
  currentOwnerSubject: 'owner',
  groupId,
  correctedAt: at(),
  itemId: 'a',
  categoryId: 'tools',
  expectedCaseVersion: null,
  caseFact: null,
  ...overrides,
});
const initialCase = (e: GroupExpense, n: number) => {
  const s = e.snapshot();
  return SettlementCase.start({
    caseId: uuid(n),
    snapshotId: uuid(n + 1),
    applicant: { actorSubject: 'selector', participantId: 'payer' },
    submittedAt: at(),
    instructionIds: [uuid(n + 2)],
    content: SettlementSnapshotContent.from(groupId, [
      {
        expenseId: s.id.value,
        groupId,
        amount: BigInt(s.total.amount),
        payerParticipantId: s.payerParticipantId,
        allocations: s.allocations.map((a) => ({
          ...a,
          burden: BigInt(a.burden.amount),
        })),
      },
    ]),
  });
};
const inState = (
  r: SettlementCase,
  status: 'AwaitingApproval' | 'Rejected' | 'PaymentActive' | 'Archived',
): SettlementCase => {
  if (status === 'AwaitingApproval') return r;
  if (status === 'Rejected')
    return r.reject({
      expectedVersion: r.version,
      snapshotId: r.snapshot.snapshotId,
      participantId: 'other',
      reason: 'review',
      decidedAt: at(),
    });
  let active = r.approve({
    expectedVersion: r.version,
    snapshotId: r.snapshot.snapshotId,
    participantId: 'other',
    decidedAt: at(),
  });
  if (status === 'PaymentActive') return active;
  for (const i of active.paymentInstructions) {
    active = active.reportPayment({
      expectedVersion: active.version,
      snapshotId: active.snapshot.snapshotId,
      instructionId: i.instructionId,
      participantId: i.payerParticipantId,
      attemptId: uuid(500),
      amount: i.amount,
      reportedAt: at(),
    });
    active = active.confirmReceipt({
      expectedVersion: active.version,
      snapshotId: active.snapshot.snapshotId,
      instructionId: i.instructionId,
      participantId: i.payeeParticipantId,
      attemptId: uuid(500),
      decidedAt: at(),
    });
  }
  return active;
};
const select = (r: Receipt, bundleId: string, c: SettlementCase) =>
  r.recordBundleSnapshotSelection({
    expectedVersion: r.version,
    selection: {
      bundleId,
      expenseId: c.snapshot.content.expenses[0].expenseId,
      groupId,
      caseId: c.snapshot.caseId,
      snapshotId: c.snapshot.snapshotId,
      actorSubject: c.snapshot.applicant.actorSubject,
      selectedAt: new Date(c.snapshot.submittedAt),
    },
  });
const fact = (c: SettlementCase): ReceiptItemCategoryCaseFact => ({
  caseId: c.snapshot.caseId,
  groupId: c.snapshot.content.groupId,
  expenseId: c.snapshot.content.expenses[0].expenseId,
  version: c.version,
  lifecycle: c.status,
});
const selectedFixture = () => {
  const f = fixture(),
    c = inState(initialCase(f.fromExpense, 10), 'Rejected');
  const receipt = select(f.receipt, 'bundle-a', c);
  return {
    ...f,
    receipt,
    c,
    command: input(receipt, {
      caseFact: fact(c),
      expectedCaseVersion: c.version,
    }),
  };
};
const refused = (operation: () => unknown, code: string) => {
  expect(operation).toThrow(ReceiptInvariantViolation);
  try {
    operation();
  } catch (e) {
    expect(e).toMatchObject({ code, message: 'Receipt invariant violated' });
  }
};

describe('IC-P1/O1/I1: registered Item Category correction preserves Receipt and financial facts', () => {
  it.each(['uploader', 'owner'])(
    'permits %s and changes only Category with immutable version history',
    (actorSubject) => {
      const { receipt, fromExpense } = fixture(),
        before = confirmed(receipt),
        expenseBefore = fromExpense.snapshot();
      const after = receipt.correctItemCategory(
        input(receipt, { actorSubject }),
      );
      const s = confirmed(after);
      expect(after.id).toBe(receipt.id);
      expect(after.version).toBe(receipt.version + 1);
      expect(s.items[0]).toEqual({
        ...before.items[0],
        categoryId: s.items[0].categoryId,
      });
      expect(s.items[0].categoryId.value).toBe('tools');
      expect(s.items.slice(1)).toEqual(before.items.slice(1));
      for (const k of [
        'bundles',
        'bundleSnapshotSelections',
        'adjustments',
        'allocations',
        'occurredOn',
        'declaredTotal',
        'uploaderSubject',
        'id',
      ] as const)
        expect(s[k]).toBe(before[k]);
      expect(after.hasCompleteBundleRegistration()).toBe(false);
      expect(after.changes.slice(0, -1)).toEqual(receipt.changes);
      expect(after.changes.at(-1)).toMatchObject({
        action: 'ItemCategoryCorrected',
        actorSubject,
        itemId: 'a',
        at: '2026-10-05T00:00:00.000Z',
        previousVersion: 4,
        version: 5,
        caseFact: null,
        before,
        after: s,
      });
      expect(confirmed(receipt).items[0].categoryId.value).toBe('food');
      expect(fromExpense.snapshot()).toBe(expenseBefore);
      expect(fromExpense.version).toBe(1);
    },
  );
  it('validates and returns the same Root for unchanged Category without history', () => {
    const { receipt } = fixture();
    expect(
      receipt.correctItemCategory(input(receipt, { categoryId: 'food' })),
    ).toBe(receipt);
    const f = selectedFixture();
    expect(
      f.receipt.correctItemCategory({ ...f.command, categoryId: 'food' }),
    ).toBe(f.receipt);
  });
  it('copies caller Case facts and UTC, freezes the whole correction, and retains old Revision', () => {
    const { receipt, c, command } = selectedFixture(),
      oldRevision = c.snapshot;
    const mutable = { ...command, caseFact: { ...fact(c) } };
    const after = receipt.correctItemCategory(mutable),
      change = after.changes.at(-1);
    if (change?.action !== 'ItemCategoryCorrected')
      throw new Error('Expected correction');
    mutable.correctedAt.setTime(0);
    mutable.caseFact.lifecycle = 'Archived';
    mutable.caseFact.version = 999;
    expect(change.caseFact).toEqual(fact(c));
    expect(change.at).toBe('2026-10-05T00:00:00.000Z');
    expect(change.before).toBe(receipt.snapshot());
    expect(change.after).toBe(after.snapshot());
    expect(c.snapshot).toBe(oldRevision);
    expect(c.status).toBe('Rejected');
    for (const v of [
      after,
      after.changes,
      change,
      change.caseFact,
      change.before,
      change.after,
      confirmed(after).items,
      ...confirmed(after).items,
      ...confirmed(after).items.map((i) => i.categoryId),
    ])
      expect(Object.isFrozen(v)).toBe(true);
    expect(Reflect.set(change.caseFact!, 'lifecycle', 'Archived')).toBe(false);
    expect(Reflect.set(confirmed(after).items[0], 'categoryId', 'bad')).toBe(
      false,
    );
  });
  it('preserves prior correction and movement history through selection and Rejected correction without unlocking', () => {
    const { receipt, otherExpense } = fixture();
    const first = receipt.correctItemCategory(input(receipt));
    const moved = first.moveBundleItems({
      expectedVersion: first.version,
      actorSubject: 'uploader',
      movedAt: at(),
      fromBundleId: 'bundle-a',
      toBundleId: 'bundle-b',
      itemIds: ['a'],
    });
    const e = otherExpense.reflectBundleItemMovement({
      expectedExpenseVersion: 1,
      expectedReceiptVersion: first.version,
      actorSubject: 'uploader',
      changedAt: at(),
      beforeBundleFact: first.bundleEditingFacts({
        expectedVersion: first.version,
        actorSubject: 'uploader',
        bundleId: 'bundle-b',
      }),
      afterBundleFact: moved.bundleEditingFacts({
        expectedVersion: moved.version,
        actorSubject: 'uploader',
        bundleId: 'bundle-b',
      }),
    });
    const c = inState(initialCase(e, 40), 'Rejected'),
      locked = select(moved, 'bundle-b', c);
    const after = locked.correctItemCategory(
      input(locked, {
        categoryId: 'food',
        actorSubject: 'owner',
        expectedCaseVersion: c.version,
        caseFact: fact(c),
      }),
    );
    expect(after.changes.slice(0, -1)).toEqual(locked.changes);
    expect(after.changes.map((change) => change.action)).toEqual([
      'Confirmed',
      'BundleRegistered',
      'BundleRegistered',
      'ItemCategoryCorrected',
      'BundleItemsMoved',
      'BundleSnapshotSelected',
      'ItemCategoryCorrected',
    ]);
    expect(confirmed(after).bundles).toBe(confirmed(locked).bundles);
    expect(confirmed(after).bundleSnapshotSelections).toBe(
      confirmed(locked).bundleSnapshotSelections,
    );
    refused(
      () =>
        after.bundleEditingFacts({
          expectedVersion: after.version,
          actorSubject: 'uploader',
          bundleId: 'bundle-b',
        }),
      'BUNDLE_EDITING_LOCKED',
    );
    refused(
      () =>
        after.moveBundleItems({
          expectedVersion: after.version,
          actorSubject: 'uploader',
          movedAt: at(),
          fromBundleId: 'bundle-b',
          toBundleId: 'bundle-a',
          itemIds: ['a'],
        }),
      'BUNDLE_EDITING_LOCKED',
    );
    expect(e.snapshot().total.amount).toBe(390);
    expect(e.version).toBe(2);
  });
});

describe('IC-P2: multi-Bundle partial selection uses only the target Expense', () => {
  it.each(['AwaitingApproval', 'PaymentActive', 'Archived'] as const)(
    'allows an unselected target while another Bundle is %s',
    (status) => {
      const f = fixture(),
        other = inState(initialCase(f.otherExpense, 20), status),
        r = select(f.receipt, 'bundle-b', other);
      expect(other.status).toBe(status);
      const after = r.correctItemCategory(input(r));
      expect(confirmed(after).items[0].categoryId.value).toBe('tools');
      expect(confirmed(after).items[2]).toBe(confirmed(r).items[2]);
      expect(confirmed(after).bundleSnapshotSelections).toBe(
        confirmed(r).bundleSnapshotSelections,
      );
      expect(other.snapshot.content.expenses[0].expenseId).toBe('expense-b');
    },
  );
  it.each(['Unselected', 'AwaitingApproval', 'PaymentActive'] as const)(
    'allows a Rejected target while another Bundle is %s',
    (status) => {
      const f = selectedFixture();
      const r =
        status === 'Unselected'
          ? f.receipt
          : select(
              f.receipt,
              'bundle-b',
              inState(initialCase(f.otherExpense, 20), status),
            );
      const after = r.correctItemCategory(
        input(r, { expectedCaseVersion: f.c.version, caseFact: fact(f.c) }),
      );
      expect(confirmed(after).items[0].categoryId.value).toBe('tools');
      expect(confirmed(after).items[2]).toBe(confirmed(r).items[2]);
      expect(confirmed(after).bundleSnapshotSelections).toBe(
        confirmed(r).bundleSnapshotSelections,
      );
    },
  );
  it.each(['AwaitingApproval', 'PaymentActive', 'Archived'] as const)(
    'rejects a %s target even when another Bundle is Rejected',
    (status) => {
      const f = fixture(),
        target = inState(initialCase(f.fromExpense, 10), status),
        other = inState(initialCase(f.otherExpense, 20), 'Rejected');
      const r = select(
        select(f.receipt, 'bundle-a', target),
        'bundle-b',
        other,
      );
      refused(
        () =>
          r.correctItemCategory(
            input(r, {
              expectedCaseVersion: target.version,
              caseFact: fact(target),
            }),
          ),
        'ITEM_CATEGORY_NOT_CORRECTABLE',
      );
      refused(
        () =>
          r.correctItemCategory(
            input(r, {
              expectedCaseVersion: other.version,
              caseFact: fact(other),
            }),
          ),
        'CASE_FACT_MISMATCH',
      );
      expect(confirmed(r).items[0].categoryId.value).toBe('food');
      expect(target.status).toBe(status);
    },
  );
});

describe('IC-F1: correction rejects invalid facts without changing existing Roots', () => {
  it.each(['outsider', 'old-owner', 'payer'])(
    'rejects non-Uploader/non-currentOwner %s even for a same Category',
    (actorSubject) => {
      const { receipt } = fixture();
      refused(
        () =>
          receipt.correctItemCategory(
            input(receipt, { actorSubject, categoryId: 'food' }),
          ),
        'ACTOR_NOT_UPLOADER_OR_OWNER',
      );
    },
  );
  it.each(['actorSubject', 'currentOwnerSubject'] as const)(
    'rejects blank %s',
    (field) => {
      const { receipt } = fixture();
      refused(
        () => receipt.correctItemCategory(input(receipt, { [field]: ' ' })),
        'ACTOR_REFERENCE_INVALID',
      );
    },
  );
  it.each([0, 3, 5, 4.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects Receipt expectedVersion %s',
    (expectedVersion) => {
      const { receipt } = fixture();
      refused(
        () =>
          receipt.correctItemCategory(
            input(receipt, { expectedVersion, categoryId: 'food' }),
          ),
        'VERSION_CONFLICT',
      );
    },
  );
  it.each(['', ' '])('rejects Category reference %j', (categoryId) => {
    const { receipt } = fixture();
    refused(
      () => receipt.correctItemCategory(input(receipt, { categoryId })),
      'CATEGORY_REFERENCE_INVALID',
    );
  });
  it('rejects Draft, unregistered/unassigned/unknown Item, group and date; old values stay unchanged', () => {
    const { draft, unregistered, receipt } = fixture(),
      before = receipt.snapshot();
    refused(
      () => draft.correctItemCategory(input(draft)),
      'RECEIPT_NOT_CONFIRMED',
    );
    for (const r of [unregistered, receipt])
      refused(
        () => r.correctItemCategory(input(r, { itemId: 'd' })),
        'ITEM_NOT_BUNDLED',
      );
    refused(
      () => receipt.correctItemCategory(input(receipt, { itemId: 'missing' })),
      'ITEM_NOT_FOUND',
    );
    refused(
      () => receipt.correctItemCategory(input(receipt, { itemId: ' ' })),
      'ITEM_FACT_INVALID',
    );
    refused(
      () => receipt.correctItemCategory(input(receipt, { groupId: ' ' })),
      'GROUP_REFERENCE_INVALID',
    );
    refused(
      () => receipt.correctItemCategory(input(receipt, { groupId: uuid(2) })),
      'BUNDLE_GROUP_MISMATCH',
    );
    refused(
      () =>
        receipt.correctItemCategory(
          input(receipt, { correctedAt: new Date(NaN), categoryId: 'food' }),
        ),
      'UTC_INSTANT_INVALID',
    );
    expect(receipt.snapshot()).toBe(before);
    expect(receipt.version).toBe(4);
  });
  it('requires explicit null Case facts for unselected targets and facts for selected targets, including no-op', () => {
    const f = selectedFixture(),
      free = fixture().receipt;
    for (const overrides of [
      { caseFact: fact(f.c) },
      { expectedCaseVersion: 1 },
    ])
      refused(
        () => free.correctItemCategory(input(free, overrides)),
        'CASE_FACT_UNEXPECTED',
      );
    refused(
      () =>
        f.receipt.correctItemCategory(input(f.receipt, { categoryId: 'food' })),
      'CASE_FACT_REQUIRED',
    );
    const noFact = input(free);
    Reflect.deleteProperty(noFact, 'caseFact');
    refused(() => free.correctItemCategory(noFact), 'CASE_FACT_UNEXPECTED');
  });
  it.each([
    'AwaitingApproval',
    'Approved',
    'PaymentActive',
    'CancellationPending',
    'Archived',
    'Withdrawn',
    'Cancelled',
    'Unknown',
  ])('rejects selected target lifecycle %s even for no-op', (lifecycle) => {
    const f = selectedFixture();
    refused(
      () =>
        f.receipt.correctItemCategory({
          ...f.command,
          categoryId: 'food',
          caseFact: { ...fact(f.c), lifecycle },
        }),
      'ITEM_CATEGORY_NOT_CORRECTABLE',
    );
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects Case source version %s',
    (version) => {
      const f = selectedFixture();
      refused(
        () =>
          f.receipt.correctItemCategory({
            ...f.command,
            expectedCaseVersion: version,
            caseFact: { ...fact(f.c), version },
          }),
        'CASE_VERSION_CONFLICT',
      );
    },
  );
  it.each([null, 1, 3, 2.5, NaN, Infinity])(
    'rejects stale/missing Case expectedVersion %s',
    (expectedCaseVersion) => {
      const f = selectedFixture();
      refused(
        () =>
          f.receipt.correctItemCategory({ ...f.command, expectedCaseVersion }),
        'CASE_VERSION_CONFLICT',
      );
    },
  );
  it.each(['case', '', '00000000-0000-4000-8000-00000000000A'])(
    'rejects noncanonical Case ID %j',
    (caseId) => {
      const f = selectedFixture();
      refused(
        () =>
          f.receipt.correctItemCategory({
            ...f.command,
            caseFact: { ...fact(f.c), caseId },
          }),
        'CASE_REFERENCE_INVALID',
      );
    },
  );
  it.each(['groupId', 'expenseId'] as const)(
    'rejects different target %s',
    (key) => {
      const f = selectedFixture();
      refused(
        () =>
          f.receipt.correctItemCategory({
            ...f.command,
            caseFact: {
              ...fact(f.c),
              [key]: key === 'groupId' ? uuid(2) : 'expense-b',
            },
          }),
        'CASE_FACT_MISMATCH',
      );
    },
  );
  it('uses caller-bound current related Case facts, keeping first selection unchanged when Case identity differs', () => {
    const f = selectedFixture(),
      nextCase = inState(initialCase(f.fromExpense, 70), 'Rejected');
    const after = f.receipt.correctItemCategory({
      ...f.command,
      expectedCaseVersion: nextCase.version,
      caseFact: fact(nextCase),
    });
    expect(confirmed(after).bundleSnapshotSelections).toBe(
      confirmed(f.receipt).bundleSnapshotSelections,
    );
    expect(after.changes.at(-1)).toMatchObject({
      caseFact: { caseId: nextCase.snapshot.caseId },
    });
  });
  it('rejects stale replay and changed-value overflow; unchanged value still validates at the safe upper version', () => {
    const { receipt } = fixture(),
      next = receipt.correctItemCategory(input(receipt));
    refused(() => next.correctItemCategory(input(receipt)), 'VERSION_CONFLICT');
    const last = Reflect.construct(Receipt, [
      receipt.snapshot(),
      Number.MAX_SAFE_INTEGER,
      receipt.changes,
    ]) as Receipt;
    refused(() => last.correctItemCategory(input(last)), 'VERSION_OVERFLOW');
    expect(last.correctItemCategory(input(last, { categoryId: 'food' }))).toBe(
      last,
    );
  });
});
