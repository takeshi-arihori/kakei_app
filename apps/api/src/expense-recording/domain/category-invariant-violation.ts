/** 公開Errorへ直結しない、カテゴリの内部拒否分類。 */
export type CategoryInvariantViolationCode =
  | 'CATEGORY_ID_EMPTY'
  | 'GROUP_ID_INVALID'
  | 'ACTOR_REFERENCE_INVALID'
  | 'ACTOR_NOT_OWNER'
  | 'GROUP_MISMATCH'
  | 'SYSTEM_CATEGORY_IMMUTABLE'
  | 'VERSION_CONFLICT'
  | 'UTC_INSTANT_INVALID'
  | 'NAME_FACT_INVALID'
  | 'STATUS_INVALID';

/** 名前や本人参照をmessageへ含めないDomain拒否。 */
export class CategoryInvariantViolation extends Error {
  /**
   * 入力値を解析せずに拒否を判別できるようにする。
   * @param code 公開応答への変換は後続Presentationが担う内部分類。
   */
  constructor(
    /** 認可・版・内部事実の違反を識別するコード。 */
    readonly code: CategoryInvariantViolationCode,
  ) {
    super('Category invariant violated');
    this.name = 'CategoryInvariantViolation';
  }
}
