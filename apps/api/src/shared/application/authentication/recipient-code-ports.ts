import type { RecipientCodeSecret } from './recipient-code-input.js';
import type { RecipientCodeStoredState } from './recipient-code-record.js';
import type {
  AuthenticatedActor,
  AuthenticatedActorResult,
  AuthenticationClock,
  AuthenticationUnavailable,
  Unauthenticated,
} from './authentication-ports.js';
import type {
  AuthenticationSerializedValue,
  AuthenticationTransactionScope,
} from './authentication-transaction-scope.js';

declare const consumptionBrand: unique symbol;
declare const evidenceBrand: unique symbol;

/** 型だけでSQL保証を主張しない。#239の非公開registryがScope/一回受付を検証する。 */
export interface RecipientCodeConsumptionHandle {
  /** 通常DTOから作れない非公開Brand。実行時はObject identityも必須。 */
  readonly [consumptionBrand]: true;
}

/** 登録済みGM参加Adapterだけが発行する保存証跡。HMAC再送proofそのものではない。 */
export interface RecipientCodeCommitEvidence {
  /** 消費handle、codeId、宛先、operation、同一Scopeへの束縛をregistryが検証する。 */
  readonly [evidenceBrand]: true;
}

/** query限定GM参加者と共有するScope。接続やTransaction所有権を公開しない。 */
export interface RecipientCodeTransactionScope extends AuthenticationTransactionScope {
  /**
   * 新規GM成功計画と対応するコード消費を一回だけstageする。
   * @param handle このleaseが発行したopaqueな消費権。別Scope/終了後/二重受付は失敗。
   * @param evidence 登録GM参加Adapterが同Scopeの成功計画へ発行した証跡。
   * @throws RecipientCodeUnavailable 証跡不一致・保存/MAC/Audit障害。握り潰しても全commit拒否。
   */
  consume(
    handle: RecipientCodeConsumptionHandle,
    evidence: RecipientCodeCommitEvidence,
  ): Promise<void>;
}

/** Sessionとコードを検証した新規処理専用facts。Client入力から生成しない。 */
export interface RecipientCodeLeaseFacts {
  /** 現在有効なSessionから解決したcaller。Group Owner判定を代替しない。 */
  readonly caller: AuthenticatedActor;
  /** 同判断点のactive宛先。外部Responseへ展開しない。 */
  readonly recipientActorId: string;
  /** 保存計画と消費証跡を束縛する内部参照。 */
  readonly codeId: string;
}

/** 原値を含まない本人向け最小状態。 */
export interface RecipientCodeStatus {
  /** 状態確認に使う原コードとは独立した参照。 */
  readonly codeId: string;
  /** Expiredは判断点で導出する。 */
  readonly state: RecipientCodeStoredState | 'expired';
  /** 延長しないUTC期限。 */
  readonly expiresAt: number;
}

/** commit確認後の一回だけ原値を返す。結果不明では復元しない。 */
export type RecipientCodeIssueResult =
  | Unauthenticated
  | AuthenticationUnavailable
  | Readonly<{
      /** 新コードと旧Issued失効とAuditの共通commit確認済み。 */
      status: 'issued';
      /** 再表示や成功再送へ保存しない新秘密値。 */
      code: RecipientCodeSecret;
      /** 古い端末表示と区別する参照。 */
      codeId: string;
      /** 判断点から正確に10分後。 */
      expiresAt: number;
    }>;

/** 本人保有照合後の取消結果。外部Error写像は#246で設計する。 */
export type RecipientCodeRevokeResult =
  | Unauthenticated
  | AuthenticationUnavailable
  | RecipientCodeUnavailableToActor
  | Readonly<{
      /** 対象Issuedの共通commit完了、または既に無効。 */
      status: 'revoked' | 'already-inactive';
    }>;

/** 本人状態確認は秘密値・宛先Profileを返さず、期限も延長しない。 */
export type RecipientCodeInspectResult =
  | Unauthenticated
  | AuthenticationUnavailable
  | Readonly<{
      /** 保有Recordの最小状態。 */
      status: 'found';
      /** 原コード・MAC・検索値を含まない。 */
      code: RecipientCodeStatus;
    }>
  | Readonly<{
      /** 返せる本人Recordがない。 */
      status: 'no-code';
    }>;

