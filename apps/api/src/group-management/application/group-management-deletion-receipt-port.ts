import type { OperationId } from './group-repository.js';

/** 1つのPrepared Group Management Retention Intentを識別する正のVersion。 */
export class RetentionIntentVersion {
  private constructor(readonly value: number) {
    Object.freeze(this);
  }

  static from(value: number): RetentionIntentVersion {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(
        'Retention intent version must be a positive safe integer',
      );
    }
    return new RetentionIntentVersion(value);
  }

  equals(other: RetentionIntentVersion): boolean {
    return this.value === other.value;
  }
}

/**
 * Group Managementが所有するCanonical Receiptの不変保存値。
 * このApplication契約はReceiptの内部を解釈せず、
 * 形式と検証は引き続きADR #55に従う。
 */
export class GroupManagementDeletionReceiptRecord {
  private constructor(
    readonly operationId: OperationId,
    readonly intentVersion: RetentionIntentVersion,
    readonly canonicalReceipt: string,
  ) {
    Object.freeze(this);
  }

  static create(input: {
    readonly operationId: OperationId;
    readonly intentVersion: RetentionIntentVersion;
    readonly canonicalReceipt: string;
  }): GroupManagementDeletionReceiptRecord {
    if (input.canonicalReceipt.length === 0) {
      throw new Error('Canonical deletion receipt must not be empty');
    }
    return new GroupManagementDeletionReceiptRecord(
      input.operationId,
      input.intentVersion,
      input.canonicalReceipt,
    );
  }
}

export type SaveGroupManagementDeletionReceiptRequest = Readonly<{
  operationId: OperationId;
  intentVersion: RetentionIntentVersion;
  record: GroupManagementDeletionReceiptRecord;
}>;

export type FindGroupManagementDeletionReceiptRequest = Readonly<{
  operationId: OperationId;
  intentVersion: RetentionIntentVersion;
}>;

export type GroupManagementDeletionReceiptSaveResult =
  | Readonly<{ kind: 'Stored' }>
  | Readonly<{ kind: 'BindingMismatch' }>
  | Readonly<{ kind: 'StaleEvidence' }>
  | Readonly<{ kind: 'Unavailable' }>;

export type GroupManagementDeletionReceiptReadResult =
  | Readonly<{
      kind: 'Found';
      record: GroupManagementDeletionReceiptRecord;
    }>
  | Readonly<{ kind: 'NotFound' }>
  | Readonly<{ kind: 'BindingMismatch' }>
  | Readonly<{ kind: 'StaleEvidence' }>
  | Readonly<{ kind: 'Unavailable' }>;

/**
 * Group Managementは削除後Receiptの保存を所有する。Adapterは両操作を
 * GroupとCloseIntentの削除と同じTransaction境界で実装する。
 * 呼出し側がReceiptを返せるのはCommit後だけ。
 */
export interface GroupManagementDeletionReceiptPort {
  save(
    request: SaveGroupManagementDeletionReceiptRequest,
  ): Promise<GroupManagementDeletionReceiptSaveResult>;

  find(
    request: FindGroupManagementDeletionReceiptRequest,
  ): Promise<GroupManagementDeletionReceiptReadResult>;
}
