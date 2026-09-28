import type {
  DeleteGroupManagementDataResult,
  GroupManagementRetentionPort,
} from '../group-management-retention-port.js';
import type { GroupManagementDeletionReceiptRecord } from '../group-management-deletion-receipt-port.js';
import type { CloseIntentId, GroupId } from '../../domain/group.js';
import {
  isVerifiedRetentionDeletionEvidence,
  type VerifiedRetentionDeletionEvidence,
} from './retention-deletion-evidence.js';

/** Application削除境界が受け取る、対象Groupと検証済み証拠。 */
export type DeleteGroupManagementDataForRetentionRequest = Readonly<{
  /** 削除するGroup Management所有DataのGroup ID。 */
  groupId: GroupId;
  /** 対象Groupへ束縛されたlive registryのCloseIntent ID。 */
  closeIntentId: CloseIntentId;
  /** Task #119の信頼済み検証経路が発行した不透明な証拠。 */
  evidence: VerifiedRetentionDeletionEvidence;
  /** 同じOperation／Intentに束縛されたGM canonical Receipt record。 */
  receipt: GroupManagementDeletionReceiptRecord;
}>;

/**
 * 真正なverified evidenceとReceipt bindingを照合してからGM削除transactionを呼ぶ。
 * このUse Case自体はRetention Coordinator、削除認可、他Context削除を実装しない。
 * @param request 対象Group、CloseIntent、検証済み証拠、保存するGM Receipt。
 * @param port Group Management所有のRetention transaction境界。
 * @returns transaction結果。不正な証拠はPortを呼ばずRejectedを返す。
 */
export async function deleteGroupManagementDataForRetention(
  request: DeleteGroupManagementDataForRetentionRequest,
  port: GroupManagementRetentionPort,
): Promise<DeleteGroupManagementDataResult> {
  if (!isVerifiedRetentionDeletionEvidence(request.evidence)) {
    return { kind: 'Rejected', reason: 'InvalidEvidence' } as const;
  }

  const { binding } = request.evidence;
  if (
    !request.receipt.operationId.equals(binding.operationId) ||
    request.receipt.intentVersion.value !== binding.intentVersion
  ) {
    return { kind: 'Rejected', reason: 'BindingMismatch' };
  }

  return port.deleteGroupData({
    groupId: request.groupId,
    closeIntentId: request.closeIntentId,
    operationId: binding.operationId,
    intentVersion: request.receipt.intentVersion,
    receipt: request.receipt,
  });
}
