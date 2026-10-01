import type {
  PaymentInstructionId,
  SnapshotRevisionId,
  SnapshotPaymentInstruction,
} from '../settlement-case.js';
import {
  canonicalUuid,
  copyUtc,
  nonempty,
  requireCondition,
} from '../settlement-case-validation.js';

declare const attemptIdBrand: unique symbol;
/** 同じ指示への再支払いごとに新規発番する報告参照。 */
export type PaymentAttemptId = string & {
  /** 指示やRevisionと取り違えないための内部Brand。 */
  readonly [attemptIdBrand]: true;
};
/** 支払操作の内部共通参照。本人性と保存CASはApplication PRE。 */
export type SettlementPaymentReference = {
  /** 読取時のCase版。実保存の先着をこの値だけで保証しない。 */
  readonly expectedVersion: number;
  /** 現在Revisionだけへの操作を許可する参照。 */
  readonly snapshotId: string;
  /** Caseの固定内容に属する支払指示参照。 */
  readonly instructionId: string;
  /** Applicationが本人Actorに束縛した旧Participantも含む参照。 */
  readonly participantId: string;
};
/** 外部の全額支払を本人が報告した内部事実。公開Inputではない。 */
export type ReportSettlementPayment = SettlementPaymentReference & {
  /** この新しい報告だけを識別する新規canonical UUID。 */
  readonly attemptId: string;
  /** 部分支払を拒否するために固定指示額と照合するJPY整数。 */
  readonly amount: bigint;
  /** 操作を記録するCaller時計。外部paidAt入力の採用ではない。 */
  readonly reportedAt: Date;
};
/** 受取側本人による最新報告への内部判断。 */
export type DecideSettlementReceipt = SettlementPaymentReference & {
  /** この指示の最新Reported Attemptと一致させる参照。 */
  readonly attemptId: string;
  /** 信頼するCaller時計の判断時刻。 */
  readonly decidedAt: Date;
};
/** 理由を必須にする支払報告差し戻しだけの内部入力。 */
export type ReturnSettlementPayment = DecideSettlementReceipt & {
  /** 空白だけを拒否し、元の理由を保持する。Logへ出さない。 */
  readonly reason: string;
};
/** 同一報告に一度だけ記録する受取側本人の不変判断。 */
export type PaymentReceiptDecision = {
  /** 固定payeeと一致する実際の判断本人。代理Ownerではない。 */
  readonly participantId: string;
  /** Approvalの却下とは別の支払報告の判断。 */
  readonly decision: 'Received' | 'Returned';
  /** CallerからコピーしたUTC判断時刻。 */
  readonly decidedAt: string;
  /** Returnedなら空でない元の理由、Receivedならnull。 */
  readonly reason: string | null;
};

/** Case配下で報告factsと受取判断のLifecycleを守る不変transitionのEntity。 */
export class PaymentAttempt {
  private constructor(
    /** 再支払いと同じ報告への判断を区別する安定参照。 */
    readonly attemptId: PaymentAttemptId,
    /** 元の精算内容に束縛する不変Revision参照。 */
    readonly snapshotId: SnapshotRevisionId,
    /** 差し戻し後の新Attemptでも変えない固定指示参照。 */
    readonly instructionId: PaymentInstructionId,
    /** 同指示内で初回1、新報告ごと+1の履歴順。 */
    readonly ordinal: number,
    /** 報告した支払本人。再参加の新IDで置換しない。 */
    readonly payerParticipantId: string,
    /** 受取判断だけを許す固定本人。 */
    readonly payeeParticipantId: string,
    /** 指示と同じ全額JPY整数。判断で変更しない。 */
    readonly amount: bigint,
    /** 実送金時刻と別の、報告操作UTC時刻。 */
    readonly reportedAt: string,
    /** 未判断null、一度判断後は理由も含めて固定する。 */
    readonly receipt: PaymentReceiptDecision | null,
  ) {
    Object.freeze(this);
  }

