import type { AuthenticationKeyScope } from './authentication-crypto-keys.js';
import type {
  AuthenticationDestructionTicket,
  AuthenticationBackupManifest,
  AuthenticationRestoreFence,
  AuthenticationVerifiedIntent,
} from './authentication-maintenance-ports.js';
import type { AuthenticationRetentionWindow } from './authentication-retention-policy.js';
import type { AuthenticationRestorePublication } from './authentication-restore-control.js';

/** commitと鍵破棄の間を再開可能にする、清掃DB操作の結果。 */
export type AuthenticationCleanupCommit =
  | Readonly<{
      /** DELETE/Audit共通commitが確認できた。全鍵完了とは別。 */
      status: 'committed';
      /** DB除去前にProviderへdurable登録済みの対象だけ。 */
      tickets: readonly AuthenticationDestructionTicket[];
      /** 今回commitしたAudit行の削除数。 */
      auditCount: number;
      /** SKIP LOCKEDの対象外も含む最古未完了期限。 */
      oldest: AuthenticationRetentionWindow | null;
    }>
  | Readonly<{
      /** SQL/鍵/Audit/commit不明を成功にしない。 */
      status: 'unavailable';
    }>;

/** 認証専用DBの清掃境界。外部全鍵破棄の成功を代行しない。 */
export interface AuthenticationCleanupDatabase {
  /**
   * Lock/Clock/AEAD/CAS下で期限対象を小Batch削除しpurge Auditと共通commitする。
   * @param limit 内部の一回上限。0や過大値を拒否する。
   * @returns commit済みticketと監視値、または結果不明を含む失敗。
   */
  deleteExpired(limit: number): Promise<AuthenticationCleanupCommit>;
  /**
   * 同じ認証Schema内で対象scopeの0-rowを新Transactionで確認する。
   * @param scopes Provider ticketに束縛した全対象。
   * @returns 全行が存在しない場合だけtrue。障害時はthrowする。
   */
  absent(scopes: readonly AuthenticationKeyScope[]): Promise<boolean>;
  /**
   * 24時間未達/証跡矛盾をDB Writerの拒否状態へ移す。
   * @returns commit確認できた場合だけtrue。
   */
  quarantine(): Promise<boolean>;
}

/** 無効化commit済みの削除対象。鍵の全世代inventoryは外部に保持する。 */
export interface AuthenticationDisabledActor {
  /** 外部Ledgerへ出さない内部本人性。 */
  readonly actorId: string;
  /** Sessionの再Sealまで終えた後の破棄対象ticket。 */
  readonly ticket: AuthenticationDestructionTicket;
}

/** 不可逆な削除意思とDB無効化/除去を結び付けるPort。 */
export interface AuthenticationDeletionDatabase {
  /**
   * 受付前にActor状態と現行削除照合世代をLock下で確認する。DB変更はしない。
   * @param actorId 内部受付が選択したActor。外部の自己申告を直接受けない。
   * @returns 外部Ledgerへ保存できる用途別仮名と、その読取世代。
   */
  plan(actorId: string): Promise<
    Readonly<{
      /** 独立した削除照合鍵の現行世代。 */
      keyVersion: string;
      /** Actor IDを直接公開しない32-byte値。 */
      digest: Uint8Array;
    }>
  >;
  /**
   * 外部意思を照合しActor終端・全Session失効・Intent・Auditを共通commitする。
   * @param intent 同じverifierが所有する真正な外部PreparedまたはComplete。
   * @returns commit済みActorと、除去前にdurable登録した全scope。
   */
  disable(
    intent: AuthenticationVerifiedIntent,
  ): Promise<AuthenticationDisabledActor>;
  /**
   * disabled ActorのSession/Identity/Aliasだけを版付きで除去する。
   * @param intent 真正な同じoperationの削除意思。
   * @param disabled disableが返したActor/ticket。DBで再照合する。
   * @returns DELETE/Auditをcommit確認した場合だけtrue。
   */
  remove(
    intent: AuthenticationVerifiedIntent,
    disabled: AuthenticationDisabledActor,
  ): Promise<boolean>;
  /**
   * 外部Completeを照合してDB IntentをcompleteへCASする。
   * @param intent 真正な外部Complete。Preparedは拒否する。
   * @returns 完了commitの確認。鍵/0-rowの代替証明にしない。
   */
  complete(intent: AuthenticationVerifiedIntent): Promise<boolean>;
  /**
   * 復旧DBにのみ存在するIntentを検出し、証跡欠落をskipしない。
   * @param intents 最新外部Ledgerの全Prepared/Complete能力。
   * @returns 全DB Intentが外部の同じoperation/仮名へ一致する場合だけtrue。
   */
  reconcileIntents(
    intents: readonly AuthenticationVerifiedIntent[],
  ): Promise<boolean>;
}

/** Restore中のDB破棄・移行・開通CASを行う専用境界。 */
export interface AuthenticationRestoreDatabase {
  /**
   * 外部fence検証後にkey_state排他Lockで旧WriterをdrainしrestoringへCASする。
   * @param fence 同じRestore runの外部所有能力。
   * @param manifest Schema/epoch/鍵State版を照合するBackupの基準。
   * @returns 隔離状態のgeneration_version。commit不明ではthrowする。
   */
  isolate(
    fence: AuthenticationRestoreFence,
    manifest: AuthenticationBackupManifest,
  ): Promise<number>;
  /**
   * 外部削除意思を隔離下で再適用する。破棄済みDEKの復号を要求しない。
   * @param fence 同じrunの有効な外部fence。
   * @param intent 真正な外部Prepared/Complete。
   * @returns DB除去前に外部Registryへ登録した全鍵ticket。
   */
  reapplyDeletion(
    fence: AuthenticationRestoreFence,
    intent: AuthenticationVerifiedIntent,
  ): Promise<AuthenticationDestructionTicket>;
  /**
   * 全Attempt/Sessionを期限に関係なく破棄する。通常清掃から呼べない。
   * @param fence 同じrunの有効な外部fence。
   * @returns DB除去前にdurable登録した全鍵ticket。
   */
  discardCredentials(
    fence: AuthenticationRestoreFence,
  ): Promise<readonly AuthenticationDestructionTicket[]>;
  /**
   * 外部の新epoch/鍵世代確認後にIdentityを再Sealし現行Aliasへ再移行する。
   * @param fence 同じrunの有効な外部fence。
   * @param publication 外部でCAS公開を確認した新epoch/全用途世代。
   * @returns Alias/Actor/参照/世代整合を検証した32-byte証拠digest。
   */
  migrateIdentity(
    fence: AuthenticationRestoreFence,
    publication: AuthenticationRestorePublication,
  ): Promise<Uint8Array>;
  /**
   * 外部checkpoint/Witnessと全検査が成立した後だけDBをactiveへCASする。
   * @param fence 同じrunの有効な外部fence。
   * @param generationVersion isolate/migrate後に保持する期待CAS版。
   * @param epoch 新epochとの完全一致を要求する。
   * @returns DB開通をcommit確認できた場合だけtrue。
   */
  activate(
    fence: AuthenticationRestoreFence,
    generationVersion: number,
    epoch: string,
  ): Promise<boolean>;
}
