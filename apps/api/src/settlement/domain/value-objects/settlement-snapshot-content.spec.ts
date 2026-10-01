import { describe, expect, it } from 'vitest';

import { derivePaymentInstructionCandidates } from '../payment-instruction-derivation.js';
import { SettlementInvariantViolation } from '../settlement-invariant-violation.js';
import { SnapshotContentInvariantViolation } from '../snapshot-content-invariant-violation.js';
import {
  SettlementSnapshotContent,
  type SnapshotExpenseFact,
} from './settlement-snapshot-content.js';

const groupId = '00000000-0000-0000-0000-000000000001';

const expense = (
  overrides: Partial<SnapshotExpenseFact> = {},
): SnapshotExpenseFact => ({
  expenseId: 'expense-a',
  groupId,
  amount: 100n,
  payerParticipantId: 'a',
  allocations: [
    { participantId: 'a', joinOrder: 1, percentage: 50, burden: 50n },
    { participantId: 'b', joinOrder: 2, percentage: 50, burden: 50n },
  ],
  ...overrides,
});

const fixed = (expenses: readonly SnapshotExpenseFact[]) =>
  SettlementSnapshotContent.from(groupId, expenses);
const balancePairs = (content: SettlementSnapshotContent) =>
  content.balances.map((p) => [p.participantId, p.amount]);

const refuse = (
  expenses: readonly SnapshotExpenseFact[],
  code: string,
  group = groupId,
) => {
  const before = structuredClone(expenses);
  let failure: unknown;
  try {
    SettlementSnapshotContent.from(group, expenses);
  } catch (error) {
    failure = error;
  }
  expect(
    failure instanceof SnapshotContentInvariantViolation ||
      failure instanceof SettlementInvariantViolation,
  ).toBe(true);
  expect(failure).toMatchObject({ code });
  expect(expenses).toEqual(before);
};

describe('選択支出の固定算術内容', () => {
  it('実支払額から負担を引き、残高0でも正割合の参加者を承認者に残す', () => {
    const content = SettlementSnapshotContent.from(groupId, [
      {
        expenseId: 'expense-a',
        groupId,
        amount: 1n,
        payerParticipantId: 'c',
        allocations: [
          { participantId: 'a', joinOrder: 1, percentage: 50, burden: 1n },
          { participantId: 'b', joinOrder: 2, percentage: 50, burden: 0n },
          { participantId: 'c', joinOrder: 3, percentage: 0, burden: 0n },
        ],
      },
    ]);
    expect(content.balances.map((p) => [p.participantId, p.amount])).toEqual([
      ['a', -1n],
      ['b', 0n],
      ['c', 1n],
    ]);
    expect(content.requiredApproverIds).toEqual(['a', 'b', 'c']);
    expect(content.candidates).toEqual([
      {
        payerParticipantId: 'a',
        payeeParticipantId: 'c',
        amount: 1n,
        currency: 'JPY',
      },
    ]);
  });
});

