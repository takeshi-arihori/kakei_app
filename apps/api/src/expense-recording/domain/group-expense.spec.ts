import { describe, expect, it } from 'vitest';

import { ExpenseInvariantViolation } from './expense-invariant-violation.js';
import {
  GroupExpense,
  type RegisterGroupExpenseInput,
} from './group-expense.js';
import { ExpenseId } from './value-objects/expense-id.js';
import { OccurredOn } from './value-objects/occurred-on.js';

const fixture = (
  overrides: Partial<RegisterGroupExpenseInput> = {},
): RegisterGroupExpenseInput => ({
  id: 'expense-example',
  groupId: '00000000-0000-0000-0000-000000000001',
  sourceOwnerSubject: 'actor-original',
  occurredOn: '2026-10-01',
  amount: 1001,
  payerParticipantId: 'p1',
  participants: [
    { participantId: 'p1', joinOrder: 1, percentage: 30 },
    { participantId: 'p2', joinOrder: 2, percentage: 30 },
    { participantId: 'p3', joinOrder: 3, percentage: 40 },
  ],
  ...overrides,
});

const percentages = (rates: readonly number[]) =>
  rates.map((percentage, i) => ({
    participantId: `p${i + 1}`,
    joinOrder: (i + 1) * 7,
    percentage,
  }));

const burdens = (input: RegisterGroupExpenseInput) =>
  GroupExpense.register(input)
    .snapshot()
    .allocations.map((p) => p.burden.amount);

const rejectWithoutChangingInput = (
  input: RegisterGroupExpenseInput,
  code: string,
) => {
  const before = structuredClone(input);
  let failure: unknown;
  try {
    GroupExpense.register(input);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ExpenseInvariantViolation);
  expect(failure).toMatchObject({ code });
  expect(input).toEqual(before);
};

const rateCombinations = (count: number, remaining = 100): number[][] => {
  if (count === 1) return [[remaining]];
  const result: number[][] = [];
  for (let rate = 0; rate <= remaining; rate += 10) {
    for (const tail of rateCombinations(count - 1, remaining - rate))
      result.push([rate, ...tail]);
  }
  return result;
};

