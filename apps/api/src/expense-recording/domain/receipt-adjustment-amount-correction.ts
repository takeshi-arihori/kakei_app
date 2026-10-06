import type { ReceiptItemAmountAffectedCase } from './receipt-item-amount-correction.js';
import type { GroupExpenseSnapshot } from './group-expense.js';
import type { ConfirmedReceiptSnapshot } from './receipt.js';
import type { ReceiptItemCorrectionCaseFact } from './receipt-item-correction-case-fact.js';

/** 財務影響が及ぶ登録済みBundleに同判断点の関連Caseを束縛する内部値。 */
export type ReceiptAdjustmentAmountAffectedCase = ReceiptItemAmountAffectedCase;

/** 既存Adjustment金額の内部訂正入力。認可・保存・再送の公開契約ではない。 */
export type CorrectReceiptAdjustmentAmount = {
  /** 実保存CASとは区別するReceipt現在読取版。 */
  readonly expectedVersion: number;
  /** 本人性を外側で確立するUploaderまたは現在Ownerの安定参照。 */
  readonly actorSubject: string;
  /** 同Group・同判断点の現在Owner。Client申告を信用しない。 */
  readonly currentOwnerSubject: string;
  /** 対象および全影響Bundleへ束縛するGroup参照。 */
  readonly groupId: string;
  /** 履歴へUTCコピーする有限操作Date。 */
  readonly correctedAt: Date;
  /** Expenseの訂正履歴と共有する非空理由。元文字列を保持しLogへ出さない。 */
  readonly reason: string;
  /** 期待Receipt版へ束縛する、既存Adjustmentの0-based位置。 */
  readonly adjustmentIndex: number;
  /** 種別の符号を維持する新しい非0 safe JPY整数。Product上限を意味しない。 */
  readonly amount: number;
  /** 再配賦後の全Item合計と一致する確認済みReceipt合計。 */
  readonly declaredTotal: number;
  /** 影響する登録済みBundleごとの現在Case facts。入力順は意味を持たない。 */
  readonly affectedCaseFacts: readonly ReceiptAdjustmentAmountAffectedCase[];
};

/** Adjustment額と全再配賦の前後をReceiptが保持する不変業務履歴。保存Schemaではない。 */
export type ReceiptAdjustmentAmountCorrectedChange = {
  /** 既存Adjustmentの額だけを明示訂正した事実。永久Bundle lockを解除しない。 */
  readonly action: 'AdjustmentAmountCorrected';
  /** Uploaderまたは現在Ownerと値一致した安定Actor。 */
  readonly actorSubject: string;
  /** 訂正時に比較したOwner。実本人性・currentnessは保証しない。 */
  readonly currentOwnerSubject: string;
  /** 全Pairに一致する訂正Group参照。 */
  readonly groupId: string;
  /** 有限操作DateからコピーしたUTC時刻。 */
  readonly at: string;
  /** 入力の非空理由をそのまま保持する。 */
  readonly reason: string;
  /** 同期待版Receipt内のAdjustment位置。種別・適用先を維持する。 */
  readonly adjustmentIndex: number;
  /** 訂正判断時のReceipt版。 */
  readonly previousVersion: number;
  /** Adjustment額変更成功後のReceipt版。 */
  readonly version: number;
  /** ReceiptのBundle順に固定した影響集合とCaseコピー。 */
  readonly affectedCaseFacts: readonly ReceiptAdjustmentAmountAffectedCase[];
  /** Adjustment額・調整後Item額・全Pair・初選択を保持する訂正前事実。 */
  readonly before: ConfirmedReceiptSnapshot;
  /** 全配賦・合計を再計算してPair・初選択を維持した訂正後事実。 */
  readonly after: ConfirmedReceiptSnapshot;
};

/** 実Receipt訂正へ既存Expenseの現在版を束縛する反映入力。DTOは認可capabilityではない。 */
export type ReflectReceiptAdjustmentAmountCorrection = {
  /** 更新するExpenseの読取版。共通保存CASは別責務。 */
  readonly expectedExpenseVersion: number;
  /** 実訂正前Receiptの読取版。Source現在版はCallerが確認する。 */
  readonly expectedReceiptVersion: number;
  /** 実Receipt訂正履歴。Callerは実Source前後と全影響Rootを同じcommitへ束縛する。 */
  readonly change: ReceiptAdjustmentAmountCorrectedChange;
};

/** 1つの影響Expenseに対する額・負担反映の不変業務履歴。 */
export type ReceiptAdjustmentAmountCorrection = {
  /** Receiptで資格比較した訂正Actor。 */
  readonly actorSubject: string;
  /** Receipt訂正と同じ操作UTC。 */
  readonly at: string;
  /** Receipt訂正と同じ元理由。 */
  readonly reason: string;
  /** 財務影響の起点となったAdjustment位置。Receiptの期待版と一体で識別する。 */
  readonly adjustmentIndex: number;
  /** 実訂正に束縛した同Receipt参照。 */
  readonly receiptId: string;
  /** 同Expense IDを維持する影響Bundle参照。 */
  readonly bundleId: string;
  /** 訂正前Receipt読取版。 */
  readonly previousReceiptVersion: number;
  /** 訂正後Receipt版。 */
  readonly receiptVersion: number;
  /** 反映前Expense版。 */
  readonly previousVersion: number;
  /** 反映後Expense版。同額でも影響Item factsの変更を履歴へ残す。 */
  readonly version: number;
  /** 当Bundleの判断に用いた現在Caseの不変コピー。未選択ならnull。 */
  readonly caseFact: ReceiptItemCorrectionCaseFact | null;
  /** 登録集合・現在payer／割合と旧額を持つExpense前事実。 */
  readonly before: GroupExpenseSnapshot;
  /** 同登録集合・payer／割合で訂正後額を配賦したExpense後事実。 */
  readonly after: GroupExpenseSnapshot;
};
