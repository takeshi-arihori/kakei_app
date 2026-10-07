import { describe, expect, it } from 'vitest';

import {
  Receipt,
  type ReceiptDraftInput,
  type ConfirmReceipt,
} from './receipt.js';
import type { EditReceiptDraft } from './receipt-draft-edit.js';
import { ReceiptInvariantViolation } from './receipt-invariant-violation.js';
import { GroupExpense } from './group-expense.js';

const source = (patch: Partial<ReceiptDraftInput> = {}): ReceiptDraftInput => ({
  id: 'receipt-draft',
  uploaderSubject: 'uploader',
  occurredOn: '2026-10-01',
  declaredTotal: 350,
  items: [
    { id: 'a', name: 'Tea', amount: 100, categoryId: 'food' },
    { id: 'b', name: 'Cup', amount: 200, categoryId: 'tools' },
  ],
  adjustments: [{ kind: 'Tax', amount: 50, target: { scope: 'Receipt' } }],
  ...patch,
});
const draft = (patch: Partial<ReceiptDraftInput> = {}) =>
  Receipt.createDraft(source(patch));
const facts = (root: Receipt) => {
  const value = root.snapshot();
  if (value.status !== 'Draft') throw Error('Draft expected');
  return value;
};
const unchanged = (root: Receipt): EditReceiptDraft => {
  const value = facts(root);
  return {
    expectedVersion: root.version,
    actorSubject: 'uploader',
    editedAt: new Date('2026-10-07T09:00:00+09:00'),
    occurredOn: value.occurredOn,
    declaredTotal: value.declaredTotal,
    items: value.items.map((item) => ({ ...item })),
    adjustments: value.adjustments.map((value) => ({
      ...value,
      target: { ...value.target },
    })),
  };
};
const edit = (
  root: Receipt,
  patch: Partial<EditReceiptDraft> = {},
): EditReceiptDraft => {
  const input = unchanged(root);
  return {
    ...input,
    items: input.items.map((item, index) =>
      index === 0 ? { ...item, amount: item.amount + 10 } : item,
    ),
    declaredTotal: input.declaredTotal + 10,
    ...patch,
  };
};
const confirmation = (
  root: Receipt,
  patch: Partial<ConfirmReceipt> = {},
): ConfirmReceipt => {
  const value = facts(root);
  return {
    expectedVersion: root.version,
    actorSubject: 'uploader',
    confirmedAt: new Date('2026-10-07T01:00:00Z'),
    occurredOn: value.occurredOn ?? '',
    declaredTotal: value.declaredTotal,
    items: value.items,
    adjustments: value.adjustments,
    ...patch,
  };
};
const failure = (action: () => unknown, code: string) => {
  try {
    action();
    throw Error('Domain rejection expected');
  } catch (error) {
    expect(error).toBeInstanceOf(ReceiptInvariantViolation);
    expect(error).toMatchObject({
      code,
      message: 'Receipt invariant violated',
    });
  }
};

