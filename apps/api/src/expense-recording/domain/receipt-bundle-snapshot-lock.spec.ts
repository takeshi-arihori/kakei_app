import { describe, expect, it } from 'vitest';
import {
  Receipt,
  type CheckReceiptBundleEditing,
  type RecordReceiptBundleSnapshotSelection,
} from './receipt.js';
import { ReceiptInvariantViolation } from './receipt-invariant-violation.js';
import { GroupExpense } from './group-expense.js';
import {
  ReceiptBundleSnapshotSelection,
  type ReceiptBundleSnapshotSelectionInput,
} from './value-objects/receipt-bundle-snapshot-selection.js';
import { SettlementCase } from '../../settlement/domain/settlement-case.js';
import { SettlementSnapshotContent } from '../../settlement/domain/value-objects/settlement-snapshot-content.js';

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const groupId = uuid(1);
const time = (): Date => new Date('2026-10-03T01:00:00Z');
const items = [
  { id: 'a', name: 'Tea', amount: 100, categoryId: 'food' },
  { id: 'b', name: 'Cup', amount: 200, categoryId: 'tools' },
];
const draft = (): Receipt =>
  Receipt.createDraft({
    id: 'receipt-1',
    uploaderSubject: 'uploader',
    occurredOn: '2026-10-02',
    declaredTotal: 300,
    items,
    adjustments: [],
  });
const confirmed = (): Receipt =>
  draft().confirm({
    expectedVersion: 1,
    actorSubject: 'uploader',
    confirmedAt: time(),
    occurredOn: '2026-10-02',
    declaredTotal: 300,
    items,
    adjustments: [],
  });
const expense = (id = 'expense-1', amount = 100): GroupExpense =>
  GroupExpense.register({
    id,
    amount,
    groupId,
    sourceOwnerSubject: 'uploader',
    occurredOn: '2026-10-02',
    payerParticipantId: 'payer',
    participants: [
      { participantId: 'payer', joinOrder: 1, percentage: 50 },
      { participantId: 'other', joinOrder: 2, percentage: 50 },
    ],
  });
const registered = (supplied: GroupExpense = expense()): Receipt =>
  confirmed().registerBundle({
    expectedVersion: 2,
    actorSubject: 'uploader',
    registeredAt: time(),
    bundleId: 'bundle-1',
    itemIds: ['a'],
    expense: supplied,
  });
const selection = (
  overrides: Partial<ReceiptBundleSnapshotSelectionInput> = {},
): ReceiptBundleSnapshotSelectionInput => ({
  bundleId: 'bundle-1',
  expenseId: 'expense-1',
  groupId,
  caseId: uuid(2),
  snapshotId: uuid(3),
  actorSubject: 'selector',
  selectedAt: time(),
  ...overrides,
});
const record = (
  overrides: Partial<RecordReceiptBundleSnapshotSelection> = {},
): RecordReceiptBundleSnapshotSelection => ({
  expectedVersion: 3,
  selection: selection(),
  ...overrides,
});
const editCheck = (
  root: Receipt,
  overrides: Partial<CheckReceiptBundleEditing> = {},
): CheckReceiptBundleEditing => ({
  expectedVersion: root.version,
  bundleId: 'bundle-1',
  actorSubject: 'uploader',
  ...overrides,
});
const snapshot = (root: Receipt) => {
  const s = root.snapshot();
  if (s.status !== 'Confirmed') throw new Error('Expected Confirmed');
  return s;
};
const failure = (operation: () => unknown, code: string): void => {
  try {
    operation();
    throw new Error('Expected ReceiptInvariantViolation');
  } catch (error) {
    expect(error).toBeInstanceOf(ReceiptInvariantViolation);
    expect(error).toMatchObject({
      code,
      message: 'Receipt invariant violated',
    });
  }
};
const locked = (): Receipt =>
  registered().recordBundleSnapshotSelection(record());

