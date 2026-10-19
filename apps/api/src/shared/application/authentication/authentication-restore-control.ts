import type { AuthenticationKeyScope } from './authentication-crypto-keys.js';
import type {
  AuthenticationBackupManifest,
  AuthenticationLedgerHead,
  AuthenticationRestoreFence,
} from './authentication-maintenance-ports.js';

/** 復旧時に外部制御状態から取得する認証専用世代。Materialを含まない。 */
export interface AuthenticationRestoreGeneration {
  /** 既存Schemaの独立した固定用途。 */
  readonly purpose:
    | 'google-identity-search'
    | 'login-attempt-cookie'
    | 'session-cookie'
    | 'actor-state-mac'
    | 'audit-actor'
    | 'audit-attempt'
    | 'audit-session'
    | 'deleted-actor'
    | 'deletion-ledger-mac';
  /** Providerで存在を確認した鍵世代。 */
  readonly keyVersion: string;
  /** Cookieは新epoch、それ以外はnull。 */
  readonly epoch: string | null;
  /** 現行検索で使う世代。 */
  readonly searchable: boolean;
  /** 同一Transactionで書込必須の世代。 */
  readonly writeRequired: boolean;
  /** 退役UTC。退役時は検索/書込をともに禁止する。 */
  readonly retiredAt: number | null;
}

/** 外部epoch CASの確認済み結果。同run/版へ束縛する。 */
export interface AuthenticationRestorePublication {
  /** 外部fenceを所有するRestore run UUIDv4。 */
  readonly runId: string;
  /** 外部制御状態の単調CAS版。 */
  readonly revision: number;
  /** 旧Backupと異なる新epoch。 */
  readonly epoch: string;
  /** 旧DBに依存しない、外部の現行全用途世代。 */
  readonly generations: readonly AuthenticationRestoreGeneration[];
}

/** DB Backupと独立するTraffic/Writer fence、epoch、Nonce世代の管理境界。 */
export interface AuthenticationRestoreControl {
  /**
   * 初回のManifest版一致を確認し、同runの隔離進行版をDB外へdurable登録する。
   * @param fence 同runの閉鎖能力。別runの進行記録を流用しない。
   * @param manifest 信頼済みBackup catalogへ束縛した固定Manifest。
   * @param current 排他Lock下で検証したDBの現在版・epoch・状態。
   * @returns 初回は現DB版+1、同runのrestoring再開は同版。commit応答喪失からも再取得する。
   * @throws Manifest不一致、未登録の進行版、別run、外部永続化障害。
   */
  authorizeIsolation(
    fence: AuthenticationRestoreFence,
    manifest: AuthenticationBackupManifest,
    current: Readonly<{
      /** DB鍵Stateの安全な正整数CAS版。 */
      version: number;
      /** 旧Backupまたは同run公開済みepoch。 */
      epoch: string;
      /** 初回と同run再開を区別するDB状態。 */
      status: 'active' | 'rotating' | 'quarantined' | 'restoring';
    }>,
  ): Promise<number>;
  /**
   * 同runで公開済みのepoch実体を変更せず再取得する。
   * @param fence 同じrunの有効な閉鎖能力。
   * @returns 未公開ならnull。DB途中更新/応答喪失の再照合に使う。
   */
  currentPublication(
    fence: AuthenticationRestoreFence,
  ): Promise<AuthenticationRestorePublication | null>;
  /**
   * 全Trafficと、このrun以外の認証/保守Writerを閉じ単一Restore所有権を取得する。
   * @param runId 再試行で固定するServer生成UUIDv4。
   * @returns このrunへ束縛したopaque所有能力。
   */
  close(runId: string): Promise<AuthenticationRestoreFence>;
  /**
   * 所有registryとfresh外部制御状態で、有効な閉鎖と所有権を確認する。
   * @param fence 同じrunの能力。
   * @returns 競合/解放/偽造がない閉鎖状態だけtrue。
   */
  verifyClosed(fence: AuthenticationRestoreFence): Promise<boolean>;
  /**
   * 旧epoch Writerをfenceし、新epochと新Cookie鍵世代をconditional公開する。
   * @param fence 同じrunの所有能力。
   * @param previousEpoch Backupの旧epoch。
   * @returns 応答喪失からも同runの公開済み実体を再取得できる結果。
   */
  publishEpoch(
    fence: AuthenticationRestoreFence,
    previousEpoch: string,
  ): Promise<AuthenticationRestorePublication>;
  /**
   * 公開結果を署名/所有registry/最新外部revisionで確認する。
   * @param fence 同じrunの閉鎖能力。
   * @param publication 新epoch/全用途世代の期待binding。
   * @returns 別run/古い版/部分世代を含まない場合だけtrue。
   */
  verifyPublication(
    fence: AuthenticationRestoreFence,
    publication: AuthenticationRestorePublication,
  ): Promise<boolean>;
  /**
   * 旧DEKのSealを恒久拒否し、保持Identityへ独立した新DEK世代を発行する。
   * @param fence 同じrunの閉鎖能力。
   * @param scope 保持IdentityのActor scope。
   * @param previousVersion Backupが参照する旧世代。新規Sealへ戻さない。
   */
  rotateIdentity(
    fence: AuthenticationRestoreFence,
    scope: AuthenticationKeyScope,
    previousVersion: string,
  ): Promise<void>;
  /**
   * 完了headを外部revisionへ束縛してCAS開通する。新削除appendと競合時は拒否する。
   * @param fence 同じrunの閉鎖能力。
   * @param publication 検証済み新epoch/鍵世代。
   * @param head 最新復旧checkpointとWitnessの一致済みhead。
   * @param evidenceDigest 全検査結果を覆う32-byte値。
   * @returns 開通CASを確認できた場合だけtrue。応答喪失は再照合まで成功にしない。
   */
  open(
    fence: AuthenticationRestoreFence,
    publication: AuthenticationRestorePublication,
    head: AuthenticationLedgerHead,
    evidenceDigest: Uint8Array,
  ): Promise<boolean>;
}