// SSC-INV1/INV2/INV3/POST1: 選択集合からだけ固定内容を導出する。
describe('選択支出からの集計と必要承認者', () => {
  it('複数支出の実支払額と負担を相殺し、支出ごとの債務を維持しない', () => {
    const content = fixed([
      expense({
        allocations: [
          { participantId: 'a', joinOrder: 1, percentage: 0, burden: 0n },
          { participantId: 'b', joinOrder: 2, percentage: 100, burden: 100n },
        ],
      }),
      expense({
        expenseId: 'expense-b',
        amount: 60n,
        payerParticipantId: 'b',
        allocations: [
          { participantId: 'a', joinOrder: 1, percentage: 100, burden: 60n },
          { participantId: 'b', joinOrder: 2, percentage: 0, burden: 0n },
        ],
      }),
    ]);
    expect(balancePairs(content)).toEqual([
      ['a', 40n],
      ['b', -40n],
    ]);
    expect(content.candidates).toEqual([
      {
        payerParticipantId: 'b',
        payeeParticipantId: 'a',
        amount: 40n,
        currency: 'JPY',
      },
    ]);
    expect(content.requiredApproverIds).toEqual(['a', 'b']);
    expect(content.candidates).toEqual(
      derivePaymentInstructionCandidates(content.balances),
    );
  });
  it('ERで確定した1001円の端数配賦を再配賦せず保持する', () => {
    const content = fixed([
      expense({
        amount: 1001n,
        payerParticipantId: 'c',
        allocations: [
          { participantId: 'a', joinOrder: 1, percentage: 30, burden: 300n },
          { participantId: 'b', joinOrder: 2, percentage: 30, burden: 300n },
          { participantId: 'c', joinOrder: 3, percentage: 40, burden: 401n },
        ],
      }),
    ]);
    expect(content.expenses[0].allocations.map((p) => p.burden)).toEqual([
      300n,
      300n,
      401n,
    ]);
    expect(balancePairs(content)).toEqual([
      ['a', -300n],
      ['b', -300n],
      ['c', 600n],
    ]);
  });
  it('全員の残高が相殺されても必要承認者を消さず、候補だけを空にする', () => {
    const content = fixed([
      expense(),
      expense({ expenseId: 'expense-b', payerParticipantId: 'b' }),
    ]);
    expect(balancePairs(content)).toEqual([
      ['a', 0n],
      ['b', 0n],
    ]);
    expect(content.requiredApproverIds).toEqual(['a', 'b']);
    expect(content.candidates).toEqual([]);
  });
  it('0円の1人支出も必要承認者を固定し承認済みにしない', () => {
    const content = fixed([
      expense({
        amount: 0n,
        allocations: [
          { participantId: 'a', joinOrder: 1, percentage: 100, burden: 0n },
        ],
      }),
    ]);
    expect(balancePairs(content)).toEqual([['a', 0n]]);
    expect(content.requiredApproverIds).toEqual(['a']);
    expect(content.candidates).toEqual([]);
  });
  it('payerでなく全選択で0%の人は承認者から除き、0残高は保持する', () => {
    const content = fixed([
      expense({
        allocations: [
          ...expense().allocations,
          { participantId: 'unused', joinOrder: 3, percentage: 0, burden: 0n },
        ],
      }),
    ]);
    expect(content.requiredApproverIds).toEqual(['a', 'b']);
    expect(balancePairs(content)).toEqual([
      ['a', 50n],
      ['b', -50n],
      ['unused', 0n],
    ]);
  });
  it('選択外と後から登録したExpenseを取り込まない', () => {
    const all = [
      expense(),
      expense({ expenseId: 'unselected', payerParticipantId: 'b' }),
    ];
    const selected = [all[0]];
    const content = fixed(selected);
    all.push(expense({ expenseId: 'later', payerParticipantId: 'b' }));
    selected.push(all[1]);
    expect(content.expenses.map((e) => e.expenseId)).toEqual(['expense-a']);
    expect(balancePairs(content)).toEqual([
      ['a', 50n],
      ['b', -50n],
    ]);
  });
  it('Expenseとallocationの入力逆順でも同じ内容・同率候補を固定する', () => {
    const first = expense({ expenseId: 'z-expense' });
    const second = expense({
      expenseId: 'a-expense',
      allocations: [...expense().allocations].reverse(),
    });
    const original = structuredClone([first, second]);
    const forward = fixed([first, second]);
    const reverse = fixed([second, first]);
    expect(forward).toEqual(reverse);
    expect(forward.equals(reverse)).toBe(true);
    expect(forward.expenses.map((e) => e.expenseId)).toEqual([
      'a-expense',
      'z-expense',
    ]);
    expect([first, second]).toEqual(original);
  });
  it('安全整数の限界額を複数支出で合算しても1円を失わない', () => {
    const amount = BigInt(Number.MAX_SAFE_INTEGER);
    const source = expense({
      amount,
      allocations: [
        { participantId: 'a', joinOrder: 1, percentage: 0, burden: 0n },
        { participantId: 'b', joinOrder: 2, percentage: 100, burden: amount },
      ],
    });
    const content = fixed([source, { ...source, expenseId: 'expense-b' }]);
    expect(balancePairs(content)).toEqual([
      ['a', amount * 2n],
      ['b', -amount * 2n],
    ]);
    expect(content.candidates[0].amount).toBe(amount * 2n);
  });
  it('歴史上の6人unionと再参加IDをActive人数上限へ切り詰めない', () => {
    const sources = [2, 3, 4, 5, 6].map((order) =>
      expense({
        expenseId: `expense-${order}`,
        amount: 10n,
        allocations: [
          { participantId: 'a', joinOrder: 1, percentage: 0, burden: 0n },
          {
            participantId: order === 6 ? 'rejoined-b' : `past-${order}`,
            joinOrder: order,
            percentage: 100,
            burden: 10n,
          },
        ],
      }),
    );
    const content = fixed(sources);
    expect(content.balances).toHaveLength(6);
    expect(content.requiredApproverIds).toEqual([
      'a',
      'past-2',
      'past-3',
      'past-4',
      'past-5',
      'rejoined-b',
    ]);
    expect(content.candidates).toHaveLength(5);
    expect(content.candidates.map((p) => p.payerParticipantId)).toEqual([
      'past-2',
      'past-3',
      'past-4',
      'past-5',
      'rejoined-b',
    ]);
    expect(content.balances.reduce((sum, p) => sum + p.amount, 0n)).toBe(0n);
  });
});

