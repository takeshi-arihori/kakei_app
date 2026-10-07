import type { ReceiptAdjustmentInput } from './receipt-adjustment.js';
import type { ReceiptDraftSnapshot, ReceiptItemCandidate } from './receipt.js';

/** Uploaderが確定前候補を置換する内部入力。本人性・実保存は外側の責務。 */
export type EditReceiptDraft = {
  /** 操作時の現在Root版。永続層のCASを代替しない。 */
  readonly expectedVersion: number;
  /** Sourceで確認するActor参照。記録済みUploaderだけを許可する。 */
  readonly actorSubject: string;
  /** 有限Dateの操作時刻。実変更だけUTC履歴へコピーする。 */
  readonly editedAt: Date;
  /** 欠損や未完成値を許す購入日候補。暦日検証は明示確認時に行う。 */
  readonly occurredOn: string | null;
  /** 未確認の宣言合計候補。JPY整数・合計一致は明示確認時に検証する。 */
  readonly declaredTotal: number;
  /** 記載順を含めて置換する全Item候補。空配列も編集中として保持する。 */
  readonly items: readonly ReceiptItemCandidate[];
  /** 順序・種別・額・対象を含めて置換する全Adjustment候補。配賦は確定時に検証する。 */
  readonly adjustments: readonly ReceiptAdjustmentInput[];
};

/** 同ReceiptのDraft候補が実際に変わった不変の前後履歴。 */
export type ReceiptDraftEditedChange = {
  /** 候補の実変更を識別し、確定と区別する。 */
  readonly action: 'DraftEdited';
  /** 操作時のUploader参照。実本人性の証拠ではない。 */
  readonly actorSubject: string;
  /** 有限DateからコピーしたUTC操作時刻。実Retention実行の証拠ではない。 */
  readonly at: string;
  /** 編集前のRoot版。 */
  readonly previousVersion: number;
  /** 実変更で一つ進めたRoot版。 */
  readonly version: number;
  /** 入力mutationから隔離した編集前のDraft。 */
  readonly before: ReceiptDraftSnapshot;
  /** 同Receipt ID・Uploaderを維持した編集後のDraft。 */
  readonly after: ReceiptDraftSnapshot;
};
