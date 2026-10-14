import type { AuthenticationRow } from './authentication-record-protection.js';

declare const dataKeyBrand: unique symbol;
declare const macKeyBrand: unique symbol;
declare const digestBrand: unique symbol;

/** Digest／MAC鍵と混同しない独立256-bit認証DEK。 */
export type AuthenticationDataKey = Uint8Array & {
  /** HMAC鍵やGroup用DEKを誤用しないModule非公開の型識別子。 */
  readonly [dataKeyBrand]: true;
};

/** A2の独立した検索・仮名・状態・削除照合Namespace。 */
export type AuthenticationMacPurpose =
  | 'auth-google-identity/v1'
  | 'auth-attempt-cookie/v1'
  | 'auth-session-cookie/v1'
  | 'auth-audit-actor/v1'
  | 'auth-audit-attempt/v1'
  | 'auth-audit-session/v1'
  | 'auth-deleted-actor/v1'
  | 'auth-actor-state/v1';

/** purposeをRuntimeと型の両方に保持する、DEKとは独立した鍵。 */
export interface AuthenticationMacKey<P extends AuthenticationMacPurpose> {
  /** 他用途のPortへ転用できないNamespace。 */
  readonly purpose: P;
  /** 用途ごとに独立ランダムな256-bit値。DB／Logへ保存しない。 */
  readonly material: Uint8Array & {
    /** 独立用途と暗号鍵の違いを型検査する非公開Brand。 */
    readonly [macKeyBrand]: P;
  };
}

/** 用途と鍵世代に束縛した32-byte出力。鍵として扱えない。 */
export interface AuthenticationDigest<P extends AuthenticationMacPurpose> {
  /** Index／仮名／MAC間の誤用を防ぐ固定用途。 */
  readonly purpose: P;
  /** 対応する検索・検証鍵の世代。 */
  readonly keyVersion: string;
  /** 用途付き出力。入力配列を共有しない。 */
  readonly bytes: Uint8Array & {
    /** 出力を別用途や鍵へ転用しない非公開Brand。 */
    readonly [digestBrand]: P;
  };
}

type MacKeyResult<P extends AuthenticationMacPurpose> =
  | Readonly<{
      /** 指定Namespaceの鍵が利用可能。 */
      status: 'available';
      /** 要求した世代と完全一致させる。 */
      keyVersion: string;
      /** Cookieは要求epoch、それ以外はnull。 */
      epoch: string | null;
      /** purposeとMaterialが一体の独立鍵。 */
      key: AuthenticationMacKey<P>;
    }>
  | Readonly<{
      /** 廃棄・不在・Provider障害を成功へ変換しない。 */
      status: 'unavailable';
    }>;

interface MacKeyPort<P extends AuthenticationMacPurpose> {
  /**
   * 固定用途の世代とepochに対応する独立鍵を取得する。
   * @param input 選択した世代とCookieだけに必須のepoch。
   * @returns 対応鍵または利用不能。例外も呼出し境界で汎用失敗へ変換する。
   */
  readKey(input: {
    /** DBの世代Stateから選択した鍵世代。 */
    keyVersion: string;
    /** Cookie用途ではUUIDv4、それ以外はnull。 */
    epoch: string | null;
  }): Promise<MacKeyResult<P>>;
}

/** Google本人性検索だけの鍵Port。 */
export type AuthenticationIdentityKeyPort =
  MacKeyPort<'auth-google-identity/v1'>;
/** Login Attempt Cookie検索だけの鍵Port。 */
export type AuthenticationAttemptCookieKeyPort =
  MacKeyPort<'auth-attempt-cookie/v1'>;
/** Session Cookie検索だけの鍵Port。 */
export type AuthenticationSessionCookieKeyPort =
  MacKeyPort<'auth-session-cookie/v1'>;
/** Actor Audit仮名だけの鍵Port。 */
export type AuthenticationAuditActorKeyPort = MacKeyPort<'auth-audit-actor/v1'>;
/** Attempt Audit仮名だけの鍵Port。 */
export type AuthenticationAuditAttemptKeyPort =
  MacKeyPort<'auth-audit-attempt/v1'>;
/** Session Audit仮名だけの鍵Port。 */
export type AuthenticationAuditSessionKeyPort =
  MacKeyPort<'auth-audit-session/v1'>;
/** 削除Actor照合だけの鍵Port。外部Ledger本文MACは含まない。 */
export type AuthenticationDeletedActorKeyPort =
  MacKeyPort<'auth-deleted-actor/v1'>;
/** Identity DEK破棄後も独立して使うActor状態MAC鍵Port。 */
export type AuthenticationActorStateKeyPort = MacKeyPort<'auth-actor-state/v1'>;

/** 独立NamespaceをCompositionで明示する。単一汎用鍵への置換を禁止する。 */
export interface AuthenticationMacKeyPorts {
  /** Identity検索専用。 */
  readonly identity: AuthenticationIdentityKeyPort;
  /** 試行Cookie専用、Sessionとは独立。 */
  readonly attemptCookie: AuthenticationAttemptCookieKeyPort;
  /** Session Cookie専用、試行とは独立。 */
  readonly sessionCookie: AuthenticationSessionCookieKeyPort;
  /** Actor Auditの仮名専用。 */
  readonly auditActor: AuthenticationAuditActorKeyPort;
  /** Attempt Auditの仮名専用。 */
  readonly auditAttempt: AuthenticationAuditAttemptKeyPort;
  /** Session Auditの仮名専用。 */
  readonly auditSession: AuthenticationAuditSessionKeyPort;
  /** 削除Actorの照合専用。 */
  readonly deletedActor: AuthenticationDeletedActorKeyPort;
  /** Actor状態改ざん検証専用。 */
  readonly actorState: AuthenticationActorStateKeyPort;
}

