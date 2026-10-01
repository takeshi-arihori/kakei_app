import {
  SettlementCaseInvariantViolation,
  type SettlementCaseInvariantViolationCode,
} from './settlement-case-invariant-violation.js';
import { SettlementSnapshotContent } from './value-objects/settlement-snapshot-content.js';

declare const caseIdBrand: unique symbol;
declare const snapshotIdBrand: unique symbol;
declare const instructionIdBrand: unique symbol;

/** Caseの安定ID。発番済みcanonical UUIDをRoot入口で検証する。 */
export type SettlementCaseId = string & {
  /** RevisionやInstructionへの取り違えを型で防ぐ内部Brand。 */
  readonly [caseIdBrand]: true;
};
/** Case配下の不変Revision参照。独立した可変RootのIDではない。 */
export type SnapshotRevisionId = string & {
  /** Case参照とは別の寿命を持つ内部Brand。 */
  readonly [snapshotIdBrand]: true;
};
/** 固定候補から有効な指示まで変わらない参照。 */
export type PaymentInstructionId = string & {
  /** Candidateの金額や相手からIDを再計算しないための内部Brand。 */
  readonly [instructionIdBrand]: true;
};

/** 初回承認だけのCase状態。後続の再申請・支払・取消は別Taskで追加する。 */
export type SettlementCaseStatus =
  'AwaitingApproval' | 'Rejected' | 'PaymentActive' | 'Archived';

/** 本人性確立後にApplicationが解決する参照。Client申告を認可証拠にしない。 */
export type SettlementApplicant = {
  /** 元申請者の安定した内部主体参照。認証Tokenではない。 */
  readonly actorSubject: string;
  /** この申請者の対象Group内Participant。再参加で旧IDを書き換えない。 */
  readonly participantId: string;
};

/** 候補の不変な識別済み内容。指示の有効性はCaseが判断する。 */
export type SnapshotPaymentInstruction = {
  /** 発番済みの一意な固定指示参照。 */
  readonly instructionId: PaymentInstructionId;
  /** 支払責務を持つ過去Participant参照。 */
  readonly payerParticipantId: string;
  /** 受取責務を持つ過去Participant参照。 */
  readonly payeeParticipantId: string;
  /** 部分支払を認めない固定JPY整数額。 */
  readonly amount: bigint;
  /** 内部額の通貨。公開Scalar表現は後続契約とする。 */
  readonly currency: 'JPY';
};

/** Caseが所有する初回の不変な業務内容。暗号化保存Schemaではない。 */
export type SettlementSnapshotRevision = {
  /** 所有するCaseとの不変な関連。 */
  readonly caseId: SettlementCaseId;
  /** この内容を識別する不変参照。 */
  readonly snapshotId: SnapshotRevisionId;
  /** 初回のみを扱う。再申請のOrdinal契約は後続Task。 */
  readonly ordinal: 1;
  /** 初回には前版がない。却下後の再申請は未実装。 */
  readonly previousSnapshotId: null;
  /** 実際の申請者。Caseの最初の申請者を将来版で置き換えない。 */
  readonly applicant: SettlementApplicant;
  /** 信頼するCaller時刻をUTCへコピーした申請時刻。 */
  readonly submittedAt: string;
  /** 選択Expense・Balance・必要承認者を保持する算術内容。 */
  readonly content: SettlementSnapshotContent;
  /** Canonical候補順へIDを束縛した不変内容。未承認中は実行不可。 */
  readonly paymentInstructionCandidates: readonly SnapshotPaymentInstruction[];
};

/** Revisionの内容を変えずにCaseへ追記する本人判断。 */
export type SettlementApproval = {
  /** 対象Revisionを明記し、将来の新版へ引き継がない。 */
  readonly snapshotId: SnapshotRevisionId;
  /** 固定必要承認者の本人参照。Ownerによる代理を意味しない。 */
  readonly participantId: string;
  /** 操作別Methodが決める判断。支払Attemptの差し戻しとは別。 */
  readonly decision: 'Approved' | 'Rejected';
  /** 信頼するCaller時刻をUTCへ固定した決定時刻。 */
  readonly decidedAt: string;
  /** 却下時は空でない元の理由、承認時はnull。Logへ出さない。 */
  readonly reason: string | null;
};

/** 初回申請の内部入力。Source確認・認可・予約commitの証明ではない。 */
export type StartSettlementCase = {
  /** Applicationが新規発番したcanonical UUID。 */
  readonly caseId: string;
  /** Applicationが新規発番したcanonical UUID。 */
  readonly snapshotId: string;
  /** Source取得のPREを満たして固定した内容。 */
  readonly content: SettlementSnapshotContent;
  /** Activeな本人として解決済みの主体とParticipant。 */
  readonly applicant: SettlementApplicant;
  /** Domainが現在時刻を取得しないための信頼済み入力。 */
  readonly submittedAt: Date;
  /** Canonical候補と同数・同順の新規指示ID。0円精算では空。 */
  readonly instructionIds: readonly string[];
};

