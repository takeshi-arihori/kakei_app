import type { ReceiptBundleEditingFacts } from './receipt-bundle-editing-facts.js';
import type {
  ReflectReceiptBundleItemMovement,
  ReceiptBundleItemMovement,
} from './receipt-bundle-item-movement.js';
import { Money } from '../../shared/domain/money.js';

import {
  ExpenseInvariantViolation,
  type ExpenseInvariantViolationCode,
} from './expense-invariant-violation.js';
import { ExpenseId } from './value-objects/expense-id.js';
import { OccurredOn } from './value-objects/occurred-on.js';
import type {
  CorrectExpenseAmount,
  ExpenseAmountCorrection,
} from './expense-amount-correction.js';
import type {
  ChangeReceiptBundleSplit,
  ReceiptBundleSplitChange,
} from './receipt-bundle-split-change.js';

/** Applicationが登録判断時に取得する参加者事実。現在の認可の証拠にはしない。 */
export type ExpenseParticipantInput = {
  /** 再参加で再利用しない、登録時点のParticipant参照。 */
  readonly participantId: string;
  /** GMが付与する1以上の一意な参加順。配列順から推測しない。 */
  readonly joinOrder: number;
  /** 0〜100の10%刻み。全Participantで合計100%とする。 */
  readonly percentage: number;
};

/** 内部Domain生成用の事実。信頼Actor・Active判定・fence確認はApplicationが担う。 */
export type RegisterGroupExpenseInput = {
  /** 前段で発番した支出識別子。ここでは発番・再送判定を行わない。 */
  readonly id: string;
  /** ADR #85のcanonical Group IDを値として参照する。 */
  readonly groupId: string;
  /** 手入力登録者またはReceipt Uploader。Participant寿命と別の安定Actorで本人性は証明しない。 */
  readonly sourceOwnerSubject: string;
  /** 購入の暦日。登録Timestampと混同しない。 */
  readonly occurredOn: string;
  /** JPY整数額。非負safe integerは実装制限でありProduct上限ではない。 */
  readonly amount: number;
  /** 実支払者の登録時Participant参照。固定集合内に存在すること。 */
  readonly payerParticipantId: string;
  /** 登録時点の全対象Participantと配賦。後からMembershipを反映しない。 */
  readonly participants: readonly ExpenseParticipantInput[];
};

/** 登録Participant参照と、その版の割合・負担を一体として固定した値。 */
export type ExpenseAllocation = {
  /** 過去の支払責務を保持するParticipant参照。 */
  readonly participantId: string;
  /** 最大剰余の同率時に使う、登録時の参加順。 */
  readonly joinOrder: number;
  /** この版の10%刻みの割合。0%は0円のまま保持する。 */
  readonly percentage: number;
  /** 合計額と整数配賦から導出する、変更できないJPY負担。 */
  readonly burden: Money;
};

/** 精算へ渡す不変な現在事実。旧値は初回事実と変更履歴に残す。公開／保存Schemaではない。 */
export type GroupExpenseSnapshot = {
  /** 同じ支出を追跡する不変な識別子。 */
  readonly id: ExpenseId;
  /** この支出が所属するGroupのcanonical参照。 */
  readonly groupId: string;
  /** 手入力登録者またはReceipt UploaderであるSource Owner参照。 */
  readonly sourceOwnerSubject: string;
  /** 購入月の根拠となる購入暦日。 */
  readonly occurredOn: OccurredOn;
  /** この版のJPY総額。訂正はRootから新しい値として作る。 */
  readonly total: Money;
  /** 脱退だけでは変更しない実支払者。Bundleは初Snapshot選択前の明示変更を許す。 */
  readonly payerParticipantId: string;
  /** 登録Participant集合・参加順を維持するこの版の割合と負担。 */
  readonly allocations: readonly ExpenseAllocation[];
};

const requireReference = (value: string): void => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ExpenseInvariantViolation(
      'IDENTIFIER_EMPTY',
      'Participant and source owner references must not be empty',
    );
  }
};

const immutableMoney = (amount: number): Money =>
  Object.freeze(Money.jpy(amount));

const requireBundleChange = (
  condition: boolean,
  code: ExpenseInvariantViolationCode,
): void => {
  if (!condition)
    throw new ExpenseInvariantViolation(
      code,
      'Bundle change invariant violated',
    );
};

