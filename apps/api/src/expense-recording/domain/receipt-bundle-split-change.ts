import type { GroupExpenseSnapshot } from './group-expense.js';
import type { ReceiptBundleEditingFacts } from './receipt-bundle-editing-facts.js';

/** 登録Participant集合と参加順を維持してBundle由来Expenseのpayer／割合だけを変える内部入力。 */
export type ChangeReceiptBundleSplit = {
  /** 現在Expenseの読取版。実保存CASはApplication／Storageの責務。 */
  readonly expectedExpenseVersion: number;
  /** 同判断点Receipt factsに期待する読取版。Source currentnessは証明しない。 */
  readonly expectedReceiptVersion: number;
  /** Receipt Policyを通過したCaller供給facts。公開認可capabilityとして使用しない。 */
  readonly bundleFact: ReceiptBundleEditingFacts;
  /** 本人性を確認済みのUploader参照。Domainは値一致のみ検証する。 */
  readonly actorSubject: string;
  /** Caller時計による有限操作日時。コピーしてUTC履歴へ保持する。 */
  readonly changedAt: Date;
  /** 登録済みParticipant集合内の変更後payer。 */
  readonly payerParticipantId: string;
  /** 登録Participant全員を重複なく指定する。joinOrderはRoot保持値を使う。 */
  readonly percentages: readonly {
    /** 登録時から維持するParticipant参照。追加・除外を認めない。 */
    readonly participantId: string;
    /** 0〜100の10%刻み、集合全体で100%。 */
    readonly percentage: number;
  }[];
};

/** 同Expense IDのpayer／割合変更履歴。amount訂正履歴と別に保持し保護保存Schemaを採用しない。 */
export type ReceiptBundleSplitChange = {
  /** 変更を行ったUploader参照。Logへ出さない。 */
  readonly actorSubject: string;
  /** Caller時刻からコピーした操作UTC。 */
  readonly at: string;
  /** 変更前のExpense版。 */
  readonly previousVersion: number;
  /** 変更成功後のExpense版。 */
  readonly version: number;
  /** 判断点Receipt／Bundle参照・版・Source額の不変コピー。 */
  readonly bundleFact: ReceiptBundleEditingFacts;
  /** 変更前の全Expense事実。 */
  readonly before: GroupExpenseSnapshot;
  /** payer／割合／負担だけを変えた全Expense事実。 */
  readonly after: GroupExpenseSnapshot;
};
