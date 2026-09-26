import { OperationId } from '../group-repository.js';

/** Receiptまたは鍵破棄の証跡を検証する所有Context。 */
export type RetentionContextName =
  'GroupManagement' | 'ExpenseRecording' | 'Settlement';

/** Groupデータ鍵の破棄対象と区別する鍵名前空間。 */
export type RetentionKeyNamespace =
  'GroupData' | 'ReceiptVerification' | 'Audit' | 'DeletedGroupToken';

/** 検証結果をRetention Intentへ結び付ける不透明な削除Token。 */
export class RetentionDeletionToken {
  /** 空のTokenを拒否する生成経路を`from`に限定する。 */
  private constructor(
    /** Intentとの照合に使う削除Tokenの値。 */
    readonly value: string,
  ) {
    Object.freeze(this);
  }

  /**
   * 削除結果を証明しない不透明なToken値を生成する。
   * @param value 削除Intentを識別する値。空白だけの値は受け付けない。
   * @returns 元の値を保持する不変のToken。
   * @throws {Error} valueが空文字または空白だけの場合。
   */
  static from(value: string): RetentionDeletionToken {
    if (value.trim().length === 0) {
      throw new Error('Retention deletion token must not be empty');
    }
    return new RetentionDeletionToken(value);
  }

  /**
   * Tokenの値が一致するかを比較する。
   * @param other 照合する削除Token。
   * @returns 保持する文字列が一致する場合はtrue。
   */
  equals(other: RetentionDeletionToken): boolean {
    return this.value === other.value;
  }
}

/**
 * 1件のPrepared Retention Intentを表す不変の識別情報。
 * 正のVersionにより、各Contextの検証結果を同じ削除試行へ結び付ける。
 */
export class PreparedRetentionDeletionBinding {
  private constructor(
    /** 検証対象となる削除IntentのToken。 */
    readonly deletionToken: RetentionDeletionToken,
    /** 同じ削除試行を識別するOperation ID。 */
    readonly operationId: OperationId,
    /** 再試行・更新を区別するIntent Version。 */
    readonly intentVersion: number,
  ) {
    Object.freeze(this);
  }

  /**
   * Intentを識別する不変のBindingを生成する。
   * @param input 削除Token、Operation ID、正の安全な整数のIntent Version。
   * @returns 指定された削除試行とVersionを結び付けるBinding。
   * @throws {Error} intentVersionが正の安全な整数でない場合。
   */
  static create(input: {
    /** 検証対象の削除Intentを識別するToken。 */
    readonly deletionToken: RetentionDeletionToken;
    /** 削除試行を識別するOperation ID。 */
    readonly operationId: OperationId;
    /** Prepared Intentの正のVersion。 */
    readonly intentVersion: number;
  }): PreparedRetentionDeletionBinding {
    if (!Number.isSafeInteger(input.intentVersion) || input.intentVersion < 1) {
      throw new Error(
        'Retention intent version must be a positive safe integer',
      );
    }
    return new PreparedRetentionDeletionBinding(
      input.deletionToken,
      input.operationId,
      input.intentVersion,
    );
  }

  /**
   * Token、Operation ID、Versionがすべて一致することを確認する。
   * @param other 照合するPrepared IntentのBinding。
   * @returns 3つの識別情報がすべて一致する場合はtrue。
   */
  equals(other: PreparedRetentionDeletionBinding): boolean {
    return (
      this.deletionToken.equals(other.deletionToken) &&
      this.operationId.equals(other.operationId) &&
      this.intentVersion === other.intentVersion
    );
  }
}

/** 正本Receiptを検証したContext所有者が返す結果。 */
export type ContextReceiptVerificationResult<
  C extends 'ExpenseRecording' | 'Settlement',
