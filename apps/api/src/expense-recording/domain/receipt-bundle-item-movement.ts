import type { GroupExpenseSnapshot } from './group-expense.js';
import type { ReceiptBundleEditingFacts } from './receipt-bundle-editing-facts.js';

/** 実Receipt移動の前後RootからCallerが取得する内部入力。公開認可capabilityではない。 */
export type ReflectReceiptBundleItemMovement = {
  /** 更新するExpenseの現在読取版。共通保存CASは外側の責務。 */
  readonly expectedExpenseVersion: number;
  /** Item移動前Receiptの読取版。実currentnessは証明しない。 */
  readonly expectedReceiptVersion: number;
  /** 移動前RootのPolicyを通過した当Bundleの値。 */
  readonly beforeBundleFact: ReceiptBundleEditingFacts;
  /** 同移動直後RootのPolicyを通過した同Pairの値。 */
  readonly afterBundleFact: ReceiptBundleEditingFacts;
  /** 本人性を外側で確認するUploader参照。 */
  readonly actorSubject: string;
  /** Caller時計の有限日時。UTC文字列へコピーする。 */
  readonly changedAt: Date;
};

/** Item所属移動を当Expenseの額・負担へ反映した不変履歴。保存Schemaではない。 */
export type ReceiptBundleItemMovement = {
  /** Uploaderと値比較した操作Actor。Logへ出さない。 */
  readonly actorSubject: string;
  /** 入力Dateからコピーした操作UTC。 */
  readonly at: string;
  /** 移動反映前のExpense版。 */
  readonly previousVersion: number;
  /** 移動反映後のExpense版。同額移動でも履歴を進める。 */
  readonly version: number;
  /** 移動前Receiptの参照・版・額の不変コピー。 */
  readonly beforeBundleFact: ReceiptBundleEditingFacts;
  /** 移動直後Receiptの同Pair参照・版・額の不変コピー。 */
  readonly afterBundleFact: ReceiptBundleEditingFacts;
  /** 登録集合・payer／割合と旧額を持つ変更前事実。 */
  readonly before: GroupExpenseSnapshot;
  /** 同登録集合・payer／割合で新額を配賦した変更後事実。 */
  readonly after: GroupExpenseSnapshot;
};
