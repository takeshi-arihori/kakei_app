import type {
  SettlementCaseActor,
  SettlementApplicant,
  SnapshotRevisionId,
} from '../settlement-case.js';
import {
  canonicalUuid,
  copyUtc,
  nonempty,
  requireCondition,
} from '../settlement-case-validation.js';
declare const cancellationIdBrand: unique symbol;
/** 同じCaseで拒否後の再要求を別履歴として識別する参照。 */
export type SettlementCancellationId = string & {
  /** SnapshotやAttemptと取り違えない内部Brand。 */
  readonly [cancellationIdBrand]: true;
};
/** 元申請者または現在Ownerへ束縛する内部取消要求。公開Inputではない。 */
export type RequestSettlementCancellation = SettlementCaseActor & {
  /** 読取時のCase版。実保存の先着確認は別責務。 */
  readonly expectedVersion: number;
  /** 現在の承認済みRevision参照。 */
  readonly snapshotId: string;
  /** 今回だけの新規canonical要求参照。 */
  readonly cancellationId: string;
  /** 空白だけを拒否し元の理由を履歴に保持する。 */
  readonly reason: string;
  /** 信頼するCaller時計。実現在時刻をDomainで取得しない。 */
  readonly requestedAt: Date;
};
/** 取消の固定必要承認者本人へ束縛する内部判断。 */
export type DecideSettlementCancellation = {
  /** 読取時のCase版。保存CASの証拠ではない。 */
  readonly expectedVersion: number;
  /** 現在の承認済みRevision参照。 */
  readonly snapshotId: string;
  /** 同意を待つ現在の取消要求参照。 */
  readonly cancellationId: string;
  /** 旧Participantも含む固定必要承認者本人。代理Ownerではない。 */
  readonly participantId: string;
  /** 信頼するCaller時計の決定時刻。 */
  readonly decidedAt: Date;
};
/** 通常Approvalと分けて残す一度だけの不変取消判断。 */
export type SettlementCancellationDecision = {
  /** 同意または拒否した固定必要本人。 */
  readonly participantId: string;
  /** 拒否時の理由必須Ruleは追加しない。 */
  readonly decision: 'Agreed' | 'Declined';
  /** Caller DateからコピーしたUTC。 */
  readonly decidedAt: string;
};
/** Case配下で理由付き要求と全員同意のLifecycleを守るChild Entity。 */
export class SettlementCancellationRequest {
  private constructor(
    /** 拒否された旧要求と新版の判断を分ける安定参照。 */
    readonly cancellationId: SettlementCancellationId,
    /** 取消対象の不変Revision参照。 */
    readonly snapshotId: SnapshotRevisionId,
    /** 同Case内の要求順。拒否後も旧履歴を残す。 */
    readonly ordinal: number,
    /** 実際の要求者。元申請者や現在OwnerのSource事実とは別。 */
    readonly applicant: SettlementApplicant,
    /** 元の要求理由。Logへ出さない。 */
    readonly reason: string,
    /** 要求操作のコピー済みUTC時刻。 */
    readonly requestedAt: string,
    /** 現在Revisionの必要集合全件。支払関係者だけへ縮めない。 */
    readonly requiredApproverIds: readonly string[],
    /** 同意と拒否の順序付き本人履歴。通常Approvalを流用しない。 */
    readonly decisions: readonly SettlementCancellationDecision[],
  ) {
    Object.freeze(this);
  }