// ER-INV-1: Confirmedな整数配賦。Actor本人性・Groupの現在状態はこのfactoryでは判定しない。
describe('Group Expenseの登録時配賦', () => {
  it('1001円を30/30/40で配賦すると最大剰余の参加者が401円を負担する', () => {
    expect(burdens(fixture())).toEqual([300, 300, 401]);
  });

  it.each(['p1', 'p2'])(
    '50/50の端数が同率なら実支払者%sに1円を優先する',
    (payerParticipantId) => {
      expect(
        burdens(
          fixture({ payerParticipantId, participants: percentages([50, 50]) }),
        ),
      ).toEqual(payerParticipantId === 'p1' ? [501, 500] : [500, 501]);
    },
  );

  it('実支払者が0%なら端数を非連続の登録参加順で決める', () => {
    const participants = [
      { participantId: 'p1', joinOrder: 1, percentage: 0 },
      { participantId: 'p2', joinOrder: 19, percentage: 50 },
      { participantId: 'p3', joinOrder: 7, percentage: 50 },
    ];
    const allocations = GroupExpense.register(
      fixture({ participants }),
    ).snapshot().allocations;
    expect(allocations.map((p) => [p.participantId, p.burden.amount])).toEqual([
      ['p1', 0],
      ['p3', 501],
      ['p2', 500],
    ]);
  });

  it('payer優先は同率内だけであり、大きい剰余を追い越さない', () => {
    expect(
      burdens(fixture({ amount: 2, participants: percentages([10, 30, 60]) })),
    ).toEqual([0, 1, 1]);
  });

  it('残り2円は異なる参加者へ1円ずつ配る', () => {
    expect(
      burdens(
        fixture({
          amount: 2,
          payerParticipantId: 'p4',
          participants: percentages([20, 20, 30, 30]),
        }),
      ),
    ).toEqual([0, 0, 1, 1]);
  });

  it('同率が複数ならpayerに続いて参加順へ配る', () => {
    expect(
      burdens(
        fixture({
          amount: 2,
          payerParticipantId: 'p3',
          participants: percentages([30, 30, 30, 10]),
        }),
      ),
    ).toEqual([1, 0, 1, 0]);
  });

  it('入力配列順を変えても同じParticipantが同じ負担を持つ', () => {
    const input = fixture({
      amount: 7,
      payerParticipantId: 'p3',
      participants: percentages([30, 30, 30, 10]),
    });
    expect(GroupExpense.register(input).snapshot()).toEqual(
      GroupExpense.register({
        ...input,
        participants: [...input.participants].reverse(),
      }).snapshot(),
    );
  });

  it('1人のGroupでは支出全額を負担する', () => {
    expect(burdens(fixture({ participants: percentages([100]) }))).toEqual([
      1001,
    ]);
  });

  it('0円でも登録した0%と全Participantを保持する', () => {
    const snapshot = GroupExpense.register(
      fixture({ amount: 0, participants: percentages([0, 20, 30, 50]) }),
    ).snapshot();
    expect(snapshot.allocations.map((p) => p.percentage)).toEqual([
      0, 20, 30, 50,
    ]);
    expect(snapshot.allocations.map((p) => p.burden.amount)).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it('安全整数の最大額も乗算で丸めず最大剰余へ配る', () => {
    expect(burdens(fixture({ amount: Number.MAX_SAFE_INTEGER }))).toEqual([
      2702159776422297, 2702159776422297, 3602879701896397,
    ]);
  });

  it('1〜4人の全364配分で合計保存・0%保持・各人floorとの差0/1を満たす', () => {
    let allocationsChecked = 0;
    for (let count = 1; count <= 4; count++) {
      for (const rates of rateCombinations(count)) {
        allocationsChecked++;
        for (const amount of [
          0,
          1,
          2,
          7,
          11,
          99,
          101,
          1001,
          Number.MAX_SAFE_INTEGER,
        ]) {
          for (let payer = 1; payer <= count; payer++) {
            const shares = GroupExpense.register(
              fixture({
                amount,
                payerParticipantId: `p${payer}`,
                participants: percentages(rates),
              }),
            ).snapshot().allocations;
            const total = shares.reduce(
              (sum, p) => sum + BigInt(p.burden.amount),
              0n,
            );
            expect(total).toBe(BigInt(amount));
            for (const share of shares) {
              expect(Number.isSafeInteger(share.burden.amount)).toBe(true);
              const floor = (BigInt(amount) * BigInt(share.percentage)) / 100n;
              const extra = BigInt(share.burden.amount) - floor;
              expect(extra === 0n || extra === 1n).toBe(true);
              if (share.percentage === 0) expect(share.burden.amount).toBe(0);
              expect(share.burden.currency).toBe('JPY');
            }
          }
        }
      }
    }
    expect(allocationsChecked).toBe(364);
  });
});

// ER-FAIL-1: 拒否してRootを作らず、渡された事実を変更しない。
describe('無効な登録事実の拒否', () => {
  it.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('額%sは技術制約に違反する', (amount) => {
    rejectWithoutChangingInput(fixture({ amount }), 'AMOUNT_INVALID');
  });
  it.each([-10, 110, 1, 15, 10.5, Number.NaN, Number.POSITIVE_INFINITY])(
    '割合%sは10%%単位の範囲外',
    (percentage) => {
      rejectWithoutChangingInput(
        fixture({ participants: percentages([percentage, 100 - percentage]) }),
        'PERCENTAGE_INVALID',
      );
    },
  );
  it.each(
    [[0], [30, 30, 30], [100, 10], [100, 100]].map((rates) => ({ rates })),
  )('割合の合計が100にならない入力を拒否する: $rates', ({ rates }) => {
    rejectWithoutChangingInput(
      fixture({ participants: percentages(rates) }),
      'PERCENTAGE_TOTAL_INVALID',
    );
  });
  it.each([0, 5])('人数%sはGroup範囲外', (count) => {
    rejectWithoutChangingInput(
      fixture({
        participants: percentages(Array.from({ length: count }, () => 20)),
      }),
      'PARTICIPANT_COUNT_INVALID',
    );
  });
  it('実支払者が固定集合にいなければ拒否する', () => {
    rejectWithoutChangingInput(
      fixture({ payerParticipantId: 'outside-participant' }),
      'PAYER_NOT_PARTICIPANT',
    );
  });
  it('異なる割合でもParticipantを重複登録しない', () => {
    rejectWithoutChangingInput(
      fixture({
        participants: [
          { participantId: 'p1', joinOrder: 1, percentage: 50 },
          { participantId: 'p1', joinOrder: 2, percentage: 50 },
        ],
      }),
      'PARTICIPANT_DUPLICATED',
    );
  });
  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('joinOrder%sを拒否する', (joinOrder) => {
    rejectWithoutChangingInput(
      fixture({
        participants: [{ participantId: 'p1', joinOrder, percentage: 100 }],
      }),
      'JOIN_ORDER_INVALID',
    );
  });
  it('joinOrderが重複すれば恣意的なTie-breakを作らず拒否する', () => {
    rejectWithoutChangingInput(
      fixture({
        participants: [
          { participantId: 'p1', joinOrder: 1, percentage: 50 },
          { participantId: 'p2', joinOrder: 1, percentage: 50 },
        ],
      }),
      'JOIN_ORDER_DUPLICATED',
    );
  });
  it.each(['id', 'sourceOwnerSubject', 'payerParticipantId'] as const)(
    '%sの空値は本人や同一性の参照にならない',
    (key) => {
      rejectWithoutChangingInput(fixture({ [key]: '  ' }), 'IDENTIFIER_EMPTY');
    },
  );
  it('Participantの空参照を拒否する', () => {
    rejectWithoutChangingInput(
      fixture({
        participants: [{ participantId: ' ', joinOrder: 1, percentage: 100 }],
      }),
      'IDENTIFIER_EMPTY',
    );
  });
  it.each([
    '',
    'group-example',
    '00000000-0000-0000-0000-00000000000A',
    '00000000000000000000000000000001',
  ])('非canonical Group参照%sを拒否する', (groupId) => {
    rejectWithoutChangingInput(fixture({ groupId }), 'GROUP_ID_INVALID');
  });
  it.each([
    '2026-02-29',
    '1900-02-29',
    '2026-04-31',
    '2026-00-01',
    '2026-13-01',
    '2026-01-00',
    '2026-01-32',
    '2026-1-01',
    '2026-10-01T00:00:00Z',
    '',
    ' 2026-10-01',
  ])('無効な購入暦日%sを拒否する', (occurredOn) => {
    rejectWithoutChangingInput(fixture({ occurredOn }), 'OCCURRED_ON_INVALID');
  });
});

// ER-POST-1 / ER-OWNER-1: 現在membershipの変更で過去事実とSource Ownerを変えない。
describe('登録時事実の固定', () => {
  it('途中参加・脱退・再参加の新Participantを既存支出に伝播させない', () => {
    const participants = percentages([50, 50]);
    const input = fixture({ participants });
    const before = structuredClone(input);
    const expense = GroupExpense.register(input);
    expect(input).toEqual(before);
    const expected = expense.snapshot();
    participants[0].percentage = 0;
    participants[1].participantId = 'p2-rejoined';
    participants[1].joinOrder = 99;
    participants.splice(0, 1);
    participants.push({
      participantId: 'new-participant',
      joinOrder: 100,
      percentage: 100,
    });
    Reflect.set(input, 'payerParticipantId', 'new-participant');
    Reflect.set(input, 'sourceOwnerSubject', 'different-actor');
    Reflect.set(input, 'amount', 2000);
    expect(expense.id.value).toBe('expense-example');
    expect(expense.snapshot()).toEqual(expected);
    expect(
      expense
        .snapshot()
        .allocations.map((p) => [
          p.participantId,
          p.percentage,
          p.burden.amount,
        ]),
    ).toEqual([
      ['p1', 50, 501],
      ['p2', 50, 500],
    ]);
    expect(expense.snapshot().sourceOwnerSubject).toBe('actor-original');
    expect(expense.snapshot().total.amount).toBe(1001);
    expect(expense.snapshot().payerParticipantId).toBe('p1');
  });

  it('snapshotと内包Money/配列/Value ObjectはRuntimeでも書き換えられない', () => {
    const expense = GroupExpense.register(fixture());
    const snapshot = expense.snapshot();
    expect(
      Reflect.defineProperty(expense, 'id', { value: ExpenseId.from('other') }),
    ).toBe(false);
    expect(Reflect.set(snapshot, 'payerParticipantId', 'other')).toBe(false);
    expect(Reflect.set(snapshot.total, 'amount', 5)).toBe(false);
    expect(Reflect.set(snapshot.total, 'currency', 'USD')).toBe(false);
    expect(Reflect.set(snapshot.id, 'value', 'other')).toBe(false);
    expect(Reflect.set(snapshot.occurredOn, 'value', '2026-11-01')).toBe(false);
    expect(Reflect.set(snapshot.allocations, '0', {})).toBe(false);
    expect(Reflect.set(snapshot.allocations[0], 'percentage', 100)).toBe(false);
    expect(Reflect.set(snapshot.allocations[0].burden, 'amount', 5)).toBe(
      false,
    );
    expect(snapshot.total.amount).toBe(1001);
    expect(snapshot.allocations.map((p) => p.burden.amount)).toEqual([
      300, 300, 401,
    ]);
  });

  it.each([
    '2000-02-29',
    '2024-02-29',
    '2026-02-28',
    '2026-01-31',
    '2026-04-30',
    '0000-02-29',
  ])('実在する購入暦日%sを時刻へ変換せず保持する', (occurredOn) => {
    expect(
      GroupExpense.register(fixture({ occurredOn })).snapshot().occurredOn
        .value,
    ).toBe(occurredOn);
  });

  it('購入日とExpense IDは値で比較し、他の値と区別する', () => {
    expect(
      OccurredOn.from('2026-10-01').equals(OccurredOn.from('2026-10-01')),
    ).toBe(true);
    expect(
      OccurredOn.from('2026-10-01').equals(OccurredOn.from('2026-10-02')),
    ).toBe(false);
    expect(
      ExpenseId.from('expense-a').equals(ExpenseId.from('expense-a')),
    ).toBe(true);
    expect(
      ExpenseId.from('expense-a').equals(ExpenseId.from('expense-b')),
    ).toBe(false);
  });
});
