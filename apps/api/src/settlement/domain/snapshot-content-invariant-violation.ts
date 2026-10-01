/** 固定算術内容の矛盾を分類する内部コード。公開APIのError契約とは独立。 */
export type SnapshotContentInvariantViolationCode =
  | 'GROUP_REFERENCE_INVALID'
  | 'SELECTION_EMPTY'
  | 'EXPENSE_REFERENCE_EMPTY'
  | 'EXPENSE_DUPLICATED'
  | 'EXPENSE_GROUP_MISMATCH'
  | 'EXPENSE_AMOUNT_INVALID'
  | 'ALLOCATION_COUNT_INVALID'
  | 'PAYER_NOT_PARTICIPANT'
  | 'ALLOCATION_PERCENTAGE_INVALID'
  | 'ALLOCATION_PERCENTAGE_TOTAL_INVALID'
  | 'ALLOCATION_BURDEN_INVALID'
  | 'ALLOCATION_BURDEN_TOTAL_INVALID'
  | 'ZERO_SHARE_BURDEN_INVALID'
  | 'PARTICIPANT_ORDER_CONFLICT';

/** 値・選択集合・保存則が矛盾するSnapshot内容を、入力値を開示せず拒否する。 */
export class SnapshotContentInvariantViolation extends Error {
  /**
   * 固定内容の生成を拒否する。入力額や参照をmessageへ含めない。
   * @param code 破られた内容Invariantの内部分類。
   */
  constructor(
    /** 内容を生成できない理由。認可や予約競合の結果ではない。 */
    readonly code: SnapshotContentInvariantViolationCode,
  ) {
    super('Invalid settlement snapshot content');
    this.name = 'SnapshotContentInvariantViolation';
  }
}
