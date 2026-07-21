import { describe, expect, it } from 'vitest';

import { Money } from './money.js';

describe('Money', () => {
  it('JPYの整数金額を値として保持する', () => {
    expect(Money.jpy(1_200).amount).toBe(1_200);
    expect(Money.jpy(1_200).currency).toBe('JPY');
  });

  it('同じ金額と通貨を持つMoneyを等価と判定する', () => {
    expect(Money.jpy(1_200).equals(Money.jpy(1_200))).toBe(true);
    expect(Money.jpy(1_200).equals(Money.jpy(1_201))).toBe(false);
  });

  it.each([-1, 10.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'JPYとして不正な金額 %s を拒否する',
    (amount) => {
      expect(() => Money.jpy(amount)).toThrow(
        'JPY amount must be a non-negative safe integer',
      );
    },
  );
});
