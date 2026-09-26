import { describe, expect, it } from 'vitest';

import { OperationId } from './group-repository.js';
import {
  GroupManagementDeletionReceiptRecord,
  RetentionIntentVersion,
  type GroupManagementDeletionReceiptPort,
  type GroupManagementDeletionReceiptReadResult,
  type GroupManagementDeletionReceiptSaveResult,
} from './group-management-deletion-receipt-port.js';

const operationId = OperationId.from('retention-operation-1');
const otherOperationId = OperationId.from('retention-operation-2');
const intentVersion = RetentionIntentVersion.from(3);
const otherIntentVersion = RetentionIntentVersion.from(4);

const record = GroupManagementDeletionReceiptRecord.create({
  operationId,
  intentVersion,
  canonicalReceipt: 'canonical-receipt-value',
});

class InMemoryReceiptPort implements GroupManagementDeletionReceiptPort {
  private readonly records = new Map<
    string,
    GroupManagementDeletionReceiptRecord
  >();
  unavailable = false;

  async save(request: {
    readonly operationId: OperationId;
    readonly intentVersion: RetentionIntentVersion;
    readonly record: GroupManagementDeletionReceiptRecord;
  }): Promise<GroupManagementDeletionReceiptSaveResult> {
    await Promise.resolve();
    if (this.unavailable) return { kind: 'Unavailable' };
    if (
      !request.operationId.equals(request.record.operationId) ||
      !request.intentVersion.equals(request.record.intentVersion)
    ) {
      return { kind: 'BindingMismatch' };
    }

    const existingForOperation = [...this.records.values()].find((candidate) =>
      candidate.operationId.equals(request.operationId),
    );
    if (existingForOperation !== undefined) {
      if (
        existingForOperation.intentVersion.value > request.intentVersion.value
      ) {
        return { kind: 'StaleEvidence' };
      }
      if (!existingForOperation.intentVersion.equals(request.intentVersion)) {
        return { kind: 'BindingMismatch' };
      }
      return existingForOperation.canonicalReceipt ===
        request.record.canonicalReceipt
        ? { kind: 'Stored' }
        : { kind: 'BindingMismatch' };
    }

    this.records.set(
      this.key(request.operationId, request.intentVersion),
      request.record,
    );
    return { kind: 'Stored' };
  }

  async find(request: {
    readonly operationId: OperationId;
    readonly intentVersion: RetentionIntentVersion;
  }): Promise<GroupManagementDeletionReceiptReadResult> {
    await Promise.resolve();
    if (this.unavailable) return { kind: 'Unavailable' };
    const exact = this.records.get(
      this.key(request.operationId, request.intentVersion),
    );
    if (exact !== undefined) {
      return exact.operationId.equals(request.operationId) &&
        exact.intentVersion.equals(request.intentVersion)
        ? { kind: 'Found', record: exact }
        : { kind: 'BindingMismatch' };
    }

    const otherVersion = [...this.records.values()].find((candidate) =>
      candidate.operationId.equals(request.operationId),
    );
    if (otherVersion === undefined) return { kind: 'NotFound' };
    return otherVersion.intentVersion.value > request.intentVersion.value
      ? { kind: 'StaleEvidence' }
      : { kind: 'BindingMismatch' };
  }

  seedCorruptLookup(
    request: {
      readonly operationId: OperationId;
      readonly intentVersion: RetentionIntentVersion;
    },
    mismatchedRecord: GroupManagementDeletionReceiptRecord,
  ): void {
    this.records.set(
      this.key(request.operationId, request.intentVersion),
      mismatchedRecord,
    );
  }

  private key(id: OperationId, version: RetentionIntentVersion): string {
    return `${id.value}:${version.value}`;
  }
}

describe('Group Management deletion Receipt Port contract', () => {
  it('same operation and intent version replay the same immutable record', async () => {
    const port = new InMemoryReceiptPort();
    const binding = { operationId, intentVersion, record };
    const conflictingRecord = GroupManagementDeletionReceiptRecord.create({
      operationId,
      intentVersion,
      canonicalReceipt: 'different-canonical-receipt',
    });

    await expect(port.save(binding)).resolves.toEqual({ kind: 'Stored' });
    await expect(port.save(binding)).resolves.toEqual({ kind: 'Stored' });
    await expect(
      port.save({ operationId, intentVersion, record: conflictingRecord }),
    ).resolves.toEqual({ kind: 'BindingMismatch' });
    await expect(port.find({ operationId, intentVersion })).resolves.toEqual({
      kind: 'Found',
      record,
    });
    expect(Object.isFrozen(record)).toBe(true);
  });

  it('rejects a record saved under a different operation or intent version', async () => {
    const port = new InMemoryReceiptPort();

    await expect(
      port.save({ operationId: otherOperationId, intentVersion, record }),
    ).resolves.toEqual({ kind: 'BindingMismatch' });
    await expect(
      port.save({ operationId, intentVersion: otherIntentVersion, record }),
    ).resolves.toEqual({ kind: 'BindingMismatch' });

    const mismatched = GroupManagementDeletionReceiptRecord.create({
      operationId: otherOperationId,
      intentVersion,
      canonicalReceipt: 'receipt-bound-to-another-operation',
    });
    port.seedCorruptLookup({ operationId, intentVersion }, mismatched);
    await expect(port.find({ operationId, intentVersion })).resolves.toEqual({
      kind: 'BindingMismatch',
    });
  });

  it('fails closed when evidence from a newer intent version is presented as current', async () => {
    const port = new InMemoryReceiptPort();
    const newer = GroupManagementDeletionReceiptRecord.create({
      operationId,
      intentVersion: otherIntentVersion,
      canonicalReceipt: 'newer-canonical-receipt',
    });
    await port.save({
      operationId,
      intentVersion: otherIntentVersion,
      record: newer,
    });

    await expect(port.find({ operationId, intentVersion })).resolves.toEqual({
      kind: 'StaleEvidence',
    });
    await expect(
      port.save({ operationId, intentVersion, record }),
    ).resolves.toEqual({
      kind: 'StaleEvidence',
    });
  });

  it('distinguishes absent records from operation/intent mismatches', async () => {
    const port = new InMemoryReceiptPort();
    await expect(port.find({ operationId, intentVersion })).resolves.toEqual({
      kind: 'NotFound',
    });
    await port.save({ operationId, intentVersion, record });
    await expect(
      port.find({ operationId, intentVersion: otherIntentVersion }),
    ).resolves.toEqual({ kind: 'BindingMismatch' });
    await expect(
      port.find({ operationId: otherOperationId, intentVersion }),
    ).resolves.toEqual({ kind: 'NotFound' });
  });

  it('returns Unavailable without exposing evidence when storage is unavailable', async () => {
    const port = new InMemoryReceiptPort();
    port.unavailable = true;

    await expect(
      port.save({ operationId, intentVersion, record }),
    ).resolves.toEqual({
      kind: 'Unavailable',
    });
    await expect(port.find({ operationId, intentVersion })).resolves.toEqual({
      kind: 'Unavailable',
    });
  });

  it('rejects invalid intent versions and empty canonical receipts', () => {
    expect(() => RetentionIntentVersion.from(0)).toThrow();
    expect(() =>
      RetentionIntentVersion.from(Number.MAX_SAFE_INTEGER + 1),
    ).toThrow();
    expect(() =>
      GroupManagementDeletionReceiptRecord.create({
        operationId,
        intentVersion,
        canonicalReceipt: '',
      }),
    ).toThrow();
  });
});
