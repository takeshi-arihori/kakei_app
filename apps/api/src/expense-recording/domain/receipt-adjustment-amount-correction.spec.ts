import { OccurredOn } from './value-objects/occurred-on.js';
import { describe, expect, it } from 'vitest';
import { Receipt } from './receipt.js';
import { GroupExpense } from './group-expense.js';
import { ReceiptInvariantViolation } from './receipt-invariant-violation.js';
import { ExpenseInvariantViolation } from './expense-invariant-violation.js';
import type {
  CorrectReceiptAdjustmentAmount,
  ReceiptAdjustmentAmountCorrectedChange,
} from './receipt-adjustment-amount-correction.js';
import type { ReceiptAdjustmentInput } from './receipt-adjustment.js';
import { SettlementCase } from '../../settlement/domain/settlement-case.js';
import { SettlementSnapshotContent } from '../../settlement/domain/value-objects/settlement-snapshot-content.js';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const groupId = uuid(1);
const at = () => new Date('2026-10-06T09:00:00+09:00');
const confirmed = (r: Receipt) => {
  const s = r.snapshot();
  if (s.status !== 'Confirmed') throw Error('Confirmed expected');
  return s;
};
const fixture = (wide = true) => {
  const items = [
    { id: 'a', name: 'Tea', amount: 100, categoryId: 'food' },
    { id: 'b', name: 'Cup', amount: 200, categoryId: 'tools' },
    { id: 'c', name: 'Paper', amount: 300, categoryId: 'tools' },
    { id: 'd', name: 'Unassigned', amount: 400, categoryId: 'food' },
  ];
  const adjustments: ReceiptAdjustmentInput[] = [
    { kind: 'Discount', amount: -10, target: { scope: 'Item', itemId: 'a' } },
    ...(wide
      ? [
          {
            kind: 'Tax' as const,
            amount: 99,
            target: { scope: 'Receipt' as const },
          },
        ]
      : []),
  ];
  const total = wide ? 1089 : 990;
  const draft = Receipt.createDraft({
    id: 'receipt',
    uploaderSubject: 'uploader',
    occurredOn: '2026-10-01',
    declaredTotal: total,
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
        { participantId: 'payer', joinOrder: 2, percentage: 50 },
        { participantId: 'other', joinOrder: 7, percentage: 50 },
      ],
    });
  const a = expense('expense-a', wide ? 320 : 290),
    b = expense('expense-b', wide ? 330 : 300);
  const unregistered = draft.confirm({
    expectedVersion: 1,
    actorSubject: 'uploader',
    confirmedAt: at(),
    occurredOn: '2026-10-01',
    declaredTotal: total,
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
      expense: a,
    })
    .registerBundle({
      expectedVersion: 3,
      actorSubject: 'uploader',
      registeredAt: at(),
      bundleId: 'bundle-b',
      itemIds: ['c'],
      expense: b,
    });
  return { draft, unregistered, receipt, a, b };
};
const input = (
  r: Receipt,
  wide = true,
  patch: Partial<CorrectReceiptAdjustmentAmount> = {},
): CorrectReceiptAdjustmentAmount => ({
  expectedVersion: r.version,
  actorSubject: 'uploader',
  currentOwnerSubject: 'owner',
  groupId,
  correctedAt: at(),
  reason: 'Correct adjustment',
  adjustmentIndex: wide ? 1 : 0,
  amount: wide ? 199 : -20,
  declaredTotal: wide ? 1189 : 980,
  affectedCaseFacts: (wide ? ['bundle-a', 'bundle-b'] : ['bundle-a']).map(
    (bundleId) => ({ bundleId, expectedCaseVersion: null, caseFact: null }),
  ),
  ...patch,
});
const change = (r: Receipt): ReceiptAdjustmentAmountCorrectedChange => {
  const c = r.changes.at(-1);
  if (c?.action !== 'AdjustmentAmountCorrected')
    throw Error('Correction expected');
  return c;
};
const reflect = (
  e: GroupExpense,
  c: ReceiptAdjustmentAmountCorrectedChange,
  expectedExpenseVersion = e.version,
  expectedReceiptVersion = c.previousVersion,
) =>
  e.reflectReceiptAdjustmentAmountCorrection({
    expectedExpenseVersion,
    expectedReceiptVersion,
    change: c,
  });
const initialCase = (e: GroupExpense, n = 10) => {
  const s = e.snapshot();
  return SettlementCase.start({
    caseId: uuid(n),
    snapshotId: uuid(n + 1),
    applicant: { actorSubject: 'uploader', participantId: 'payer' },
    submittedAt: at(),
    instructionIds: s.total.amount === 0 ? [] : [uuid(n + 2)],
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
const rejected = (c: SettlementCase) =>
  c.reject({
    expectedVersion: c.version,
    snapshotId: c.snapshot.snapshotId,
    participantId: 'other',
    reason: 'wrong amount',
    decidedAt: at(),
  });
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
      selectedAt: at(),
    },
  });
const caseEntry = (bundleId: string, c: SettlementCase) => ({
  bundleId,
  expectedCaseVersion: c.version,
  caseFact: {
    caseId: String(c.snapshot.caseId),
    groupId,
    expenseId: c.snapshot.content.expenses[0].expenseId,
    version: c.version,
    lifecycle: String(c.status),
  },
});
const refusal = (op: () => unknown, code: string) => {
  expect(op).toThrow(ReceiptInvariantViolation);
  try {
    op();
  } catch (e) {
    expect(e).toMatchObject({ code, message: 'Receipt invariant violated' });
  }
};

