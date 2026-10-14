/** Google本人性を保存する行。日時やProfileを追加しない。 */
export interface AuthenticationIdentityRow {
  /** 他用途との暗号文差替えを防ぐ固定用途。 */
  readonly recordKind: 'google-identity';
  /** Server生成のcanonical UUIDv4。 */
  readonly identityId: string;
  /** Identity DEKのScopeとなる内部本人性。 */
  readonly actorId: string;
  /** Metadata更新ごとに増加する正のsafe integer。 */
  readonly version: number;
}

/** Cookieで選択した試行の全平文Metadata。AADとPayloadに束縛する。 */
export interface AuthenticationAttemptRow {
  /** Session用の値との混同を防ぐ固定用途。 */
  readonly recordKind: 'login-attempt';
  /** DEKのScopeにも用いるServer生成UUIDv4。 */
  readonly attemptId: string;
  /** Metadata更新ごとに増加する正のsafe integer。 */
  readonly version: number;
  /** Restore前のCookieを拒否する認証世代。 */
  readonly epoch: string;
  /** 非負safe integerのUTC milliseconds。 */
  readonly createdAt: number;
  /** createdAtから300000ms後。現在時刻との比較はStoreが行う。 */
  readonly expiresAt: number;
  /** 消費・置換を終端とする保存状態。 */
  readonly state: 'ready' | 'consumed' | 'replaced';
  /** readyではnull、それ以外は作成以降のUTC milliseconds。 */
  readonly terminalAt: number | null;
  /** 検索Digestに用いた独立鍵の世代。 */
  readonly cookieDigestKeyVersion: string;
  /** 原値を復元できない32-byte検索値。 */
  readonly cookieDigest: Uint8Array;
}

/** Cookieで選択したSessionの全平文Metadata。 */
export interface AuthenticationSessionRow {
  /** 試行用の値との混同を防ぐ固定用途。 */
  readonly recordKind: 'session';
  /** DEKのScopeにも用いるServer生成UUIDv4。 */
  readonly sessionId: string;
  /** Identityを復号せず検証する内部本人性。 */
  readonly actorId: string;
  /** 活動・失効を含むMetadata更新の正の版。 */
  readonly version: number;
  /** Restore前のCookieを拒否する認証世代。 */
  readonly epoch: string;
  /** 非負safe integerのUTC milliseconds。 */
  readonly createdAt: number;
  /** 発行から最大604800000ms、idle以上の絶対期限。 */
  readonly absoluteExpiresAt: number;
  /** 絶対期限を超えない活動期限。現在時刻の判断はStoreが行う。 */
  readonly idleExpiresAt: number;
  /** revokedからactiveへ戻さない保存状態。 */
  readonly state: 'active' | 'revoked';
  /** activeではnull、失効時は作成以降のUTC milliseconds。 */
  readonly terminalAt: number | null;
  /** Session専用Cookie検索鍵の世代。 */
  readonly cookieDigestKeyVersion: string;
  /** Cookie原値を保存しない32-byte検索値。 */
  readonly cookieDigest: Uint8Array;
}

/** 認証基盤だけが所有し、Group IDを持たない保護対象行。 */
export type AuthenticationRow =
  | AuthenticationIdentityRow
  | AuthenticationAttemptRow
  | AuthenticationSessionRow;

/** 認証専用Envelopeの解釈を固定するMetadata。 */
export interface AuthenticationRecordHeader {
  /** 未対応形式を受理しない固定Version。 */
  readonly envelopeVersion: 1;
  /** A2で採用済みの認証付き暗号。 */
  readonly algorithmId: 'AES-256-GCM';
  /** 他Applicationとの暗号文混同を拒否する。 */
  readonly app: 'kakei_app';
  /** Group／Settlementとは独立したData Owner。 */
  readonly owner: 'authentication';
  /** 選択行の用途と完全一致させる。 */
  readonly recordKind: AuthenticationRow['recordKind'];
  /** IdentityはactorId、他はRecord ID。 */
  readonly keyScopeId: string;
  /** 選択済み行の論理ID。 */
  readonly logicalRecordId: string;
  /** 未対応Payloadの解釈を禁止する固定Version。 */
  readonly schemaVersion: 1;
  /** Providerが割り当てたDEK世代。 */
  readonly keyVersion: string;
  /** RowのMetadata版と完全一致させる。 */
  readonly recordVersion: number;
}

