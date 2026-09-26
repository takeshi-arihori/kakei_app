import type { OperationId } from './group-repository.js';

/** Positive version of one prepared Group Management retention intent. */
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
 * Immutable persistence value for the canonical receipt owned by Group
 * Management. The canonical receipt itself stays opaque to this Application
 * contract; its format and verification remain governed by ADR #55.
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
 * Group Management owns persistence of its post-deletion receipt. An adapter
 * implements both operations at the same transaction boundary as Group and
 * CloseIntent deletion; callers may return a receipt only after commit.
 */
export interface GroupManagementDeletionReceiptPort {
  save(
    request: SaveGroupManagementDeletionReceiptRequest,
  ): Promise<GroupManagementDeletionReceiptSaveResult>;

  find(
    request: FindGroupManagementDeletionReceiptRequest,
  ): Promise<GroupManagementDeletionReceiptReadResult>;
}