describe('AJ1-3: Adjustment correction and complete financial effects', () => {
  it.each(['uploader', 'owner'])(
    'allows %s, reflects wide Tax into all affected Expenses',
    (actorSubject) => {
      const f = fixture(),
        old = confirmed(f.receipt),
        r = f.receipt.correctAdjustmentAmount(
          input(f.receipt, true, { actorSubject }),
        ),
        c = change(r),
        s = confirmed(r);
      expect(s.items.map((i) => [i.originalAmount, i.adjustedAmount])).toEqual([
        [100, 110],
        [200, 240],
        [300, 360],
        [400, 479],
      ]);
      expect(s.declaredTotal).toBe(1189);
      expect(s.bundles).toBe(old.bundles);
      expect(s.bundleSnapshotSelections).toBe(old.bundleSnapshotSelections);
      expect(s.adjustments[0]).toBe(old.adjustments[0]);
      expect(s.adjustments[1]).toEqual({ ...old.adjustments[1], amount: 199 });
      expect(old.adjustments[1].amount).toBe(99);
      expect(c).toMatchObject({
        action: 'AdjustmentAmountCorrected',
        adjustmentIndex: 1,
        actorSubject,
        at: '2026-10-06T00:00:00.000Z',
        reason: 'Correct adjustment',
        previousVersion: 4,
        version: 5,
      });
      expect(c.affectedCaseFacts.map((x) => x.bundleId)).toEqual([
        'bundle-a',
        'bundle-b',
      ]);
      expect(r.changes.slice(0, -1)).toEqual(f.receipt.changes);
      const a = reflect(f.a, c),
        b = reflect(f.b, c);
      expect(a.snapshot().total.amount).toBe(350);
      expect(a.snapshot().allocations.map((x) => x.burden.amount)).toEqual([
        175, 175,
      ]);
      expect(b.snapshot().total.amount).toBe(360);
      expect(a.id).toBe(f.a.id);
      expect(a.initialSnapshot).toBe(f.a.initialSnapshot);
      expect(a.version).toBe(2);
      expect(a.receiptAdjustmentAmountCorrections[0]).toMatchObject({
        adjustmentIndex: 1,
        receiptId: 'receipt',
        bundleId: 'bundle-a',
        reason: 'Correct adjustment',
        previousReceiptVersion: 4,
        receiptVersion: 5,
        previousVersion: 1,
        version: 2,
      });
      expect(f.a.version).toBe(1);
      expect(f.a.snapshot().total.amount).toBe(320);
      expect(s.items.map((i) => [i.id, i.name, i.categoryId])).toEqual(
        old.items.map((i) => [i.id, i.name, i.categoryId]),
      );
    },
  );
  it('corrects one Item Discount while unrelated selected Bundle remains blocked', () => {
    const f = fixture(false),
      locked = select(f.receipt, 'bundle-b', initialCase(f.b));
    const r = locked.correctAdjustmentAmount(input(locked, false)),
      c = change(r);
    expect(c.affectedCaseFacts.map((x) => x.bundleId)).toEqual(['bundle-a']);
    expect(confirmed(r).items.map((i) => i.adjustedAmount)).toEqual([
      80, 200, 300, 400,
    ]);
    expect(reflect(f.a, c).snapshot().total.amount).toBe(280);
    expect(() => reflect(f.b, c)).toThrow(ExpenseInvariantViolation);
  });
  it('derives actual rounding footprint, excluding unchanged registered Bundle', () => {
    const f = fixture(),
      r = select(f.receipt, 'bundle-a', initialCase(f.a));
    const updated = r.correctAdjustmentAmount(
      input(r, true, {
        amount: 102,
        declaredTotal: 1092,
        affectedCaseFacts: [
          { bundleId: 'bundle-b', expectedCaseVersion: null, caseFact: null },
        ],
      }),
    );
    expect(change(updated).affectedCaseFacts.map((x) => x.bundleId)).toEqual([
      'bundle-b',
    ]);
    expect(reflect(f.b, change(updated)).snapshot().total.amount).toBe(331);
  });
  it('rejects wide change affecting only unassigned secondary items as outside registered slice', () => {
    const f = fixture();
    refusal(
      () =>
        f.receipt.correctAdjustmentAmount(
          input(f.receipt, true, {
            amount: 100,
            declaredTotal: 1090,
            affectedCaseFacts: [],
          }),
        ),
      'ADJUSTMENT_NOT_BUNDLED',
    );
  });
  it('keeps old Rejected Snapshot and locks, resubmits corrected Expense as new Revision', () => {
    const f = fixture(false),
      started = initialCase(f.a),
      rej = rejected(started),
      r = select(f.receipt, 'bundle-a', started);
    const oldRevision = rej.snapshot;
    const corrected = r.correctAdjustmentAmount(
        input(r, false, { affectedCaseFacts: [caseEntry('bundle-a', rej)] }),
      ),
      c = change(corrected),
      e = reflect(f.a, c),
      es = e.snapshot();
    expect(e.snapshot().total.amount).toBe(280);
    expect(rej.snapshot).toBe(oldRevision);
    expect(rej.snapshot.content.expenses[0].amount).toBe(290n);
    const resubmitted = rej.resubmit({
      expectedVersion: rej.version,
      currentSnapshotId: rej.snapshot.snapshotId,
      snapshotId: uuid(30),
      applicant: { actorSubject: 'uploader', participantId: 'payer' },
      currentOwnerSubject: 'owner',
      submittedAt: at(),
      instructionIds: [uuid(31)],
      content: SettlementSnapshotContent.from(groupId, [
        {
          expenseId: es.id.value,
          groupId,
          amount: BigInt(es.total.amount),
          payerParticipantId: es.payerParticipantId,
          allocations: es.allocations.map((a) => ({
            ...a,
            burden: BigInt(a.burden.amount),
          })),
        },
      ]),
    });
    expect(resubmitted.snapshot.content.expenses[0].amount).toBe(280n);
    expect(rej.snapshot.content.expenses[0].amount).toBe(290n);
    expect(() =>
      corrected.bundleEditingFacts({
        expectedVersion: corrected.version,
        actorSubject: 'uploader',
        bundleId: 'bundle-a',
      }),
    ).toThrow(ReceiptInvariantViolation);
  });
  it('rejects whole wide change when any affected Bundle is Awaiting Approval', () => {
    const f = fixture(),
      r = select(f.receipt, 'bundle-b', initialCase(f.b));
    refusal(
      () =>
        r.correctAdjustmentAmount(
          input(r, true, {
            affectedCaseFacts: [
              {
                bundleId: 'bundle-a',
                expectedCaseVersion: null,
                caseFact: null,
              },
              caseEntry('bundle-b', initialCase(f.b)),
            ],
          }),
        ),
      'ADJUSTMENT_AMOUNT_NOT_CORRECTABLE',
    );
    expect(r.version).toBe(5);
    expect(confirmed(r).declaredTotal).toBe(1089);
  });
  it('accepts independently Rejected cases for every affected registered Bundle', () => {
    const f = fixture(),
      ca = initialCase(f.a, 10),
      cb = initialCase(f.b, 20),
      ra = rejected(ca),
      rb = rejected(cb),
      r = select(select(f.receipt, 'bundle-a', ca), 'bundle-b', cb);
    const u = r.correctAdjustmentAmount(
      input(r, true, {
        actorSubject: 'owner',
        affectedCaseFacts: [
          caseEntry('bundle-b', rb),
          caseEntry('bundle-a', ra),
        ],
      }),
    );
    expect(reflect(f.a, change(u)).snapshot().total.amount).toBe(350);
    expect(reflect(f.b, change(u)).snapshot().total.amount).toBe(360);
  });
});
describe('AJ1/4: validated boundary and refusal leave prior Root untouched', () => {
  it.each([
    [{ expectedVersion: 3 }, 'VERSION_CONFLICT'],
    [{ expectedVersion: NaN }, 'VERSION_CONFLICT'],
    [{ actorSubject: 'other' }, 'ACTOR_NOT_UPLOADER_OR_OWNER'],
    [{ actorSubject: '' }, 'ACTOR_REFERENCE_INVALID'],
    [{ currentOwnerSubject: '' }, 'ACTOR_REFERENCE_INVALID'],
    [{ groupId: '' }, 'GROUP_REFERENCE_INVALID'],
    [{ groupId: uuid(2) }, 'BUNDLE_GROUP_MISMATCH'],
    [{ correctedAt: new Date(NaN) }, 'UTC_INSTANT_INVALID'],
    [{ reason: '  ' }, 'CORRECTION_REASON_EMPTY'],
    [{ adjustmentIndex: -1 }, 'ADJUSTMENT_INDEX_INVALID'],
    [{ adjustmentIndex: 0.5 }, 'ADJUSTMENT_INDEX_INVALID'],
    [{ adjustmentIndex: 2 }, 'ADJUSTMENT_INDEX_INVALID'],
    [{ adjustmentIndex: NaN }, 'ADJUSTMENT_INDEX_INVALID'],
    [{ amount: 0 }, 'ADJUSTMENT_INVALID'],
    [{ amount: -99 }, 'ADJUSTMENT_INVALID'],
    [{ amount: 0.5 }, 'ADJUSTMENT_INVALID'],
    [{ amount: NaN }, 'ADJUSTMENT_INVALID'],
    [{ amount: Infinity }, 'ADJUSTMENT_INVALID'],
    [{ amount: Number.MAX_SAFE_INTEGER + 1 }, 'ADJUSTMENT_INVALID'],
    [{ declaredTotal: -1 }, 'TOTAL_INVALID'],
    [{ declaredTotal: 0.5 }, 'TOTAL_INVALID'],
    [{ declaredTotal: NaN }, 'TOTAL_INVALID'],
    [{ declaredTotal: 1188 }, 'RECEIPT_TOTAL_MISMATCH'],
  ])('rejects invalid input %j', (patch, code) => {
    const f = fixture(),
      old = f.receipt.snapshot(),
      oldChanges = f.receipt.changes;
    refusal(
      () => f.receipt.correctAdjustmentAmount(input(f.receipt, true, patch)),
      code,
    );
    expect(f.receipt.snapshot()).toBe(old);
    expect(f.receipt.changes).toBe(oldChanges);
    expect(f.receipt.version).toBe(4);
  });
  it('rejects negative adjusted item', () => {
    const f = fixture(false);
    refusal(
      () =>
        f.receipt.correctAdjustmentAmount(
          input(f.receipt, false, { amount: -101, declaredTotal: 899 }),
        ),
      'ADJUSTMENT_INVALID',
    );
  });
  it('rejects positive Discount', () => {
    const f = fixture(false);
    refusal(
      () =>
        f.receipt.correctAdjustmentAmount(
          input(f.receipt, false, { amount: 20, declaredTotal: 1020 }),
        ),
      'ADJUSTMENT_INVALID',
    );
  });
  it('rejects Draft', () => {
    const f = fixture();
    refusal(
      () => f.draft.correctAdjustmentAmount(input(f.draft)),
      'RECEIPT_NOT_CONFIRMED',
    );
  });
  it('rejects unregistered target', () => {
    const f = fixture(false);
    refusal(
      () =>
        f.unregistered.correctAdjustmentAmount(
          input(f.unregistered, false, { affectedCaseFacts: [] }),
        ),
      'ADJUSTMENT_NOT_BUNDLED',
    );
  });
  it.each(['missing', 'extra', 'duplicate'])(
    'rejects %s Case entries',
    (mode) => {
      const f = fixture(),
        facts = input(f.receipt).affectedCaseFacts;
      const wrong =
        mode === 'missing'
          ? facts.slice(0, 1)
          : mode === 'extra'
            ? [
                ...facts,
                {
                  bundleId: 'other',
                  expectedCaseVersion: null,
                  caseFact: null,
                },
              ]
            : [facts[0], facts[0]];
      refusal(
        () =>
          f.receipt.correctAdjustmentAmount(
            input(f.receipt, true, { affectedCaseFacts: wrong }),
          ),
        'AFFECTED_CASE_FACTS_MISMATCH',
      );
    },
  );
  it('requires explicit null Case for never selected Bundle', () => {
    const f = fixture(),
      facts = [
        caseEntry('bundle-a', rejected(initialCase(f.a))),
        { bundleId: 'bundle-b', expectedCaseVersion: null, caseFact: null },
      ];
    refusal(
      () =>
        f.receipt.correctAdjustmentAmount(
          input(f.receipt, true, { affectedCaseFacts: facts }),
        ),
      'CASE_FACT_UNEXPECTED',
    );
  });
  it.each([
    'Awaiting Approval',
    'Approved',
    'Payment Active',
    'Archived',
    'Withdrawn',
    'Cancelled',
    'Cancellation Pending',
  ])('rejects selected %s', (lifecycle) => {
    const f = fixture(false),
      c = initialCase(f.a),
      r = select(f.receipt, 'bundle-a', c),
      entry = caseEntry('bundle-a', rejected(c));
    entry.caseFact.lifecycle = lifecycle;
    refusal(
      () =>
        r.correctAdjustmentAmount(
          input(r, false, { affectedCaseFacts: [entry] }),
        ),
      'ADJUSTMENT_AMOUNT_NOT_CORRECTABLE',
    );
  });
  it.each([
    ['caseId', 'invalid', 'CASE_REFERENCE_INVALID'],
    ['groupId', uuid(2), 'CASE_FACT_MISMATCH'],
    ['expenseId', 'other', 'CASE_FACT_MISMATCH'],
    ['version', 0, 'CASE_VERSION_CONFLICT'],
    ['version', 3, 'CASE_VERSION_CONFLICT'],
  ])('rejects mismatched Case %s', (key, value, code) => {
    const f = fixture(false),
      c = initialCase(f.a),
      r = select(f.receipt, 'bundle-a', c),
      entry = caseEntry('bundle-a', rejected(c));
    const fact = { ...entry.caseFact, [key]: value };
    refusal(
      () =>
        r.correctAdjustmentAmount(
          input(r, false, {
            affectedCaseFacts: [{ ...entry, caseFact: fact }],
          }),
        ),
      code,
    );
  });
  it('requires Case after initial selection', () => {
    const f = fixture(false),
      r = select(f.receipt, 'bundle-a', initialCase(f.a));
    refusal(
      () => r.correctAdjustmentAmount(input(r, false)),
      'CASE_FACT_REQUIRED',
    );
  });
});
describe('AJ5: no-op, stale replay, immutable input and histories', () => {
  it('returns same Root on identical amount after checking existing allocation footprint', () => {
    const f = fixture();
    expect(
      f.receipt.correctAdjustmentAmount(
        input(f.receipt, true, { amount: 99, declaredTotal: 1089 }),
      ),
    ).toBe(f.receipt);
    refusal(
      () =>
        f.receipt.correctAdjustmentAmount(
          input(f.receipt, true, {
            amount: 99,
            declaredTotal: 1089,
            reason: '',
          }),
        ),
      'CORRECTION_REASON_EMPTY',
    );
    refusal(
      () =>
        f.receipt.correctAdjustmentAmount(
          input(f.receipt, true, {
            amount: 99,
            declaredTotal: 1089,
            affectedCaseFacts: [],
          }),
        ),
      'AFFECTED_CASE_FACTS_MISMATCH',
    );
  });
  it('rejects same-value input when selected Case is not Rejected', () => {
    const f = fixture(false),
      c = initialCase(f.a),
      r = select(f.receipt, 'bundle-a', c);
    refusal(
      () =>
        r.correctAdjustmentAmount(
          input(r, false, {
            amount: -10,
            declaredTotal: 990,
            affectedCaseFacts: [caseEntry('bundle-a', c)],
          }),
        ),
      'ADJUSTMENT_AMOUNT_NOT_CORRECTABLE',
    );
  });
  it('rejects stale expected Receipt and Expense versions', () => {
    const f = fixture(),
      i = input(f.receipt),
      r = f.receipt.correctAdjustmentAmount(i),
      c = change(r),
      e = reflect(f.a, c);
    refusal(() => r.correctAdjustmentAmount(i), 'VERSION_CONFLICT');
    expect(() => reflect(e, c, 1)).toThrow(ExpenseInvariantViolation);
    expect(() => reflect(f.a, c, 1, c.previousVersion - 1)).toThrow(
      ExpenseInvariantViolation,
    );
  });
  it('copies UTC and mutable Case facts before freezing both histories', () => {
    const f = fixture(false),
      start = initialCase(f.a),
      rej = rejected(start),
      r = select(f.receipt, 'bundle-a', start),
      entry = caseEntry('bundle-a', rej),
      time = at();
    const u = r.correctAdjustmentAmount(
        input(r, false, { correctedAt: time, affectedCaseFacts: [entry] }),
      ),
      c = change(u),
      e = reflect(f.a, c),
      h = e.receiptAdjustmentAmountCorrections[0];
    entry.caseFact.lifecycle = 'Archived';
    time.setUTCFullYear(2040);
    expect(c.at).toBe('2026-10-06T00:00:00.000Z');
    expect(c.affectedCaseFacts[0].caseFact?.lifecycle).toBe('Rejected');
    expect(h.caseFact?.lifecycle).toBe('Rejected');
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.after.adjustments)).toBe(true);
    expect(Object.isFrozen(c.after.adjustments[0].target)).toBe(true);
    expect(Object.isFrozen(h)).toBe(true);
    expect(Object.isFrozen(h.caseFact)).toBe(true);
  });
  it('preserves prior corrections through repeated Adjustment changes and original amount correction', () => {
    const f = fixture(false),
      r1 = f.receipt.correctAdjustmentAmount(input(f.receipt, false)),
      e1 = reflect(f.a, change(r1));
    const r2 = r1.correctAdjustmentAmount(
        input(r1, false, { amount: -30, declaredTotal: 970 }),
      ),
      e2 = reflect(e1, change(r2));
    expect(e2.receiptAdjustmentAmountCorrections).toHaveLength(2);
    expect(e2.receiptAdjustmentAmountCorrections[0]).toBe(
      e1.receiptAdjustmentAmountCorrections[0],
    );
    const r3 = r2.correctItemAmount({
        expectedVersion: r2.version,
        actorSubject: 'uploader',
        currentOwnerSubject: 'owner',
        groupId,
        correctedAt: at(),
        reason: 'original',
        itemId: 'a',
        amount: 200,
        declaredTotal: 1070,
        affectedCaseFacts: [
          { bundleId: 'bundle-a', expectedCaseVersion: null, caseFact: null },
        ],
      }),
      c3 = r3.changes.at(-1);
    if (c3?.action !== 'ItemAmountCorrected') throw Error('Original expected');
    const e3 = e2.reflectReceiptItemAmountCorrection({
      expectedExpenseVersion: e2.version,
      expectedReceiptVersion: c3.previousVersion,
      change: c3,
    });
    expect(e3.receiptAdjustmentAmountCorrections).toBe(
      e2.receiptAdjustmentAmountCorrections,
    );
    expect(e3.receiptItemAmountCorrections).toHaveLength(1);
    const r4 = r3.correctAdjustmentAmount(
        input(r3, false, { amount: -40, declaredTotal: 1060 }),
      ),
      e4 = reflect(e3, change(r4));
    expect(e4.receiptItemAmountCorrections).toBe(
      e3.receiptItemAmountCorrections,
    );
    expect(e4.initialSnapshot).toBe(f.a.initialSnapshot);
  });
});
describe('AJ4: Expense verifies bound Pair facts', () => {
  it.each([
    'actor',
    'reason',
    'utc',
    'receipt',
    'amount',
    'membership',
    'source',
    'date',
    'adjustment',
    'kind',
    'target',
    'index',
    'case',
  ])('rejects forged %s facts', (key) => {
    const f = fixture(),
      r = f.receipt.correctAdjustmentAmount(input(f.receipt)),
      c = change(r);
    const bad = { ...c };
    if (key === 'actor') bad.actorSubject = 'other';
    if (key === 'reason') bad.reason = '';
    if (key === 'utc') bad.at = '2026-10-06';
    if (key === 'receipt') bad.previousVersion = 1;
    if (key === 'amount')
      bad.before = {
        ...c.before,
        items: c.before.items.map((i) => ({
          ...i,
          adjustedAmount: i.adjustedAmount + 1,
        })),
      };
    if (key === 'membership')
      bad.after = {
        ...c.after,
        bundles: c.after.bundles.map((b) => ({ ...b, itemIds: ['c'] })),
      };
    if (key === 'source') bad.after = { ...c.after, uploaderSubject: 'other' };
    if (key === 'date')
      bad.after = { ...c.after, occurredOn: OccurredOn.from('2026-10-02') };
    if (key === 'adjustment')
      bad.after = { ...c.after, adjustments: c.before.adjustments };
    if (key === 'kind')
      bad.after = {
        ...c.after,
        adjustments: c.after.adjustments.map((a, n) =>
          n === 1 ? { ...a, kind: 'Shipping' } : a,
        ),
      };
    if (key === 'target')
      bad.after = {
        ...c.after,
        adjustments: c.after.adjustments.map((a, n) =>
          n === 1 ? { ...a, target: { scope: 'Item', itemId: 'a' } } : a,
        ),
      };
    if (key === 'index') bad.adjustmentIndex = 0;
    if (key === 'case') bad.affectedCaseFacts = [];
    expect(() => reflect(f.a, bad)).toThrow(ExpenseInvariantViolation);
    expect(f.a.version).toBe(1);
  });
  it('rejects wrong Expense Pair', () => {
    const f = fixture(),
      r = f.receipt.correctAdjustmentAmount(input(f.receipt));
    const other = GroupExpense.register({
      id: 'other',
      groupId,
      sourceOwnerSubject: 'uploader',
      occurredOn: '2026-10-01',
      amount: 350,
      payerParticipantId: 'payer',
      participants: [{ participantId: 'payer', joinOrder: 2, percentage: 100 }],
    });
    expect(() => reflect(other, change(r))).toThrow(ExpenseInvariantViolation);
  });
});