  /**
   * Caseが資格・Attempt不在を検証した新要求を作る。
   * @param snapshotId Caseの現在Revision参照。
   * @param requiredApproverIds Revisionの固定必要本人全件。
   * @param input 資格のSource取得はApplication PREとなる内部事実。
   * @param ordinal 同Case内の要求順。
   * @returns 本人の明示同意を一件も捏造しないPending要求。
   * @throws SettlementCaseInvariantViolation ID・集合・理由・要求者・順序・時刻が無効な場合。
   */
  static request(
    snapshotId: SnapshotRevisionId,
    requiredApproverIds: readonly string[],
    input: RequestSettlementCancellation,
    ordinal: number,
  ): SettlementCancellationRequest {
    requireCondition(
      canonicalUuid(input.cancellationId),
      'CANCELLATION_ID_INVALID',
    );
    requireCondition(canonicalUuid(snapshotId), 'SNAPSHOT_ID_INVALID');
    requireCondition(nonempty(input.reason), 'CANCELLATION_REASON_EMPTY');
    requireCondition(
      nonempty(input.applicant.actorSubject),
      'ACTOR_SUBJECT_EMPTY',
    );
    requireCondition(
      nonempty(input.applicant.participantId),
      'PARTICIPANT_ID_EMPTY',
    );
    requireCondition(
      Number.isSafeInteger(ordinal) && ordinal > 0,
      'CANCELLATION_ORDINAL_INVALID',
    );
    requireCondition(
      requiredApproverIds.length > 0 &&
        requiredApproverIds.every(nonempty) &&
        new Set(requiredApproverIds).size === requiredApproverIds.length,
      'CANCELLATION_APPROVERS_INVALID',
    );
    return new SettlementCancellationRequest(
      input.cancellationId as SettlementCancellationId,
      snapshotId,
      ordinal,
      Object.freeze({ ...input.applicant }),
      input.reason,
      copyUtc(input.requestedAt),
      Object.freeze([...requiredApproverIds]),
      Object.freeze([]),
    );
  }

  /**
   * 固定必要本人の明示同意を追記する。要求者の自己同意も別操作にする。
   * @param input Caseが現在版と要求参照を確認した内部本人判断。
   * @returns 全員成立までPending、全員後Agreedとなる新Entity。
   * @throws SettlementCaseInvariantViolation 状態・参照・本人・再判断・時刻が無効な場合。
   */
  agree(input: DecideSettlementCancellation): SettlementCancellationRequest {
    return this.decide(input, 'Agreed');
  }

  /**
   * 固定必要本人の拒否を追記し、要求をDeclinedにする。
   * @param input Caseが現在版と要求参照を確認した内部本人判断。理由は必須にしない。
   * @returns 記録済み同意も残すDeclinedの新Entity。
   * @throws SettlementCaseInvariantViolation 状態・参照・本人・再判断・時刻が無効な場合。
   */
  decline(input: DecideSettlementCancellation): SettlementCancellationRequest {
    return this.decide(input, 'Declined');
  }

  /**
   * 固定全員の明示判断から要求の成立状態を返す。
   * @returns 一人拒否Declined、全員同意Agreed、その他Pending。
   */
  get status(): 'Pending' | 'Agreed' | 'Declined' {
    if (this.decisions.some((d) => d.decision === 'Declined'))
      return 'Declined';
    return this.requiredApproverIds.every((id) =>
      this.decisions.some(
        (d) => d.participantId === id && d.decision === 'Agreed',
      ),
    )
      ? 'Agreed'
      : 'Pending';
  }
  private decide(
    input: DecideSettlementCancellation,
    decision: 'Agreed' | 'Declined',
  ): SettlementCancellationRequest {
    requireCondition(this.status === 'Pending', 'CANCELLATION_NOT_PENDING');
    requireCondition(
      input.cancellationId === this.cancellationId &&
        input.snapshotId === this.snapshotId,
      'CANCELLATION_MISMATCH',
    );
    requireCondition(
      this.requiredApproverIds.includes(input.participantId),
      'CANCELLATION_PARTICIPANT_NOT_REQUIRED',
    );
    requireCondition(
      !this.decisions.some((d) => d.participantId === input.participantId),
      'CANCELLATION_ALREADY_DECIDED',
    );
    const decisions = Object.freeze([
      ...this.decisions,
      Object.freeze({
        participantId: input.participantId,
        decision,
        decidedAt: copyUtc(input.decidedAt),
      }),
    ]);
    return new SettlementCancellationRequest(
      this.cancellationId,
      this.snapshotId,
      this.ordinal,
      this.applicant,
      this.reason,
      this.requestedAt,
      this.requiredApproverIds,
      decisions,
    );
  }
}