/** 個別支出Rootとして登録facts・整数配賦・版を守る。金額訂正操作は手入力の既存契約に従う。 */
export class GroupExpense {
  private constructor(
    private readonly state: GroupExpenseSnapshot,
    /** 登録時点の全事実。金額訂正・Bundle配賦変更・Item移動後も維持する。 */
    readonly initialSnapshot: GroupExpenseSnapshot = state,
    /** 初回1、金額訂正・実配賦変更・Item移動反映ごと+1。保存CASは別責務。 */
    readonly version: number = 1,
    /** 金額だけの順序付き訂正履歴。旧値・変更者・時刻・理由を保持する。 */
    readonly corrections: readonly ExpenseAmountCorrection[] = Object.freeze(
      [],
    ),
    /** Bundleのpayer／割合変更履歴。金額訂正後も維持する。 */
    readonly bundleSplitChanges: readonly ReceiptBundleSplitChange[] = Object.freeze(
      [],
    ),
    /** Item移動の額反映履歴。同額移動も残し、他操作後も維持する。 */
    readonly bundleItemMovements: readonly ReceiptBundleItemMovement[] = Object.freeze(
      [],
    ),
  ) {
    Object.freeze(this);
  }

  /**
   * 訂正やCase選択で維持する支出の同一性を返す。
   * @returns このRootの変更できないExpense ID。
   */
  get id(): ExpenseId {
    return this.state.id;
  }

