/** Receipt Rootの不変条件に違反した理由を示す内部Domainコード。 */
export type ReceiptInvariantViolationCode =
  | 'RECEIPT_ID_INVALID'
  | 'ACTOR_REFERENCE_INVALID'
  | 'RECEIPT_DRAFT_INVALID'
  | 'RECEIPT_NOT_DRAFT'
  | 'VERSION_CONFLICT'
  | 'VERSION_OVERFLOW'
  | 'ACTOR_NOT_UPLOADER'
  | 'UTC_INSTANT_INVALID'
  | 'ITEM_FACT_INVALID'
  | 'CATEGORY_REFERENCE_INVALID'
  | 'OCCURRED_ON_INVALID'
  | 'TOTAL_INVALID'
  | 'ADJUSTMENT_INVALID'
  | 'RECEIPT_TOTAL_MISMATCH';

/** 入力値を公開Errorへ漏らさず、Receipt条件を拒否するDomain Error。 */
export class ReceiptInvariantViolation extends Error {
  /**
   * PIIや金額を含まない固定messageと失敗codeを持つ。
   * @param code Receipt条件の違反を識別する内部code。
   */
  constructor(
    /** Callerが入力値を解析せず失敗条件を分類するcode。 */
    readonly code: ReceiptInvariantViolationCode,
  ) {
    super('Receipt invariant violated');
    this.name = 'ReceiptInvariantViolation';
  }
}