/** Groupと異なる認証DEKの所有範囲。 */
export interface AuthenticationKeyScope {
  /** Identity／Attempt／Sessionごとに鍵Namespaceを分離する。 */
  readonly recordKind: AuthenticationRow['recordKind'];
  /** IdentityはActor、Attempt／SessionはRecordのUUIDv4。 */
  readonly keyScopeId: string;
}

/** 割当の失敗を汎用失敗へ写像しながらProviderで世代を封鎖する理由。 */
export type AuthenticationRotationReason =
  | 'seal-threshold'
  | 'seal-limit'
  | 'counter-regression'
  | 'key-lost'
  | 'allocation-invalid'
  | 'seal-disabled';

/** durable単調Nonce割当の結果。外側Transactionに巻き戻されない。 */
export type AuthenticationSealAllocation =
  | Readonly<{
      /** Providerで割当済み、以後の故障でもNonceをburnする。 */
      status: 'allocated';
      /** 要求したScopeと完全一致する所有範囲。 */
      scope: AuthenticationKeyScope;
      /** 新規書込みを許可する現行鍵だけを返す。 */
      lifecycle: 'current';
      /** 独立ランダムDEK。Global Root＋IDから再導出しない。 */
      key: AuthenticationDataKey;
      /** Nonce uniquenessの単位となる鍵世代。 */
      keyVersion: string;
      /** 原子的・durableに割当した12-byte値。Callerは指定できない。 */
      nonce: Uint8Array;
      /** 同Scope／kind／世代で正の単調Seal回数。2^32以上を拒否。 */
      sealCount: bigint;
    }>
  | Readonly<{
      /** 後退／喪失／Restore・旧世代は新規Sealへ進めない。 */
      status: 'counter-regressed' | 'key-lost' | 'seal-disabled';
      /** 封鎖とRotation要求の対象世代。 */
      keyVersion: string;
    }>;

/** 鍵廃棄後のCiphertext復活を許可しない読取結果。 */
export type AuthenticationReadKeyResult =
  | Readonly<{
      /** 指定Scope・世代の読取を許可する。 */
      status: 'available';
      /** 要求した所有範囲と一致させる。 */
      scope: AuthenticationKeyScope;
      /** 要求した世代と一致させる。 */
      keyVersion: string;
      /** 旧世代は読取だけ。Sealへの再利用を禁止する。 */
      lifecycle: 'current' | 'read-only';
      /** 廃棄されていない独立DEK。 */
      key: AuthenticationDataKey;
    }>
  | Readonly<{
      /** 未知・Destroyed・故障を同じ外部失敗にする。 */
      status: 'unavailable';
    }>;

/**
 * 認証専用DEKとNonceのProvider境界。割当StateはDB Transaction／Backupと独立。
 * 具体Providerのdurability・線形化・廃棄証拠は本番Gateで別途検証する。
 */
export interface AuthenticationDataKeyPort {
  /**
   * Scopeごとに現行DEKと一意96-bit Nonceを原子的・durableに割当する。
   * @param scope Identity ActorまたはAttempt／Session Record。
   * @returns rollbackでもburnする割当、または旧世代封鎖を伴う失敗。
   */
  allocateForSeal(
    scope: AuthenticationKeyScope,
  ): Promise<AuthenticationSealAllocation>;
  /**
   * 指定世代の現行・旧読取鍵だけを取得する。Destroyedは永久拒否する。
   * @param input 所有範囲と認証対象の鍵世代。
   * @returns 一致する鍵、または利用不能。
   */
  readKey(input: {
    /** Record種別と所有範囲。 */
    scope: AuthenticationKeyScope;
    /** 保存Headerの認証対象世代。 */
    keyVersion: string;
  }): Promise<AuthenticationReadKeyResult>;
  /**
   * 新しい独立Key世代への切替を要求する。後退・Restore時は旧世代のSealを禁止する。
   * @param input Scope、対象世代と固定理由。IDはAlertや例外へ複製しない。
   */
  requestRotation(input: {
    /** 切替対象の所有範囲。 */
    scope: AuthenticationKeyScope;
    /** 封鎖・移行対象の世代。 */
    keyVersion: string;
    /** Providerが扱う固定理由。 */
    reason: AuthenticationRotationReason;
  }): Promise<void>;
}

/** 認証判断前にLock下で検証するActorの全状態。 */
export interface AuthenticationActorState {
  /** Google識別子から独立した本人性。 */
  readonly actorId: string;
  /** 状態変更ごとの正のsafe integer。 */
  readonly version: number;
  /** disabledは終端。暗黙の再有効化を禁止する。 */
  readonly state: 'active' | 'disabled';
  /** 作成UTC milliseconds。 */
  readonly createdAt: number;
  /** activeならnull、disabledなら作成以降。 */
  readonly disabledAt: number | null;
}

/** 入力や例外を含めず固定Codeだけを通知する監視Port。 */
export interface AuthenticationCryptoAlert {
  /** 暗号操作の分類だけを公開する。 */
  readonly operation: 'seal' | 'open' | 'digest';
  /** 入力値・ID・鍵・Payloadを含まない固定失敗分類。 */
  readonly code:
    | 'INVALID_INPUT'
    | 'KEY_UNAVAILABLE'
    | 'ALLOCATION_INVALID'
    | 'SEAL_LIMIT'
    | 'COUNTER_REGRESSION'
    | 'AUTHENTICATION_FAILED'
    | 'ROTATION_FAILED';
}