describe('AJ4/5: numerical extremes and prior operation histories', () => {
  it('rejects Receipt version overflow but permits a fully validated no-op', () => {
    const f = fixture(false),
      r: unknown = Reflect.construct(Receipt, [
        f.receipt.snapshot(),
        Number.MAX_SAFE_INTEGER,
        f.receipt.changes,
      ]);
    if (!(r instanceof Receipt)) throw Error('Receipt expected');
    refusal(
      () => r.correctAdjustmentAmount(input(r, false)),
      'VERSION_OVERFLOW',
    );
    expect(
      r.correctAdjustmentAmount(
        input(r, false, { amount: -10, declaredTotal: 990 }),
      ),
    ).toBe(r);
  });
  it('rejects Expense version overflow after validating financial Pair', () => {
    const f = fixture(false),
      r = f.receipt.correctAdjustmentAmount(input(f.receipt, false)),
      e: unknown = Reflect.construct(GroupExpense, [
        f.a.snapshot(),
        f.a.initialSnapshot,
        Number.MAX_SAFE_INTEGER,
        f.a.corrections,
        f.a.bundleSplitChanges,
        f.a.bundleItemMovements,
        f.a.receiptItemAmountCorrections,
      ]);
    if (!(e instanceof GroupExpense)) throw Error('Expense expected');
    expect(() => reflect(e, change(r))).toThrowError(
      expect.objectContaining({ code: 'VERSION_OVERFLOW' }),
    );
  });
  it('keeps new history through split, movement, and hand-input amount operations', () => {
    const f = fixture(false),
      r = f.receipt.correctAdjustmentAmount(input(f.receipt, false)),
      a = reflect(f.a, change(r)),
      before = r.bundleEditingFacts({
        expectedVersion: r.version,
        actorSubject: 'uploader',
        bundleId: 'bundle-a',
      });
    const split = a.changeBundleSplit({
      expectedExpenseVersion: a.version,
      expectedReceiptVersion: r.version,
      bundleFact: before,
      actorSubject: 'uploader',
      changedAt: at(),
      payerParticipantId: 'other',
      percentages: [
        { participantId: 'payer', percentage: 80 },
        { participantId: 'other', percentage: 20 },
      ],
    });
    expect(split.receiptAdjustmentAmountCorrections).toBe(
      a.receiptAdjustmentAmountCorrections,
    );
    const moved = r.moveBundleItems({
        expectedVersion: r.version,
        actorSubject: 'uploader',
        movedAt: at(),
        fromBundleId: 'bundle-a',
        toBundleId: 'bundle-b',
        itemIds: ['b'],
      }),
      after = moved.bundleEditingFacts({
        expectedVersion: moved.version,
        actorSubject: 'uploader',
        bundleId: 'bundle-a',
      });
    const m = split.reflectBundleItemMovement({
      expectedExpenseVersion: split.version,
      expectedReceiptVersion: r.version,
      beforeBundleFact: before,
      afterBundleFact: after,
      actorSubject: 'uploader',
      changedAt: at(),
    });
    expect(m.receiptAdjustmentAmountCorrections).toBe(
      a.receiptAdjustmentAmountCorrections,
    );
    const hand = m.correctAmount({
      expectedExpenseVersion: m.version,
      expectedCaseVersion: 2,
      actorSubject: 'owner',
      currentOwnerSubject: 'owner',
      correctedAt: at(),
      reason: 'history regression',
      amount: m.snapshot().total.amount,
      caseFact: {
        caseId: uuid(90),
        groupId,
        expenseId: m.id.value,
        version: 2,
        lifecycle: 'Rejected',
        allTargetsReleased: false,
      },
    });
    expect(hand.receiptAdjustmentAmountCorrections).toBe(
      a.receiptAdjustmentAmountCorrections,
    );
  });
  it('preserves existing split and movement history when Adjustment is corrected later', () => {
    const f = fixture(false),
      r = f.receipt,
      pre = r.bundleEditingFacts({
        expectedVersion: r.version,
        actorSubject: 'uploader',
        bundleId: 'bundle-a',
      });
    const split = f.a.changeBundleSplit({
      expectedExpenseVersion: f.a.version,
      expectedReceiptVersion: r.version,
      bundleFact: pre,
      actorSubject: 'uploader',
      changedAt: at(),
      payerParticipantId: 'other',
      percentages: [
        { participantId: 'payer', percentage: 70 },
        { participantId: 'other', percentage: 30 },
      ],
    });
    const moved = r.moveBundleItems({
        expectedVersion: r.version,
        actorSubject: 'uploader',
        movedAt: at(),
        fromBundleId: 'bundle-a',
        toBundleId: 'bundle-b',
        itemIds: ['b'],
      }),
      post = moved.bundleEditingFacts({
        expectedVersion: moved.version,
        actorSubject: 'uploader',
        bundleId: 'bundle-a',
      });
    const m = split.reflectBundleItemMovement({
        expectedExpenseVersion: split.version,
        expectedReceiptVersion: r.version,
        beforeBundleFact: pre,
        afterBundleFact: post,
        actorSubject: 'uploader',
        changedAt: at(),
      }),
      u = moved.correctAdjustmentAmount(input(moved, false)),
      e = reflect(m, change(u));
    expect(e.bundleSplitChanges).toBe(split.bundleSplitChanges);
    expect(e.bundleItemMovements).toBe(m.bundleItemMovements);
    expect(e.snapshot().payerParticipantId).toBe('other');
    expect(e.snapshot().allocations.map((a) => a.percentage)).toEqual([70, 30]);
  });
});