> =
  | Readonly<{
      /** 正本Receiptを検証したことを表す判別子。 */
      kind: 'Verified';
      /** Receiptを検証した所有Context。 */
      context: C;
      /** ReceiptをPrepared Intentへ結び付ける識別情報。 */
      binding: PreparedRetentionDeletionBinding;
    }>
  | Readonly<{
      /** Receiptを検証できず拒否したことを表す判別子。 */
      kind: 'Rejected';
      /** 拒否理由。 */
      reason: 'BindingMismatch' | 'StaleEvidence' | 'InvalidReceipt';
    }>
  | Readonly<{
      /** 所有Contextの検証処理を利用できないことを表す判別子。 */
      kind: 'Unavailable';
    }>;

/**
 * ADR #55に基づき外部Contextの正本Receiptを検証するPort。
 * Verifiedは、所有Contextが正本Field、MAC／鍵Version、Context識別子、
 * およびPrepared IntentとのBindingを確認したことを表す。
 */
export interface ContextDeletionReceiptVerifierPort<
  C extends 'ExpenseRecording' | 'Settlement',
> {
  /** このPortが証跡を所有するContext。 */
  readonly context: C;

  /**
   * 所有ContextのReceiptを指定されたPrepared Intentと照合する。
   * @param request 所有Contextの正本Receiptと照合先のBinding。
   * @returns 正本Receiptの検証結果。成功時はContextとBinding、拒否時は理由、利用不能時はUnavailableを返す。
   */
  verify(
    request: Readonly<{
      /** 所有Contextが発行した正本Receipt。 */
      canonicalReceipt: unknown;
      /** Receiptを照合するPrepared Intentの識別情報。 */
      binding: PreparedRetentionDeletionBinding;
    }>,
  ): Promise<ContextReceiptVerificationResult<C>>;
}

/** 1つのContextがGroupデータ鍵の全件を確認した結果。 */
export type ContextKeyDestructionVerificationResult =
  | Readonly<{
      /** 全Groupデータ鍵の破棄を確認したことを表す判別子。 */
      kind: 'Verified';
      /** 鍵破棄を確認した所有Context。 */
      context: RetentionContextName;
      /** 確認結果をPrepared Intentへ結び付ける識別情報。 */
      binding: PreparedRetentionDeletionBinding;
      /** 破棄を確認した鍵の名前空間。 */
      keyNamespace: RetentionKeyNamespace;
    }>
  | Readonly<{
      /** 鍵破棄を確認できず拒否したことを表す判別子。 */
      kind: 'Rejected';
      /** 不在・不完全・不一致などの拒否理由。 */
      reason:
        | 'BindingMismatch'
        | 'StaleEvidence'
        | 'MissingEvidence'
        | 'IncompleteEvidence';
    }>
  | Readonly<{
      /** 所有Contextの鍵確認処理を利用できないことを表す判別子。 */
      kind: 'Unavailable';
    }>;

/**
 * 1つのContextが所有するGroupデータ鍵の全Versionを検証するPort。
 * 呼出側が渡すVersion一覧や真偽値は受け取らず、所有者が全Versionの不存在を
 * 確認した場合に限りVerifiedを返す。
 */
export interface ContextKeyDestructionVerifierPort {
  /** このPortが鍵の完全性を検証する所有Context。 */
  readonly context: RetentionContextName;

  /**
   * 所有Context内のGroupデータ鍵が全Versionで存在しないことを確認する。
   * @param request 全Groupデータ鍵の破棄を照合するPrepared IntentのBinding。
   * @returns 全Versionの不在確認結果。一部でも未確認なら拒否し、検証を利用できない場合はUnavailableを返す。
   */
  verify(
    request: Readonly<{
      /** 鍵破棄を照合するPrepared Intentの識別情報。 */
      binding: PreparedRetentionDeletionBinding;
    }>,
  ): Promise<ContextKeyDestructionVerificationResult>;
}

const evidenceBrand: unique symbol = Symbol(
  'VerifiedRetentionDeletionEvidence',
);
const issuedEvidence = new WeakSet<object>();

/**
 * Retention削除境界が受け取る不透明な証跡。
 * Brandと発行者はModule内に隠し、必要な全Context Portの成功後にのみ
 * Application検証処理が生成する。
 */
