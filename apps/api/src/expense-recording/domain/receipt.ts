import { CategoryId } from './value-objects/category-id.js';
import { OccurredOn } from './value-objects/occurred-on.js';
import { ReceiptId } from './value-objects/receipt-id.js';
import {
  ReceiptAdjustmentAllocation,
  type ReceiptAdjustmentAllocationResult,
  type ReceiptAdjustmentInput,
} from './receipt-adjustment.js';
import { ReceiptAdjustmentViolation } from './receipt-adjustment-violation.js';
import {
  ReceiptInvariantViolation,
  type ReceiptInvariantViolationCode,
} from './receipt-invariant-violation.js';

/** Draftで保持する、未確認Item候補の入力事実。 */
export type ReceiptItemCandidate = {
  /** Receipt内の安定Item参照。Adjustmentの対象にも使う。 */
  readonly id: string;
  /** OCR等から得た品名候補。品名の正規化・Product Validationは別Gate。 */
  readonly name: string;
  /** Adjustment前の候補JPY額。確定時に再検証する。 */
  readonly amount: number;
  /** Item単位のCategory候補参照。現在状態の照会はApplication責務。 */
  readonly categoryId: string;
};

/** Uploaderが手動確認したItemの入力事実。 */
export type ReviewedReceiptItem = {
  /** Receipt内で一意なItem参照。 */
  readonly id: string;
  /** Uploaderが確認した品名。命名Validationはここで追加しない。 */
  readonly name: string;
  /** Adjustment前の確認済みJPY整数額。 */
  readonly amount: number;
  /** Item単位の確認済みCategory参照。 */
  readonly categoryId: string;
};

/** ReceiptがDraftで所有する未確認候補facts。 */
export type ReceiptDraftInput = {
  /** 呼出元が用意するReceipt参照。 */
  readonly id: string;
  /** Draftの業務上のUploader安定参照。本人性の証明ではない。 */
  readonly uploaderSubject: string;
  /** 未確認の購入日候補。欠損・不正値は確定時に拒否する。 */
  readonly occurredOn: string | null;
  /** 未確認の宣言Receipt合計候補。JPY整数としての検証は確定時に行う。 */
  readonly declaredTotal: number;
  /** OCR等から得た未確認Item候補をReceipt記載順に保持する。 */
  readonly items: readonly ReceiptItemCandidate[];
  /** 未確認Adjustment候補。品目・符号等は確定時に再検証する。 */
  readonly adjustments: readonly ReceiptAdjustmentInput[];
};

/** DraftからConfirmedへ移すUploaderの明示的な確認入力。 */
export type ConfirmReceipt = {
  /** 操作を判断する現在Root版。永続層のCAS証拠ではない。 */
  readonly expectedVersion: number;
  /** Sourceから確認されたActor参照。ここで比較しても本人性は証明しない。 */
  readonly actorSubject: string;
  /** 履歴へ記録する確定操作時刻。UTCとして有限Dateを渡す。 */
  readonly confirmedAt: Date;
  /** Uploaderが確認した購入暦日。 */
  readonly occurredOn: string;
  /** Uploaderが確認したReceipt合計のJPY整数額。 */
  readonly declaredTotal: number;
  /** Uploaderが確認・修正したItem facts。Draft候補を暗黙採用しない。 */
  readonly items: readonly ReviewedReceiptItem[];
  /** Uploaderが確認・修正・削除したAdjustment facts。 */
  readonly adjustments: readonly ReceiptAdjustmentInput[];
};

/** Rootが保持するDraft候補の不変Snapshot。 */
export type ReceiptDraftSnapshot = {
  /** DraftからConfirmedまで保たれる同一Receipt参照。 */
  readonly id: ReceiptId;
  /** DraftのSource OwnerであるUploader参照。 */
  readonly uploaderSubject: string;
  /** 未確認の日付候補。 */
  readonly occurredOn: string | null;
  /** 未確認の宣言合計候補。 */
  readonly declaredTotal: number;
  /** 未確認Item候補の不変コピー。 */
  readonly items: readonly ReceiptItemCandidate[];
  /** 未確認Adjustment候補の不変コピー。 */
  readonly adjustments: readonly ReceiptAdjustmentInput[];
  /** Receiptの現在状態。 */
  readonly status: 'Draft';
};

/** 手動確認後のItemと調整前後の額を固定する不変値。 */
export type ConfirmedReceiptItem = {
  /** Draftから引き継いだReceipt内Item参照。 */
  readonly id: string;
  /** Uploaderが確認した品名fact。 */
  readonly name: string;
  /** Uploaderが確認したItem Category参照。 */
  readonly categoryId: CategoryId;
  /** Adjustmentを適用する前のJPY額。 */
  readonly originalAmount: number;
  /** #175の全Adjustmentを適用した後のJPY額。 */
  readonly adjustedAmount: number;
};

