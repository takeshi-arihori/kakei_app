import { describe, expect, it, vi } from 'vitest';

import { OperationId } from '../group-repository.js';
import {
  GroupManagementDeletionReceiptRecord,
  RetentionIntentVersion,
} from '../group-management-deletion-receipt-port.js';
import {
  PreparedRetentionDeletionBinding,
  RetentionDeletionToken,
  verifyRetentionDeletionEvidence,
  type ContextDeletionReceiptVerifierPort,
  type ContextKeyDestructionVerifierPort,
  type RetentionContextName,
} from './retention-deletion-evidence.js';
import { deleteGroupManagementDataForRetention } from './delete-group-management-data-for-retention.js';
import type { GroupManagementRetentionPort } from '../group-management-retention-port.js';
import { CloseIntentId, GroupId } from '../../domain/group.js';

const operationId = OperationId.from('retention-delete-operation');
const binding = PreparedRetentionDeletionBinding.create({
  deletionToken: RetentionDeletionToken.from('opaque-deletion-token'),
  operationId,
  intentVersion: 2,
});

const receipt = GroupManagementDeletionReceiptRecord.create({
  operationId,
  intentVersion: RetentionIntentVersion.from(2),
  canonicalReceipt: 'canonical-gm-receipt',
});

const issueEvidence = async () => {
  const receiptVerifier = <C extends 'ExpenseRecording' | 'Settlement'>(
    context: C,
  ): ContextDeletionReceiptVerifierPort<C> => ({
    context,
    verify: () => Promise.resolve({ kind: 'Verified', context, binding }),
  });
  const keyVerifier = (
    context: RetentionContextName,
  ): ContextKeyDestructionVerifierPort => ({
    context,
    verify: () =>
      Promise.resolve({
        kind: 'Verified',
        context,
        binding,
        keyNamespace: 'GroupData',
      }),
  });
  const result = await verifyRetentionDeletionEvidence(
    {
      binding,
      expenseRecordingReceipt: 'expense-receipt',
      settlementReceipt: 'settlement-receipt',
    },
    {
      expenseReceiptVerifier: receiptVerifier('ExpenseRecording'),
      settlementReceiptVerifier: receiptVerifier('Settlement'),
      keyDestructionVerifiers: [
        keyVerifier('GroupManagement'),
        keyVerifier('ExpenseRecording'),
        keyVerifier('Settlement'),
      ],
    },
  );
  if (result.kind !== 'Verified') throw new Error('Expected verified evidence');
  return result.evidence;
};

describe('delete Group Management data for retention', () => {
  it('starts the GM transaction only for genuine evidence with matching receipt binding', async () => {
    const evidence = await issueEvidence();
    const execute = vi.fn<GroupManagementRetentionPort['deleteGroupData']>();
    execute.mockResolvedValue({ kind: 'Deleted', record: receipt });
    const port: GroupManagementRetentionPort = {
      deleteGroupData: execute,
      findReceipt: vi.fn(),
      purgeRetiredCloseIntents: vi.fn(),
    };

    await expect(
      deleteGroupManagementDataForRetention(
        {
          groupId: GroupId.from('00000000-0000-4000-8000-000000000103'),
          closeIntentId: CloseIntentId.from(
            '00000000-0000-4000-8000-000000000203',
          ),
          evidence,
          receipt,
        },
        port,
      ),
    ).resolves.toEqual({ kind: 'Deleted', record: receipt });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects forged evidence before opening the GM transaction', async () => {
    const execute = vi.fn<GroupManagementRetentionPort['deleteGroupData']>();
    const port: GroupManagementRetentionPort = {
      deleteGroupData: execute,
      findReceipt: vi.fn(),
      purgeRetiredCloseIntents: vi.fn(),
    };

    const result = await deleteGroupManagementDataForRetention(
      {
        groupId: GroupId.from('00000000-0000-4000-8000-000000000103'),
        closeIntentId: CloseIntentId.from(
          '00000000-0000-4000-8000-000000000203',
        ),
        evidence: {
          binding,
        } as never,
        receipt,
      },
      port,
    );

    expect(result).toEqual({ kind: 'Rejected', reason: 'InvalidEvidence' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a receipt bound to another operation or intent version', async () => {
    const evidence = await issueEvidence();
    const execute = vi.fn<GroupManagementRetentionPort['deleteGroupData']>();
    const port: GroupManagementRetentionPort = {
      deleteGroupData: execute,
      findReceipt: vi.fn(),
      purgeRetiredCloseIntents: vi.fn(),
    };
    const mismatched = GroupManagementDeletionReceiptRecord.create({
      operationId: OperationId.from('another-operation'),
      intentVersion: RetentionIntentVersion.from(3),
      canonicalReceipt: 'mismatched-receipt',
    });

    await expect(
      deleteGroupManagementDataForRetention(
        {
          groupId: GroupId.from('00000000-0000-4000-8000-000000000103'),
          closeIntentId: CloseIntentId.from(
            '00000000-0000-4000-8000-000000000203',
          ),
          evidence,
          receipt: mismatched,
        },
        port,
      ),
    ).resolves.toEqual({ kind: 'Rejected', reason: 'BindingMismatch' });
    expect(execute).not.toHaveBeenCalled();
  });
});
