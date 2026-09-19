export type Currency = 'JPY';

export class Money {
  private constructor(
    readonly amount: number,
    readonly currency: Currency,
  ) {}

  static jpy(amount: number): Money {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error('JPY amount must be a non-negative safe integer');
    }

    return new Money(amount, 'JPY');
  }

  equals(other: Money): boolean {
    return this.amount === other.amount && this.currency === other.currency;
  }
}
