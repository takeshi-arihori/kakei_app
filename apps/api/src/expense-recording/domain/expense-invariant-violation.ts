/** 手入力支出の生成を拒否する、公開Errorへ直結しない内部業務コード。 */
export type ExpenseInvariantViolationCode =
  | 'IDENTIFIER_EMPTY'
  | 'GROUP_ID_INVALID'
  | 'OCCURRED_ON_INVALID'
  | 'AMOUNT_INVALID'
  | 'PARTICIPANT_COUNT_INVALID'
  | 'PARTICIPANT_DUPLICATED'
  | 'JOIN_ORDER_INVALID'
  | 'JOIN_ORDER_DUPLICATED'
  | 'PERCENTAGE_INVALID'
  | 'PERCENTAGE_TOTAL_INVALID'
  | 'PAYER_NOT_PARTICIPANT';

/** 無効な入力から支出を生成しないための、機械判定可能なDomain拒否。 */
export class ExpenseInvariantViolation extends Error {
  /**
   * 金額や本人識別子をmessageへ含めずに拒否理由を表す。
   * @param code 支出Invariantの違反を識別する内部コード。
   * @param message 入力値を含まない固定の説明。
   */
  constructor(
    /** 呼出し側が入力値を解析せず拒否を分類するためのコード。 */
    readonly code: ExpenseInvariantViolationCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExpenseInvariantViolation';
  }
}