export type VerifiedRetentionDeletionEvidence = Readonly<{
  /** Module内のApplication検証処理だけが設定できる非公開Brand。 */
  readonly [evidenceBrand]: true;
  /** 検証済み証跡をPrepared Intentへ結び付ける識別情報。 */
  readonly binding: PreparedRetentionDeletionBinding;
}>;

/** 証跡がPrepared Intentに適合せずFail Closedとなった理由。 */
export type RetentionDeletionEvidenceRejectionReason =
  | 'MissingContext'
  | 'DuplicateContext'
  | 'UnexpectedContext'
  | 'BindingMismatch'
  | 'StaleEvidence'
  | 'InvalidEvidence'
  | 'IncompleteEvidence'
  | 'KeyNamespaceMismatch';

/** 生の証明Dataを公開せず検証済み証跡を組み立てた結果。 */
export type RetentionDeletionEvidenceVerificationResult =
  | Readonly<{
      /** 全Contextの検証が成功したことを表す判別子。 */
      kind: 'Verified';
      /** 後続Retention境界に渡す不透明な証跡。 */
      evidence: VerifiedRetentionDeletionEvidence;
    }>
  | Readonly<{
      /** 証跡が不適合で拒否されたことを表す判別子。 */
      kind: 'Rejected';
      /** fail-closedとした理由。 */
      reason: RetentionDeletionEvidenceRejectionReason;
    }>
  | Readonly<{
      /** 必要な検証Portを利用できなかったことを表す判別子。 */
      kind: 'Unavailable';
    }>;

/** Prepared Intentの識別情報と外部2 Contextの不透明なReceipt。 */
export type VerifyRetentionDeletionEvidenceRequest = Readonly<{
  /** すべての検証結果を結び付けるPrepared Intent。 */
  binding: PreparedRetentionDeletionBinding;
  /** Expense Recordingが発行した不透明な正本Receipt。 */
  expenseRecordingReceipt: unknown;
  /** Settlementが発行した不透明な正本Receipt。 */
  settlementReceipt: unknown;
}>;

/** ApplicationのComposition Rootから渡す所有Context別の信頼済み検証Port。 */
export type VerifyRetentionDeletionEvidencePorts = Readonly<{
  /** Expense Recording自身が所有するReceipt検証Port。 */
  expenseReceiptVerifier: ContextDeletionReceiptVerifierPort<'ExpenseRecording'>;
  /** Settlement自身が所有するReceipt検証Port。 */
  settlementReceiptVerifier: ContextDeletionReceiptVerifierPort<'Settlement'>;
  /** 3 Contextそれぞれが所有するGroupデータ鍵検証Port。 */
  keyDestructionVerifiers: readonly ContextKeyDestructionVerifierPort[];
}>;

const contexts: readonly RetentionContextName[] = [
  'GroupManagement',
  'ExpenseRecording',
  'Settlement',
];

/**
 * 1件のPrepared Intentについて、外部2 ContextのReceiptと3 Contextが所有する
 * Groupデータ鍵の破棄確認を検証する。証跡を組み立てるだけで、Context Dataの削除、
 * 削除認可、Coordinator実行は行わない。
 * @param request 検証対象のPrepared Intentと外部2 Contextの正本Receipt。
 * @param ports Composition Rootが配線したContext所有の信頼済み検証Port。
 * @returns 全検証成功時は発行済み証跡、不適合時は拒否理由、Portの利用不能または呼出し失敗時はUnavailableを返す。
 */