describe('DE1: Uploaderだけが確定前の候補を編集する', () => {
  it('同じReceiptとUploaderのDraftを維持し、版と前後履歴を一つ進める', () => {
    const old = draft(),
      input = edit(old),
      updated = old.editDraft(input);
    expect(updated.id).toBe(old.id);
    expect(updated.version).toBe(2);
    expect(facts(updated)).toMatchObject({
      uploaderSubject: 'uploader',
      declaredTotal: 360,
      status: 'Draft',
    });
    expect(facts(updated).items.map((item) => item.amount)).toEqual([110, 200]);
    expect(updated.changes).toHaveLength(1);
    expect(updated.changes[0]).toMatchObject({
      action: 'DraftEdited',
      actorSubject: 'uploader',
      at: '2026-10-07T00:00:00.000Z',
      previousVersion: 1,
      version: 2,
      before: old.snapshot(),
      after: updated.snapshot(),
    });
    expect(old.version).toBe(1);
    expect(facts(old).declaredTotal).toBe(350);
    expect(old.changes).toEqual([]);
  });
  it.each(['name', 'amount', 'categoryId'] as const)(
    'Itemの%s候補を単独修正できる',
    (key) => {
      const old = draft(),
        input = unchanged(old),
        item = { ...input.items[0], [key]: key === 'amount' ? 125 : 'Changed' };
      const updated = old.editDraft({
        ...input,
        items: [item, input.items[1]],
      });
      expect(facts(updated).items[0][key]).toBe(item[key]);
      expect(facts(updated).items[1]).toEqual(facts(old).items[1]);
    },
  );
  it.each(['occurredOn', 'declaredTotal'] as const)(
    '%sだけを編集中に修正できる',
    (key) => {
      const old = draft(),
        input = unchanged(old),
        value = key === 'occurredOn' ? '2026-10-02' : 400;
      const updated = old.editDraft({ ...input, [key]: value });
      expect(facts(updated)[key]).toBe(value);
      expect(facts(updated).items).toEqual(facts(old).items);
    },
  );
  it.each(['追加', '削除', '記載順変更'])(
    'Item候補の%sを未確定のまま保持する',
    (operation) => {
      const old = draft(),
        input = unchanged(old);
      const items =
        operation === '追加'
          ? [
              ...input.items,
              { id: 'c', name: 'Paper', amount: 300, categoryId: 'tools' },
            ]
          : operation === '削除'
            ? input.items.slice(1)
            : [...input.items].reverse();
      const updated = old.editDraft({ ...input, items });
      expect(facts(updated).items).toEqual(items);
      expect(updated.version).toBe(2);
      expect(updated.hasCompleteBundleRegistration()).toBe(false);
    },
  );
  it.each(['Tax', 'Shipping', 'Discount', 'Point'] as const)(
    '%s Adjustmentの種別・額・Item対象を候補として変更できる',
    (kind) => {
      const old = draft(),
        input = unchanged(old),
        adjustments = [
          {
            kind,
            amount: kind === 'Tax' || kind === 'Shipping' ? 20 : -20,
            target: { scope: 'Item' as const, itemId: 'b' },
          },
        ];
      const updated = old.editDraft({ ...input, adjustments });
      expect(facts(updated).adjustments).toEqual(adjustments);
    },
  );
  it.each(['追加', '削除', '順序変更'])(
    'Adjustment候補の%sを保持する',
    (operation) => {
      const values: ReceiptDraftInput['adjustments'] = [
        { kind: 'Tax', amount: 10, target: { scope: 'Receipt' } },
        {
          kind: 'Discount',
          amount: -5,
          target: { scope: 'Item', itemId: 'a' },
        },
      ];
      const old = draft({ adjustments: values }),
        input = unchanged(old);
      const adjustments =
        operation === '追加'
          ? [
              ...input.adjustments,
              {
                kind: 'Shipping' as const,
                amount: 20,
                target: { scope: 'Receipt' as const },
              },
            ]
          : operation === '削除'
            ? []
            : [...input.adjustments].reverse();
      const updated = old.editDraft({ ...input, adjustments });
      expect(facts(updated).adjustments).toEqual(adjustments);
    },
  );
});