// SSC-FAIL1: 拒否はcallerの事実を変えず、内容を作らない。
describe('矛盾する選択factsの拒否', () => {
  it.each(['', ' ', 'group-example', '00000000-0000-0000-0000-00000000000A'])(
    '非canonical Group %sを拒否する',
    (group) => refuse([expense()], 'GROUP_REFERENCE_INVALID', group),
  );
  it('空選択を承認不要のSnapshotへ変換しない', () =>
    refuse([], 'SELECTION_EMPTY'));
  it.each(['', ' '])('空Expense参照%sを拒否する', (expenseId) =>
    refuse([expense({ expenseId })], 'EXPENSE_REFERENCE_EMPTY'),
  );
  it('同じIDのExpenseを二重計上しない', () =>
    refuse([expense(), expense()], 'EXPENSE_DUPLICATED'));
  it('別Groupのfactsを混ぜない', () =>
    refuse(
      [expense({ groupId: '00000000-0000-0000-0000-000000000002' })],
      'EXPENSE_GROUP_MISMATCH',
    ));
  it('負のExpense額を拒否する', () =>
    refuse([expense({ amount: -1n })], 'EXPENSE_AMOUNT_INVALID'));
  it.each([0, 0.5, Number.NaN, '1', null, undefined])(
    'JPY bigint以外のExpense額%sを拒否する',
    (amount) => {
      const source = expense();
      Reflect.set(source, 'amount', amount);
      refuse([source], 'EXPENSE_AMOUNT_INVALID');
    },
  );
  it.each([0, 5])('単Expense allocation数%sを拒否する', (count) =>
    refuse(
      [
        expense({
          allocations: Array.from({ length: count }, (_, i) => ({
            participantId: `p-${i}`,
            joinOrder: i + 1,
            percentage: 20,
            burden: 20n,
          })),
        }),
      ],
      'ALLOCATION_COUNT_INVALID',
    ),
  );
  it.each(['', ' ', 'outside'])(
    '集合にいないpayer%sを拒否する',
    (payerParticipantId) =>
      refuse([expense({ payerParticipantId })], 'PAYER_NOT_PARTICIPANT'),
  );
  it('allocationの空Participantを拒否する', () =>
    refuse(
      [
        expense({
          allocations: [
            { ...expense().allocations[0], participantId: ' ' },
            expense().allocations[1],
          ],
        }),
      ],
      'PARTICIPANT_ID_EMPTY',
    ));
  it('同一支出の重複Participantを拒否する', () =>
    refuse(
      [
        expense({
          allocations: [
            expense().allocations[0],
            { ...expense().allocations[1], participantId: 'a' },
          ],
        }),
      ],
      'PARTICIPANT_DUPLICATED',
    ));
  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('無効な参加順%sを拒否する', (joinOrder) =>
    refuse(
      [
        expense({
          allocations: [
            { ...expense().allocations[0], joinOrder },
            expense().allocations[1],
          ],
        }),
      ],
      'JOIN_ORDER_INVALID',
    ),
  );
  it('同一支出の参加順重複を拒否する', () =>
    refuse(
      [
        expense({
          allocations: [
            expense().allocations[0],
            { ...expense().allocations[1], joinOrder: 1 },
          ],
        }),
      ],
      'JOIN_ORDER_DUPLICATED',
    ));
  it.each([-10, 110, 15, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    '無効な割合%sを拒否する',
    (percentage) =>
      refuse(
        [
          expense({
            allocations: [
              { ...expense().allocations[0], percentage },
              expense().allocations[1],
            ],
          }),
        ],
        'ALLOCATION_PERCENTAGE_INVALID',
      ),
  );
  it('割合合計100でないfactsを拒否する', () =>
    refuse(
      [
        expense({
          allocations: [
            { ...expense().allocations[0], percentage: 30 },
            expense().allocations[1],
          ],
        }),
      ],
      'ALLOCATION_PERCENTAGE_TOTAL_INVALID',
    ));
  it('負の負担を拒否する', () =>
    refuse(
      [
        expense({
          allocations: [
            { ...expense().allocations[0], burden: -1n },
            expense().allocations[1],
          ],
        }),
      ],
      'ALLOCATION_BURDEN_INVALID',
    ));
  it.each([0, 0.5, Number.NaN, '1', null, undefined])(
    'JPY bigint以外の負担%sを拒否する',
    (burden) => {
      const allocations = structuredClone(expense().allocations);
      Reflect.set(allocations[0], 'burden', burden);
      refuse([expense({ allocations })], 'ALLOCATION_BURDEN_INVALID');
    },
  );
  it('負担合計とExpense額の不一致を拒否する', () =>
    refuse([expense({ amount: 101n })], 'ALLOCATION_BURDEN_TOTAL_INVALID'));
  it('0%の負担を残高や承認者へ紛れ込ませない', () =>
    refuse(
      [
        expense({
          allocations: [
            { ...expense().allocations[0], percentage: 0 },
            { ...expense().allocations[1], percentage: 100 },
          ],
        }),
      ],
      'ZERO_SHARE_BURDEN_INVALID',
    ));
  it('別Expenseで同じParticipantの参加順を変えない', () =>
    refuse(
      [
        expense(),
        expense({
          expenseId: 'expense-b',
          allocations: [
            { ...expense().allocations[0], joinOrder: 99 },
            expense().allocations[1],
          ],
        }),
      ],
      'PARTICIPANT_ORDER_CONFLICT',
    ));
  it('別Expenseで別Participantへ旧参加順を再利用しない', () =>
    refuse(
      [
        expense(),
        expense({
          expenseId: 'expense-b',
          payerParticipantId: 'rejoined-a',
          allocations: [
            { ...expense().allocations[0], participantId: 'rejoined-a' },
            expense().allocations[1],
          ],
        }),
      ],
      'PARTICIPANT_ORDER_CONFLICT',
    ));
});

describe('内容の不変性と値比較', () => {
  it('元Expense・allocation・選択配列へのdeepmutationを伝播させない', () => {
    const source = expense();
    const selected = [source];
    const content = fixed(selected);
    const before = structuredClone(content);
    Reflect.set(source, 'amount', 200n);
    Reflect.set(source, 'payerParticipantId', 'b');
    Reflect.set(source.allocations[0], 'participantId', 'rejoined-a');
    Reflect.set(source.allocations[0], 'percentage', 0);
    Reflect.set(source.allocations[0], 'burden', 0n);
    selected.push(expense({ expenseId: 'later' }));
    expect(structuredClone(content)).toEqual(before);
  });
  it('内容・facts・配賦・残高・候補・必要承認者をRuntimeでも変更させない', () => {
    const content = fixed([expense()]);
    expect(Reflect.set(content, 'groupId', 'other')).toBe(false);
    expect(Reflect.set(content, 'currency', 'USD')).toBe(false);
    expect(Reflect.set(content.expenses, '0', {})).toBe(false);
    expect(Reflect.set(content.expenses[0], 'amount', 200n)).toBe(false);
    expect(Reflect.set(content.expenses[0].allocations, '0', {})).toBe(false);
    expect(Reflect.set(content.expenses[0].allocations[0], 'burden', 0n)).toBe(
      false,
    );
    expect(Reflect.set(content.balances, '0', {})).toBe(false);
    expect(Reflect.set(content.balances[0], 'amount', 0n)).toBe(false);
    expect(Reflect.set(content.candidates, '0', {})).toBe(false);
    expect(Reflect.set(content.candidates[0], 'amount', 1n)).toBe(false);
    expect(Reflect.set(content.requiredApproverIds, '0', 'outsider')).toBe(
      false,
    );
    expect(content.expenses[0].amount).toBe(100n);
  });
  it('後続内容を作っても旧内容を変更しない', () => {
    const old = fixed([expense()]);
    const before = structuredClone(old);
    const later = fixed([expense({ payerParticipantId: 'b' })]);
    expect(old.equals(later)).toBe(false);
    expect(structuredClone(old)).toEqual(before);
  });
  it('別インスタンスでも同じ全factsなら値が等しい', () =>
    expect(fixed([expense()]).equals(fixed([expense()]))).toBe(true));
  it('異なるGroup・選択・額・payer・配賦・参照・参加順は別の内容である', () => {
    const original = fixed([expense()]);
    const otherGroup = '00000000-0000-0000-0000-000000000002';
    const others = [
      SettlementSnapshotContent.from(otherGroup, [
        expense({ groupId: otherGroup }),
      ]),
      fixed([expense(), expense({ expenseId: 'extra' })]),
      fixed([expense({ expenseId: 'other' })]),
      fixed([
        expense({
          amount: 120n,
          allocations: expense().allocations.map((p) => ({
            ...p,
            burden: 60n,
          })),
        }),
      ]),
      fixed([expense({ payerParticipantId: 'b' })]),
      fixed([
        expense({
          allocations: [
            { ...expense().allocations[0], percentage: 40, burden: 40n },
            { ...expense().allocations[1], percentage: 60, burden: 60n },
          ],
        }),
      ]),
      fixed([
        expense({
          allocations: [
            ...expense().allocations,
            { participantId: 'c', joinOrder: 3, percentage: 0, burden: 0n },
          ],
        }),
      ]),
      fixed([
        expense({
          payerParticipantId: 'other-a',
          allocations: [
            { ...expense().allocations[0], participantId: 'other-a' },
            expense().allocations[1],
          ],
        }),
      ]),
      fixed([
        expense({
          allocations: expense().allocations.map((p) => ({
            ...p,
            joinOrder: p.joinOrder + 10,
          })),
        }),
      ]),
    ];
    for (const other of others) expect(original.equals(other)).toBe(false);
  });
});
