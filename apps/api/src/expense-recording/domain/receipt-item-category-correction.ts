import type { ConfirmedReceiptSnapshot } from './receipt.js';

/** Callerが現在の関連Caseへ束縛する内部facts。認可capability・Source照会・保存CASの証拠ではない。 */
export type ReceiptItemCategoryCaseFact = {
  /** 同判断点の関連Caseのcanonical UUID。初選択Caseと同一とは限らない。 */
  readonly caseId: string;
  /** 対象Bundleと一致させるCaseのGroup参照。 */
  readonly groupId: string;
  /** Case固定対象のうち、訂正Itemに対応するExpense参照。実所属はCallerが確認する。 */
  readonly expenseId: string;
  /** 現在Caseの正safe整数版。Root内比較は実currentnessを保証しない。 */
  readonly version: number;
  /** 初選択済みItemの訂正はRejectedだけを許可する。未知値も拒否する。 */
  readonly lifecycle: string;
};

/** 登録済みConfirmed Item一件のCategoryだけを訂正する内部操作。 */
export type CorrectReceiptItemCategory = {
  /** 同判断点のReceipt読取版。保存CASは別責務。 */
  readonly expectedVersion: number;
  /** 本人性を外側で確立したUploaderまたは現在Group Ownerの安定参照。 */
  readonly actorSubject: string;
  /** 同Group・同判断点の現在Owner参照。Client申告を信用しない。 */
  readonly currentOwnerSubject: string;
  /** 対象ItemのBundleに束縛するGroup参照。 */
  readonly groupId: string;
  /** 履歴へUTCコピーするCaller時計の有限日時。 */
  readonly correctedAt: Date;
  /** 同一性を維持して訂正する登録済みItem。未割当Itemの一般編集は別操作。 */
  readonly itemId: string;
  /** Active・実在・Group適合を外側で確認する新Category参照。 */
  readonly categoryId: string;
  /** 初選択済みならCase期待版。未選択なら明示null。 */
  readonly expectedCaseVersion: number | null;
  /** 初選択済みなら同判断点の関連Case facts。未選択なら明示null。 */
  readonly caseFact: ReceiptItemCategoryCaseFact | null;
};

/** Item値訂正の不変履歴。Audit Logや保護保存Schemaとは区別する。 */
export type ReceiptItemCategoryCorrectedChange = {
  /** Item Categoryだけを訂正した事実。Bundle永久lockを解除しない。 */
  readonly action: 'ItemCategoryCorrected';
  /** 訂正資格を値比較した安定Actor。Logへ出さない。 */
  readonly actorSubject: string;
  /** Caller日時をコピーした訂正UTC。 */
  readonly at: string;
  /** 前後Snapshotで同じ訂正対象Item参照。 */
  readonly itemId: string;
  /** 訂正判断時のReceipt版。 */
  readonly previousVersion: number;
  /** 訂正成功後のReceipt版。 */
  readonly version: number;
  /** 判断に用いた関連Case factsの不変コピー。未選択ならnull。 */
  readonly caseFact: ReceiptItemCategoryCaseFact | null;
  /** 旧Categoryと既存Pair・初選択・金融値を保持する不変事実。 */
  readonly before: ConfirmedReceiptSnapshot;
  /** 対象Category以外を維持した訂正後の不変事実。 */
  readonly after: ConfirmedReceiptSnapshot;
};
