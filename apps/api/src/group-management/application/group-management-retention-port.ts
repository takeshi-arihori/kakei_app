import type {
  FindGroupManagementDeletionReceiptRequest,
  GroupManagementDeletionReceiptReadResult,
  GroupManagementDeletionReceiptRecord,
  RetentionIntentVersion,
} from './group-management-deletion-receipt-port.js';
import type { OperationId } from './group-repository.js';
import type { CloseIntentId, GroupId } from '../domain/group.js';

/** Group Management削除transactionへ渡す、検証済みBindingに対応した入力。 */
export type DeleteGroupManagementDataRequest = Readonly<{
  /** 削除するGroup Management所有DataのGroup ID。 */
  groupId: GroupId;
  /** live registry行を特定するCloseIntent ID。 */
  closeIntentId: CloseIntentId;
  /** 検証済みPrepared intentのOperation ID。 */
  operationId: OperationId;
  /** 検証済みPrepared intentのVersion。 */
  intentVersion: RetentionIntentVersion;
  /** 同じtransactionで永続化するGM canonical post-deletion Receipt。 */
  receipt: GroupManagementDeletionReceiptRecord;
}>;

/** GM削除transactionを開始せずFail Closedにする理由。 */
export type GroupManagementRetentionRejectionReason =
  | 'InvalidEvidence'
  | 'GroupNotFound'
  | 'RegistryNotFound'
  | 'RegistryBindingMismatch'
  | 'RegistryNotLive'
  | 'BindingMismatch'
  | 'StaleEvidence';

/** Group Management削除transactionの結果。 */
export type DeleteGroupManagementDataResult =
  | Readonly<{
      /** registry退役、Group Data削除、Receipt保存がcommitしたことを表す。 */
      kind: 'Deleted';
      /** commit後にだけ返すcanonical Receipt record。 */
      record: GroupManagementDeletionReceiptRecord;
    }>
  | Readonly<{
      /** 同じOperation／Intentのcommit済み結果を再取得したことを表す。 */
      kind: 'AlreadyDeleted';
      /** 以前のcommitで保存された同一Receipt record。 */
      record: GroupManagementDeletionReceiptRecord;
    }>
  | Readonly<{
      /** 入力または永続状態がPrepared削除と一致しないことを表す。 */
      kind: 'Rejected';
      /** Group Dataを変更せず拒否した理由。 */
      reason: GroupManagementRetentionRejectionReason;
    }>
  | Readonly<{
      /** transaction結果を安全に確定できないため再試行可能であることを表す。 */
      kind: 'Unavailable';
    }>;

/** CloseIntent registryの期限切れ退役行をpurgeした結果。 */
export type PurgeRetiredCloseIntentsResult =
  | Readonly<{
      /** 対象行の削除がcommitしたことを表す。 */
      kind: 'Purged';
      /** transaction開始時に一度だけ取得したUTC基準時刻。 */
      txNow: Date;
      /** `retain_until <= txNow`で削除した行数。 */
      purgedCount: number;
    }>
  | Readonly<{
      /** purge結果を安全に確定できず、同じ処理を再試行できることを表す。 */
      kind: 'Unavailable';
    }>;

/**
 * Group Managementが所有するRetention永続化境界。
 * Production削除の認可や他Context Dataの削除は行わない。
 */
export interface GroupManagementRetentionPort {
  /**
   * registry退役、GM業務Data削除、Receipt保存を1 transactionで実行する。
   * @param request 真正なverified evidenceとの照合後にApplicationが渡す削除入力。
   * @returns commit済みReceipt、拒否理由、または再試行可能なUnavailable。
   */
  deleteGroupData(
    request: DeleteGroupManagementDataRequest,
  ): Promise<DeleteGroupManagementDataResult>;

  /**
   * commit後に応答を失ったOperationのReceiptを再取得する。
   * @param request Operation IDとIntent Version。
   * @returns 保存済みReceipt、未保存、不一致、古い証拠、またはUnavailable。
   */
  findReceipt(
    request: FindGroupManagementDeletionReceiptRequest,
  ): Promise<GroupManagementDeletionReceiptReadResult>;

  /**
   * transaction開始時の単一時刻に到達したretired registry行だけを削除する。
   * @returns commitした削除件数と基準時刻、または再試行可能なUnavailable。
   */
  purgeRetiredCloseIntents(): Promise<PurgeRetiredCloseIntentsResult>;
}
