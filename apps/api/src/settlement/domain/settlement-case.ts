import {
  canonicalUuid,
  copyUtc,
  nonempty,
  requireCondition,
} from './settlement-case-validation.js';
import {
  PaymentAttempt,
  type ReportSettlementPayment,
  type DecideSettlementReceipt,
  type ReturnSettlementPayment,
} from './entities/payment-attempt.js';
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

/** 承認・新版・取り下げ・支払完了のCase状態。取消は後続Task。 */
export type SettlementCaseStatus =
  'AwaitingApproval' | 'Rejected' | 'PaymentActive' | 'Archived' | 'Withdrawn';

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

/** 指示の不変内容に、報告履歴から導出する現在状態を添える。 */
export type SettlementPaymentInstruction = SnapshotPaymentInstruction & {
  /** 差し戻し後はUnpaidへ戻り、過去報告は別履歴として残る。 */
  readonly status: 'Unpaid' | 'Reported' | 'Received';
  /** この指示の最新Attempt。未報告ならnull。 */
  readonly latestAttemptId: PaymentAttempt['attemptId'] | null;
};

/** Caseが所有する不変なRevision内容。暗号化保存Schemaではない。 */
export type SettlementSnapshotRevision = {
  /** 所有するCaseとの不変な関連。 */
  readonly caseId: SettlementCaseId;
  /** この内容を識別する不変参照。 */
  readonly snapshotId: SnapshotRevisionId;
  /** 初回1、再申請ごと+1。同じCase内の連鎖順。 */
  readonly ordinal: number;
  /** 初回null、新版は直前のRejected Revision参照。 */
  readonly previousSnapshotId: SnapshotRevisionId | null;
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

/** 再申請・取り下げの内部資格事実。具体認可PortやClient role proofではない。 */
export type SettlementCaseActor = {
  /** Applicationが本人へ束縛して解決した操作Participantと安定主体参照。 */
  readonly applicant: SettlementApplicant;
  /** 同一Group・同一判断点で取得する現在Ownerの主体参照。正しさはSource PRE。 */
  readonly currentOwnerSubject: string;
};

/** 訂正済みSourceから同じ対象集合を再申請する内部入力。 */
export type ResubmitSettlementCase = Omit<StartSettlementCase, 'caseId'> &
  SettlementCaseActor & {
    /** 読取時のCase版。実保存CASはApplication/Adapterが検証する。 */
    readonly expectedVersion: number;
    /** 新snapshotIdとは別の、再申請元の現在Revision参照。 */
    readonly currentSnapshotId: string;
  };

/** AwaitingApprovalまたはRejected Case全体の理由付き取り下げ入力。 */
export type WithdrawSettlementCase = SettlementCaseActor & {
  /** 読取時のCase版。実予約解放とのatomic commitは後続責務。 */
  readonly expectedVersion: number;
  /** 取り下げ時点の現在Revision参照。 */
  readonly snapshotId: string;
  /** 元の理由を履歴へ保持し、空白だけを拒否する。 */
  readonly reason: string;
  /** 信頼するCaller時刻をUTCへコピーして記録する。 */
  readonly withdrawnAt: Date;
};

/** 全Revisionと判断を残してCaseを終端にした不変な取り下げ記録。 */
export type SettlementWithdrawal = {
  /** 取り下げ時の最新Revision。不成立な内容を承認済みに変更しない。 */
  readonly snapshotId: SnapshotRevisionId;
  /** 実際の操作本人。現在Owner factをこの記録で証明しない。 */
  readonly applicant: SettlementApplicant;
  /** 取り下げ理由を元の内容で保持する。Logへ出さない。 */
  readonly reason: string;
  /** Caller DateからコピーしたUTC時刻。 */
  readonly withdrawnAt: string;
};

const noInstructions: readonly SnapshotPaymentInstruction[] = Object.freeze([]);
const noExpenseIds: readonly string[] = Object.freeze([]);

/** 固定対象・不変Revision・本人判断と全員承認Invariantを所有するRoot。 */
export class SettlementCase {
  /** 初回から変えない対象Expense集合。新版にも追加・除外を許可しない。 */
  readonly targetExpenseIds: readonly string[];

  /** Case最初の申請者。Participant寿命と安定Actor参照を区別して保持する。 */
  readonly originalApplicant: SettlementApplicant;

  private constructor(
    /** Caseを追跡する安定参照。 */
    readonly caseId: SettlementCaseId,
    /** 旧内容を変えずに追記する全Revision履歴。 */
    readonly revisions: readonly SettlementSnapshotRevision[],
    /** 記録順の判断履歴。Readonlyだけでなく配列・各記録をfreezeする。 */
    readonly approvals: readonly SettlementApproval[],
    /** 本人判断・再申請・全体取り下げからRootが確定するCase状態。 */
    readonly status: SettlementCaseStatus,
    /** 初回1、判断・再申請・取り下げ・支払操作成功ごと+1。実保存CASは別契約。 */
    readonly version: number,
    /** 同指示の全支払報告と受取判断。Root経由でのみ履歴を進める。 */
    readonly paymentAttempts: readonly PaymentAttempt[],
    /** 理由付き全体取り下げの記録。未取り下げならnull。 */
    readonly withdrawal: SettlementWithdrawal | null,
    /** 全0承認または全受取成立の最終操作UTC。未Archiveならnull。 */
    readonly archivedAt: string | null,
  ) {
    this.originalApplicant = revisions[0].applicant;
    this.targetExpenseIds = Object.freeze(
      revisions[0].content.expenses.map((expense) => expense.expenseId),
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
    const snapshot = SettlementCase.createRevision(input, 1, null);
    return SettlementCase.withDecisions(
      Object.freeze([snapshot]),
      SettlementCase.selfApproval(snapshot),
      1,
      snapshot.submittedAt,
      null,
    );
  }

  private static createRevision(
    input: StartSettlementCase,
    ordinal: number,
    previousSnapshotId: SnapshotRevisionId | null,
  ): SettlementSnapshotRevision {
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
      ordinal,
      previousSnapshotId,
      applicant: Object.freeze({
        actorSubject: input.applicant.actorSubject,
        participantId: input.applicant.participantId,
      }),
      submittedAt,
      content: input.content,
      paymentInstructionCandidates: Object.freeze(candidates),
    });
    return snapshot;
  }

  private static selfApproval(
    snapshot: SettlementSnapshotRevision,
  ): readonly SettlementApproval[] {
    return Object.freeze(
      snapshot.content.requiredApproverIds.includes(
        snapshot.applicant.participantId,
      )
        ? [
            Object.freeze({
              snapshotId: snapshot.snapshotId,
              participantId: snapshot.applicant.participantId,
              decision: 'Approved' as const,
              decidedAt: snapshot.submittedAt,
              reason: null,
            }),
          ]
        : [],
    );
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
   * 同じ対象集合の訂正済み内容を新版にし、旧判断を継承せず改めて承認を求める。
   * @param input 資格・Source・期待Expense版のPREをApplicationで満たす内部事実。
   * @returns 旧Revisionと全判断を残す新Root。元申請者と対象集合は不変。
   * @throws SettlementCaseInvariantViolation 状態・資格・版・参照・集合・新規ID・内容・時刻が無効な場合。
   */
  resubmit(input: ResubmitSettlementCase): SettlementCase {
    requireCondition(this.status === 'Rejected', 'CASE_NOT_REJECTED');
    this.requireCurrentRevision(input.expectedVersion, input.currentSnapshotId);
    this.requireCaseActor(input);
    const snapshot = SettlementCase.createRevision(
      {
        caseId: this.caseId,
        snapshotId: input.snapshotId,
        content: input.content,
        applicant: input.applicant,
        submittedAt: input.submittedAt,
        instructionIds: input.instructionIds,
      },
      this.revisions.length + 1,
      this.snapshot.snapshotId,
    );
    requireCondition(
      snapshot.content.groupId === this.revisions[0].content.groupId,
      'REVISION_GROUP_MISMATCH',
    );
    const ids = snapshot.content.expenses.map((expense) => expense.expenseId);
    requireCondition(
      ids.length === this.targetExpenseIds.length &&
        ids.every((id, i) => id === this.targetExpenseIds[i]),
      'TARGET_EXPENSE_SET_MISMATCH',
    );
    requireCondition(
      !this.revisions.some(
        (revision) => revision.snapshotId === snapshot.snapshotId,
      ),
      'SNAPSHOT_ID_REUSED',
    );
    const usedInstructions = new Set(
      this.revisions.flatMap((revision) =>
        revision.paymentInstructionCandidates.map(
          (candidate) => candidate.instructionId,
        ),
      ),
    );
    requireCondition(
      snapshot.paymentInstructionCandidates.every(
        (candidate) => !usedInstructions.has(candidate.instructionId),
      ),
      'INSTRUCTION_ID_REUSED',
    );
    return SettlementCase.withDecisions(
      Object.freeze([...this.revisions, snapshot]),
      Object.freeze([
        ...this.approvals,
        ...SettlementCase.selfApproval(snapshot),
      ]),
      this.version + 1,
      snapshot.submittedAt,
      null,
    );
  }

  /**
   * 理由を残してCase全体を取り下げる。実予約解放は共通commitの後続責務。
   * @param input 元申請者または現在Ownerとして本人へ束縛した操作事実。
   * @returns 全履歴と全対象解放の判断を保持するWithdrawn終端Root。
   * @throws SettlementCaseInvariantViolation 状態・資格・版・Revision・理由・時刻が無効な場合。
   */
  withdraw(input: WithdrawSettlementCase): SettlementCase {
    requireCondition(
      this.status === 'AwaitingApproval' || this.status === 'Rejected',
      'CASE_CANNOT_BE_WITHDRAWN',
    );
    this.requireCurrentRevision(input.expectedVersion, input.snapshotId);
    this.requireCaseActor(input);
    requireCondition(nonempty(input.reason), 'WITHDRAWAL_REASON_EMPTY');
    const withdrawnAt = copyUtc(input.withdrawnAt);
    const withdrawal = Object.freeze({
      snapshotId: this.snapshot.snapshotId,
      applicant: Object.freeze({
        actorSubject: input.applicant.actorSubject,
        participantId: input.applicant.participantId,
      }),
      reason: input.reason,
      withdrawnAt,
    });
    return SettlementCase.withDecisions(
      this.revisions,
      this.approvals,
      this.version + 1,
      withdrawnAt,
      withdrawal,
    );
  }

  /**
   * 最新Revision内容を返す。旧版はrevisionsに保持し、再申請で書き換えない。
   * @returns 初回または最新の不変Revision内容。
   */
  get snapshot(): SettlementSnapshotRevision {
    return this.revisions[this.revisions.length - 1];
  }

  /**
   * 最新Revisionの判断だけを取り出す。旧承認を新版の成立条件へ混ぜない。
   * @returns 最新Snapshot参照に属する不変の判断配列。
   */
  get currentRevisionApprovals(): readonly SettlementApproval[] {
    return Object.freeze(
      this.approvals.filter(
        (approval) => approval.snapshotId === this.snapshot.snapshotId,
      ),
    );
  }

  /**
   * Case取り下げ時に解放すべき全対象を返す。Adapterの実解放済み証拠ではない。
   * @returns Withdrawnなら初回固定集合全件、その他は不変な空配列。
   */
  get expenseIdsToRelease(): readonly string[] {
    return this.status === 'Withdrawn' ? this.targetExpenseIds : noExpenseIds;
  }

  /**
   * 内容を変えずに、Caseの判断履歴から現在Revisionの成立状態を返す。
   * @returns 最新Revisionの判断状態。Case取り下げで承認成立へ変更しない。
   */
  get revisionStatus(): 'AwaitingApproval' | 'Rejected' | 'Approved' {
    const approvals = this.currentRevisionApprovals;
    if (approvals.some((approval) => approval.decision === 'Rejected'))
      return 'Rejected';
    return this.snapshot.content.requiredApproverIds.every((id) =>
      approvals.some(
        (approval) =>
          approval.participantId === id && approval.decision === 'Approved',
      ),
    )
      ? 'Approved'
      : 'AwaitingApproval';
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
   * 支払なしの全員承認と、全支払受取確認によるArchiveを区別する。
   * @returns 全0承認ならNoPaymentRequired、全受取ならAllPaymentsReceived、未完了ならnull。
   */
  get archiveReason(): 'NoPaymentRequired' | 'AllPaymentsReceived' | null {
    if (this.status !== 'Archived') return null;
    return this.snapshot.paymentInstructionCandidates.length === 0
      ? 'NoPaymentRequired'
      : 'AllPaymentsReceived';
  }

  /**
   * 支払者本人の全額報告を新Attemptとして記録する。実送金は行わない。
   * @param input 本人・版・固定指示に束縛した内部報告事実。
   * @returns 全履歴と新報告を保持し、受取確認を待つ新Root。
   * @throws SettlementCaseInvariantViolation 状態・参照・版・本人・額・ID・時刻・既存報告が無効な場合。
   */
  reportPayment(input: ReportSettlementPayment): SettlementCase {
    const instruction = this.requirePaymentInstruction(input);
    const latest = this.latestAttempt(instruction.instructionId);
    requireCondition(
      !latest || latest.status === 'Returned',
      'INSTRUCTION_NOT_UNPAID',
    );
    requireCondition(
      !this.paymentAttempts.some((a) => a.attemptId === input.attemptId),
      'ATTEMPT_ID_REUSED',
    );
    const ordinal =
      this.paymentAttempts.filter(
        (a) => a.instructionId === instruction.instructionId,
      ).length + 1;
    const attempt = PaymentAttempt.report(
      this.snapshot.snapshotId,
      instruction,
      input,
      ordinal,
    );
    return this.withPaymentAttempt(attempt, attempt.reportedAt);
  }

  /**
   * 受取側本人が最新報告を確認し、全件成立時だけCaseをArchiveする。
   * @param input 本人・現在版・指示・最新Attemptに束縛した内部判断。
   * @returns 受取記録と全件完了判定を保持する新Root。
   * @throws SettlementCaseInvariantViolation 状態・参照・版・最新報告・本人・時刻が無効な場合。
   */
  confirmReceipt(input: DecideSettlementReceipt): SettlementCase {
    const attempt = this.requireLatestAttempt(input).confirmReceipt(input);
    return this.withPaymentAttempt(attempt, attempt.receipt!.decidedAt);
  }

  /**
   * 最新報告を受取側本人が理由付きで差し戻し、同指示の再報告を可能にする。
   * @param input 本人・現在版・最新Attemptと空でない理由。
   * @returns 旧報告factsと差し戻し履歴を保持する新Root。
   * @throws SettlementCaseInvariantViolation 状態・版・参照・本人・理由・時刻が無効な場合。
   */
  returnPayment(input: ReturnSettlementPayment): SettlementCase {
    const attempt = this.requireLatestAttempt(input).returnPayment(input);
    return this.withPaymentAttempt(attempt, attempt.receipt!.decidedAt);
  }

  /**
   * 承認済み固定指示の現在状態を、不変な履歴参照とともに返す。
   * @returns 未承認なら空、承認済みなら全指示。Returned後はUnpaid、履歴は削除しない。
   */
  get paymentInstructions(): readonly SettlementPaymentInstruction[] {
    if (this.revisionStatus !== 'Approved') return Object.freeze([]);
    return Object.freeze(
      this.snapshot.paymentInstructionCandidates.map((instruction) => {
        const latest = this.latestAttempt(instruction.instructionId);
        return Object.freeze({
          ...instruction,
          status:
            !latest || latest.status === 'Returned'
              ? ('Unpaid' as const)
              : latest.status,
          latestAttemptId: latest?.attemptId ?? null,
        });
      }),
    );
  }

  private requirePaymentInstruction(
    input: ReportSettlementPayment | DecideSettlementReceipt,
  ): SnapshotPaymentInstruction {
    requireCondition(
      this.status === 'PaymentActive',
      'CASE_NOT_PAYMENT_ACTIVE',
    );
    this.requireCurrentRevision(input.expectedVersion, input.snapshotId);
    const instruction = this.snapshot.paymentInstructionCandidates.find(
      (i) => i.instructionId === input.instructionId,
    );
    requireCondition(!!instruction, 'INSTRUCTION_NOT_FOUND');
    return instruction!;
  }

  private latestAttempt(instructionId: string): PaymentAttempt | undefined {
    return this.paymentAttempts.findLast(
      (a) => a.instructionId === instructionId,
    );
  }

  private requireLatestAttempt(input: DecideSettlementReceipt): PaymentAttempt {
    const instruction = this.requirePaymentInstruction(input);
    const attempt = this.latestAttempt(instruction.instructionId);
    requireCondition(
      !!attempt && attempt.attemptId === input.attemptId,
      'ATTEMPT_MISMATCH',
    );
    return attempt!;
  }

  private withPaymentAttempt(
    attempt: PaymentAttempt,
    decidedAt: string,
  ): SettlementCase {
    const existing = this.paymentAttempts.some(
      (a) => a.attemptId === attempt.attemptId,
    );
    const attempts = Object.freeze(
      existing
        ? this.paymentAttempts.map((a) =>
            a.attemptId === attempt.attemptId ? attempt : a,
          )
        : [...this.paymentAttempts, attempt],
    );
    const received = this.snapshot.paymentInstructionCandidates.every(
      (instruction) =>
        attempts.findLast((a) => a.instructionId === instruction.instructionId)
          ?.status === 'Received',
    );
    return new SettlementCase(
      this.caseId,
      this.revisions,
      this.approvals,
      received ? 'Archived' : 'PaymentActive',
      this.version + 1,
      attempts,
      this.withdrawal,
      received ? decidedAt : null,
    );
  }

  private requireDecision(input: DecideSettlementApproval): void {
    requireCondition(
      this.status === 'AwaitingApproval',
      'CASE_NOT_AWAITING_APPROVAL',
    );
    this.requireCurrentRevision(input.expectedVersion, input.snapshotId);
    requireCondition(
      this.snapshot.content.requiredApproverIds.includes(input.participantId),
      'PARTICIPANT_NOT_REQUIRED',
    );
    requireCondition(
      !this.currentRevisionApprovals.some(
        (approval) => approval.participantId === input.participantId,
      ),
      'APPROVAL_ALREADY_RECORDED',
    );
  }

  private requireCurrentRevision(
    expectedVersion: number,
    snapshotId: string,
  ): void {
    requireCondition(
      Number.isSafeInteger(expectedVersion) && expectedVersion === this.version,
      'CASE_VERSION_CONFLICT',
    );
    requireCondition(
      snapshotId === this.snapshot.snapshotId,
      'SNAPSHOT_MISMATCH',
    );
  }

  private requireCaseActor(input: SettlementCaseActor): void {
    requireCondition(
      nonempty(input.applicant.actorSubject),
      'ACTOR_SUBJECT_EMPTY',
    );
    requireCondition(
      nonempty(input.applicant.participantId),
      'PARTICIPANT_ID_EMPTY',
    );
    requireCondition(
      nonempty(input.currentOwnerSubject),
      'CURRENT_OWNER_SUBJECT_EMPTY',
    );
    requireCondition(
      input.applicant.actorSubject === this.originalApplicant.actorSubject ||
        input.applicant.actorSubject === input.currentOwnerSubject,
      'ACTOR_NOT_CASE_APPLICANT_OR_OWNER',
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
      this.revisions,
      approvals,
      this.version + 1,
      decidedAt,
      this.withdrawal,
    );
  }

  private static withDecisions(
    revisions: readonly SettlementSnapshotRevision[],
    approvals: readonly SettlementApproval[],
    version: number,
    decidedAt: string,
    withdrawal: SettlementWithdrawal | null,
  ): SettlementCase {
    const snapshot = revisions[revisions.length - 1];
    const currentApprovals = approvals.filter(
      (approval) => approval.snapshotId === snapshot.snapshotId,
    );
    const rejected = currentApprovals.some(
      (approval) => approval.decision === 'Rejected',
    );
    const allApproved = snapshot.content.requiredApproverIds.every((id) =>
      currentApprovals.some(
        (approval) =>
          approval.participantId === id && approval.decision === 'Approved',
      ),
    );
    const zero = snapshot.content.balances.every(
      (balance) => balance.amount === 0n,
    );
    const status: SettlementCaseStatus = withdrawal
      ? 'Withdrawn'
      : rejected
        ? 'Rejected'
        : allApproved
          ? zero
            ? 'Archived'
            : 'PaymentActive'
          : 'AwaitingApproval';
    return new SettlementCase(
      snapshot.caseId,
      revisions,
      approvals,
      status,
      version,
      Object.freeze([]),
      withdrawal,
      status === 'Archived' ? decidedAt : null,
    );
  }
}
