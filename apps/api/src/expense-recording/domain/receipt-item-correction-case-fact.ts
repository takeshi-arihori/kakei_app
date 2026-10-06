/** Callerが現在の関連Caseへ束縛する内部facts。認可capability・Source照会・保存CASの証拠ではない。 */
export type ReceiptItemCorrectionCaseFact = {
  /** 同判断点の関連Caseのcanonical UUID。初選択Caseと同一とは限らない。 */
  readonly caseId: string;
  /** 対象Bundleと一致させるCaseのGroup参照。 */
  readonly groupId: string;
  /** Case固定対象のうち、訂正Itemに対応するExpense参照。実所属はCallerが確認する。 */
  readonly expenseId: string;
  /** 現在Caseの正safe整数版。Root内比較は実currentnessを保証しない。 */
  readonly version: number;
  /** 初選択済み影響Bundleの明細訂正はRejectedだけを許可する。未知値も拒否する。 */
  readonly lifecycle: string;
};