const customFixture = (
  amounts: readonly number[],
  adjustments: readonly ReceiptAdjustmentInput[],
  total: number,
  bundles: readonly {
    id: string;
    itemIds: readonly string[];
    amount: number;
  }[],
) => {
  const items = amounts.map((amount, n) => ({
    id: 'i' + n,
    name: 'Synthetic ' + n,
    amount,
    categoryId: 'food',
  }));
  let r = Receipt.createDraft({
    id: 'custom-receipt',
    uploaderSubject: 'uploader',
    occurredOn: '2026-10-01',
    declaredTotal: total,
    items,
    adjustments,
  }).confirm({
    expectedVersion: 1,
    actorSubject: 'uploader',
    confirmedAt: at(),
    occurredOn: '2026-10-01',
    declaredTotal: total,
    items,
    adjustments,
  });
  const expenses = bundles.map((b) =>
    GroupExpense.register({
      id: 'e-' + b.id,
      groupId,
      sourceOwnerSubject: 'uploader',
      occurredOn: '2026-10-01',
      amount: b.amount,
      payerParticipantId: 'payer',
      participants: [
        { participantId: 'payer', joinOrder: 2, percentage: 50 },
        { participantId: 'other', joinOrder: 7, percentage: 50 },
      ],
    }),
  );
  bundles.forEach((b, n) => {
    r = r.registerBundle({
      expectedVersion: r.version,
      actorSubject: 'uploader',
      registeredAt: at(),
      bundleId: b.id,
      itemIds: b.itemIds,
      expense: expenses[n],
    });
  });
  return { r, expenses };
};
describe('AJ2/3: signed kinds, rounding and same-total impact', () => {
  it.each(['Tax', 'Shipping', 'Discount', 'Point'] as const)(
    'preserves %s kind and signed Item target',
    (kind) => {
      const positive = kind === 'Tax' || kind === 'Shipping',
        old = positive ? 10 : -10,
        next = positive ? 20 : -20;
      const f = customFixture(
        [100],
        [{ kind, amount: old, target: { scope: 'Item', itemId: 'i0' } }],
        100 + old,
        [{ id: 'one', itemIds: ['i0'], amount: 100 + old }],
      );
      const r = f.r.correctAdjustmentAmount(
        input(f.r, false, {
          adjustmentIndex: 0,
          amount: next,
          declaredTotal: 100 + next,
          affectedCaseFacts: [
            { bundleId: 'one', expectedCaseVersion: null, caseFact: null },
          ],
        }),
      );
      expect(confirmed(r).adjustments).toEqual([
        { kind, amount: next, target: { scope: 'Item', itemId: 'i0' } },
      ]);
      expect(reflect(f.expenses[0], change(r)).snapshot().total.amount).toBe(
        100 + next,
      );
    },
  );
  it('includes same-total Bundle whose largest-remainder allocations change', () => {
    const f = customFixture(
      [5, 3, 1],
      [{ kind: 'Tax', amount: 4, target: { scope: 'Receipt' } }],
      13,
      [
        { id: 'one', itemIds: ['i0', 'i2'], amount: 9 },
        { id: 'two', itemIds: ['i1'], amount: 4 },
      ],
    );
    const r = f.r.correctAdjustmentAmount(
        input(f.r, true, {
          adjustmentIndex: 0,
          amount: 5,
          declaredTotal: 14,
          affectedCaseFacts: ['two', 'one'].map((bundleId) => ({
            bundleId,
            expectedCaseVersion: null,
            caseFact: null,
          })),
        }),
      ),
      c = change(r),
      e = reflect(f.expenses[0], c);
    expect(confirmed(f.r).allocations[0].amounts).toEqual([2, 1, 1]);
    expect(confirmed(r).allocations[0].amounts).toEqual([3, 2, 0]);
    expect(c.affectedCaseFacts.map((f) => f.bundleId)).toEqual(['one', 'two']);
    expect(e.snapshot().total.amount).toBe(9);
    expect(e.version).toBe(2);
    expect(e.receiptAdjustmentAmountCorrections).toHaveLength(1);
  });
  it('does not block whole change on zero originalAmount Bundle without financial impact', () => {
    const f = customFixture(
      [0, 100],
      [{ kind: 'Tax', amount: 10, target: { scope: 'Receipt' } }],
      110,
      [
        { id: 'zero', itemIds: ['i0'], amount: 0 },
        { id: 'one', itemIds: ['i1'], amount: 110 },
      ],
    );
    const r = select(f.r, 'zero', initialCase(f.expenses[0]));
    const u = r.correctAdjustmentAmount(
      input(r, true, {
        adjustmentIndex: 0,
        amount: 20,
        declaredTotal: 120,
        affectedCaseFacts: [
          { bundleId: 'one', expectedCaseVersion: null, caseFact: null },
        ],
      }),
    );
    expect(change(u).affectedCaseFacts.map((f) => f.bundleId)).toEqual(['one']);
  });
  it('allows Item-specific positive adjustment on zero original amount', () => {
    const f = customFixture(
      [0],
      [{ kind: 'Tax', amount: 10, target: { scope: 'Item', itemId: 'i0' } }],
      10,
      [{ id: 'one', itemIds: ['i0'], amount: 10 }],
    );
    const r = f.r.correctAdjustmentAmount(
      input(f.r, false, {
        adjustmentIndex: 0,
        amount: 20,
        declaredTotal: 20,
        affectedCaseFacts: [
          { bundleId: 'one', expectedCaseVersion: null, caseFact: null },
        ],
      }),
    );
    expect(reflect(f.expenses[0], change(r)).snapshot().total.amount).toBe(20);
  });
  it('rejects overflowing adjusted amount', () => {
    const f = customFixture(
      [Number.MAX_SAFE_INTEGER - 1],
      [{ kind: 'Tax', amount: 1, target: { scope: 'Item', itemId: 'i0' } }],
      Number.MAX_SAFE_INTEGER,
      [{ id: 'one', itemIds: ['i0'], amount: Number.MAX_SAFE_INTEGER }],
    );
    refusal(
      () =>
        f.r.correctAdjustmentAmount(
          input(f.r, false, {
            adjustmentIndex: 0,
            amount: 2,
            declaredTotal: Number.MAX_SAFE_INTEGER,
            affectedCaseFacts: [
              { bundleId: 'one', expectedCaseVersion: null, caseFact: null },
            ],
          }),
        ),
      'ADJUSTMENT_INVALID',
    );
  });
  it('copies mutable reflected Case entries and revalidates changed state', () => {
    const f = fixture(false),
      c = rejected(initialCase(f.a)),
      r = select(f.receipt, 'bundle-a', c),
      u = r.correctAdjustmentAmount(
        input(r, false, { affectedCaseFacts: [caseEntry('bundle-a', c)] }),
      ),
      h = change(u),
      mutable = caseEntry('bundle-a', c),
      copy = { ...h, affectedCaseFacts: [mutable] },
      e = reflect(f.a, copy);
    mutable.caseFact.lifecycle = 'Archived';
    expect(e.receiptAdjustmentAmountCorrections[0].caseFact?.lifecycle).toBe(
      'Rejected',
    );
    expect(() => reflect(f.a, copy)).toThrow(ExpenseInvariantViolation);
  });
});

