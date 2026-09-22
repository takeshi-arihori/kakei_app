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
 * Each owning Context implements this port at the same transaction boundary as
 * its business writes. A Receipt is evidence that the fence is durable and all
 * commands admitted before it have committed or rolled back.
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