const initialCase = (): SettlementCase => {
  const s = expense().snapshot();
  return SettlementCase.start({
    caseId: uuid(2),
    snapshotId: uuid(3),
    applicant: { actorSubject: 'selector', participantId: 'payer' },
    submittedAt: time(),
    instructionIds: [uuid(20)],
    content: SettlementSnapshotContent.from(groupId, [
      {
        expenseId: s.id.value,
        groupId: s.groupId,
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
const sourceSelection = (
  root: SettlementCase,
): ReceiptBundleSnapshotSelectionInput => ({
  bundleId: 'bundle-1',
  expenseId: root.snapshot.content.expenses[0].expenseId,
  groupId: root.snapshot.content.groupId,
  caseId: root.snapshot.caseId,
  snapshotId: root.snapshot.snapshotId,
  actorSubject: root.snapshot.applicant.actorSubject,
  selectedAt: new Date(root.snapshot.submittedAt),
});
const rejectedCase = (): SettlementCase => {
  const root = initialCase();
  return root.reject({
    expectedVersion: root.version,
    snapshotId: root.snapshot.snapshotId,
    participantId: 'other',
    decidedAt: time(),
    reason: 'review',
  });
};
const withdrawnCase = (): SettlementCase => {
  const root = rejectedCase();
  return root.withdraw({
    expectedVersion: root.version,
    snapshotId: root.snapshot.snapshotId,
    applicant: root.originalApplicant,
    currentOwnerSubject: 'owner',
    reason: 'withdraw',
    withdrawnAt: time(),
  });
};
const cancelledCase = (): SettlementCase => {
  const source = initialCase();
  const active = source.approve({
    expectedVersion: source.version,
    snapshotId: source.snapshot.snapshotId,
    participantId: 'other',
    decidedAt: time(),
  });
  let root = active.requestCancellation({
    expectedVersion: active.version,
    snapshotId: active.snapshot.snapshotId,
    cancellationId: uuid(30),
    applicant: active.originalApplicant,
    currentOwnerSubject: 'owner',
    reason: 'cancel',
    requestedAt: time(),
  });
  for (const participantId of ['payer', 'other'])
    root = root.agreeCancellation({
      expectedVersion: root.version,
      snapshotId: root.snapshot.snapshotId,
      cancellationId: uuid(30),
      participantId,
      decidedAt: time(),
    });
  return root;
};

describe('Receipt Bundle first Snapshot selection and permanent editing policy', () => {
  it('allows only the Uploader before selection without changing any Root facts', () => {
    const root = registered();
    const before = root.snapshot();
    expect(root.assertBundleEditingAllowed(editCheck(root))).toBeUndefined();
    expect(root.snapshot()).toBe(before);
    expect(root.version).toBe(3);
    expect(root.changes).toHaveLength(2);
  });
  it.each(['owner', 'other'])(
    'refuses editing actor %s before selection',
    (actorSubject) => {
      const root = registered();
      failure(
        () =>
          root.assertBundleEditingAllowed(editCheck(root, { actorSubject })),
        'ACTOR_NOT_UPLOADER',
      );
    },
  );
  it('records Source selection by a non-Uploader without granting them editing permission', () => {
    const before = registered();
    const root = before.recordBundleSnapshotSelection(record());
    const s = snapshot(root);
    expect(s.bundleSnapshotSelections).toHaveLength(1);
    expect(s.bundleSnapshotSelections[0]).toMatchObject({
      bundleId: { value: 'bundle-1' },
      expenseId: { value: 'expense-1' },
      groupId,
      caseId: uuid(2),
      snapshotId: uuid(3),
      actorSubject: 'selector',
      selectedAt: '2026-10-03T01:00:00.000Z',
    });
    expect(root.id).toBe(before.id);
    expect(s.bundles).toBe(snapshot(before).bundles);
    expect(s.items).toBe(snapshot(before).items);
    expect(s.adjustments).toBe(snapshot(before).adjustments);
    expect(s.allocations).toBe(snapshot(before).allocations);
    expect(root.version).toBe(4);
    expect(root.changes[2]).toMatchObject({
      action: 'BundleSnapshotSelected',
      actorSubject: 'selector',
      at: '2026-10-03T01:00:00.000Z',
      previousVersion: 3,
      version: 4,
      before: before.snapshot(),
      after: root.snapshot(),
    });
    expect(root.changes[0]).toBe(before.changes[0]);
    expect(snapshot(before).bundleSnapshotSelections).toEqual([]);
  });
  it('rejects the common Item membership, payer and percentage editing policy after selection', () => {
    const root = locked();
    failure(
      () => root.assertBundleEditingAllowed(editCheck(root)),
      'BUNDLE_EDITING_LOCKED',
    );
  });
  it.each([
    { state: 'Rejected', create: rejectedCase },
    { state: 'Withdrawn', create: withdrawnCase },
    { state: 'Cancelled', create: cancelledCase },
  ])(
    'does not unlock after the actual Case becomes $state',
    ({ state, create }) => {
      const source = initialCase();
      const before = registered();
      const root = before.recordBundleSnapshotSelection({
        expectedVersion: before.version,
        selection: sourceSelection(source),
      });
      const changed = create();
      expect(changed.status).toBe(state);
      expect(changed.revisions[0]).toEqual(source.revisions[0]);
      failure(
        () => root.assertBundleEditingAllowed(editCheck(root)),
        'BUNDLE_EDITING_LOCKED',
      );
      const replay = root.recordBundleSnapshotSelection({
        expectedVersion: root.version,
        selection: sourceSelection(changed),
      });
      expect(replay).toBe(root);
    },
  );
  it('locks only the selected Bundle and keeps it locked while registering a remaining Pair', () => {
    const first = locked();
    const complete = first.registerBundle({
      expectedVersion: first.version,
      actorSubject: 'uploader',
      registeredAt: time(),
      bundleId: 'bundle-2',
      itemIds: ['b'],
      expense: expense('expense-2', 200),
    });
    failure(
      () => complete.assertBundleEditingAllowed(editCheck(complete)),
      'BUNDLE_EDITING_LOCKED',
    );
    expect(
      complete.assertBundleEditingAllowed(
        editCheck(complete, { bundleId: 'bundle-2' }),
      ),
    ).toBeUndefined();
    expect(snapshot(complete).bundleSnapshotSelections).toBe(
      snapshot(first).bundleSnapshotSelections,
    );
    expect(first.hasCompleteBundleRegistration()).toBe(false);
    expect(complete.hasCompleteBundleRegistration()).toBe(true);
  });
  it('handles identical Source fact as pure no-op but rejects stale replay and a replacement first fact', () => {
    const root = locked();
    const before = root.snapshot();
    expect(
      root.recordBundleSnapshotSelection(
        record({ expectedVersion: root.version }),
      ),
    ).toBe(root);
    failure(
      () => root.recordBundleSnapshotSelection(record()),
      'VERSION_CONFLICT',
    );
    failure(
      () =>
        root.recordBundleSnapshotSelection(
          record({
            expectedVersion: root.version,
            selection: selection({ snapshotId: uuid(4) }),
          }),
        ),
      'BUNDLE_ALREADY_SELECTED',
    );
    failure(
      () =>
        root.recordBundleSnapshotSelection(
          record({
            expectedVersion: root.version,
            selection: selection({
              selectedAt: new Date('2026-10-02T00:00:00Z'),
            }),
          }),
        ),
      'BUNDLE_ALREADY_SELECTED',
    );
    expect(root.snapshot()).toBe(before);
    expect(root.version).toBe(4);
    expect(root.changes).toHaveLength(3);
  });
  it.each([
    { bundleId: 'missing', code: 'BUNDLE_NOT_FOUND' },
    { expenseId: 'different', code: 'BUNDLE_SNAPSHOT_PAIR_MISMATCH' },
    { groupId: uuid(10), code: 'BUNDLE_SNAPSHOT_PAIR_MISMATCH' },
    { groupId: 'another-group', code: 'BUNDLE_SNAPSHOT_PAIR_MISMATCH' },
  ])(
    'rejects mismatched Source mapping $code without a partial lock',
    ({ code, ...overrides }) => {
      const root = registered();
      const before = root.snapshot();
      failure(
        () =>
          root.recordBundleSnapshotSelection(
            record({ selection: selection(overrides) }),
          ),
        code,
      );
      expect(root.snapshot()).toBe(before);
      expect(snapshot(root).bundleSnapshotSelections).toEqual([]);
    },
  );
  it.each([
    { caseId: 'bad' },
    { snapshotId: '' },
    { groupId: '' },
    { expenseId: '' },
  ])('rejects invalid Source reference %j', (overrides) => {
    failure(
      () =>
        registered().recordBundleSnapshotSelection(
          record({ selection: selection(overrides) }),
        ),
      'BUNDLE_SNAPSHOT_REFERENCE_INVALID',
    );
  });
  it('rejects invalid timestamp and actor reference', () => {
    failure(
      () =>
        registered().recordBundleSnapshotSelection(
          record({ selection: selection({ selectedAt: new Date(NaN) }) }),
        ),
      'UTC_INSTANT_INVALID',
    );
    failure(
      () =>
        registered().recordBundleSnapshotSelection(
          record({ selection: selection({ actorSubject: ' ' }) }),
        ),
      'ACTOR_REFERENCE_INVALID',
    );
  });
  it('rejects Draft, unknown editing Bundle and stale editing version', () => {
    failure(
      () =>
        draft().recordBundleSnapshotSelection(record({ expectedVersion: 1 })),
      'RECEIPT_NOT_CONFIRMED',
    );
    failure(
      () => draft().assertBundleEditingAllowed(editCheck(draft())),
      'RECEIPT_NOT_CONFIRMED',
    );
    const root = registered();
    failure(
      () =>
        root.assertBundleEditingAllowed(
          editCheck(root, { bundleId: 'missing' }),
        ),
      'BUNDLE_NOT_FOUND',
    );
    failure(
      () =>
        root.assertBundleEditingAllowed(
          editCheck(root, { expectedVersion: 2 }),
        ),
      'VERSION_CONFLICT',
    );
    failure(
      () =>
        root.assertBundleEditingAllowed(editCheck(root, { actorSubject: ' ' })),
      'ACTOR_REFERENCE_INVALID',
    );
  });
  it('deeply freezes the copied Source selection, preserves supplied Expense and original revision', () => {
    const supplied = expense();
    const expenseBefore = supplied.snapshot();
    const source = initialCase();
    const revision = source.snapshot;
    const input = record({ selection: sourceSelection(source) });
    const before = registered(supplied);
    const root = before.recordBundleSnapshotSelection(input);
    const value = snapshot(root).bundleSnapshotSelections[0];
    input.selection.selectedAt.setTime(0);
    Reflect.set(input.selection, 'snapshotId', uuid(4));
    expect(value.snapshotId).toBe(uuid(3));
    expect(value.selectedAt).toBe('2026-10-03T01:00:00.000Z');
    for (const v of [
      root,
      root.changes,
      root.changes[2],
      root.snapshot(),
      snapshot(root).bundleSnapshotSelections,
      value,
      value.bundleId,
      value.expenseId,
    ])
      expect(Object.isFrozen(v)).toBe(true);
    expect(Reflect.set(value, 'snapshotId', uuid(4))).toBe(false);
    expect(snapshot(before).bundleSnapshotSelections).toEqual([]);
    expect(supplied.snapshot()).toBe(expenseBefore);
    expect(supplied.version).toBe(1);
    expect(source.snapshot).toBe(revision);
  });
});

describe('Immutable Bundle Snapshot selection value', () => {
  it('keeps a nonblank Group reference opaque in the value and leaves Pair matching to Receipt', () => {
    const value = ReceiptBundleSnapshotSelection.from(
      selection({ groupId: 'opaque-group' }),
    );
    expect(value.groupId).toBe('opaque-group');
  });
  it('compares all Source facts by value and normalizes only the UTC timestamp', () => {
    const a = ReceiptBundleSnapshotSelection.from(selection());
    expect(
      a.equals(
        ReceiptBundleSnapshotSelection.from(
          selection({ selectedAt: new Date('2026-10-03T10:00:00+09:00') }),
        ),
      ),
    ).toBe(true);
    expect(
      a.equals(
        ReceiptBundleSnapshotSelection.from(selection({ snapshotId: uuid(4) })),
      ),
    ).toBe(false);
    expect(
      a.equals(
        ReceiptBundleSnapshotSelection.from(
          selection({ actorSubject: 'other' }),
        ),
      ),
    ).toBe(false);
  });
});