export async function verifyRetentionDeletionEvidence(
  request: VerifyRetentionDeletionEvidenceRequest,
  ports: VerifyRetentionDeletionEvidencePorts,
): Promise<RetentionDeletionEvidenceVerificationResult> {
  if (!isPreparedBinding(request.binding)) {
    return { kind: 'Rejected', reason: 'BindingMismatch' };
  }

  const receiptPortResult = validateReceiptPorts(ports);
  if (receiptPortResult !== undefined) {
    return { kind: 'Rejected', reason: receiptPortResult };
  }

  const keyPortResult = validateKeyPorts(ports.keyDestructionVerifiers);
  if (keyPortResult !== undefined) {
    return { kind: 'Rejected', reason: keyPortResult };
  }

  let receiptResults: readonly [
    ContextReceiptVerificationResult<'ExpenseRecording'>,
    ContextReceiptVerificationResult<'Settlement'>,
  ];
  try {
    receiptResults = await Promise.all([
      ports.expenseReceiptVerifier.verify({
        canonicalReceipt: request.expenseRecordingReceipt,
        binding: request.binding,
      }),
      ports.settlementReceiptVerifier.verify({
        canonicalReceipt: request.settlementReceipt,
        binding: request.binding,
      }),
    ]);
  } catch {
    return { kind: 'Unavailable' };
  }

  for (const result of receiptResults) {
    if (!isReceiptVerificationResult(result)) {
      return { kind: 'Rejected', reason: 'InvalidEvidence' };
    }
    if (result.kind === 'Unavailable') return { kind: 'Unavailable' };
    if (result.kind === 'Rejected') {
      return { kind: 'Rejected', reason: mapReceiptRejection(result.reason) };
    }
    if (!result.binding.equals(request.binding)) {
      return { kind: 'Rejected', reason: 'BindingMismatch' };
    }
  }
  if (
    receiptResults[0].kind === 'Verified' &&
    receiptResults[0].context !== 'ExpenseRecording'
  ) {
    return { kind: 'Rejected', reason: 'UnexpectedContext' };
  }
  if (
    receiptResults[1].kind === 'Verified' &&
    receiptResults[1].context !== 'Settlement'
  ) {
    return { kind: 'Rejected', reason: 'UnexpectedContext' };
  }

  let keyResults: readonly ContextKeyDestructionVerificationResult[];
  try {
    keyResults = await Promise.all(
      ports.keyDestructionVerifiers.map((verifier) =>
        verifier.verify({ binding: request.binding }),
      ),
    );
  } catch {
    return { kind: 'Unavailable' };
  }

  for (const [index, result] of keyResults.entries()) {
    if (!isKeyDestructionVerificationResult(result)) {
      return { kind: 'Rejected', reason: 'IncompleteEvidence' };
    }
    if (result.kind === 'Unavailable') return { kind: 'Unavailable' };
    if (result.kind === 'Rejected') {
      return { kind: 'Rejected', reason: mapKeyRejection(result.reason) };
    }
    if (result.keyNamespace !== 'GroupData') {
      return { kind: 'Rejected', reason: 'KeyNamespaceMismatch' };
    }
    if (result.context !== ports.keyDestructionVerifiers[index]?.context) {
      return { kind: 'Rejected', reason: 'UnexpectedContext' };
    }
    if (!result.binding.equals(request.binding)) {
      return { kind: 'Rejected', reason: 'BindingMismatch' };
    }
  }

  const evidence = issueVerifiedEvidence(request.binding);
  return { kind: 'Verified', evidence };
}

/**
 * 後続Application Portが受け取る不透明値のRuntime Guard。
 * @param value このModuleが発行した証跡かを調べる値。
 * @returns 発行済みの同一オブジェクトの場合だけtrue。形が同じ複製や呼出側の自作値はfalse。
 */
export function isVerifiedRetentionDeletionEvidence(
  value: unknown,
): value is VerifiedRetentionDeletionEvidence {
  return (
    typeof value === 'object' && value !== null && issuedEvidence.has(value)
  );
}

function issueVerifiedEvidence(
  binding: PreparedRetentionDeletionBinding,
): VerifiedRetentionDeletionEvidence {
  const value = Object.freeze({
    [evidenceBrand]: true as const,
    binding,
  });
  issuedEvidence.add(value);
  return value;
}

function validateReceiptPorts(
  ports: VerifyRetentionDeletionEvidencePorts,
): RetentionDeletionEvidenceRejectionReason | undefined {
  const receiptContexts = [
    ports.expenseReceiptVerifier.context,
    ports.settlementReceiptVerifier.context,
  ];
  if (new Set(receiptContexts).size !== receiptContexts.length) {
    return 'DuplicateContext';
  }
  if (
    ports.expenseReceiptVerifier.context !== 'ExpenseRecording' ||
    ports.settlementReceiptVerifier.context !== 'Settlement'
  ) {
    return 'MissingContext';
  }
}

