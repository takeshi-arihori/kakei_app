import { OperationId } from '../group-repository.js';

/** Receiptまたは鍵破棄の証跡を検証する所有Context。 */
export type RetentionContextName =
  'GroupManagement' | 'ExpenseRecording' | 'Settlement';

/** Groupデータ鍵の破棄対象と区別する鍵名前空間。 */
export type RetentionKeyNamespace =
  'GroupData' | 'ReceiptVerification' | 'Audit' | 'DeletedGroupToken';

/** 検証結果をRetention Intentへ結び付ける不透明な削除Token。 */
export class RetentionDeletionToken {
  /** 内部値の漏えいを避けるため、生成には`from`を使用する。 */
  private constructor(
    /** Intentとの照合に使う削除Tokenの値。 */
    readonly value: string,
  ) {
    Object.freeze(this);
  }

  /** 削除結果を証明しない不透明なToken値を生成する。 */
  static from(value: string): RetentionDeletionToken {
    if (value.trim().length === 0) {
      throw new Error('Retention deletion token must not be empty');
    }
    return new RetentionDeletionToken(value);
  }

  /** 検証証跡として値を公開せずにTokenを比較する。 */
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

  /** 有効なBindingを生成し、不正なIntent Versionを拒否する。 */
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

  /** Token、Operation ID、Versionがすべて一致することを確認する。 */
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

  /** 所有ContextのReceiptを指定されたPrepared Intentと照合する。 */
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

  /** 所有Context内のGroupデータ鍵が全Versionで存在しないことを確認する。 */
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

/** Retention削除境界が受け取る不透明な証跡を検証する未実装のUse Case。 */
export async function verifyRetentionDeletionEvidence(
  request: VerifyRetentionDeletionEvidenceRequest,
  ports: VerifyRetentionDeletionEvidencePorts,
): Promise<RetentionDeletionEvidenceVerificationResult> {
  void request;
  void ports;
  return { kind: 'Unavailable' };
}

/** 発行済みRetention削除証跡かを確認する未実装のRuntime Guard。 */
export function isVerifiedRetentionDeletionEvidence(
  value: unknown,
): value is VerifiedRetentionDeletionEvidence {
  void value;
  return false;
}