  /**
   * Caseが束縛した固定指示への全額本人報告を作る。
   * @param snapshotId Caseが検証した現在Revision参照。
   * @param instruction Caseが所有する不変指示内容。外部Client値を渡さない。
   * @param input 本人性・発番新規性をApplicationで検証する内部事実。
   * @param ordinal Caseが履歴から決める同指示内の順序。
   * @returns 未受取確認の不変報告。Case外で保存せずRootから利用する。
   * @throws SettlementCaseInvariantViolation ID・本人・指示・額・順序・時刻が無効な場合。
   */
  static report(
    snapshotId: SnapshotRevisionId,
    instruction: SnapshotPaymentInstruction,
    input: ReportSettlementPayment,
    ordinal: number,
  ): PaymentAttempt {
    requireCondition(canonicalUuid(snapshotId), 'SNAPSHOT_ID_INVALID');
    requireCondition(
      canonicalUuid(instruction.instructionId),
      'INSTRUCTION_ID_INVALID',
    );
    requireCondition(canonicalUuid(input.attemptId), 'ATTEMPT_ID_INVALID');
    requireCondition(
      Number.isSafeInteger(ordinal) && ordinal > 0,
      'ATTEMPT_ORDINAL_INVALID',
    );
    requireCondition(
      nonempty(instruction.payerParticipantId) &&
        nonempty(instruction.payeeParticipantId) &&
        instruction.payerParticipantId !== instruction.payeeParticipantId,
      'INSTRUCTION_PARTICIPANTS_INVALID',
    );
    requireCondition(
      input.participantId === instruction.payerParticipantId,
      'ACTOR_NOT_PAYMENT_PAYER',
    );
    requireCondition(
      typeof instruction.amount === 'bigint' &&
        instruction.amount > 0n &&
        input.amount === instruction.amount &&
        instruction.currency === 'JPY',
      'PAYMENT_AMOUNT_MISMATCH',
    );
    return new PaymentAttempt(
      input.attemptId as PaymentAttemptId,
      snapshotId,
      instruction.instructionId,
      ordinal,
      input.participantId,
      instruction.payeeParticipantId,
      instruction.amount,
      copyUtc(input.reportedAt),
      null,
    );
  }

  /**
   * 固定受取本人の確認を、元報告を変更せずに記録する。
   * @param input Caseが現在版・最新Attemptを検証した内部判断。
   * @returns Receivedの新Entity。元Entityは不変。
   * @throws SettlementCaseInvariantViolation 未Reported・本人違い・無効時刻の場合。
   */
  confirmReceipt(input: DecideSettlementReceipt): PaymentAttempt {
    return this.decide(input, 'Received', null);
  }

  /**
   * 固定受取本人の理由付き差し戻しを記録する。
   * @param input Caseが現在版・最新Attemptを検証した本人判断と理由。
   * @returns 元報告factsと差し戻し理由を保持するReturnedの新Entity。
   * @throws SettlementCaseInvariantViolation 未Reported・本人違い・空理由・無効時刻の場合。
   */
  returnPayment(input: ReturnSettlementPayment): PaymentAttempt {
    requireCondition(nonempty(input.reason), 'PAYMENT_RETURN_REASON_EMPTY');
    return this.decide(input, 'Returned', input.reason);
  }

  /**
   * 元報告と一度だけの受取判断から状態を返す。
   * @returns 未判断Reported、確認Received、差し戻しReturned。
   */
  get status(): 'Reported' | 'Received' | 'Returned' {
    return this.receipt?.decision ?? 'Reported';
  }

  private decide(
    input: DecideSettlementReceipt,
    decision: 'Received' | 'Returned',
    reason: string | null,
  ): PaymentAttempt {
    requireCondition(this.status === 'Reported', 'ATTEMPT_NOT_REPORTED');
    requireCondition(
      input.participantId === this.payeeParticipantId,
      'ACTOR_NOT_PAYMENT_PAYEE',
    );
    return new PaymentAttempt(
      this.attemptId,
      this.snapshotId,
      this.instructionId,
      this.ordinal,
      this.payerParticipantId,
      this.payeeParticipantId,
      this.amount,
      this.reportedAt,
      Object.freeze({
        participantId: input.participantId,
        decision,
        decidedAt: copyUtc(input.decidedAt),
        reason,
      }),
    );
  }
}