function validateKeyPorts(
  ports: readonly ContextKeyDestructionVerifierPort[],
): RetentionDeletionEvidenceRejectionReason | undefined {
  const supplied = ports.map(({ context }) => context);
  if (new Set(supplied).size !== supplied.length) return 'DuplicateContext';
  if (supplied.some((context) => !contexts.includes(context))) {
    return 'UnexpectedContext';
  }
  if (contexts.some((context) => !supplied.includes(context))) {
    return 'MissingContext';
  }
}

function mapReceiptRejection(
  reason: 'BindingMismatch' | 'StaleEvidence' | 'InvalidReceipt',
): RetentionDeletionEvidenceRejectionReason {
  switch (reason) {
    case 'BindingMismatch':
      return 'BindingMismatch';
    case 'StaleEvidence':
      return 'StaleEvidence';
    case 'InvalidReceipt':
      return 'InvalidEvidence';
  }
}

function mapKeyRejection(
  reason:
    | 'BindingMismatch'
    | 'StaleEvidence'
    | 'MissingEvidence'
    | 'IncompleteEvidence',
): RetentionDeletionEvidenceRejectionReason {
  switch (reason) {
    case 'BindingMismatch':
      return 'BindingMismatch';
    case 'StaleEvidence':
      return 'StaleEvidence';
    case 'MissingEvidence':
      return 'MissingContext';
    case 'IncompleteEvidence':
      return 'IncompleteEvidence';
  }
}

function isPreparedBinding(
  value: unknown,
): value is PreparedRetentionDeletionBinding {
  return (
    value instanceof PreparedRetentionDeletionBinding &&
    Object.isFrozen(value) &&
    value.intentVersion > 0 &&
    Number.isSafeInteger(value.intentVersion) &&
    value.deletionToken instanceof RetentionDeletionToken &&
    Object.isFrozen(value.deletionToken) &&
    typeof value.deletionToken.value === 'string' &&
    value.deletionToken.value.trim().length > 0 &&
    value.operationId instanceof OperationId &&
    Object.isFrozen(value.operationId) &&
    typeof value.operationId.value === 'string' &&
    value.operationId.value.trim().length > 0
  );
}

function isReceiptVerificationResult(
  value: unknown,
): value is ContextReceiptVerificationResult<
  'ExpenseRecording' | 'Settlement'
> {
  if (!isRecord(value)) return false;
  if (value.kind === 'Unavailable') return true;
  if (value.kind === 'Rejected') {
    return (
      value.reason === 'BindingMismatch' ||
      value.reason === 'StaleEvidence' ||
      value.reason === 'InvalidReceipt'
    );
  }
  return (
    value.kind === 'Verified' &&
    (value.context === 'ExpenseRecording' || value.context === 'Settlement') &&
    isPreparedBinding(value.binding)
  );
}

function isKeyDestructionVerificationResult(
  value: unknown,
): value is ContextKeyDestructionVerificationResult {
  if (!isRecord(value)) return false;
  if (value.kind === 'Unavailable') return true;
  if (value.kind === 'Rejected') {
    return (
      value.reason === 'BindingMismatch' ||
      value.reason === 'StaleEvidence' ||
      value.reason === 'MissingEvidence' ||
      value.reason === 'IncompleteEvidence'
    );
  }
  return (
    value.kind === 'Verified' &&
    isRetentionContextName(value.context) &&
    isRetentionKeyNamespace(value.keyNamespace) &&
    isPreparedBinding(value.binding)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRetentionContextName(value: unknown): value is RetentionContextName {
  return (
    value === 'GroupManagement' ||
    value === 'ExpenseRecording' ||
    value === 'Settlement'
  );
}

function isRetentionKeyNamespace(
  value: unknown,
): value is RetentionKeyNamespace {
  return (
    value === 'GroupData' ||
    value === 'ReceiptVerification' ||
    value === 'Audit' ||
    value === 'DeletedGroupToken'
  );
}
