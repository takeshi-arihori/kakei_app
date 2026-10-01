import { ExpenseInvariantViolation } from '../expense-invariant-violation.js';

/** 支出の同一性を表す値。発番方式と永続化形式は後続の境界で定める。 */
export class ExpenseId {
  private constructor(
    /** 訂正やCase選択を通じて維持するopaque識別子。 */
    readonly value: string,
  ) {
    Object.freeze(this);
  }

  /**
   * 識別子を発番・正規化せず、内部入力の空値だけを拒否する。
   * @param value 前段で割り当てた空白だけではない識別子。
   * @returns 外部から変更できない支出識別子。
   * @throws ExpenseInvariantViolation 識別子が空の場合。
   */
  static from(value: string): ExpenseId {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ExpenseInvariantViolation(
        'IDENTIFIER_EMPTY',
        'Expense identifier must not be empty',
      );
    }
    return new ExpenseId(value);
  }

  /**
   * 他の支出識別子との値の等価性を判定する。
   * @param other 比較対象の支出識別子。
   * @returns 同じ支出を指す場合true。
   */
  equals(other: ExpenseId): boolean {
    return this.value === other.value;
  }
}
