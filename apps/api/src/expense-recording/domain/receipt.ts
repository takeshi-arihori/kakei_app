import { GroupExpense } from './group-expense.js';
import { ReceiptBundleId } from './value-objects/receipt-bundle-id.js';
import {
  ReceiptBundleSnapshotSelection,
  type ReceiptBundleSnapshotSelectionInput,
} from './value-objects/receipt-bundle-snapshot-selection.js';
import type { ExpenseId } from './value-objects/expense-id.js';
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
  /** 初回登録済みのItemとExpense対応。実保存の証拠ではない。 */
  readonly bundles: readonly ReceiptBundleRegistration[];
  /** 各Bundleの初Snapshot選択。Caseの現在状態から解除しない。 */
  readonly bundleSnapshotSelections: readonly ReceiptBundleSnapshotSelection[];
  /** Receiptの現在状態。共有・保存状態の証明ではない。 */
  readonly status: 'Confirmed';
};

/** Uploaderが未割当Itemと初回Expenseの対応を追記する内部入力。 */
export type RegisterReceiptBundle = {
  /** 現在Root版。保存CASを代替しない。 */
  readonly expectedVersion: number;
  /** 本人性を外側で確認する安定参照。DomainではUploaderとの値一致だけを検証。 */
  readonly actorSubject: string;
  /** 履歴へコピーする有限操作日時。時計はCallerが供給。 */
  readonly registeredAt: Date;
  /** Caller発番の未使用Bundle参照。公開形式は未確定。 */
  readonly bundleId: string;
  /** このReceipt内の未割当Confirmed Itemを重複なく1件以上指定。 */
  readonly itemIds: readonly string[];
  /** 対応を作るversion 1のExpense。実保存新規性は別Gate。 */
  readonly expense: GroupExpense;
};

/** Receiptが所有する不変の初回Bundle対応facts。別Rootではない。 */
export type ReceiptBundleRegistration = {
  /** 後続編集でも対応を追跡する安定Bundle参照。 */
  readonly id: ReceiptBundleId;
  /** 初回登録のItem所属。登録操作では既存対応を変えない。 */
  readonly itemIds: readonly string[];
  /** 対応する個別Expense Rootの参照。Expense factsは複製しない。 */
  readonly expenseId: ExpenseId;
  /** 初回Expense由来の参照。Receipt実Group所属の証拠ではない。 */
  readonly groupId: string;
};

/** 初回Pair登録で発生した不変のReceipt遷移履歴。 */
export type ReceiptBundleRegistrationChange = {
  /** 未割当Itemと初回Expense対応を追加した事実。 */
  readonly action: 'BundleRegistered';
  /** Uploaderと値一致したActor。実本人性は別Gate。 */
  readonly actorSubject: string;
  /** Caller時刻からコピーしたUTC操作日時。 */
  readonly at: string;
  /** 操作判断時の旧Root版。 */
  readonly previousVersion: number;
  /** 登録成功後の新版。 */
  readonly version: number;
  /** 既存Pairを保持する登録前facts。 */
  readonly before: ConfirmedReceiptSnapshot;
  /** 新Pairを追加した登録後facts。 */
  readonly after: ConfirmedReceiptSnapshot;
};

/** Source確認後の初選択factsをRootへ記録する内部入力。 */
export type RecordReceiptBundleSnapshotSelection = {
  /** 現在Root版。永続CASや操作結果replayの証拠ではない。 */
  readonly expectedVersion: number;
  /** Callerが確認したSource初選択facts。Uploader編集操作とは別。 */
  readonly selection: ReceiptBundleSnapshotSelectionInput;
};

/** Item所属・payer・割合の共通編集Policyを照会する内部入力。 */
export type CheckReceiptBundleEditing = {
  /** 編集を判断するRoot版。実編集と同判断点で利用する。 */
  readonly expectedVersion: number;
  /** Uploaderと値比較するActor参照。実認可の証明ではない。 */
  readonly actorSubject: string;
  /** 登録済みBundleの参照。未知Bundleを編集可とは扱わない。 */
  readonly bundleId: string;
};

