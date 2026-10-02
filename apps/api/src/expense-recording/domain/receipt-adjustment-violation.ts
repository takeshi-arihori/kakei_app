/** Receipt Adjustment計算を拒否した理由を分類する内部Domainコード。 */
export type ReceiptAdjustmentViolationCode =
  | 'ITEM_REFERENCE_INVALID'
  | 'ITEM_AMOUNT_INVALID'
  | 'ITEM_REFERENCE_DUPLICATED'
  | 'ADJUSTMENT_KIND_INVALID'
  | 'ADJUSTMENT_AMOUNT_INVALID'
  | 'ADJUSTMENT_SIGN_INVALID'
  | 'ADJUSTMENT_TARGET_INVALID'
  | 'ADJUSTMENT_ITEM_NOT_FOUND'
  | 'RECEIPT_ADJUSTMENT_BASIS_ZERO'
  | 'ADJUSTED_AMOUNT_NEGATIVE'
  | 'ADJUSTED_AMOUNT_UNSAFE';

/** 不正なAdjustmentから部分的な配賦結果を返さないDomain拒否。 */
export class ReceiptAdjustmentViolation extends Error {
  /**
   * 入力金額や識別子をメッセージへ含めず拒否理由を固定する。
   * @param code Receipt Adjustmentの契約違反を表す内部コード。
   * @param message 入力値を含まない説明。
   */
  constructor(
    /** 入力値を解析せず失敗種別を分類するコード。 */
    readonly code: ReceiptAdjustmentViolationCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReceiptAdjustmentViolation';
  }
}
