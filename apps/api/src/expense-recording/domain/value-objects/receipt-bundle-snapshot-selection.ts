import { ReceiptInvariantViolation } from '../receipt-invariant-violation.js';
import { ReceiptBundleId } from './receipt-bundle-id.js';
import { ExpenseId } from './expense-id.js';

/** 初選択としてSource確認後にCallerが供給する内部facts。実証済みPortではない。 */
export type ReceiptBundleSnapshotSelectionInput = {
  /** 初回対応が登録済みのBundle参照。 */
  readonly bundleId: string;
  /** Snapshotに選択された対応Expense参照。 */
  readonly expenseId: string;
  /** SourceとBundle対応で同一にするGroup参照。 */
  readonly groupId: string;
  /** 初選択を所有するCaseの内部canonical UUID参照。 */
  readonly caseId: string;
  /** 初選択の不変Revisionの内部canonical UUID参照。 */
  readonly snapshotId: string;
  /** Sourceの選択Actor安定参照。記録しても本人性・資格は証明しない。 */
  readonly actorSubject: string;
  /** Sourceが供給する初選択時刻。Domainは実最初の時刻を照会しない。 */
  readonly selectedAt: Date;
};

const canonicalReference = (value: string): boolean =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

/** 初Snapshot選択の不変値。Caseの状態や可変Lifecycleを所有しない。 */
export class ReceiptBundleSnapshotSelection {
  private constructor(
    /** 編集lockの対象となるReceipt内Bundle参照。 */
    readonly bundleId: ReceiptBundleId,
    /** 初回Pairで対応したExpense参照。 */
    readonly expenseId: ExpenseId,
    /** 選択SourceとPairを束縛するGroup参照。 */
    readonly groupId: string,
    /** 初選択を所有するCase参照。実存在の証拠ではない。 */
    readonly caseId: string,
    /** 初選択Revisionの参照。最新Case状態から更新しない。 */
    readonly snapshotId: string,
    /** Sourceに記録された選択Actor。Uploader編集権限とは別のfacts。 */
    readonly actorSubject: string,
    /** DateからコピーしたSourceのUTC初選択時刻。 */
    readonly selectedAt: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Source factsの表現を検証し、値として固定する。
   * @param input 同判断点のSource確認は将来Applicationが担う初選択facts。
   * @returns 入力変更やCaseの現在状態を伝播させない不変値。
   * @throws ReceiptInvariantViolation 参照、ActorまたはUTC日時が不正な場合。
   */
  static from(
    input: ReceiptBundleSnapshotSelectionInput,
  ): ReceiptBundleSnapshotSelection {
    const bundleId = ReceiptBundleId.from(input.bundleId);
    if (
      typeof input.groupId !== 'string' ||
      input.groupId.trim().length === 0 ||
      !canonicalReference(input.caseId) ||
      !canonicalReference(input.snapshotId)
    ) {
      throw new ReceiptInvariantViolation('BUNDLE_SNAPSHOT_REFERENCE_INVALID');
    }
    let expenseId: ExpenseId;
    try {
      expenseId = ExpenseId.from(input.expenseId);
    } catch {
      throw new ReceiptInvariantViolation('BUNDLE_SNAPSHOT_REFERENCE_INVALID');
    }
    if (
      typeof input.actorSubject !== 'string' ||
      input.actorSubject.trim().length === 0
    ) {
      throw new ReceiptInvariantViolation('ACTOR_REFERENCE_INVALID');
    }
    if (
      !(input.selectedAt instanceof Date) ||
      !Number.isFinite(input.selectedAt.getTime())
    ) {
      throw new ReceiptInvariantViolation('UTC_INSTANT_INVALID');
    }
    return new ReceiptBundleSnapshotSelection(
      bundleId,
      expenseId,
      input.groupId,
      input.caseId,
      input.snapshotId,
      input.actorSubject,
      input.selectedAt.toISOString(),
    );
  }

  /**
   * 全Source factsを値で比較し、同一の初選択か判断する。
   * @param other 比較する初選択値。
   * @returns Bundle、Expense、Source参照、Actor、UTC日時がすべて同一ならtrue。
   */
  equals(other: ReceiptBundleSnapshotSelection): boolean {
    return (
      this.bundleId.equals(other.bundleId) &&
      this.expenseId.equals(other.expenseId) &&
      this.groupId === other.groupId &&
      this.caseId === other.caseId &&
      this.snapshotId === other.snapshotId &&
      this.actorSubject === other.actorSubject &&
      this.selectedAt === other.selectedAt
    );
  }
}