/** 本人判断の内部入力。永続化CASやoperation再送契約を採用しない。 */
export type DecideSettlementApproval = {
  /** Applicationが読み取ったCase版。古い判断をこの値に拒否する。 */
  readonly expectedVersion: number;
  /** 判断対象の現在Revision。過去／別Snapshotへの判断を拒否する。 */
  readonly snapshotId: string;
  /** 本人Actorに束縛して解決した固定必要承認者参照。 */
  readonly participantId: string;
  /** 記録へコピーする信頼済みの判断時刻。 */
  readonly decidedAt: Date;
};

/** 理由付き却下だけの内部入力。 */
export type RejectSettlementApproval = DecideSettlementApproval & {
  /** 空白だけを拒否し、元の理由を履歴に保持する。 */
  readonly reason: string;
};

const requireCondition = (
  condition: boolean,
  code: SettlementCaseInvariantViolationCode,
): void => {
  if (!condition) throw new SettlementCaseInvariantViolation(code);
};
const canonicalUuid = (value: string): boolean =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const nonempty = (value: string): boolean =>
  typeof value === 'string' && value.trim().length > 0;
const copyUtc = (date: Date): string => {
  requireCondition(
    date instanceof Date && Number.isFinite(date.getTime()),
    'UTC_INSTANT_INVALID',
  );
  return date.toISOString();
};
const noInstructions: readonly SnapshotPaymentInstruction[] = Object.freeze([]);

/** 固定対象・不変Revision・本人判断と全員承認Invariantを所有するRoot。 */
export class SettlementCase {
  /** 初回から変えない対象Expense集合。現在未精算一覧から再選択しない。 */
  readonly targetExpenseIds: readonly string[];

  /** Case最初の申請者。Participant寿命と安定Actor参照を区別して保持する。 */
  readonly originalApplicant: SettlementApplicant;

  private constructor(
    /** Caseを追跡する安定参照。 */
    readonly caseId: SettlementCaseId,
    /** 初回内容は判断操作で置換・変更しない。 */
    readonly snapshot: SettlementSnapshotRevision,
    /** 記録順の判断履歴。Readonlyだけでなく配列・各記録をfreezeする。 */
    readonly approvals: readonly SettlementApproval[],
    /** Rootだけが全員承認または却下から確定する状態。 */
    readonly status: SettlementCaseStatus,
    /** 初回1、判断成功ごと+1。保存AdapterのCASは後続契約。 */
    readonly version: number,
    /** No Payment Required成立時の最終承認UTC、その他はnull。 */
    readonly archivedAt: string | null,
  ) {
    this.originalApplicant = snapshot.applicant;
    this.targetExpenseIds = Object.freeze(
      snapshot.content.expenses.map((expense) => expense.expenseId),
    );
    Object.freeze(this);
  }

  /**
   * 初回内容を固定し、必要な場合だけ申請者本人の承認を記録する。
   * @param input 認可・Source確認・発番を後続Applicationで検証する内部入力。
   * @returns 初回Revisionと自己承認を保持するCase。単独必要承認者なら即時Archive。
   * @throws SettlementCaseInvariantViolation 内容VO、ID、主体参照、時刻、指示ID束縛が無効な場合。
   */
  static start(input: StartSettlementCase): SettlementCase {
    requireCondition(
      input.content instanceof SettlementSnapshotContent,
      'SNAPSHOT_CONTENT_INVALID',
    );
    requireCondition(canonicalUuid(input.caseId), 'CASE_ID_INVALID');
    requireCondition(canonicalUuid(input.snapshotId), 'SNAPSHOT_ID_INVALID');
    requireCondition(
      nonempty(input.applicant.actorSubject),
      'ACTOR_SUBJECT_EMPTY',
    );
    requireCondition(
      nonempty(input.applicant.participantId),
      'PARTICIPANT_ID_EMPTY',
    );
    requireCondition(
      input.instructionIds.length === input.content.candidates.length,
      'INSTRUCTION_COUNT_MISMATCH',
    );
    const used = new Set<string>();
    const candidates = input.content.candidates.map((candidate, i) => {
      const id = input.instructionIds[i];
      requireCondition(canonicalUuid(id), 'INSTRUCTION_ID_INVALID');
      requireCondition(!used.has(id), 'INSTRUCTION_ID_DUPLICATED');
      used.add(id);
      return Object.freeze({
        instructionId: id as PaymentInstructionId,
        ...candidate,
      });
    });
    const submittedAt = copyUtc(input.submittedAt);
    const snapshot: SettlementSnapshotRevision = Object.freeze({
      caseId: input.caseId as SettlementCaseId,
      snapshotId: input.snapshotId as SnapshotRevisionId,
      ordinal: 1,
      previousSnapshotId: null,
      applicant: Object.freeze({
        actorSubject: input.applicant.actorSubject,
        participantId: input.applicant.participantId,
      }),
      submittedAt,
      content: input.content,
      paymentInstructionCandidates: Object.freeze(candidates),
    });
    const approvals: readonly SettlementApproval[] = Object.freeze(
      snapshot.content.requiredApproverIds.includes(
        snapshot.applicant.participantId,
      )
        ? [
            Object.freeze({
              snapshotId: snapshot.snapshotId,
              participantId: snapshot.applicant.participantId,
              decision: 'Approved' as const,
              decidedAt: submittedAt,
              reason: null,
            }),
          ]
        : [],
    );
    return SettlementCase.withDecisions(snapshot, approvals, 1, submittedAt);
  }

