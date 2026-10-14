import type { VerifiedGoogleIdentity } from '../google-id-token-verification.js';
import type {
  AuthenticationActorState,
  AuthenticationDigest,
} from './authentication-crypto-keys.js';

/** 既存Verifierの結果と選択した検索世代。 */
export interface AuthenticationIdentityDigestInput {
  /** ProfileやID Tokenを持たないcanonical本人性。 */
  readonly identity: VerifiedGoogleIdentity;
  /** key-stateで選択した検索世代。 */
  readonly keyVersion: string;
}

/** 原値を保存しないCookie検索の入力。 */
export interface AuthenticationCookieDigestInput {
  /** canonical Base64URLの独立32-byte秘密値。 */
  readonly secret: string;
  /** Cookie復元を拒否する認証世代。 */
  readonly epoch: string;
  /** 列挙対象のCookie検索鍵世代。 */
  readonly keyVersion: string;
}

/** 直接IDを保存しないAudit／削除照合の入力。 */
export interface AuthenticationPseudonymInput {
  /** 対応用途のActor／Attempt／Session UUIDv4。 */
  readonly subjectId: string;
  /** 独立した用途別鍵世代。 */
  readonly keyVersion: string;
}

/** 状態MACの入力。Actor Lock後に同じ状態を検証する。 */
export interface AuthenticationActorMacInput {
  /** 認証判断に使う全Actor状態。 */
  readonly row: AuthenticationActorState;
  /** 保持Actorの状態MACに対応する独立鍵世代。 */
  readonly keyVersion: string;
}

/** 期限・認可・検索世代列挙を担当しない、用途ごとのHMAC Port。 */
export interface AuthenticationDigests {
  /**
   * canonical Google本人性から検索Aliasを導出する。
   * @param input Verifier結果と検索世代。
   * @returns Identity検索専用の32-byte値。
   * @throws AuthenticationCryptoUnavailable 不正入力・鍵障害の場合。
   */
  identity(
    input: AuthenticationIdentityDigestInput,
  ): Promise<AuthenticationDigest<'auth-google-identity/v1'>>;
  /**
   * 試行Cookieをepochと用途に束縛する。
   * @param input Cookie原値、epoch、試行検索世代。
   * @returns 試行だけの検索値。
   * @throws AuthenticationCryptoUnavailable 不正入力・鍵障害の場合。
   */
  attemptCookie(
    input: AuthenticationCookieDigestInput,
  ): Promise<AuthenticationDigest<'auth-attempt-cookie/v1'>>;
  /**
   * Session Cookieを試行とは独立した鍵で導出する。
   * @param input Cookie原値、epoch、Session検索世代。
   * @returns Sessionだけの検索値。
   * @throws AuthenticationCryptoUnavailable 不正入力・鍵障害の場合。
   */
  sessionCookie(
    input: AuthenticationCookieDigestInput,
  ): Promise<AuthenticationDigest<'auth-session-cookie/v1'>>;
  /**
   * ActorのAudit用仮名を導出する。
   * @param input Actor UUIDv4とAudit世代。
   * @returns Actor Audit専用の仮名。
   * @throws AuthenticationCryptoUnavailable 不正入力・鍵障害の場合。
   */
  auditActor(
    input: AuthenticationPseudonymInput,
  ): Promise<AuthenticationDigest<'auth-audit-actor/v1'>>;
  /**
   * AttemptのAudit用仮名を導出する。
   * @param input Attempt UUIDv4とAudit世代。
   * @returns Attempt Audit専用の仮名。
   * @throws AuthenticationCryptoUnavailable 不正入力・鍵障害の場合。
   */
  auditAttempt(
    input: AuthenticationPseudonymInput,
  ): Promise<AuthenticationDigest<'auth-audit-attempt/v1'>>;
  /**
   * SessionのAudit用仮名を導出する。
   * @param input Session UUIDv4とAudit世代。
   * @returns Session Audit専用の仮名。
   * @throws AuthenticationCryptoUnavailable 不正入力・鍵障害の場合。
   */
  auditSession(
    input: AuthenticationPseudonymInput,
  ): Promise<AuthenticationDigest<'auth-audit-session/v1'>>;
  /**
   * 削除LedgerでActorを照合する独立仮名を導出する。
   * @param input Actor UUIDv4と削除照合世代。
   * @returns Auditや本人性検索とは異なる削除照合値。
   * @throws AuthenticationCryptoUnavailable 不正入力・鍵障害の場合。
   */
  deletedActor(
    input: AuthenticationPseudonymInput,
  ): Promise<AuthenticationDigest<'auth-deleted-actor/v1'>>;
  /**
   * Actorの状態・版・日時へMACを付ける。
   * @param input Lock下の全状態と状態MAC世代。
   * @returns Identity DEKとは独立した状態MAC。
   * @throws AuthenticationCryptoUnavailable 不正入力・鍵障害の場合。
   */
  actorState(
    input: AuthenticationActorMacInput,
  ): Promise<AuthenticationDigest<'auth-actor-state/v1'>>;
  /**
   * 保存MACを32-byte定数時間で比較する。
   * @param input Lock下の状態、独立世代、信頼前の保存MAC。
   * @returns 固定長の検証が一致した場合だけtrue。
   * @throws AuthenticationCryptoUnavailable 状態不正・鍵障害の場合。
   */
  verifyActorState(
    input: AuthenticationActorMacInput & {
      /** 原値を露出せず比較する32-byte保存MAC。 */
      readonly mac: Uint8Array;
    },
  ): Promise<boolean>;
}