/** 初選択を記録して永久編集lockを開始した不変Root履歴。 */
export type ReceiptBundleSnapshotSelectionChange = {
  /** 初Snapshot選択を記録した事実。解除・置換のLifecycleは持たない。 */
  readonly action: 'BundleSnapshotSelected';
  /** Sourceの選択Actor。取込ActorやUploaderの証明ではない。 */
  readonly actorSubject: string;
  /** Sourceの初選択UTC時刻。取込時刻やAudit Logではない。 */
  readonly at: string;
  /** 初選択記録を判断した旧Root版。 */
  readonly previousVersion: number;
  /** 記録成功後のRoot版。 */
  readonly version: number;
  /** 既存Item・初回対応を保持する記録前facts。 */
  readonly before: ConfirmedReceiptSnapshot;
  /** 初選択不変値を追加した記録後facts。 */
  readonly after: ConfirmedReceiptSnapshot;
};

/** 同Receiptの確認・Bundle対応・初選択の順序付き履歴。 */
export type ReceiptChange =
  | ReceiptConfirmationChange
  | ReceiptBundleRegistrationChange
  | ReceiptBundleSnapshotSelectionChange;

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

/** ERがReceipt確認・Bundle対応・永久編集lock・合計Invariantを守る個別Root。 */
export class Receipt {
  private constructor(
    private readonly current: ReceiptSnapshot,
    /** Root内だけで進める版。永続層の先着・CASを証明しない。 */
    readonly version: number,
    /** 確認・Bundle登録・初選択の不変履歴。Audit Logや保存Schemaではない。 */
    readonly changes: readonly ReceiptChange[],
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
    this.requireUploaderVersion(input.expectedVersion, input.actorSubject);
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
      bundles: Object.freeze([]),
      bundleSnapshotSelections: Object.freeze([]),
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
   * 未割当Confirmed Itemと初回Expenseの対応を追記する。
   * @param input Uploader、期待版、操作時刻、Bundle参照と初回Expense Root。
   * @returns 既存factsとPairを維持し、版・履歴を進めた新Receipt Root。
   * @throws ReceiptInvariantViolation 状態、Actor、版、Item選択またはExpense対応が不正な場合。
   */
  registerBundle(input: RegisterReceiptBundle): Receipt {
    const before = this.current;
    if (before.status !== 'Confirmed') return reject('RECEIPT_NOT_CONFIRMED');
    this.requireUploaderVersion(input.expectedVersion, input.actorSubject);
    const at = utcInstant(input.registeredAt);
    const id = ReceiptBundleId.from(input.bundleId);
    requireCondition(
      !before.bundles.some((bundle) => bundle.id.equals(id)),
      'BUNDLE_ALREADY_REGISTERED',
    );
    requireCondition(
      Array.isArray(input.itemIds) &&
        input.itemIds.length > 0 &&
        input.itemIds.every(
          (itemId) => typeof itemId === 'string' && itemId.trim().length > 0,
        ) &&
        new Set(input.itemIds).size === input.itemIds.length,
      'BUNDLE_ITEMS_INVALID',
    );
    const selected = new Set(input.itemIds);
    const selectedItems = before.items.filter((item) => selected.has(item.id));
    requireCondition(
      selectedItems.length === selected.size,
      'BUNDLE_ITEMS_INVALID',
    );
    requireCondition(
      !before.bundles.some((bundle) =>
        bundle.itemIds.some((itemId) => selected.has(itemId)),
      ),
      'ITEM_ALREADY_ASSIGNED',
    );
    requireCondition(
      input.expense instanceof GroupExpense &&
        input.expense.version === 1 &&
        input.expense.corrections.length === 0,
      'BUNDLE_EXPENSE_NOT_INITIAL',
    );
    const expense = input.expense.snapshot();
    requireCondition(
      !before.bundles.some((bundle) => bundle.expenseId.equals(expense.id)),
      'EXPENSE_ALREADY_PAIRED',
    );
    const amount = selectedItems.reduce(
      (sum, item) => sum + BigInt(item.adjustedAmount),
      0n,
    );
    requireCondition(
      expense.sourceOwnerSubject === before.uploaderSubject &&
        expense.occurredOn.value === before.occurredOn.value &&
        BigInt(expense.total.amount) === amount,
      'BUNDLE_EXPENSE_MISMATCH',
    );
    requireCondition(
      before.bundles.length === 0 ||
        before.bundles[0].groupId === expense.groupId,
      'BUNDLE_GROUP_MISMATCH',
    );
    const bundle: ReceiptBundleRegistration = Object.freeze({
      id,
      itemIds: Object.freeze([...input.itemIds]),
      expenseId: expense.id,
      groupId: expense.groupId,
    });
    const after: ConfirmedReceiptSnapshot = Object.freeze({
      ...before,
      bundles: Object.freeze([...before.bundles, bundle]),
    });
    const change: ReceiptBundleRegistrationChange = Object.freeze({
      action: 'BundleRegistered',
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
   * 登録済みBundleの初Snapshot選択を記録し、永久編集lockを開始する。
   * @param input Source確認後の初選択factsと現在期待版。実最初のSource判定は外側の責務。
   * @returns 新版Root。同一factを現在期待版で再入力した場合は同じRootのpure no-op。
   * @throws ReceiptInvariantViolation 状態、版、Source Actor・UTC・参照対応が不正、または初選択を置換する場合。
   */
  recordBundleSnapshotSelection(
    input: RecordReceiptBundleSnapshotSelection,
  ): Receipt {
    const before = this.current;
    if (before.status !== 'Confirmed') return reject('RECEIPT_NOT_CONFIRMED');
    this.requireVersion(input.expectedVersion);
    const selection = ReceiptBundleSnapshotSelection.from(input.selection);
    const bundle = before.bundles.find((value) =>
      value.id.equals(selection.bundleId),
    );
    if (!bundle) return reject('BUNDLE_NOT_FOUND');
    requireCondition(
      bundle.expenseId.equals(selection.expenseId) &&
        bundle.groupId === selection.groupId,
      'BUNDLE_SNAPSHOT_PAIR_MISMATCH',
    );
    const first = before.bundleSnapshotSelections.find((value) =>
      value.bundleId.equals(selection.bundleId),
    );
    if (first) {
      if (first.equals(selection)) return this;
      return reject('BUNDLE_ALREADY_SELECTED');
    }
    requireCondition(
      Number.isSafeInteger(this.version + 1),
      'VERSION_OVERFLOW',
    );
    const after: ConfirmedReceiptSnapshot = Object.freeze({
      ...before,
      bundleSnapshotSelections: Object.freeze([
        ...before.bundleSnapshotSelections,
        selection,
      ]),
    });
    const change: ReceiptBundleSnapshotSelectionChange = Object.freeze({
      action: 'BundleSnapshotSelected',
      actorSubject: selection.actorSubject,
      at: selection.selectedAt,
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
   * Item所属・payer・割合についてUploaderの編集可否を検証する。
   * @param input 同判断点の現在期待版、Actorと登録済みBundle参照。
   * @throws ReceiptInvariantViolation 状態、版、Uploader、Bundle参照が不正、または初選択済みの場合。
   */
  assertBundleEditingAllowed(input: CheckReceiptBundleEditing): void {
    const current = this.current;
    if (current.status !== 'Confirmed') return reject('RECEIPT_NOT_CONFIRMED');
    this.requireVersion(input.expectedVersion);
    this.requireUploader(input.actorSubject);
    const id = ReceiptBundleId.from(input.bundleId);
    requireCondition(
      current.bundles.some((bundle) => bundle.id.equals(id)),
      'BUNDLE_NOT_FOUND',
    );
    requireCondition(
      !current.bundleSnapshotSelections.some((selection) =>
        selection.bundleId.equals(id),
      ),
      'BUNDLE_EDITING_LOCKED',
    );
  }

  /**
   * 全Confirmed Itemに初回Expense対応がある純Domain事実を返す。
   * @returns Draftまたは未割当Itemがある場合false。trueも保存・月次包含の証拠ではない。
   */
  hasCompleteBundleRegistration(): boolean {
    const current = this.current;
    if (current.status !== 'Confirmed' || current.bundles.length === 0)
      return false;
    const assigned = new Set(
      current.bundles.flatMap((bundle) => bundle.itemIds),
    );
    return current.items.every((item) => assigned.has(item.id));
  }

  private requireVersion(expectedVersion: number): void {
    requireCondition(
      Number.isSafeInteger(expectedVersion) && expectedVersion === this.version,
      'VERSION_CONFLICT',
    );
  }

  private requireUploader(actorSubject: string): void {
    requireCondition(
      typeof actorSubject === 'string' && actorSubject.trim().length > 0,
      'ACTOR_REFERENCE_INVALID',
    );
    requireCondition(
      actorSubject === this.current.uploaderSubject,
      'ACTOR_NOT_UPLOADER',
    );
  }

  private requireUploaderVersion(
    expectedVersion: number,
    actorSubject: string,
  ): void {
    this.requireVersion(expectedVersion);
    this.requireUploader(actorSubject);
    requireCondition(
      Number.isSafeInteger(this.version + 1),
      'VERSION_OVERFLOW',
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