/** 手動確認後のReceipt全体facts。 */
export type ConfirmedReceiptSnapshot = {
  /** Draftから変わらないReceipt同一性。 */
  readonly id: ReceiptId;
  /** Source OwnerであるUploader参照。 */
  readonly uploaderSubject: string;
  /** 有効性を確認した購入暦日。 */
  readonly occurredOn: OccurredOn;
  /** 調整後Item合計に一致する宣言Receipt合計。 */
  readonly declaredTotal: number;
  /** Uploader確認後のItemと調整後額をReceipt順で保持する。 */
  readonly items: readonly ConfirmedReceiptItem[];
  /** Uploaderが確認したAdjustment facts。 */
  readonly adjustments: readonly ReceiptAdjustmentInput[];
  /** Adjustmentごとの符号付きItem配賦額。 */
  readonly allocations: readonly ReceiptAdjustmentAllocationResult[];
  /** Receiptの現在状態。共有・保存状態の証明ではない。 */
  readonly status: 'Confirmed';
};

/** DraftかConfirmedかを識別するRoot Snapshot。 */
export type ReceiptSnapshot = ReceiptDraftSnapshot | ConfirmedReceiptSnapshot;

/** Draft確認で発生した不変のRoot遷移履歴。 */
export type ReceiptConfirmationChange = {
  /** Draftを明示確認後のConfirmedへ移した事実。 */
  readonly action: 'Confirmed';
  /** 入力された安定Actor参照。実本人性の証拠ではない。 */
  readonly actorSubject: string;
  /** UTC形式へコピーした確認時刻。 */
  readonly at: string;
  /** 遷移前のRoot版。 */
  readonly previousVersion: number;
  /** 遷移後のRoot版。 */
  readonly version: number;
  /** OCR／候補を含む遷移前の不変Draft値。 */
  readonly before: ReceiptDraftSnapshot;
  /** 手動確認後の遷移先snapshot。 */
  readonly after: ConfirmedReceiptSnapshot;
};

const reject = (code: ReceiptInvariantViolationCode): never => {
  throw new ReceiptInvariantViolation(code);
};

const requireCondition = (
  condition: boolean,
  code: ReceiptInvariantViolationCode,
): void => {
  if (!condition) reject(code);
};

const copyAdjustment = (
  adjustment: ReceiptAdjustmentInput,
): ReceiptAdjustmentInput => {
  if (adjustment.target.scope === 'Item') {
    return Object.freeze({
      kind: adjustment.kind,
      amount: adjustment.amount,
      target: Object.freeze({
        scope: 'Item' as const,
        itemId: adjustment.target.itemId,
      }),
    });
  }
  if (adjustment.target.scope === 'Receipt') {
    return Object.freeze({
      kind: adjustment.kind,
      amount: adjustment.amount,
      target: Object.freeze({ scope: 'Receipt' as const }),
    });
  }
  return reject('ADJUSTMENT_INVALID');
};

const freezeCandidates = (
  items: readonly ReceiptItemCandidate[],
): readonly ReceiptItemCandidate[] =>
  Object.freeze(
    items.map((item) =>
      Object.freeze({
        id: item.id,
        name: item.name,
        amount: item.amount,
        categoryId: item.categoryId,
      }),
    ),
  );

const freezeAdjustments = (
  adjustments: readonly ReceiptAdjustmentInput[],
): readonly ReceiptAdjustmentInput[] =>
  Object.freeze(adjustments.map(copyAdjustment));

const utcInstant = (value: Date): string => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    reject('UTC_INSTANT_INVALID');
  }
  return value.toISOString();
};

/** ERがReceipt Draftの手動確認・合計Invariant・変更履歴を守る個別Root。 */
export class Receipt {
  private constructor(
    private readonly current: ReceiptSnapshot,
    /** Root内だけで進める版。永続層の先着・CASを証明しない。 */
    readonly version: number,
    /** Confirmedへの遷移履歴。Audit Logや保存Schemaではない。 */
    readonly changes: readonly ReceiptConfirmationChange[],
  ) {
    Object.freeze(this);
  }

  /**
   * Draftから確定後まで維持するReceipt同一性を返す。
   * @returns 変更できないReceipt ID。
   */
  get id(): ReceiptId {
    return this.current.id;
  }