describe('DE2: 拒否はDraftと既存履歴を変えない', () => {
  it.each(['owner', 'other-participant'])(
    'Uploaderでない%sへ編集を許可しない',
    (actorSubject) => {
      const old = draft();
      failure(
        () => old.editDraft(edit(old, { actorSubject })),
        'ACTOR_NOT_UPLOADER',
      );
      expect(old.version).toBe(1);
      expect(old.changes).toEqual([]);
    },
  );
  it.each(['', '   ', null, 1])(
    '不正Actor %sを固定codeで拒否する',
    (actorSubject) => {
      const old = draft();
      failure(
        () => old.editDraft({ ...edit(old), actorSubject } as EditReceiptDraft),
        'ACTOR_REFERENCE_INVALID',
      );
    },
  );
  it.each([0, 2, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    '現在版に一致しない%sを拒否する',
    (expectedVersion) => {
      const old = draft(),
        before = old.snapshot();
      failure(
        () => old.editDraft(edit(old, { expectedVersion })),
        'VERSION_CONFLICT',
      );
      expect(old.snapshot()).toBe(before);
    },
  );
  it.each([new Date('invalid'), null, '2026-10-07', {}, Infinity])(
    '不正時刻%sを拒否する',
    (editedAt) => {
      const old = draft();
      failure(
        () => old.editDraft({ ...edit(old), editedAt } as EditReceiptDraft),
        'UTC_INSTANT_INVALID',
      );
    },
  );
  it('確定後はDraft編集を拒否し、Confirmedと履歴を保持する', () => {
    const old = draft(),
      root = old.confirm(confirmation(old)),
      input = edit(old, { expectedVersion: root.version }),
      before = root.snapshot();
    failure(() => root.editDraft(input), 'RECEIPT_NOT_DRAFT');
    expect(root.snapshot()).toBe(before);
    expect(root.changes).toHaveLength(1);
  });
  it.each([
    { items: null },
    { items: {} },
    { items: [null] },
    { items: [{ id: {}, name: 'a', amount: 1, categoryId: 'food' }] },
    { items: [{ id: 'a', name: 1, amount: 1, categoryId: 'food' }] },
    { items: [{ id: 'a', name: 'a', amount: '1', categoryId: 'food' }] },
    { items: [{ id: 'a', name: 'a', amount: 1, categoryId: {} }] },
    { items: Array(1) },
    { adjustments: null },
    { adjustments: [null] },
    { adjustments: [1] },
    { adjustments: [{ kind: {}, amount: 10, target: { scope: 'Receipt' } }] },
    {
      adjustments: [
        { kind: 'Tax', amount: '10', target: { scope: 'Receipt' } },
      ],
    },
    { adjustments: [{ kind: 'Tax', amount: 10, target: null }] },
    {
      adjustments: [
        { kind: 'Tax', amount: 10, target: { scope: 'Item', itemId: null } },
      ],
    },
    {
      adjustments: [{ kind: 'Tax', amount: 10, target: { scope: 'Unknown' } }],
    },
    { adjustments: Array(1) },
    { declaredTotal: '350' },
    { occurredOn: {} },
  ])('候補の型構造が不正な%sを部分更新せず拒否する', (patch) => {
    const old = draft(),
      input = { ...edit(old), ...patch } as EditReceiptDraft,
      before = old.snapshot();
    failure(() => old.editDraft(input), 'RECEIPT_DRAFT_INVALID');
    expect(old.snapshot()).toBe(before);
    expect(old.version).toBe(1);
    expect(old.changes).toEqual([]);
  });
  it('新版のRootへ旧版の編集・確定を再適用しない', () => {
    const old = draft(),
      updated = old.editDraft(edit(old));
    failure(() => updated.editDraft(edit(old)), 'VERSION_CONFLICT');
    failure(() => updated.confirm(confirmation(old)), 'VERSION_CONFLICT');
    expect(updated.changes).toHaveLength(1);
  });
});

describe('DE3: 内容変更とno-op・深い不変性を区別する', () => {
  it('参照と時刻だけが変わる同値入力は版・履歴・編集時刻を増やさない', () => {
    const initial = draft(),
      root = initial.editDraft(edit(initial)),
      input = unchanged(root);
    input.editedAt.setUTCFullYear(2027);
    expect(root.editDraft(input)).toBe(root);
    expect(root.changes).toHaveLength(1);
    expect(root.changes[0].at).toBe('2026-10-07T00:00:00.000Z');
    expect(root.hasCompleteBundleRegistration()).toBe(false);
  });
  it.each([
    { actorSubject: 'owner', code: 'ACTOR_NOT_UPLOADER' },
    { expectedVersion: 0, code: 'VERSION_CONFLICT' },
    { editedAt: new Date('invalid'), code: 'UTC_INSTANT_INVALID' },
  ])('同値でも%sのguardを省略しない', ({ code, ...patch }) => {
    const root = draft();
    failure(() => root.editDraft({ ...unchanged(root), ...patch }), code);
  });
  it.each([NaN, Infinity, -Infinity, 1.5, -1, 0])(
    '未完成number %sを候補として保持し、同値判定できる',
    (amount) => {
      const root = draft(),
        input = edit(root, {
          declaredTotal: amount,
          items: [{ id: '', name: '', amount, categoryId: '' }],
          occurredOn: null,
          adjustments: [],
        });
      const updated = root.editDraft(input);
      expect(facts(updated).items[0].amount).toBe(amount);
      expect(updated.editDraft(unchanged(updated))).toBe(updated);
      expect(updated.snapshot().status).toBe('Draft');
    },
  );
  it('未完成日付・Category・符号・対象の意味検証を確定へ残す', () => {
    const root = draft(),
      input = edit(root, {
        occurredOn: 'not-a-date',
        declaredTotal: 999,
        items: [{ id: '', name: '', amount: -10, categoryId: '' }],
        adjustments: [
          {
            kind: 'Discount',
            amount: 10,
            target: { scope: 'Item', itemId: 'missing' },
          },
        ],
      });
    const updated = root.editDraft(input);
    expect(facts(updated).occurredOn).toBe('not-a-date');
    expect(facts(updated).declaredTotal).toBe(999);
    failure(
      () => updated.confirm(confirmation(updated)),
      'OCCURRED_ON_INVALID',
    );
  });
  it('候補を空にした編集中Draftも確定扱いしない', () => {
    const root = draft(),
      updated = root.editDraft(
        edit(root, {
          items: [],
          adjustments: [],
          occurredOn: null,
          declaredTotal: 0,
        }),
      );
    expect(facts(updated).items).toEqual([]);
    expect(updated.hasCompleteBundleRegistration()).toBe(false);
    failure(
      () => updated.confirm(confirmation(updated)),
      'OCCURRED_ON_INVALID',
    );
  });
  it('safe版上限で実変更だけ拒否し同値は成功する', () => {
    const initial = draft(),
      value: unknown = Reflect.construct(Receipt, [
        initial.snapshot(),
        Number.MAX_SAFE_INTEGER,
        initial.changes,
      ]);
    if (!(value instanceof Receipt)) throw Error('Receipt expected');
    expect(value.editDraft(unchanged(value))).toBe(value);
    failure(() => value.editDraft(edit(value)), 'VERSION_OVERFLOW');
    expect(value.version).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('Item・Adjustment・target・Dateの後続mutationから新旧Snapshotと履歴を隔離する', () => {
    const root = draft(),
      input = edit(root),
      updated = root.editDraft(input),
      snapshot = facts(updated),
      change = updated.changes[0];
    Reflect.set(input.items[0], 'amount', 999);
    Reflect.set(input.items, '0', { id: 'changed' });
    Reflect.set(input.adjustments[0].target, 'scope', 'Item');
    Reflect.set(input.adjustments[0], 'amount', 999);
    input.editedAt.setUTCFullYear(2030);
    expect(snapshot.items[0].amount).toBe(110);
    expect(snapshot.adjustments[0].amount).toBe(50);
    expect(snapshot.adjustments[0].target).toEqual({ scope: 'Receipt' });
    expect(change.at).toBe('2026-10-07T00:00:00.000Z');
    expect(facts(root).items[0].amount).toBe(100);
    for (const value of [
      updated,
      updated.changes,
      change,
      change.before,
      change.after,
      snapshot,
      snapshot.items,
      snapshot.items[0],
      snapshot.adjustments,
      snapshot.adjustments[0],
      snapshot.adjustments[0].target,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(snapshot.items[0], 'name', 'changed')).toBe(false);
    expect(Reflect.set(change, 'at', 'changed')).toBe(false);
  });
  it('連続編集は各前後Snapshotと全履歴を維持する', () => {
    const initial = draft(),
      first = initial.editDraft(edit(initial)),
      second = first.editDraft(edit(first));
    expect(second.version).toBe(3);
    expect(second.changes).toHaveLength(2);
    expect(second.changes[0]).toBe(first.changes[0]);
    expect(second.changes[1].before).toBe(first.snapshot());
    expect(facts(first).declaredTotal).toBe(360);
    expect(facts(second).declaredTotal).toBe(370);
  });
});

describe('DE4: 編集候補を自動確定せず最新の明示確認へ渡す', () => {
  it('編集後の配賦・合計Validationが失敗しても編集履歴を保持する', () => {
    const initial = draft(),
      root = initial.editDraft(edit(initial, { declaredTotal: 999 }));
    failure(() => root.confirm(confirmation(root)), 'RECEIPT_TOTAL_MISMATCH');
    expect(root.version).toBe(2);
    expect(root.changes).toHaveLength(1);
    const fixed = root.editDraft(edit(root, { declaredTotal: 370 })),
      confirmed = fixed.confirm(confirmation(fixed)),
      value = confirmed.snapshot();
    expect(value.status).toBe('Confirmed');
    if (value.status !== 'Confirmed') throw Error('Confirmed expected');
    expect(value.declaredTotal).toBe(370);
    expect(
      value.items.reduce((sum, item) => sum + item.adjustedAmount, 0),
    ).toBe(370);
    expect(confirmed.version).toBe(4);
    expect(confirmed.changes.map((value) => value.action)).toEqual([
      'DraftEdited',
      'DraftEdited',
      'Confirmed',
    ]);
    expect(confirmed.changes.slice(0, -1)).toEqual(fixed.changes);
  });
  it.each([
    [{ occurredOn: 'invalid' }, 'OCCURRED_ON_INVALID'],
    [{ declaredTotal: -1 }, 'TOTAL_INVALID'],
    [
      { items: [{ id: 'a', name: 'Tea', amount: 300, categoryId: '' }] },
      'CATEGORY_REFERENCE_INVALID',
    ],
    [
      {
        adjustments: [
          { kind: 'Discount', amount: 10, target: { scope: 'Receipt' } },
        ],
      },
      'ADJUSTMENT_INVALID',
    ],
  ] as const)(
    '編集成功でも既存の確定Validation %sを回避しない',
    (patch, code) => {
      const initial = draft(),
        root = initial.editDraft({
          ...unchanged(initial),
          ...patch,
        });
      failure(() => root.confirm(confirmation(root)), String(code));
      expect(root.snapshot().status).toBe('Draft');
    },
  );
  it('明示確認値は最新候補と異なっても再検証し、編集履歴とBundle登録を維持する', () => {
    const initial = draft(),
      updated = initial.editDraft(edit(initial)),
      reviewed = source(),
      root = updated.confirm(
        confirmation(updated, {
          items: reviewed.items,
          adjustments: reviewed.adjustments,
          declaredTotal: reviewed.declaredTotal,
        }),
      );
    const expense = GroupExpense.register({
      id: 'expense',
      groupId: '00000000-0000-4000-8000-000000000001',
      sourceOwnerSubject: 'uploader',
      occurredOn: '2026-10-01',
      amount: 350,
      payerParticipantId: 'payer',
      participants: [{ participantId: 'payer', joinOrder: 1, percentage: 100 }],
    });
    const registered = root.registerBundle({
      expectedVersion: root.version,
      actorSubject: 'uploader',
      registeredAt: new Date('2026-10-07T02:00:00Z'),
      bundleId: 'bundle',
      itemIds: ['a', 'b'],
      expense,
    });
    expect(registered.hasCompleteBundleRegistration()).toBe(true);
    expect(registered.changes.map((value) => value.action)).toEqual([
      'DraftEdited',
      'Confirmed',
      'BundleRegistered',
    ]);
    expect(registered.changes[0]).toBe(updated.changes[0]);
  });
});
