import { ReceiptInvariantViolation } from '../receipt-invariant-violation.js';

/** Draftから確定後まで維持するopaqueなReceipt同一性。 */
export class ReceiptId {
  private constructor(
    /** 呼出元が発番した値。形式・発番・保存時一意性はここで決めない。 */
    readonly value: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Receipt参照を不変値へ変換する。
   * @param value 空でないReceipt参照。正規化やID発番は行わない。
   * @returns 比較可能な不変Receipt ID。
   * @throws ReceiptInvariantViolation 参照が空またはstring以外の場合。
   */
  static from(value: string): ReceiptId {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ReceiptInvariantViolation('RECEIPT_ID_INVALID');
    }
    return new ReceiptId(value);
  }

  /**
   * IDの文字列値で同一Receiptか比較する。
   * @param other 比較するReceipt ID。
   * @returns 同じ値ならtrue。
   */
  equals(other: ReceiptId): boolean {
    return this.value === other.value;
  }
}
