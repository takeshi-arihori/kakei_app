import { describe, expect, it } from 'vitest';
import { Receipt } from './receipt.js';
import { GroupExpense } from './group-expense.js';
import { ReceiptInvariantViolation } from './receipt-invariant-violation.js';
import { ExpenseInvariantViolation } from './expense-invariant-violation.js';
import type {
  CorrectReceiptItemAmount,
  ReceiptItemAmountCorrectedChange,
} from './receipt-item-amount-correction.js';
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
  patch: Partial<CorrectReceiptItemAmount> = {},
): CorrectReceiptItemAmount => ({
  expectedVersion: r.version,
  actorSubject: 'uploader',
  currentOwnerSubject: 'owner',
  groupId,
  correctedAt: at(),
  reason: 'Correct original amount',
  itemId: 'a',
  amount: 200,
  declaredTotal: wide ? 1189 : 1090,
  affectedCaseFacts: (wide ? ['bundle-a', 'bundle-b'] : ['bundle-a']).map(
    (bundleId) => ({ bundleId, expectedCaseVersion: null, caseFact: null }),
  ),
  ...patch,
});
const change = (r: Receipt): ReceiptItemAmountCorrectedChange => {
  const c = r.changes.at(-1);
  if (c?.action !== 'ItemAmountCorrected') throw Error('Correction expected');
  return c;
};
const reflect = (
  e: GroupExpense,
  c: ReceiptItemAmountCorrectedChange,
  expectedExpenseVersion = e.version,
  expectedReceiptVersion = c.previousVersion,
) =>
  e.reflectReceiptItemAmountCorrection({
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

describe('IA-P/O/I: original Item correction and all financial effects', () => {
  it.each(['uploader', 'owner'])(
    'permits %s and rebalances every affected Pair without changing identities',
    (actorSubject) => {
      const f = fixture(),
        before = confirmed(f.receipt),
        oldA = f.a.snapshot(),
        oldB = f.b.snapshot();
      const r = f.receipt.correctItemAmount(
          input(f.receipt, true, { actorSubject }),
        ),
        s = confirmed(r),
        c = change(r);
      expect(s.items.map((i) => [i.originalAmount, i.adjustedAmount])).toEqual([
        [200, 208],
        [200, 218],
        [300, 327],
        [400, 436],
      ]);
      expect(s.declaredTotal).toBe(1189);
      expect(s.items.reduce((n, i) => n + i.adjustedAmount, 0)).toBe(1189);
      expect(s.bundles).toBe(before.bundles);
      expect(s.adjustments).toBe(before.adjustments);
      expect(s.bundleSnapshotSelections).toBe(before.bundleSnapshotSelections);
      expect(s.items.map((i) => [i.id, i.name, i.categoryId.value])).toEqual(
        before.items.map((i) => [i.id, i.name, i.categoryId.value]),
      );
      expect(c).toMatchObject({
        actorSubject,
        at: '2026-10-06T00:00:00.000Z',
        reason: 'Correct original amount',
        previousVersion: 4,
        version: 5,
        itemId: 'a',
      });
      expect(c.affectedCaseFacts.map((a) => a.bundleId)).toEqual([
        'bundle-a',
        'bundle-b',
      ]);
      const a = reflect(f.a, c),
        b = reflect(f.b, c);
      expect(a.snapshot().total.amount).toBe(426);
      expect(b.snapshot().total.amount).toBe(327);
      expect(a.snapshot().allocations.map((x) => x.burden.amount)).toEqual([
        213, 213,
      ]);
      expect(b.snapshot().allocations.map((x) => x.burden.amount)).toEqual([
        164, 163,
      ]);
      for (const [old, current] of [
        [f.a, a],
        [f.b, b],
      ]) {
        expect(current.id).toBe(old.id);
        expect(current.initialSnapshot).toBe(old.initialSnapshot);
        expect(current.version).toBe(2);
        expect(current.snapshot().payerParticipantId).toBe(
          old.snapshot().payerParticipantId,
        );
        expect(
          current
            .snapshot()
            .allocations.map((x) => [
              x.participantId,
              x.joinOrder,
              x.percentage,
            ]),
        ).toEqual(
          old
            .snapshot()
            .allocations.map((x) => [
              x.participantId,
              x.joinOrder,
              x.percentage,
            ]),
        );
        expect(current.receiptItemAmountCorrections[0]).toMatchObject({
          actorSubject,
          reason: c.reason,
          itemId: 'a',
          receiptId: 'receipt',
          previousReceiptVersion: 4,
          receiptVersion: 5,
        });
      }
      expect(f.receipt.snapshot()).toBe(before);
      expect(f.a.snapshot()).toBe(oldA);
      expect(f.b.snapshot()).toBe(oldB);
      expect(r.hasCompleteBundleRegistration()).toBe(false);
    },
  );
  it('preserves a real Rejected Revision and feeds corrected facts to the next Revision', () => {
    const f = fixture(false),
      oldCase = initialCase(f.a),
      c = rejected(oldCase),
      r = select(f.receipt, 'bundle-a', oldCase);
    const corrected = r.correctItemAmount(
        input(r, false, { affectedCaseFacts: [caseEntry('bundle-a', c)] }),
      ),
      e = reflect(f.a, change(corrected));
    expect(e.snapshot().total.amount).toBe(390);
    expect(c.snapshot.content.expenses[0].amount).toBe(290n);
    expect(confirmed(corrected).bundleSnapshotSelections).toBe(
      confirmed(r).bundleSnapshotSelections,
    );
    expect(() =>
      corrected.bundleEditingFacts({
        expectedVersion: corrected.version,
        actorSubject: 'uploader',
        bundleId: 'bundle-a',
      }),
    ).toThrow(ReceiptInvariantViolation);
    const revised = c.resubmit({
      expectedVersion: c.version,
      applicant: { actorSubject: 'uploader', participantId: 'payer' },
      currentSnapshotId: c.snapshot.snapshotId,
      currentOwnerSubject: 'owner',
      snapshotId: uuid(99),
      submittedAt: at(),
      instructionIds: [uuid(100)],
      content: SettlementSnapshotContent.from(groupId, [
        {
          expenseId: e.id.value,
          groupId,
          amount: BigInt(e.snapshot().total.amount),
          payerParticipantId: e.snapshot().payerParticipantId,
          allocations: e.snapshot().allocations.map((a) => ({
            ...a,
            burden: BigInt(a.burden.amount),
          })),
        },
      ]),
    });
    expect(revised.snapshot.content.expenses[0].amount).toBe(390n);
    expect(c.snapshot.content.expenses[0].amount).toBe(290n);
  });
  it('allows an unaffected Bundle to remain AwaitingApproval without granting its state to an affected Bundle', () => {
    const f = fixture(false),
      c = initialCase(f.b),
      r = select(f.receipt, 'bundle-b', c);
    expect(r.correctItemAmount(input(r, false)).version).toBe(r.version + 1);
  });
  it('rejects spillover into an AwaitingApproval Bundle even when the target is unselected', () => {
    const f = fixture(),
      c = initialCase(f.b),
      r = select(f.receipt, 'bundle-b', c);
    refusal(
      () =>
        r.correctItemAmount(
          input(r, true, {
            affectedCaseFacts: [
              {
                bundleId: 'bundle-a',
                expectedCaseVersion: null,
                caseFact: null,
              },
              caseEntry('bundle-b', c),
            ],
          }),
        ),
      'ITEM_AMOUNT_NOT_CORRECTABLE',
    );
    expect(f.b.version).toBe(1);
    expect(confirmed(r).items[0].originalAmount).toBe(100);
  });
  it('permits every affected Bundle when its own actual Case is Rejected', () => {
    const f = fixture(),
      ca = rejected(initialCase(f.a, 10)),
      cb = rejected(initialCase(f.b, 20));
    const r = select(select(f.receipt, 'bundle-a', ca), 'bundle-b', cb);
    const corrected = r.correctItemAmount(
      input(r, true, {
        affectedCaseFacts: [
          caseEntry('bundle-b', cb),
          caseEntry('bundle-a', ca),
        ],
      }),
    );
    expect(reflect(f.a, change(corrected)).snapshot().total.amount).toBe(426);
    expect(reflect(f.b, change(corrected)).snapshot().total.amount).toBe(327);
  });
  it('checks the current related Case independently from the first-selection Case ID', () => {
    const f = fixture(false),
      first = initialCase(f.a, 10),
      current = rejected(initialCase(f.a, 30)),
      r = select(f.receipt, 'bundle-a', first);
    const corrected = r.correctItemAmount(
      input(r, false, { affectedCaseFacts: [caseEntry('bundle-a', current)] }),
    );
    expect(change(corrected).affectedCaseFacts[0].caseFact?.caseId).toBe(
      uuid(30),
    );
    expect(confirmed(corrected).bundleSnapshotSelections[0].caseId).toBe(
      uuid(10),
    );
  });
  it('copies mutable time/Case input and freezes all new financial history', () => {
    const f = fixture(false),
      c = rejected(initialCase(f.a)),
      r = select(f.receipt, 'bundle-a', c),
      entry = caseEntry('bundle-a', c),
      time = at();
    const corrected = r.correctItemAmount(
        input(r, false, { correctedAt: time, affectedCaseFacts: [entry] }),
      ),
      history = change(corrected),
      e = reflect(f.a, history);
    time.setUTCFullYear(2040);
    entry.caseFact.lifecycle = 'Archived';
    entry.caseFact.version = 100;
    expect(history.at).toBe('2026-10-06T00:00:00.000Z');
    expect(history.affectedCaseFacts[0].caseFact?.lifecycle).toBe('Rejected');
    expect(Object.isFrozen(history.affectedCaseFacts)).toBe(true);
    expect(Object.isFrozen(history.affectedCaseFacts[0].caseFact)).toBe(true);
    expect(() => {
      Reflect.set(confirmed(corrected).items[0], 'originalAmount', 999);
    }).not.toThrow();
    expect(confirmed(corrected).items[0].originalAmount).toBe(200);
    expect(Object.isFrozen(e.receiptItemAmountCorrections[0])).toBe(true);
  });
  it('keeps Category and financial histories through later Item movement and split changes', () => {
    const f = fixture(false),
      category = f.receipt.correctItemCategory({
        expectedVersion: 4,
        actorSubject: 'owner',
        currentOwnerSubject: 'owner',
        groupId,
        correctedAt: at(),
        itemId: 'a',
        categoryId: 'tools',
        expectedCaseVersion: null,
        caseFact: null,
      });
    const corrected = category.correctItemAmount(input(category, false)),
      a = reflect(f.a, change(corrected));
    const beforeFact = corrected.bundleEditingFacts({
      expectedVersion: corrected.version,
      actorSubject: 'uploader',
      bundleId: 'bundle-a',
    });
    const split = a.changeBundleSplit({
      expectedExpenseVersion: a.version,
      expectedReceiptVersion: corrected.version,
      bundleFact: beforeFact,
      actorSubject: 'uploader',
      changedAt: at(),
      payerParticipantId: 'other',
      percentages: [
        { participantId: 'payer', percentage: 80 },
        { participantId: 'other', percentage: 20 },
      ],
    });
    expect(split.receiptItemAmountCorrections).toBe(
      a.receiptItemAmountCorrections,
    );
    const moved = corrected.moveBundleItems({
      expectedVersion: corrected.version,
      actorSubject: 'uploader',
      movedAt: at(),
      fromBundleId: 'bundle-a',
      toBundleId: 'bundle-b',
      itemIds: ['b'],
    });
    const afterFact = moved.bundleEditingFacts({
      expectedVersion: moved.version,
      actorSubject: 'uploader',
      bundleId: 'bundle-a',
    });
    const movedA = split.reflectBundleItemMovement({
      expectedExpenseVersion: split.version,
      expectedReceiptVersion: corrected.version,
      beforeBundleFact: beforeFact,
      afterBundleFact: afterFact,
      actorSubject: 'uploader',
      changedAt: at(),
    });
    expect(movedA.receiptItemAmountCorrections).toBe(
      a.receiptItemAmountCorrections,
    );
    expect(movedA.bundleSplitChanges).toBe(split.bundleSplitChanges);
    expect(moved.changes.map((c) => c.action)).toContain(
      'ItemCategoryCorrected',
    );
    expect(moved.changes.map((c) => c.action)).toContain('ItemAmountCorrected');
  });
  it('preserves financial history through later financial corrections', () => {
    const f = fixture(false),
      first = f.receipt.correctItemAmount(input(f.receipt, false)),
      a = reflect(f.a, change(first));
    const second = first.correctItemAmount(
        input(first, false, { amount: 201, declaredTotal: 1091 }),
      ),
      next = reflect(a, change(second));
    expect(next.receiptItemAmountCorrections).toHaveLength(2);
    expect(next.receiptItemAmountCorrections[0]).toBe(
      a.receiptItemAmountCorrections[0],
    );
    expect(next.initialSnapshot.total.amount).toBe(290);
    expect(next.snapshot().total.amount).toBe(391);
  });
});

describe('IA-F: rejected inputs preserve old Roots', () => {
  const rows: [Partial<CorrectReceiptItemAmount>, string][] = [
    [{ expectedVersion: 3 }, 'VERSION_CONFLICT'],
    [{ expectedVersion: NaN }, 'VERSION_CONFLICT'],
    [{ actorSubject: 'other' }, 'ACTOR_NOT_UPLOADER_OR_OWNER'],
    [{ actorSubject: '' }, 'ACTOR_REFERENCE_INVALID'],
    [{ currentOwnerSubject: ' ' }, 'ACTOR_REFERENCE_INVALID'],
    [{ groupId: uuid(2) }, 'BUNDLE_GROUP_MISMATCH'],
    [{ groupId: '' }, 'GROUP_REFERENCE_INVALID'],
    [{ itemId: 'unknown' }, 'ITEM_NOT_FOUND'],
    [{ itemId: 'd' }, 'ITEM_NOT_BUNDLED'],
    [{ amount: -1 }, 'ADJUSTMENT_INVALID'],
    [{ amount: 0.1 }, 'ADJUSTMENT_INVALID'],
    [{ amount: NaN }, 'ADJUSTMENT_INVALID'],
    [{ amount: Number.MAX_SAFE_INTEGER + 1 }, 'ADJUSTMENT_INVALID'],
    [{ amount: 0, declaredTotal: 890 }, 'ADJUSTMENT_INVALID'],
    [{ declaredTotal: NaN }, 'TOTAL_INVALID'],
    [{ declaredTotal: -1 }, 'TOTAL_INVALID'],
    [{ declaredTotal: 1190 }, 'RECEIPT_TOTAL_MISMATCH'],
    [{ reason: ' ' }, 'CORRECTION_REASON_EMPTY'],
    [{ correctedAt: new Date(NaN) }, 'UTC_INSTANT_INVALID'],
    [{ affectedCaseFacts: [] }, 'AFFECTED_CASE_FACTS_MISMATCH'],
    [
      {
        affectedCaseFacts: [
          { bundleId: 'bundle-a', expectedCaseVersion: null, caseFact: null },
        ],
      },
      'AFFECTED_CASE_FACTS_MISMATCH',
    ],
    [
      {
        affectedCaseFacts: [
          { bundleId: 'bundle-a', expectedCaseVersion: null, caseFact: null },
          { bundleId: 'bundle-a', expectedCaseVersion: null, caseFact: null },
        ],
      },
      'AFFECTED_CASE_FACTS_MISMATCH',
    ],
  ];
  it.each(rows)('rejects %j with %s', (patch, code) => {
    const f = fixture(),
      before = f.receipt.snapshot();
    refusal(
      () => f.receipt.correctItemAmount(input(f.receipt, true, patch)),
      code,
    );
    expect(f.receipt.snapshot()).toBe(before);
    expect(f.a.version).toBe(1);
  });
  it('refuses Draft before interpreting correction', () => {
    const f = fixture();
    refusal(
      () => f.draft.correctItemAmount(input(f.draft)),
      'RECEIPT_NOT_CONFIRMED',
    );
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
  ])('rejects target Case %s', (lifecycle) => {
    const f = fixture(false),
      c = initialCase(f.a),
      r = select(f.receipt, 'bundle-a', c),
      entry = caseEntry('bundle-a', c);
    entry.caseFact.lifecycle = lifecycle;
    refusal(
      () =>
        r.correctItemAmount(input(r, false, { affectedCaseFacts: [entry] })),
      'ITEM_AMOUNT_NOT_CORRECTABLE',
    );
  });
  it.each(['group', 'expense', 'case', 'version', 'expectedVersion'])(
    'rejects affected Case %s mismatch',
    (field) => {
      const f = fixture(false),
        c = rejected(initialCase(f.a)),
        r = select(f.receipt, 'bundle-a', c),
        entry = caseEntry('bundle-a', c);
      if (field === 'group') entry.caseFact.groupId = uuid(2);
      if (field === 'expense') entry.caseFact.expenseId = 'expense-b';
      if (field === 'case') entry.caseFact.caseId = 'INVALID';
      if (field === 'version') entry.caseFact.version = 0;
      if (field === 'expectedVersion') entry.expectedCaseVersion = 99;
      refusal(
        () =>
          r.correctItemAmount(input(r, false, { affectedCaseFacts: [entry] })),
        field === 'case'
          ? 'CASE_REFERENCE_INVALID'
          : field === 'version' || field === 'expectedVersion'
            ? 'CASE_VERSION_CONFLICT'
            : 'CASE_FACT_MISMATCH',
      );
    },
  );
  it('does not accept a selected target without its Case or an unselected target with borrowed facts', () => {
    const f = fixture(false),
      c = rejected(initialCase(f.a)),
      r = select(f.receipt, 'bundle-a', c);
    refusal(() => r.correctItemAmount(input(r, false)), 'CASE_FACT_REQUIRED');
    refusal(
      () =>
        f.receipt.correctItemAmount(
          input(f.receipt, false, {
            affectedCaseFacts: [caseEntry('bundle-a', c)],
          }),
        ),
      'CASE_FACT_UNEXPECTED',
    );
  });
  it('rejects stale replay after correction without mutating history', () => {
    const f = fixture(false),
      command = input(f.receipt, false),
      r = f.receipt.correctItemAmount(command);
    refusal(() => r.correctItemAmount(command), 'VERSION_CONFLICT');
    expect(r.changes).toHaveLength(f.receipt.changes.length + 1);
  });
  it('validates no-op qualification and returns the same Root without history', () => {
    const f = fixture(),
      command = input(f.receipt, true, {
        amount: 100,
        declaredTotal: 1089,
        affectedCaseFacts: [
          { bundleId: 'bundle-a', expectedCaseVersion: null, caseFact: null },
        ],
      });
    expect(f.receipt.correctItemAmount(command)).toBe(f.receipt);
    refusal(
      () => f.receipt.correctItemAmount({ ...command, actorSubject: 'other' }),
      'ACTOR_NOT_UPLOADER_OR_OWNER',
    );
    refusal(
      () => f.receipt.correctItemAmount({ ...command, declaredTotal: 1088 }),
      'RECEIPT_TOTAL_MISMATCH',
    );
    refusal(
      () => f.receipt.correctItemAmount({ ...command, reason: ' ' }),
      'CORRECTION_REASON_EMPTY',
    );
  });
  it.each([
    'expenseVersion',
    'receiptVersion',
    'oldAmount',
    'uploader',
    'pair',
    'group',
    'actor',
    'reason',
    'at',
  ])('refuses Expense reflection with %s mismatch', (field) => {
    const f = fixture(false),
      r = f.receipt.correctItemAmount(input(f.receipt, false)),
      c = change(r);
    let e = f.a,
      expectedExpenseVersion = e.version,
      expectedReceiptVersion = c.previousVersion,
      altered = c;
    if (field === 'expenseVersion') expectedExpenseVersion = 9;
    if (field === 'receiptVersion') expectedReceiptVersion = 9;
    if (field === 'oldAmount')
      e = GroupExpense.register({
        id: 'expense-a',
        groupId,
        sourceOwnerSubject: 'uploader',
        occurredOn: '2026-10-01',
        amount: 291,
        payerParticipantId: 'payer',
        participants: [
          { participantId: 'payer', joinOrder: 2, percentage: 50 },
          { participantId: 'other', joinOrder: 7, percentage: 50 },
        ],
      });
    if (field === 'uploader')
      altered = { ...c, before: { ...c.before, uploaderSubject: 'other' } };
    if (field === 'pair')
      altered = {
        ...c,
        after: {
          ...c.after,
          bundles: c.after.bundles.map((b) =>
            b.id.value === 'bundle-a' ? { ...b, itemIds: ['a'] } : b,
          ),
        },
      };
    if (field === 'group') altered = { ...c, groupId: uuid(2) };
    if (field === 'actor') altered = { ...c, actorSubject: 'other' };
    if (field === 'reason') altered = { ...c, reason: '' };
    if (field === 'at') altered = { ...c, at: 'invalid' };
    expect(() =>
      reflect(e, altered, expectedExpenseVersion, expectedReceiptVersion),
    ).toThrow(ExpenseInvariantViolation);
    expect(e.version).toBe(1);
  });
});

describe('IA-boundary: exact financial scope and version bounds', () => {
  it('tracks an affected same-total Bundle when tax and discount allocations change', () => {
    const items = [
      { id: 'a', name: 'Tea', amount: 100, categoryId: 'food' },
      { id: 'b', name: 'Cup', amount: 100, categoryId: 'food' },
    ];
    const adjustments: ReceiptAdjustmentInput[] = [
      { kind: 'Tax', amount: 10, target: { scope: 'Receipt' } },
      { kind: 'Discount', amount: -10, target: { scope: 'Receipt' } },
    ];
    const draft = Receipt.createDraft({
      id: 'balanced',
      uploaderSubject: 'uploader',
      occurredOn: '2026-10-01',
      declaredTotal: 200,
      items,
      adjustments,
    });
    const make = (id: string) =>
      GroupExpense.register({
        id,
        groupId,
        sourceOwnerSubject: 'uploader',
        occurredOn: '2026-10-01',
        amount: 100,
        payerParticipantId: 'payer',
        participants: [
          { participantId: 'payer', joinOrder: 1, percentage: 100 },
        ],
      });
    const a = make('expense-a'),
      b = make('expense-b');
    const r = draft
      .confirm({
        expectedVersion: 1,
        actorSubject: 'uploader',
        confirmedAt: at(),
        occurredOn: '2026-10-01',
        declaredTotal: 200,
        items,
        adjustments,
      })
      .registerBundle({
        expectedVersion: 2,
        actorSubject: 'uploader',
        registeredAt: at(),
        bundleId: 'bundle-a',
        itemIds: ['a'],
        expense: a,
      })
      .registerBundle({
        expectedVersion: 3,
        actorSubject: 'uploader',
        registeredAt: at(),
        bundleId: 'bundle-b',
        itemIds: ['b'],
        expense: b,
      });
    const corrected = r.correctItemAmount(
        input(r, true, { declaredTotal: 300 }),
      ),
      reflected = reflect(b, change(corrected));
    expect(reflected.snapshot().total.amount).toBe(100);
    expect(reflected.version).toBe(2);
    expect(reflected.receiptItemAmountCorrections).toHaveLength(1);
    expect(confirmed(corrected).allocations.map((a) => a.amounts)).toEqual([
      [7, 3],
      [-7, -3],
    ]);
    expect(r.hasCompleteBundleRegistration()).toBe(true);
    expect(corrected.hasCompleteBundleRegistration()).toBe(true);
  });
  it('rejects a zero Receipt-wide allocation basis without partial results', () => {
    const items = [{ id: 'a', name: 'Tea', amount: 100, categoryId: 'food' }],
      adjustments: ReceiptAdjustmentInput[] = [
        { kind: 'Tax', amount: 1, target: { scope: 'Receipt' } },
      ];
    const e = GroupExpense.register({
      id: 'expense-a',
      groupId,
      sourceOwnerSubject: 'uploader',
      occurredOn: '2026-10-01',
      amount: 101,
      payerParticipantId: 'payer',
      participants: [{ participantId: 'payer', joinOrder: 1, percentage: 100 }],
    });
    const r = Receipt.createDraft({
      id: 'single',
      uploaderSubject: 'uploader',
      occurredOn: '2026-10-01',
      declaredTotal: 101,
      items,
      adjustments,
    })
      .confirm({
        expectedVersion: 1,
        actorSubject: 'uploader',
        confirmedAt: at(),
        occurredOn: '2026-10-01',
        declaredTotal: 101,
        items,
        adjustments,
      })
      .registerBundle({
        expectedVersion: 2,
        actorSubject: 'uploader',
        registeredAt: at(),
        bundleId: 'bundle-a',
        itemIds: ['a'],
        expense: e,
      });
    refusal(
      () =>
        r.correctItemAmount(input(r, false, { amount: 0, declaredTotal: 1 })),
      'ADJUSTMENT_INVALID',
    );
    expect(confirmed(r).declaredTotal).toBe(101);
  });
  it('accepts zero adjusted Item amounts without removing Item or Participant identities', () => {
    const f = fixture(false),
      r = f.receipt.correctItemAmount(
        input(f.receipt, false, { amount: 10, declaredTotal: 900 }),
      ),
      e = reflect(f.a, change(r));
    expect(confirmed(r).items[0].adjustedAmount).toBe(0);
    expect(e.snapshot().total.amount).toBe(200);
    expect(e.snapshot().allocations.map((a) => a.participantId)).toEqual([
      'payer',
      'other',
    ]);
  });
  it('rejects total unsafe overflow and Receipt version overflow but permits a valid same-value no-op', () => {
    const f = fixture(false);
    refusal(
      () =>
        f.receipt.correctItemAmount(
          input(f.receipt, false, {
            amount: Number.MAX_SAFE_INTEGER,
            declaredTotal: Number.MAX_SAFE_INTEGER,
          }),
        ),
      'RECEIPT_TOTAL_MISMATCH',
    );
    const r: unknown = Reflect.construct(Receipt, [
      f.receipt.snapshot(),
      Number.MAX_SAFE_INTEGER,
      f.receipt.changes,
    ]);
    if (!(r instanceof Receipt)) throw Error('Receipt expected');
    refusal(() => r.correctItemAmount(input(r, false)), 'VERSION_OVERFLOW');
    expect(
      r.correctItemAmount(input(r, false, { amount: 100, declaredTotal: 990 })),
    ).toBe(r);
  });
  it('rejects Expense version overflow after all Pair checks', () => {
    const f = fixture(false),
      r = f.receipt.correctItemAmount(input(f.receipt, false)),
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
    expect(e.snapshot().total.amount).toBe(290);
  });
  it('preserves both existing amount history and Receipt history through further amount operations', () => {
    const f = fixture(false),
      r = f.receipt.correctItemAmount(input(f.receipt, false)),
      a = reflect(f.a, change(r));
    const corrected = a.correctAmount({
      expectedExpenseVersion: a.version,
      expectedCaseVersion: 2,
      actorSubject: 'owner',
      currentOwnerSubject: 'owner',
      correctedAt: at(),
      reason: 'amount contract regression',
      amount: 390,
      caseFact: {
        caseId: uuid(90),
        groupId,
        expenseId: a.id.value,
        version: 2,
        lifecycle: 'Rejected',
        allTargetsReleased: false,
      },
    });
    expect(corrected.receiptItemAmountCorrections).toBe(
      a.receiptItemAmountCorrections,
    );
    const next = r.correctItemAmount(
        input(r, false, { amount: 201, declaredTotal: 1091 }),
      ),
      reflected = reflect(corrected, change(next));
    expect(reflected.corrections).toBe(corrected.corrections);
    expect(reflected.receiptItemAmountCorrections).toHaveLength(2);
  });
  it('checks own Case facts again during Expense reflection and copies mutable input Case records', () => {
    const f = fixture(false),
      c = rejected(initialCase(f.a)),
      r = select(f.receipt, 'bundle-a', c),
      corrected = r.correctItemAmount(
        input(r, false, { affectedCaseFacts: [caseEntry('bundle-a', c)] }),
      ),
      history = change(corrected);
    const mutable = caseEntry('bundle-a', c),
      copy = { ...history, affectedCaseFacts: [mutable] },
      e = reflect(f.a, copy);
    mutable.caseFact.lifecycle = 'Archived';
    mutable.caseFact.version = 90;
    expect(e.receiptItemAmountCorrections[0].caseFact?.lifecycle).toBe(
      'Rejected',
    );
    expect(e.receiptItemAmountCorrections[0].caseFact?.version).toBe(c.version);
    expect(() =>
      reflect(f.a, { ...history, affectedCaseFacts: [mutable] }),
    ).toThrow(ExpenseInvariantViolation);
  });
  it('rejects an unrelated Expense and an extra influence entry instead of updating another Pair', () => {
    const f = fixture(false),
      r = f.receipt.correctItemAmount(input(f.receipt, false)),
      history = change(r);
    expect(() => reflect(f.b, history)).toThrow(ExpenseInvariantViolation);
    refusal(
      () =>
        f.receipt.correctItemAmount(
          input(f.receipt, false, {
            affectedCaseFacts: [
              {
                bundleId: 'bundle-a',
                expectedCaseVersion: null,
                caseFact: null,
              },
              {
                bundleId: 'bundle-b',
                expectedCaseVersion: null,
                caseFact: null,
              },
            ],
          }),
        ),
      'AFFECTED_CASE_FACTS_MISMATCH',
    );
  });
});