/** コード/宛先/Groupの存在を外部へ区別しない内部拒否。 */
export interface RecipientCodeUnavailableToActor {
  /** 初回処理を許可しない。成功再送の検索はこの拒否より先に行う。 */
  readonly status: 'unavailable-to-actor';
}

/** GM保護operationから得る再送分岐。秘密値や現在コード状態に依存しない。 */
export type RecipientCodeReplay<T extends AuthenticationSerializedValue> =
  | Readonly<{
      /** 原Actor/operation/内容と保存proof世代を検証した成功。 */
      status: 'replayed';
      /** 同Scopeで固定した最小保存結果。 */
      value: T;
    }>
  | Readonly<{
      /** 保存成功なし。内部NoReplayをserializeしてpreflightを終了する。 */
      status: 'no-replay';
    }>;

/** GMの内容を知らず、成功再送と初回作成の受付順だけを調整する。 */
export interface RecipientCodeUseCallbacks<
  T extends AuthenticationSerializedValue,
> {
  /**
   * caller-only preflightと新規lease内の両方でGM共通operationを照合する。
   * @param caller 現在有効Sessionの本人。元Actor一致もGMが検証する。
   * @param scope 同じregistryのScope。再送ではコード行/宛先Actorを読まない。
   * @returns 保存世代のproof/内容照合後の最小結果またはNoReplay。MismatchはGMの契約で拒否する。
   * @throws 保存/認証不整合。全rollback/unavailableへ写像し、秘密値を返さない。
   */
  replay(
    caller: AuthenticatedActor,
    scope: AuthenticationTransactionScope,
  ): Promise<RecipientCodeReplay<T>>;
  /**
   * 新規処理だけ現在Owner/Active/版/人数/自己/重複をGMで判断する。
   * @param facts callerとMAC/epoch/期限を検証した宛先。本人性をClientへ返さない。
   * @param handle 同一Scopeだけで一度使える消費handle。
   * @param scope query限定GM参加Adapterに渡すScope。失敗計画で消費しない。
   * @returns GM保存証跡・両Audit・Session更新と共通commitする確定本文。
   * @throws 業務拒否/保存障害。部分保存や新operationでの自動再作成を行わない。
   */
  create(
    facts: RecipientCodeLeaseFacts,
    handle: RecipientCodeConsumptionHandle,
    scope: RecipientCodeTransactionScope,
  ): Promise<T>;
}

/**
 * #239/#240のAdapterが実装する専用認証lease契約。ここには認証/SQL/暗号実装を置かない。
 * Actor後付けLockを避け、認証key-state→登録GM key-state→Actor UUID昇順→Session→code→Group→operation→Auditを守る。
 * 全Lock後とserialize前にClock/期限を再確認し、未await/失敗/偽証跡では全rollbackする。
 * 呼出し側の入力は最初のawait前にCopyし、GM型/SQL/Domainには依存しない。
 */