/** 許可したMetadataと認証付き暗号文だけを保存する。AADは行から再構成する。 */
export interface AuthenticationRecordEnvelope {
  /** 選択行との照合前は信頼しないMetadata。 */
  readonly header: AuthenticationRecordHeader;
  /** Providerが単調割当した96-bit値。Google nonceとは別物。 */
  readonly nonce: Uint8Array;
  /** 非空の保護Payload。Cookie原値を含めない。 */
  readonly ciphertext: Uint8Array;
  /** 128-bit GCM認証Tag。 */
  readonly authenticationTag: Uint8Array;
}

/** Identityの最小秘密項目。既存Verifierのcanonical issuerを使う。 */
export interface AuthenticationIdentitySecrets {
  /** 許容Google issuerの正規化後の固定値。 */
  readonly issuer: 'https://accounts.google.com';
  /** caseを保持する安定識別子。emailへ置換しない。 */
  readonly subject: string;
}

/** 試行専用の秘密項目。追加検索索引にしない。 */
export interface AuthenticationAttemptSecrets {
  /** Server期待値、canonical Base64URLの32-byte。 */
  readonly nonce: string;
  /** 試行に束縛する独立32-byte秘密値。 */
  readonly csrf: string;
}

/** Session専用の秘密項目。Cookie原値は含めない。 */
export interface AuthenticationSessionSecrets {
  /** Sessionに束縛する独立32-byte秘密値。 */
  readonly csrf: string;
}

/** 行のkindに対応する秘密項目だけを許可する。 */
export type AuthenticationSecrets =
  | AuthenticationIdentitySecrets
  | AuthenticationAttemptSecrets
  | AuthenticationSessionSecrets;

/** 原子的な保存を担当せず、行と秘密項目の完全性を守るPort。 */
export interface AuthenticationRecordCodec {
  /**
   * 新しいNonceを割り当て、全行Metadataと最小秘密項目を保護する。
   * @param input 選択行とkindに対応する秘密項目。Nonceは受け取らない。
   * @returns 保存可能なEnvelope。
   * @throws AuthenticationCryptoUnavailable 形式・鍵・Nonce・暗号化の失敗時。
   */
  seal(input: {
    /** 保存する行の全平文Metadata。 */
    row: AuthenticationRow;
    /** kindに対応する最小秘密項目。 */
    secrets: AuthenticationSecrets;
  }): Promise<AuthenticationRecordEnvelope>;
  /**
   * 選択行からAADを再構成し、復号後の全Metadata Copyも検証する。
   * @param input 保存で選択した期待行と信頼前のEnvelope。
   * @returns kindに対応する認証済み秘密項目。
   * @throws AuthenticationCryptoUnavailable 形式・差替え・鍵・認証の失敗時。
   */
  open(input: {
    /** Headerだけを信頼せず、Storeの選択行を期待値とする。 */
    row: AuthenticationRow;
    /** 保存された暗号文とMetadata。 */
    envelope: AuthenticationRecordEnvelope;
  }): Promise<AuthenticationSecrets>;
}

/** 暗号障害・改ざん・不正形式の詳細や秘密値を返さない失敗。 */
export class AuthenticationCryptoUnavailable extends Error {
  /** Storeが既存のunavailableへ写像できる固定判定。 */
  readonly status = 'unavailable' as const;
  /** 原因や入力を含めない汎用失敗を生成する。 */
  constructor() {
    super('Authentication crypto unavailable');
    this.name = 'AuthenticationCryptoUnavailable';
  }
}
