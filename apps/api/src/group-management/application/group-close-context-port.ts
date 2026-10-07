import type {
  CloseFenceReceipt,
  CloseIntentId,
  CloseUnfenceReceipt,
  GroupCloseContext,
  GroupId,
  UtcInstant,
} from '../domain/group.js';

export type InstallGroupCloseFenceRequest = Readonly<{
  groupId: GroupId;
  closeIntentId: CloseIntentId;
  cutoff: UtcInstant;
}>;

export type RemoveGroupCloseFenceRequest = Readonly<
  InstallGroupCloseFenceRequest & {
    fenceVersion: number;
  }
>;

/**
 * 各Data OwnerのContextは、業務保存と同じTransaction境界でこのPortを実装する。
 * ReceiptはFenceが永続化され、その前に受け付けた全Commandが
 * CommitまたはRollback済みであることのEvidence。
 */
export interface GroupCloseContextPort {
  readonly context: GroupCloseContext;

  installFence(
    request: InstallGroupCloseFenceRequest,
  ): Promise<CloseFenceReceipt>;

  removeFence(
    request: RemoveGroupCloseFenceRequest,
  ): Promise<CloseUnfenceReceipt>;
}
