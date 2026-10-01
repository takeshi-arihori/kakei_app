import { ExpenseInvariantViolation } from '../expense-invariant-violation.js';

/** 購入の暦日。UTC Timestampへ変換して購入月をずらさない。 */
export class OccurredOn {
  private constructor(
    /** YYYY-MM-DDで固定した購入暦日。時刻・Timezoneは含まない。 */
    readonly value: string,
  ) {
    Object.freeze(this);
  }

  /**
   * 固定長の暦日を検証し、Dateの自動繰り上がりを許さない。
   * @param value YYYY-MM-DD形式の実在するGregorian暦日。
   * @returns 変更できない購入暦日。
   * @throws ExpenseInvariantViolation 形式または暦日が無効の場合。
   */
  static from(value: string): OccurredOn {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const leapYear = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
      const daysInMonth = [
        31,
        leapYear ? 29 : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
      ];
      if (
        month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <= daysInMonth[month - 1]
      ) {
        return new OccurredOn(value);
      }
    }
    throw new ExpenseInvariantViolation(
      'OCCURRED_ON_INVALID',
      'OccurredOn must be a valid YYYY-MM-DD calendar date',
    );
  }

  /**
   * 購入暦日を時刻変換せず比較する。
   * @param other 比較対象の購入暦日。
   * @returns 同じ購入暦日の場合true。
   */
  equals(other: OccurredOn): boolean {
    return this.value === other.value;
  }
}
