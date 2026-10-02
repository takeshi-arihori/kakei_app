import { describe, expect, it } from 'vitest';

import { ReceiptAdjustmentViolation } from './receipt-adjustment-violation.js';
import {
  ReceiptAdjustmentAllocation,
  type ReceiptAdjustmentInput,
  type ReceiptAdjustmentItemInput,
} from './receipt-adjustment.js';

const items: readonly ReceiptAdjustmentItemInput[] = [
  { id: 'item-1', amount: 110 },
  { id: 'item-2', amount: 240 },
  { id: 'item-3', amount: 200 },
];

const receiptDiscount: ReceiptAdjustmentInput = {
  kind: 'Discount',
  amount: -50,
  target: { scope: 'Receipt' },
};

describe('Receipt Adjustmentの整数配賦', () => {
  it('Receipt全体の値引きを元金額比と最大剰余・Item順で配賦する', () => {
    const result = ReceiptAdjustmentAllocation.calculate(items, [
      receiptDiscount,
    ]);

    expect(result.items.map((item) => item.adjustedAmount)).toEqual([
      100, 218, 182,
    ]);
    expect(result.allocations[0]?.amounts).toEqual([-10, -22, -18]);
    expect(
      result.allocations[0]?.amounts.reduce(
        (sum, amount) => sum + BigInt(amount),
        0n,
      ),
    ).toBe(-50n);
  });

  it('Adjustmentごとに元金額を重みに使い、順序によらず合算する', () => {
    const adjustments: readonly ReceiptAdjustmentInput[] = [
      receiptDiscount,
      { kind: 'Tax', amount: 50, target: { scope: 'Receipt' } },
      {
        kind: 'Shipping',
        amount: 7,
        target: { scope: 'Item', itemId: 'item-2' },
      },
    ];

    const forward = ReceiptAdjustmentAllocation.calculate(items, adjustments);
    const reverse = ReceiptAdjustmentAllocation.calculate(
      items,
      [...adjustments].reverse(),
    );

    expect(forward.items.map((item) => item.adjustedAmount)).toEqual([
      110, 247, 200,
    ]);
    expect(reverse.items.map((item) => item.adjustedAmount)).toEqual([
      110, 247, 200,
    ]);
  });

  it('ゼロ金額のItemへReceipt全体の配賦を行わない', () => {
    const result = ReceiptAdjustmentAllocation.calculate(
      [
        { id: 'zero', amount: 0 },
        { id: 'positive', amount: 3 },
      ],
      [{ kind: 'Tax', amount: 1, target: { scope: 'Receipt' } }],
    );

    expect(result.allocations[0]?.amounts).toEqual([0, 1]);
  });

  it('剰余の大きいItemを配列の先頭より優先する', () => {
    const result = ReceiptAdjustmentAllocation.calculate(
      [
        { id: 'first', amount: 1 },
        { id: 'second', amount: 3 },
      ],
      [{ kind: 'Tax', amount: 1, target: { scope: 'Receipt' } }],
    );

    expect(result.allocations[0]?.amounts).toEqual([0, 1]);
  });

  it('各全体Adjustmentの円未満をItem順で決定し、safe integerを超える積も正確に扱う', () => {
    const amount = Number.MAX_SAFE_INTEGER;
    const result = ReceiptAdjustmentAllocation.calculate(
      [
        { id: 'first', amount },
        { id: 'second', amount },
      ],
      [
        {
          kind: 'Discount',
          amount: -amount,
          target: { scope: 'Receipt' },
        },
      ],
    );

    expect(result.allocations[0]?.amounts).toEqual([
      -4503599627370496, -4503599627370495,
    ]);
    expect(result.items.map((item) => item.adjustedAmount)).toEqual([
      4503599627370495, 4503599627370496,
    ]);
  });

  it('Item対象Adjustmentは対象Itemだけに作用する', () => {
    const result = ReceiptAdjustmentAllocation.calculate(items, [
      {
        kind: 'Point',
        amount: -5,
        target: { scope: 'Item', itemId: 'item-2' },
      },
    ]);

    expect(result.allocations[0]?.amounts).toEqual([0, -5, 0]);
    expect(result.items.map((item) => item.adjustedAmount)).toEqual([
      110, 235, 200,
    ]);
  });

  it.each([
    { kind: 'Tax', amount: -1 },
    { kind: 'Shipping', amount: -1 },
    { kind: 'Discount', amount: 1 },
    { kind: 'Point', amount: 1 },
    { kind: 'Tax', amount: 0 },
    { kind: 'Shipping', amount: 0 },
    { kind: 'Discount', amount: 0 },
    { kind: 'Point', amount: 0 },
  ] as const)(
    'Adjustment種別と符号の契約に反する値を拒否する: $kind $amount',
    (entry) => {
      let failure: unknown;
      try {
        ReceiptAdjustmentAllocation.calculate(items, [
          { ...entry, target: { scope: 'Receipt' } },
        ]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ReceiptAdjustmentViolation);
      expect(failure).toMatchObject({
        code:
          entry.amount === 0
            ? 'ADJUSTMENT_AMOUNT_INVALID'
            : 'ADJUSTMENT_SIGN_INVALID',
      });
    },
  );

  it('存在しない対象Itemと正の元金額がないReceipt全体Adjustmentを拒否する', () => {
    expect(() =>
      ReceiptAdjustmentAllocation.calculate(items, [
        {
          kind: 'Tax',
          amount: 1,
          target: { scope: 'Item', itemId: 'missing' },
        },
      ]),
    ).toThrow(ReceiptAdjustmentViolation);
    expect(() =>
      ReceiptAdjustmentAllocation.calculate(
        [{ id: 'zero', amount: 0 }],
        [receiptDiscount],
      ),
    ).toThrow(ReceiptAdjustmentViolation);
  });

  it('値引き超過による負額とsafe integer上限超過を全体拒否する', () => {
    expect(() =>
      ReceiptAdjustmentAllocation.calculate(
        [{ id: 'item', amount: 1 }],
        [
          {
            kind: 'Discount',
            amount: -2,
            target: { scope: 'Item', itemId: 'item' },
          },
        ],
      ),
    ).toThrow(ReceiptAdjustmentViolation);
    expect(() =>
      ReceiptAdjustmentAllocation.calculate(
        [{ id: 'item', amount: Number.MAX_SAFE_INTEGER }],
        [
          {
            kind: 'Tax',
            amount: 1,
            target: { scope: 'Item', itemId: 'item' },
          },
        ],
      ),
    ).toThrow(ReceiptAdjustmentViolation);
  });

  it('複数Adjustmentの最終負額を全体拒否する', () => {
    let failure: unknown;
    try {
      ReceiptAdjustmentAllocation.calculate(
        [{ id: 'item', amount: 3 }],
        [
          {
            kind: 'Discount',
            amount: -2,
            target: { scope: 'Item', itemId: 'item' },
          },
          {
            kind: 'Point',
            amount: -2,
            target: { scope: 'Item', itemId: 'item' },
          },
        ],
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ReceiptAdjustmentViolation);
    expect(failure).toMatchObject({ code: 'ADJUSTED_AMOUNT_NEGATIVE' });
    expect(failure).toMatchObject({
      message: 'Adjusted Receipt Item amount is negative',
    });
  });

  it('途中負額をclampせず、全Adjustment合算後の非負額を順序独立に返す', () => {
    const discountThenTax = ReceiptAdjustmentAllocation.calculate(
      [{ id: 'item', amount: 2 }],
      [
        {
          kind: 'Discount',
          amount: -5,
          target: { scope: 'Item', itemId: 'item' },
        },
        {
          kind: 'Tax',
          amount: 4,
          target: { scope: 'Item', itemId: 'item' },
        },
      ],
    );
    const taxThenDiscount = ReceiptAdjustmentAllocation.calculate(
      [{ id: 'item', amount: 2 }],
      [
        {
          kind: 'Tax',
          amount: 4,
          target: { scope: 'Item', itemId: 'item' },
        },
        {
          kind: 'Discount',
          amount: -5,
          target: { scope: 'Item', itemId: 'item' },
        },
      ],
    );

    expect(discountThenTax.items[0]?.adjustedAmount).toBe(1);
    expect(taxThenDiscount.items[0]?.adjustedAmount).toBe(1);
  });

  it('不正なItem金額・重複識別子を拒否する', () => {
    for (const invalid of [
      [{ id: '', amount: 1 }],
      [{ id: '  ', amount: 1 }],
      [{ id: 'item', amount: -1 }],
      [{ id: 'item', amount: 1.5 }],
      [
        { id: 'same', amount: 1 },
        { id: 'same', amount: 2 },
      ],
    ]) {
      expect(() => ReceiptAdjustmentAllocation.calculate(invalid, [])).toThrow(
        ReceiptAdjustmentViolation,
      );
    }
  });

  it('同じ種別の不正符号は入力に依存しない固定Domain Errorを返す', () => {
    const messages = [-1, -999].map((amount) => {
      try {
        ReceiptAdjustmentAllocation.calculate(items, [
          { kind: 'Tax', amount, target: { scope: 'Receipt' } },
        ]);
        return 'unexpected success';
      } catch (error) {
        expect(error).toBeInstanceOf(ReceiptAdjustmentViolation);
        expect(error).toMatchObject({ code: 'ADJUSTMENT_SIGN_INVALID' });
        if (!(error instanceof Error)) throw error;
        return error.message;
      }
    });

    expect(messages).toEqual([
      'Receipt Adjustment sign is invalid',
      'Receipt Adjustment sign is invalid',
    ]);
  });

  it('小数・safe integer外のAdjustmentを拒否する', () => {
    for (const amount of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
      let failure: unknown;
      try {
        ReceiptAdjustmentAllocation.calculate(items, [
          { kind: 'Tax', amount, target: { scope: 'Receipt' } },
        ]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ReceiptAdjustmentViolation);
      expect(failure).toMatchObject({ code: 'ADJUSTMENT_AMOUNT_INVALID' });
    }
  });

  it('入力を変更せず、入力配列とは独立した不変結果を返す', () => {
    const inputItems = items.map((item) => ({ ...item }));
    const inputAdjustments = [
      { ...receiptDiscount, target: { scope: 'Receipt' as const } },
    ];
    const beforeItems = structuredClone(inputItems);
    const beforeAdjustments = structuredClone(inputAdjustments);

    const result = ReceiptAdjustmentAllocation.calculate(
      inputItems,
      inputAdjustments,
    );

    expect(inputItems).toEqual(beforeItems);
    expect(inputAdjustments).toEqual(beforeAdjustments);
    expect(result).not.toBe(inputItems);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
    expect(Object.isFrozen(result.allocations[0]?.amounts)).toBe(true);
  });
});