describe('AJ4: reflected selected Case guard and other roots', () => {
  it.each(['caseId', 'groupId', 'expenseId', 'version'])(
    'rechecks own Case %s',
    (key) => {
      const f = fixture(false),
        c = rejected(initialCase(f.a)),
        r = select(f.receipt, 'bundle-a', c),
        u = r.correctAdjustmentAmount(
          input(r, false, { affectedCaseFacts: [caseEntry('bundle-a', c)] }),
        ),
        h = change(u),
        entry = caseEntry('bundle-a', c),
        fact = { ...entry.caseFact, [key]: key === 'version' ? 0 : 'invalid' };
      expect(() =>
        reflect(f.a, {
          ...h,
          affectedCaseFacts: [{ ...entry, caseFact: fact }],
        }),
      ).toThrow(ExpenseInvariantViolation);
    },
  );
  it('keeps original Correction history through later financial changes', () => {
    const f = fixture(false),
      a = f.a.correctAmount({
        expectedExpenseVersion: 1,
        expectedCaseVersion: 2,
        actorSubject: 'owner',
        currentOwnerSubject: 'owner',
        correctedAt: at(),
        reason: 'prior correction',
        amount: 290,
        caseFact: {
          caseId: uuid(80),
          groupId,
          expenseId: 'expense-a',
          version: 2,
          lifecycle: 'Rejected',
          allTargetsReleased: false,
        },
      }),
      r = f.receipt.correctAdjustmentAmount(input(f.receipt, false)),
      e = reflect(a, change(r));
    expect(e.corrections).toBe(a.corrections);
    expect(e.initialSnapshot).toBe(f.a.initialSnapshot);
  });
});
