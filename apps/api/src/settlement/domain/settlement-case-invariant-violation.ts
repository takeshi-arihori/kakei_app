/** Case承認・再申請・取り下げ・支払の拒否分類。公開Error契約や認可結果ではない。 */
export type SettlementCaseInvariantViolationCode =
  | 'SNAPSHOT_CONTENT_INVALID'
  | 'CASE_ID_INVALID'
  | 'SNAPSHOT_ID_INVALID'
  | 'INSTRUCTION_ID_INVALID'
  | 'ACTOR_SUBJECT_EMPTY'
  | 'PARTICIPANT_ID_EMPTY'
  | 'UTC_INSTANT_INVALID'
  | 'INSTRUCTION_COUNT_MISMATCH'
  | 'INSTRUCTION_ID_DUPLICATED'
  | 'CASE_NOT_AWAITING_APPROVAL'
  | 'CASE_VERSION_CONFLICT'
  | 'SNAPSHOT_MISMATCH'
  | 'PARTICIPANT_NOT_REQUIRED'
  | 'APPROVAL_ALREADY_RECORDED'
  | 'REJECTION_REASON_EMPTY'
  | 'CASE_NOT_REJECTED'
  | 'CASE_CANNOT_BE_WITHDRAWN'
  | 'CURRENT_OWNER_SUBJECT_EMPTY'
  | 'ACTOR_NOT_CASE_APPLICANT_OR_OWNER'
  | 'REVISION_GROUP_MISMATCH'
  | 'TARGET_EXPENSE_SET_MISMATCH'
  | 'SNAPSHOT_ID_REUSED'
  | 'INSTRUCTION_ID_REUSED'
  | 'WITHDRAWAL_REASON_EMPTY'
  | 'CASE_NOT_PAYMENT_ACTIVE'
  | 'INSTRUCTION_NOT_FOUND'
  | 'ACTOR_NOT_PAYMENT_PAYER'
  | 'PAYMENT_AMOUNT_MISMATCH'
  | 'ATTEMPT_ID_INVALID'
  | 'ATTEMPT_ID_REUSED'
  | 'ATTEMPT_ORDINAL_INVALID'
  | 'INSTRUCTION_PARTICIPANTS_INVALID'
  | 'INSTRUCTION_NOT_UNPAID'
  | 'ATTEMPT_MISMATCH'
  | 'ATTEMPT_NOT_REPORTED'
  | 'ACTOR_NOT_PAYMENT_PAYEE'
  | 'PAYMENT_RETURN_REASON_EMPTY';

/** 業務状態を変えずに返す拒否。参照・理由・金額をmessageへ含めない。 */
export class SettlementCaseInvariantViolation extends Error {
  /**
   * 機械判定用の分類だけを保持する。
   * @param code 入力またはCase状態の矛盾を表す固定分類。
   */
  constructor(
    /** Applicationで個別に扱う内部分類。公開Errorは別境界で変換する。 */
    readonly code: SettlementCaseInvariantViolationCode,
  ) {
    super('Settlement case invariant violated');
    this.name = 'SettlementCaseInvariantViolation';
  }
}