  /**
   * Candidate factsから内部のReceipt Draft Rootを作る。
   * @param input 外部ID発番、認可、OCR、保存を行わない呼出元提供facts。
   * @returns 未確認候補を不変コピーして保持するDraft Root。
   * @throws ReceiptInvariantViolation ID、Uploader参照または配列factsが不正な場合。
   */
  static createDraft(input: ReceiptDraftInput): Receipt {
    const id = ReceiptId.from(input.id);
    requireCondition(
      typeof input.uploaderSubject === 'string' &&
        input.uploaderSubject.trim().length > 0,
      'ACTOR_REFERENCE_INVALID',
    );
    requireCondition(
      Array.isArray(input.items) && Array.isArray(input.adjustments),
      'RECEIPT_DRAFT_INVALID',
    );
    const snapshot: ReceiptDraftSnapshot = Object.freeze({
      id,
      uploaderSubject: input.uploaderSubject,
      occurredOn: input.occurredOn,
      declaredTotal: input.declaredTotal,
      items: freezeCandidates(input.items),
      adjustments: freezeAdjustments(input.adjustments),
      status: 'Draft',
    });
    return new Receipt(snapshot, 1, Object.freeze([]));
  }

  /**
   * 手動確認factsを検証し、Draftを同一IDのConfirmed新版へ遷移する。
   * @param input Uploader確認値、期待版、Actor参照、操作UTC時刻。
   * @returns Confirmed Snapshotと不変遷移履歴を持つ新しいRoot。
   * @throws ReceiptInvariantViolation Actor、版、日付、金額、Category参照、AdjustmentまたはReceipt合計が不正な場合。
   */
  confirm(input: ConfirmReceipt): Receipt {
    const before = this.current;
    if (before.status !== 'Draft') {
      throw new ReceiptInvariantViolation('RECEIPT_NOT_DRAFT');
    }
    requireCondition(
      Number.isSafeInteger(input.expectedVersion) &&
        input.expectedVersion === this.version,
      'VERSION_CONFLICT',
    );
    requireCondition(
      typeof input.actorSubject === 'string' &&
        input.actorSubject.trim().length > 0,
      'ACTOR_REFERENCE_INVALID',
    );
    requireCondition(
      input.actorSubject === before.uploaderSubject,
      'ACTOR_NOT_UPLOADER',
    );
    requireCondition(
      Number.isSafeInteger(this.version + 1),
      'VERSION_OVERFLOW',
    );
    const at = utcInstant(input.confirmedAt);
    let occurredOn: OccurredOn;
    try {
      occurredOn = OccurredOn.from(input.occurredOn);
    } catch {
      return reject('OCCURRED_ON_INVALID');
    }
    requireCondition(
      Number.isSafeInteger(input.declaredTotal) && input.declaredTotal >= 0,
      'TOTAL_INVALID',
    );
    requireCondition(Array.isArray(input.items), 'ITEM_FACT_INVALID');
    const categoryIds = input.items.map((item) => {
      requireCondition(
        typeof item.id === 'string' &&
          item.id.trim().length > 0 &&
          typeof item.name === 'string' &&
          typeof item.categoryId === 'string',
        'ITEM_FACT_INVALID',
      );
      try {
        return CategoryId.from(item.categoryId);
      } catch {
        return reject('CATEGORY_REFERENCE_INVALID');
      }
    });
    requireCondition(Array.isArray(input.adjustments), 'ADJUSTMENT_INVALID');
    let allocation;
    try {
      allocation = ReceiptAdjustmentAllocation.calculate(
        input.items.map((item) => ({ id: item.id, amount: item.amount })),
        input.adjustments,
      );
    } catch (error) {
      if (error instanceof ReceiptAdjustmentViolation) {
        return reject('ADJUSTMENT_INVALID');
      }
      throw error;
    }
    const adjustedTotal = allocation.items.reduce(
      (sum, item) => sum + BigInt(item.adjustedAmount),
      0n,
    );
    requireCondition(
      adjustedTotal === BigInt(input.declaredTotal),
      'RECEIPT_TOTAL_MISMATCH',
    );
    const items: readonly ConfirmedReceiptItem[] = Object.freeze(
      input.items.map((item, index) =>
        Object.freeze({
          id: item.id,
          name: item.name,
          categoryId: categoryIds[index],
          originalAmount: allocation.items[index].originalAmount,
          adjustedAmount: allocation.items[index].adjustedAmount,
        }),
      ),
    );
    const after: ConfirmedReceiptSnapshot = Object.freeze({
      id: before.id,
      uploaderSubject: before.uploaderSubject,
      occurredOn,
      declaredTotal: input.declaredTotal,
      items,
      adjustments: freezeAdjustments(input.adjustments),
      allocations: allocation.allocations,
      status: 'Confirmed',
    });
    const change: ReceiptConfirmationChange = Object.freeze({
      action: 'Confirmed',
      actorSubject: input.actorSubject,
      at,
      previousVersion: this.version,
      version: this.version + 1,
      before,
      after,
    });
    return new Receipt(
      after,
      this.version + 1,
      Object.freeze([...this.changes, change]),
    );
  }

  /**
   * Rootの現在値を返す。Confirmedは公開・保存済みを表さない。
   * @returns 変更不能なDraftまたはConfirmed facts。
   */
  snapshot(): ReceiptSnapshot {
    return this.current;
  }
}
