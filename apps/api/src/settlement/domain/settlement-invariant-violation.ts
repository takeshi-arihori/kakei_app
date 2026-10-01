/** 精算の純計算を拒否する内部コード。公開Errorへの変換は別の境界で行う。 */
export type SettlementInvariantViolationCode =
  | 'PARTICIPANT_ID_EMPTY'
  | 'JOIN_ORDER_INVALID'
  | 'BALANCE_NOT_INTEGER'
  | 'PARTICIPANT_DUPLICATED'
  | 'JOIN_ORDER_DUPLICATED'
  | 'BALANCE_TOTAL_NOT_ZERO';

/** 金額やActorをmessageへ含めず、無効な精算計算を分類するDomain拒否。 */
export class SettlementInvariantViolation extends Error {
  /**
   * 入力値を開示せずに計算拒否を表す。
   * @param code 破られた精算Invariantの内部コード。
   * @param message 入力値を含めない固定の説明。
   */
  constructor(
    /** 拒否したInvariantを機械判定するためのコード。 */
    readonly code: SettlementInvariantViolationCode,
    message: string,
  ) {
    super(message);
    this.name = 'SettlementInvariantViolation';
  }
}