  /**
   * 明示済み状態と資格で金額のみ訂正し、同IDの固定配賦を再計算する。
   * @param input Source照会・認可・実解放・atomic commitはApplication PREとなる内部入力。
   * @returns 旧事実と履歴を保持し、現在額と版を進めた新Root。
   * @throws ExpenseInvariantViolation 版・参照・状態・資格・理由・時刻・額が無効な場合。
   */
  correctAmount(input: CorrectExpenseAmount): GroupExpense {
    const requireCorrection = (
      condition: boolean,
      code: ExpenseInvariantViolationCode,
    ): void => {
      if (!condition)
        throw new ExpenseInvariantViolation(
          code,
          'Expense correction invariant violated',
        );
    };
    requireCorrection(
      Number.isSafeInteger(input.expectedExpenseVersion) &&
        input.expectedExpenseVersion === this.version,
      'EXPENSE_VERSION_CONFLICT',
    );
    const fact = input.caseFact;
    requireCorrection(
      fact.groupId === this.state.groupId && fact.expenseId === this.id.value,
      'CASE_FACT_MISMATCH',
    );
    requireCorrection(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        fact.caseId,
      ),
      'CASE_REFERENCE_INVALID',
    );
    requireCorrection(
      Number.isSafeInteger(fact.version) &&
        fact.version > 0 &&
        Number.isSafeInteger(input.expectedCaseVersion) &&
        input.expectedCaseVersion === fact.version,
      'CASE_VERSION_CONFLICT',
    );
    requireCorrection(
      fact.lifecycle === 'Rejected' ||
        ((fact.lifecycle === 'Withdrawn' || fact.lifecycle === 'Cancelled') &&
          fact.allTargetsReleased === true),
      'EXPENSE_NOT_CORRECTABLE',
    );
    requireReference(input.actorSubject);
    requireReference(input.currentOwnerSubject);
    requireCorrection(
      input.actorSubject === this.state.sourceOwnerSubject ||
        input.actorSubject === input.currentOwnerSubject,
      'ACTOR_NOT_SOURCE_OWNER_OR_OWNER',
    );
    requireCorrection(
      typeof input.reason === 'string' && input.reason.trim().length > 0,
      'CORRECTION_REASON_EMPTY',
    );
    requireCorrection(
      input.correctedAt instanceof Date &&
        Number.isFinite(input.correctedAt.getTime()),
      'UTC_INSTANT_INVALID',
    );
    const calculated = GroupExpense.register({
      id: this.id.value,
      groupId: this.state.groupId,
      sourceOwnerSubject: this.state.sourceOwnerSubject,
      occurredOn: this.state.occurredOn.value,
      amount: input.amount,
      payerParticipantId: this.state.payerParticipantId,
      participants: this.state.allocations.map((a) => ({
        participantId: a.participantId,
        joinOrder: a.joinOrder,
        percentage: a.percentage,
      })),
    }).snapshot();
    const after = Object.freeze({
      ...this.state,
      total: calculated.total,
      allocations: calculated.allocations,
    });
    const record: ExpenseAmountCorrection = Object.freeze({
      actorSubject: input.actorSubject,
      correctedAt: input.correctedAt.toISOString(),
      reason: input.reason,
      previousVersion: this.version,
      version: this.version + 1,
      caseFact: Object.freeze({
        groupId: fact.groupId,
        expenseId: fact.expenseId,
        caseId: fact.caseId,
        version: fact.version,
        lifecycle: fact.lifecycle,
        allTargetsReleased: fact.allTargetsReleased,
      }),
      before: this.state,
      after,
    });
    return new GroupExpense(
      after,
      this.initialSnapshot,
      this.version + 1,
      Object.freeze([...this.corrections, record]),
      this.bundleSplitChanges,
      this.bundleItemMovements,
    );
  }

  /**
   * 未選択Bundleの編集factsに束縛し、同ID・同登録集合のpayer／割合だけを変更する。
   * @param input 実Receipt照会・本人性・同時選択の裁定はApplication PREとなる内部入力。
   * @returns 実変更の新版と不変履歴。同一財務値は全検証後に同じRootを返す。
   * @throws ExpenseInvariantViolation 版、Source facts、Actor、日時、固定集合または配賦が不正な場合。
   */
  changeBundleSplit(input: ChangeReceiptBundleSplit): GroupExpense {
    requireBundleChange(
      Number.isSafeInteger(input.expectedExpenseVersion) &&
        input.expectedExpenseVersion === this.version,
      'EXPENSE_VERSION_CONFLICT',
    );
    const fact = input.bundleFact;
    this.requireCurrentBundleFact(
      fact,
      input.expectedReceiptVersion,
      input.actorSubject,
    );
    requireBundleChange(
      input.changedAt instanceof Date &&
        Number.isFinite(input.changedAt.getTime()),
      'UTC_INSTANT_INVALID',
    );

    const percentages = new Map(
      input.percentages.map((p) => [p.participantId, p.percentage]),
    );
    requireBundleChange(
      input.percentages.length === this.state.allocations.length &&
        percentages.size === this.state.allocations.length &&
        this.state.allocations.every((a) => percentages.has(a.participantId)),
      'PARTICIPANT_SET_MISMATCH',
    );
    // 配列順やCaller指定joinOrderを採用せず、登録時集合へ割合だけを写して既存配賦を再利用する。
    const calculated = GroupExpense.register({
      id: this.id.value,
      groupId: this.state.groupId,
      sourceOwnerSubject: this.state.sourceOwnerSubject,
      occurredOn: this.state.occurredOn.value,
      amount: this.state.total.amount,
      payerParticipantId: input.payerParticipantId,
      participants: this.state.allocations.map((a) => ({
        participantId: a.participantId,
        joinOrder: a.joinOrder,
        percentage: percentages.get(a.participantId)!,
      })),
    }).snapshot();
    if (
      calculated.payerParticipantId === this.state.payerParticipantId &&
      calculated.allocations.every(
        (a, n) => a.percentage === this.state.allocations[n].percentage,
      )
    )
      return this;
    requireBundleChange(
      Number.isSafeInteger(this.version + 1),
      'VERSION_OVERFLOW',
    );
    const after = Object.freeze({
      ...this.state,
      payerParticipantId: calculated.payerParticipantId,
      allocations: calculated.allocations,
    });
    const record: ReceiptBundleSplitChange = Object.freeze({
      actorSubject: input.actorSubject,
      at: input.changedAt.toISOString(),
      previousVersion: this.version,
      version: this.version + 1,
      bundleFact: this.copyBundleFact(fact),
      before: this.state,
      after,
    });
    return new GroupExpense(
      after,
      this.initialSnapshot,
      this.version + 1,
      this.corrections,
      Object.freeze([...this.bundleSplitChanges, record]),
      this.bundleItemMovements,
    );
  }

  /**
   * 同Item移動のReceipt前後factsに束縛し、現在payer／割合で新額を再配賦する。
   * @param input 実移動Sourceの前後束縛・本人性・3Root共通commitはCaller PREとなる内部入力。
   * @returns 同ID・登録集合・payer／割合を維持する新版と履歴。同額移動でも履歴を進める。
   * @throws ExpenseInvariantViolation 版、前後Pair参照・額、Actor、時刻または新版上限が不正な場合。
   */
  reflectBundleItemMovement(
    input: ReflectReceiptBundleItemMovement,
  ): GroupExpense {
    requireBundleChange(
      Number.isSafeInteger(input.expectedExpenseVersion) &&
        input.expectedExpenseVersion === this.version,
      'EXPENSE_VERSION_CONFLICT',
    );
    const beforeFact = input.beforeBundleFact,
      afterFact = input.afterBundleFact;
    this.requireCurrentBundleFact(
      beforeFact,
      input.expectedReceiptVersion,
      input.actorSubject,
    );
    this.requireBundleFactShape(afterFact);
    requireBundleChange(
      Number.isSafeInteger(afterFact.receiptVersion) &&
        afterFact.receiptVersion === beforeFact.receiptVersion + 1,
      'RECEIPT_VERSION_CONFLICT',
    );
    requireBundleChange(
      afterFact.receiptId === beforeFact.receiptId &&
        afterFact.bundleId === beforeFact.bundleId &&
        afterFact.expenseId === beforeFact.expenseId &&
        afterFact.groupId === beforeFact.groupId &&
        afterFact.uploaderSubject === beforeFact.uploaderSubject &&
        afterFact.occurredOn === beforeFact.occurredOn,
      'BUNDLE_FACT_MISMATCH',
    );
    requireBundleChange(
      input.changedAt instanceof Date &&
        Number.isFinite(input.changedAt.getTime()),
      'UTC_INSTANT_INVALID',
    );
    requireBundleChange(
      Number.isSafeInteger(this.version + 1),
      'VERSION_OVERFLOW',
    );
    const calculated = GroupExpense.register({
      id: this.id.value,
      groupId: this.state.groupId,
      sourceOwnerSubject: this.state.sourceOwnerSubject,
      occurredOn: this.state.occurredOn.value,
      amount: afterFact.adjustedAmount,
      payerParticipantId: this.state.payerParticipantId,
      participants: this.state.allocations.map((a) => ({
        participantId: a.participantId,
        joinOrder: a.joinOrder,
        percentage: a.percentage,
      })),
    }).snapshot();
    const after = Object.freeze({
      ...this.state,
      total: calculated.total,
      allocations: calculated.allocations,
    });
    const record: ReceiptBundleItemMovement = Object.freeze({
      actorSubject: input.actorSubject,
      at: input.changedAt.toISOString(),
      previousVersion: this.version,
      version: this.version + 1,
      beforeBundleFact: this.copyBundleFact(beforeFact),
      afterBundleFact: this.copyBundleFact(afterFact),
      before: this.state,
      after,
    });
    return new GroupExpense(
      after,
      this.initialSnapshot,
      this.version + 1,
      this.corrections,
      this.bundleSplitChanges,
      Object.freeze([...this.bundleItemMovements, record]),
    );
  }

  private requireBundleFactShape(fact: ReceiptBundleEditingFacts): void {
    requireBundleChange(
      typeof fact === 'object' &&
        fact !== null &&
        [
          fact.receiptId,
          fact.bundleId,
          fact.expenseId,
          fact.groupId,
          fact.uploaderSubject,
        ].every(
          (value) => typeof value === 'string' && value.trim().length > 0,
        ) &&
        Number.isSafeInteger(fact.adjustedAmount) &&
        fact.adjustedAmount >= 0,
      'BUNDLE_FACT_INVALID',
    );
  }

  private requireCurrentBundleFact(
    fact: ReceiptBundleEditingFacts,
    expectedReceiptVersion: number,
    actorSubject: string,
  ): void {
    this.requireBundleFactShape(fact);
    requireBundleChange(
      Number.isSafeInteger(fact.receiptVersion) &&
        fact.receiptVersion > 0 &&
        Number.isSafeInteger(expectedReceiptVersion) &&
        expectedReceiptVersion === fact.receiptVersion,
      'RECEIPT_VERSION_CONFLICT',
    );
    requireBundleChange(
      fact.expenseId === this.id.value &&
        fact.groupId === this.state.groupId &&
        fact.uploaderSubject === this.state.sourceOwnerSubject &&
        fact.occurredOn === this.state.occurredOn.value &&
        fact.adjustedAmount === this.state.total.amount,
      'BUNDLE_FACT_MISMATCH',
    );
    requireReference(actorSubject);
    requireBundleChange(
      actorSubject === fact.uploaderSubject,
      'ACTOR_NOT_UPLOADER',
    );
  }

  private copyBundleFact(
    fact: ReceiptBundleEditingFacts,
  ): ReceiptBundleEditingFacts {
    return Object.freeze({
      receiptId: fact.receiptId,
      bundleId: fact.bundleId,
      expenseId: fact.expenseId,
      groupId: fact.groupId,
      receiptVersion: fact.receiptVersion,
      uploaderSubject: fact.uploaderSubject,
      occurredOn: fact.occurredOn,
      adjustedAmount: fact.adjustedAmount,
    });
  }

  /**
   * 入力を検証・copyして登録事実を固定する。認可・予約・commitは行わない。
   * @param input Applicationから渡す登録時の事実。
   * @returns 割合の合計と負担額の合計を保証する不変な支出Root。
   * @throws ExpenseInvariantViolation 識別子、暦日、金額、参加者、配賦が無効の場合。
   */
  static register(input: RegisterGroupExpenseInput): GroupExpense {
    const id = ExpenseId.from(input.id);
    // ADR #85の公開ID値だけを参照し、GMのEntityやDomain型へ依存しない。
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        input.groupId,
      )
    ) {
      throw new ExpenseInvariantViolation(
        'GROUP_ID_INVALID',
        'Group reference must be a lowercase canonical UUID',
      );
    }
    requireReference(input.sourceOwnerSubject);
    requireReference(input.payerParticipantId);
    const occurredOn = OccurredOn.from(input.occurredOn);
    if (!Number.isSafeInteger(input.amount) || input.amount < 0) {
      throw new ExpenseInvariantViolation(
        'AMOUNT_INVALID',
        'JPY amount must be a non-negative safe integer',
      );
    }
    if (input.participants.length < 1 || input.participants.length > 4) {
      throw new ExpenseInvariantViolation(
        'PARTICIPANT_COUNT_INVALID',
        'Expense must contain one to four participants',
      );
    }

    const participantIds = new Set<string>();
    const joinOrders = new Set<number>();
    let percentageTotal = 0;
    for (const participant of input.participants) {
      requireReference(participant.participantId);
      if (participantIds.has(participant.participantId)) {
        throw new ExpenseInvariantViolation(
          'PARTICIPANT_DUPLICATED',
          'Expense participants must be unique',
        );
      }
      participantIds.add(participant.participantId);
      if (
        !Number.isSafeInteger(participant.joinOrder) ||
        participant.joinOrder < 1
      ) {
        throw new ExpenseInvariantViolation(
          'JOIN_ORDER_INVALID',
          'Join order must be a positive safe integer',
        );
      }
      if (joinOrders.has(participant.joinOrder)) {
        throw new ExpenseInvariantViolation(
          'JOIN_ORDER_DUPLICATED',
          'Expense join orders must be unique',
        );
      }
      joinOrders.add(participant.joinOrder);
      if (
        !Number.isInteger(participant.percentage) ||
        participant.percentage < 0 ||
        participant.percentage > 100 ||
        participant.percentage % 10 !== 0
      ) {
        throw new ExpenseInvariantViolation(
          'PERCENTAGE_INVALID',
          'Split percentages must be zero to one hundred in steps of ten',
        );
      }
      percentageTotal += participant.percentage;
    }
    if (percentageTotal !== 100) {
      throw new ExpenseInvariantViolation(
        'PERCENTAGE_TOTAL_INVALID',
        'Split percentages must total one hundred',
      );
    }
    if (!participantIds.has(input.payerParticipantId)) {
      throw new ExpenseInvariantViolation(
        'PAYER_NOT_PARTICIPANT',
        'Payer must be an expense participant',
      );
    }

    // safe integerでも割合との積は範囲外になり得るため、積から端数まで整数演算する。
    const total = BigInt(input.amount);
    const shares = input.participants.map((participant) => {
      const product = total * BigInt(participant.percentage);
      return {
        participantId: participant.participantId,
        joinOrder: participant.joinOrder,
        percentage: participant.percentage,
        burden: product / 100n,
        remainder: product % 100n,
      };
    });
    const remaining = Number(
      total - shares.reduce((sum, share) => sum + share.burden, 0n),
    );
    shares.sort((left, right) => {
      const remainderOrder = Number(right.remainder - left.remainder);
      if (remainderOrder !== 0) return remainderOrder;
      const payerOrder =
        Number(right.participantId === input.payerParticipantId) -
        Number(left.participantId === input.payerParticipantId);
      return payerOrder || left.joinOrder - right.joinOrder;
    });
    // 最大剰余では追加は各人1円まで。残りがあるとき0%は配布先にならない。
    for (const share of shares.slice(0, remaining)) share.burden += 1n;
    const allocations = shares
      .sort((left, right) => left.joinOrder - right.joinOrder)
      .map((share): ExpenseAllocation =>
        Object.freeze({
          participantId: share.participantId,
          joinOrder: share.joinOrder,
          percentage: share.percentage,
          burden: immutableMoney(Number(share.burden)),
        }),
      );

    return new GroupExpense(
      Object.freeze({
        id,
        groupId: input.groupId,
        sourceOwnerSubject: input.sourceOwnerSubject,
        occurredOn,
        total: immutableMoney(input.amount),
        payerParticipantId: input.payerParticipantId,
        allocations: Object.freeze(allocations),
      }),
    );
  }

  /**
   * 後続計算用の現在事実を返す。金額・配列・各値も変更できない。
   * @returns 登録の固定factsとこの版の額・負担。旧値は訂正履歴に保持する。
   */
  snapshot(): GroupExpenseSnapshot {
    return this.state;
  }
}