  /**
   * 必要承認者本人の承認を追記し、全員一致時だけ指示を有効化する。
   * @param input 現在版・Revisionと本人Participantを束縛した判断。
   * @returns 元Rootを変更しない新しいCase。全0なら直接Archive。
   * @throws SettlementCaseInvariantViolation 状態・版・Revision・本人・再判断・時刻が無効な場合。
   */
  approve(input: DecideSettlementApproval): SettlementCase {
    this.requireDecision(input);
    return this.record(input, 'Approved', null);
  }

  /**
   * 理由付き却下を追記してRejectedにし、指示を有効化しない。
   * @param input 現在版・Revisionと本人Participant、空でない却下理由。
   * @returns 既存承認と却下を保持する新しいCase。元Rootは不変。
   * @throws SettlementCaseInvariantViolation 状態・版・Revision・本人・再判断・理由・時刻が無効な場合。
   */
  reject(input: RejectSettlementApproval): SettlementCase {
    this.requireDecision(input);
    requireCondition(nonempty(input.reason), 'REJECTION_REASON_EMPTY');
    return this.record(input, 'Rejected', input.reason);
  }

  /**
   * 内容を変えずに、Caseの判断履歴から現在Revisionの成立状態を返す。
   * @returns 支払有効または0円ArchiveならApproved、それ以外は現在の判断状態。
   */
  get revisionStatus(): 'AwaitingApproval' | 'Rejected' | 'Approved' {
    return this.status === 'PaymentActive' || this.status === 'Archived'
      ? 'Approved'
      : this.status;
  }

  /**
   * 全員承認済みの支払指示だけを返す。CallerがCandidateを実行してはならない。
   * @returns PaymentActive時の固定指示全件、それ以外は不変な空配列。
   */
  get activePaymentInstructions(): readonly SnapshotPaymentInstruction[] {
    return this.status === 'PaymentActive'
      ? this.snapshot.paymentInstructionCandidates
      : noInstructions;
  }

  /**
   * 初回承認で成立するArchive結果を返す。支払完了Archiveは後続Task。
   * @returns 全0円の全員承認ならNoPaymentRequired、それ以外はnull。
   */
  get archiveReason(): 'NoPaymentRequired' | null {
    return this.status === 'Archived' ? 'NoPaymentRequired' : null;
  }

  private requireDecision(input: DecideSettlementApproval): void {
    requireCondition(
      this.status === 'AwaitingApproval',
      'CASE_NOT_AWAITING_APPROVAL',
    );
    requireCondition(
      Number.isSafeInteger(input.expectedVersion) &&
        input.expectedVersion === this.version,
      'CASE_VERSION_CONFLICT',
    );
    requireCondition(
      input.snapshotId === this.snapshot.snapshotId,
      'SNAPSHOT_MISMATCH',
    );
    requireCondition(
      this.snapshot.content.requiredApproverIds.includes(input.participantId),
      'PARTICIPANT_NOT_REQUIRED',
    );
    requireCondition(
      !this.approvals.some(
        (approval) => approval.participantId === input.participantId,
      ),
      'APPROVAL_ALREADY_RECORDED',
    );
  }

  private record(
    input: DecideSettlementApproval,
    decision: 'Approved' | 'Rejected',
    reason: string | null,
  ): SettlementCase {
    const decidedAt = copyUtc(input.decidedAt);
    const approvals = Object.freeze([
      ...this.approvals,
      Object.freeze({
        snapshotId: this.snapshot.snapshotId,
        participantId: input.participantId,
        decision,
        decidedAt,
        reason,
      }),
    ]);
    return SettlementCase.withDecisions(
      this.snapshot,
      approvals,
      this.version + 1,
      decidedAt,
    );
  }

  private static withDecisions(
    snapshot: SettlementSnapshotRevision,
    approvals: readonly SettlementApproval[],
    version: number,
    decidedAt: string,
  ): SettlementCase {
    const rejected = approvals.some(
      (approval) => approval.decision === 'Rejected',
    );
    const allApproved = snapshot.content.requiredApproverIds.every((id) =>
      approvals.some(
        (approval) =>
          approval.participantId === id && approval.decision === 'Approved',
      ),
    );
    const zero = snapshot.content.balances.every(
      (balance) => balance.amount === 0n,
    );
    const status: SettlementCaseStatus = rejected
      ? 'Rejected'
      : allApproved
        ? zero
          ? 'Archived'
          : 'PaymentActive'
        : 'AwaitingApproval';
    return new SettlementCase(
      snapshot.caseId,
      snapshot,
      approvals,
      status,
      version,
      status === 'Archived' ? decidedAt : null,
    );
  }
}