export interface RecipientCodeSessionPort {
  /**
   * 本人の明示操作で旧Issued失効・新Record・Auditを共通commitする。自動retryしない。
   * @param sessionSecret canonical Session Cookie。ActorをClient指定しない。
   * @param clock Lock後の判断点。発行元Sessionの後のlogoutはコードを失効させない。
   * @returns commit確認後だけ新しい32-byte CSPRNG原値を一回返す。結果不明もunavailable。
   */
  issue(
    sessionSecret: string,
    clock: AuthenticationClock,
  ): Promise<RecipientCodeIssueResult>;
  /**
   * @param sessionSecret 本人の現在Session。無効なら保有状態も返さない。
   * @param codeId 本人保有を照合するUUIDv4。原コードではない。他人との差を公開しない。
   * @param clock Lock後Clock。清掃済み/期限切れ/終端はAlreadyInactive。
   * @returns 取消済み/AlreadyInactive、未認証、存在非開示の拒否、または結果不明を含む障害。
   */
  revoke(
    sessionSecret: string,
    codeId: string,
    clock: AuthenticationClock,
  ): Promise<RecipientCodeRevokeResult>;
  /**
   * @param sessionSecret 本人の現在Session。status照会でidle/コードTTLを延長しない。
   * @param clock Lock後の現在状態判断。
   * @returns 最小状態/不在/未認証/障害。原値の再表示を提供しない。
   */
  inspect(
    sessionSecret: string,
    clock: AuthenticationClock,
  ): Promise<RecipientCodeInspectResult>;
  /**
   * caller-only再送照会のmiss後だけ専用leaseを開始し、その中でもoperationを再照合する。
   * @param sessionSecret 同一callerの現在Session。lease間で失効した場合も再検証する。
   * @param code 同期的に正規形検証/Copyした秘密値。保存/Log/成功結果へ残さない。
   * @param clock Lock後とserialize前のClock。期限等値を初回作成で拒否する。
   * @param callbacks GMが所有する共通operation照合と新規保存。保存proof世代を用いた再送には現コード/宛先active/Owner/現在版を要求しない。
   * @returns 共通commit後の本文、未認証、存在非開示の拒否、または結果不明を含む障害。
   */
  use<T extends AuthenticationSerializedValue>(
    sessionSecret: string,
    code: RecipientCodeSecret,
    clock: AuthenticationClock,
    callbacks: RecipientCodeUseCallbacks<T>,
  ): Promise<AuthenticatedActorResult<T> | RecipientCodeUnavailableToActor>;
}

/** #239の本人性lease基盤。発行/取消Store本文と実消費Writerは後続Taskが所有する。 */
export interface RecipientCodeSessionLeasePort {
  /**
   * 本人だけを読む状態確認用lease。Actor共有Lock、Session再検証と監査を行う。
   * @param sessionSecret 現在のcanonical Session。
   * @param clock Lock後と確定時に再検証するServer Clock。
   * @param callback 同registryのScope。コード原値を復元せずidleを更新しない。
   * @param signal 任意の中断要求。GM準備/業務保存は行わない。
   * @returns commit確認後の最小本文、未認証または障害。
   */
  inspectActor<T extends AuthenticationSerializedValue>(
    sessionSecret: string,
    clock: AuthenticationClock,
    callback: (
      caller: AuthenticatedActor,
      scope: AuthenticationTransactionScope,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<AuthenticatedActorResult<T>>;
  /**
   * 本人Actorを最初から排他Lockする管理用入口。別Actorを後付けLockしない。
   * @param sessionSecret 現在のcanonical Session。
   * @param clock Lock後と本文確定時に再確認するServer Clock。
   * @param callback 本人factsとquery参加可能なScope。発行/取消の保存本文は#240。
   * @param signal 任意の中断要求。中断時は本文を返さず全Transactionをabortする。
   * @returns commit確認後の本文、未認証、または結果不明を含む障害。
   */
  withActor<T extends AuthenticationSerializedValue>(
    sessionSecret: string,
    clock: AuthenticationClock,
    callback: (
      caller: AuthenticatedActor,
      scope: AuthenticationTransactionScope,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<AuthenticatedActorResult<T>>;
  /**
   * caller-only成功再送後のmissだけ専用複合leaseへ進む。Callbackを自動retryしない。
   * @param sessionSecret 現在のcanonical Session。
   * @param code await前に独立Copyするコード入力。
   * @param clock 全blocking Lock後/serialize前の期限判断。
   * @param callbacks GM-owned成功再送と新規作成計画。実Adapterは#242。
   * @param signal 任意の中断要求。COMMIT送信後は結果不明として扱う。
   * @returns commit済み本文、未認証、存在非開示の拒否、または障害。
   */
  use<T extends AuthenticationSerializedValue>(
    sessionSecret: string,
    code: RecipientCodeSecret,
    clock: AuthenticationClock,
    callbacks: RecipientCodeUseCallbacks<T>,
    signal?: AbortSignal,
  ): Promise<AuthenticatedActorResult<T> | RecipientCodeUnavailableToActor>;
}
