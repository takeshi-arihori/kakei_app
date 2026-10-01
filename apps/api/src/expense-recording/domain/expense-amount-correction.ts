import type { GroupExpenseSnapshot } from './group-expense.js';

/** Applicationが同判断点Sourceから確認する内部事実。公開Portや認可証拠ではない。 */
export type ExpenseCorrectionCaseFact = {
  /** 対象CaseのGroup。 */
  readonly groupId: string;
  /** このCaseの固定対象である訂正Expense参照。対象全件の確認はSource PRE。 */
  readonly expenseId: string;
  /** ApplicationがSourceへ束縛したcanonical Case参照。 */
  readonly caseId: string;
  /** 同判断点に読み取ったCase版。保存CASではない。 */
  readonly version: number;
  /** Rejected、または全解放済みWithdrawn／Cancelledだけを許可する。 */
  readonly lifecycle: string;
  /** Sourceが確認した全対象の実解放。Client申告を信用する値ではない。 */
  readonly allTargetsReleased: boolean;
};

/** 金額だけを訂正する内部操作。通常編集や他Fieldの許可を追加しない。 */
export type CorrectExpenseAmount = {
  /** 読取時のExpense版。 */
  readonly expectedExpenseVersion: number;
  /** 操作が想定するCase版。 */
  readonly expectedCaseVersion: number;
  /** ApplicationがSource確認を済ませた同判断点事実。 */
  readonly caseFact: ExpenseCorrectionCaseFact;
  /** 本人性を確立済みの安定Actor。Participant寿命とは別。 */
  readonly actorSubject: string;
  /** 同Group・同判断点の現在Owner。実認可はApplication PRE。 */
  readonly currentOwnerSubject: string;
  /** 訂正後の非負JPY整数。safe integerは技術制約。 */
  readonly amount: number;
  /** 空白だけを拒否し元の理由を保持する。 */
  readonly reason: string;
  /** 信頼するCaller時計。Domainは現在時刻を取得しない。 */
  readonly correctedAt: Date;
};

/** 同ID支出の版付き不変訂正記録。保護保存Schemaとして採用しない。 */
export type ExpenseAmountCorrection = {
  /** 変更した安定Actor。Logへ出さない。 */
  readonly actorSubject: string;
  /** コピー済みの操作UTC。 */
  readonly correctedAt: string;
  /** 変更理由の元値。 */
  readonly reason: string;
  /** 訂正直前のExpense版。 */
  readonly previousVersion: number;
  /** 訂正成功後のExpense版。 */
  readonly version: number;
  /** Source判断に束縛したCase参照・版・Lifecycle。 */
  readonly caseFact: ExpenseCorrectionCaseFact;
  /** 訂正前の全事実。旧Snapshotへのmutationは伝播させない。 */
  readonly before: GroupExpenseSnapshot;
  /** 訂正後の額と再配賦、維持した登録facts。 */
  readonly after: GroupExpenseSnapshot;
};
