import { ReceiptInvariantViolation } from '../receipt-invariant-violation.js';

/** Receipt内のBundle対応を追跡するopaqueな同一性。 */
export class ReceiptBundleId {
  private constructor(
    /** Caller発番の安定参照。発番・保存形式はここで決めない。 */
    readonly value: string,
  ) {
    Object.freeze(this);
  }

  /**
   * 空参照を拒否し、正規化せず不変値として保持する。
   * @param value 空白だけではない内部Bundle参照。
   * @returns 比較可能な不変Bundle ID。
   * @throws ReceiptInvariantViolation string以外または空参照の場合。
   */
  static from(value: string): ReceiptBundleId {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ReceiptInvariantViolation('BUNDLE_ID_INVALID');
    }
    return new ReceiptBundleId(value);
  }

  /**
   * 値で同じBundleを指すか比較する。
   * @param other 比較対象のBundle参照。
   * @returns 同一参照値の場合true。
   */
  equals(other: ReceiptBundleId): boolean {
    return this.value === other.value;
  }
}
