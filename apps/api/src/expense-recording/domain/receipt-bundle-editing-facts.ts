/** Receiptの編集Policyを通過して取得する内部facts。認可tokenやSource Portではない。 */
export type ReceiptBundleEditingFacts = {
  /** 同判断点にCallerが読み取ったReceiptのopaque参照。 */
  readonly receiptId: string;
  /** Receipt内で登録済みのBundle参照。 */
  readonly bundleId: string;
  /** 初回Pairで対応した個別Expense参照。 */
  readonly expenseId: string;
  /** 初回PairのGroup参照。実所属はApplicationが確認する。 */
  readonly groupId: string;
  /** Policy判断に用いたReceipt版。実現在版や保存fenceの証明ではない。 */
  readonly receiptVersion: number;
  /** ReceiptのUploader参照。本人性はCallerが確立する。 */
  readonly uploaderSubject: string;
  /** Receiptで確認された購入暦日。 */
  readonly occurredOn: string;
  /** このBundleに所属するItemの調整後JPY整数合計。 */
  readonly adjustedAmount: number;
};
