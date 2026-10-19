import type { AuthenticationKeyScope } from './authentication-crypto-keys.js';
import type { AuthenticationRetentionWindow } from './authentication-retention-policy.js';

declare const headBrand: unique symbol;
declare const intentBrand: unique symbol;
declare const destructionBrand: unique symbol;
declare const fenceBrand: unique symbol;
declare const inventoryCursorBrand: unique symbol;

/** 同Providerの固定未完了票snapshotへ束縛する、不透明な続き位置。 */
export type AuthenticationActorDeletionCursor = object & {
  /** Provider所有registryで偽造・別snapshot・別Providerを拒否する。 */
  readonly [inventoryCursorBrand]: true;
};

/** 未完了Actor票を先頭から欠落なく走査するsnapshotの一Page。 */
export interface AuthenticationActorDeletionPage {
  /** 同じsnapshot内で重複しない、全世代binding付き未完了票。 */
  readonly tickets: readonly AuthenticationDestructionTicket[];
  /** 固定snapshotの続き。nullは全件読了で、残件を黙って切り捨てない。 */
  readonly nextCursor: AuthenticationActorDeletionCursor | null;
}

/** 検証Adapterのregistryに所有された最新head。構造的な偽造を受理しない。 */
export type AuthenticationVerifiedHead = object & {
  /** Runtimeの所有registryでも検証する非公開識別子。 */
  readonly [headBrand]: true;
};
/** 最新Ledgerの不可逆な削除意思とbindingを持つopaque handle。 */
export type AuthenticationVerifiedIntent = object & {
  /** 同operationの外部証跡にだけ束縛する。 */
  readonly [intentBrand]: true;
};
/** 全世代inventoryが閉じ、破棄を確認した対象のopaque handle。 */
export type AuthenticationVerifiedDestruction = object & {
  /** booleanや別operationの証跡へ置換しない。 */
  readonly [destructionBrand]: true;
};
/** 外部Traffic／Writerを閉じたRestore runの所有能力。 */
export type AuthenticationRestoreFence = object & {
  /** 別runや解放済み能力の混用を拒否する。 */
  readonly [fenceBrand]: true;
};

/** Providerのconditional appendとManifestに使う認証専用head。 */
export interface AuthenticationLedgerHead {
  /** 正の連続sequence。genesisだけ0。 */
  readonly sequence: number;
  /** Canonical本文と前headを覆うlowercase SHA256 hexadecimal。 */
  readonly hash: string;
}

/** Ledgerへ直接IDを保存しない削除意思。 */
export interface AuthenticationDeletionRecord {
  /** 復旧checkpointとの混同を防ぐ固定用途。 */
  readonly kind: 'actor-deletion';
  /** 一連の再試行で不変のServer生成UUIDv4。 */
  readonly operationId: string;
  /** 当該仮名を検証できる削除専用鍵世代。 */
  readonly actorDigestKeyVersion: string;
  /** deleted-actor用途の32-byte値。Auditの仮名とは独立。 */
  readonly actorDigest: Uint8Array;
  /** DB無効化前の外部受付UTC。24時間期限の起算を失わない。 */
  readonly preparedAt: number;
  /** 同operationの単調な証跡版。 */
  readonly version: number;
  /** Preparedを取消せずCompleteへだけ進む。 */
  readonly state: 'prepared' | 'complete';
  /** 直接Actor／Key IDを含まないProviderの管理用opaque参照。 */
  readonly targetReference: string;
}

/** 開通直前にWitnessへ束縛する復旧checkpoint本文。 */
export interface AuthenticationRecoveryRecord {
  /** 削除意思とは別の固定用途。 */
  readonly kind: 'recovery';
  /** 外部fenceと同じServer生成Restore run UUIDv4。 */
  readonly operationId: string;
  /** 旧Cookieを拒否する新epoch。 */
  readonly epoch: string;
  /** 検証完了のUTC。 */
  readonly completedAt: number;
  /** 全除去・新鍵世代・Alias検査の固定Canonical証拠digest。 */
  readonly evidenceDigest: Uint8Array;
}

/** MACとhash chainが覆うImmutable Ledgerの一行。 */
export interface AuthenticationLedgerEntry {
  /** namespace内で欠番のないsequence。 */
  readonly sequence: number;
  /** 直前headの完全一致を要求する。 */
  readonly previousHash: string;
  /** 許可した最小本文だけ。 */
  readonly record: AuthenticationDeletionRecord | AuthenticationRecoveryRecord;
  /** 専用Ledger MAC鍵の読取世代。 */
  readonly macKeyVersion: string;
  /** Canonical全Fieldへの32-byte HMAC。 */
  readonly mac: Uint8Array;
  /** Canonical全FieldとMACを覆うSHA256。 */
  readonly hash: string;
}

/** Provider署名検証へ渡す、fresh requestとheadの完全なbinding。 */
export interface AuthenticationHeadAttestation {
  /** Group等の別Ledgerと分離する固定Namespace。 */
  readonly namespace: 'authentication/v1';
  /** 独立した二つのFailure domainを区別する用途。 */
  readonly source: 'checkpoint' | 'witness';
  /** Callerがfresh latest readのため生成したUUIDv4。 */
  readonly challenge: string;
  /** attestationが覆う最新head。 */
  readonly head: AuthenticationLedgerHead;
  /** Providerが検証する署名等。Log／DBへ複製しない。 */
  readonly attestation: Uint8Array;
}

/** 外部Storeの配置・線形化・署名は実ProviderのProduction Gate。 */
export interface AuthenticationLedgerProvider {
  /**
   * 両Failure domainからfreshでlinearizableなlatestを読む。
   * @param challenge 呼出し側が新規生成したUUIDv4。
   * @returns Namespaceとchallengeへ束縛した独立した二証跡。
   */
  latest(challenge: string): Promise<readonly AuthenticationHeadAttestation[]>;
  /**
   * 固定headまでの連続行を最大128件ずつ読む。
   * @param after 既読sequence。次行から返す。
   * @param head latestで選択した固定head。
   * @returns 欠番や順序変更を含めず、末尾を超えないPage。
   */
  page(
    after: number,
    head: AuthenticationLedgerHead,
  ): Promise<readonly AuthenticationLedgerEntry[]>;
  /**
   * expected headにだけImmutable appendし独立Witnessへ同headを記録する。
   * @param expected 事前確認済みhead。
   * @param entry 専用MACで保護済みの次行。
   * @throws Provider障害・CAS競合・応答喪失。Callerは同operationのlatestを再照合する。
   */
  append(
    expected: AuthenticationLedgerHead,
    entry: AuthenticationLedgerEntry,
  ): Promise<void>;
}

/** Providerの署名・challenge・sourceへのbindingを検証する能力。 */
export interface AuthenticationAttestationVerifier {
  /**
   * Provider固有の署名/Trust anchorを検証する。呼出し有無だけで信頼しない。
   * @param proof fresh requestに対応するProvider証跡。
   * @returns 完全一致する真正な最新証跡だけtrue。
   */
  verifyHead(proof: AuthenticationHeadAttestation): Promise<boolean>;
}

/** 専用Ledger MAC鍵。DEK／Audit／削除照合鍵と共有しない。 */
export interface AuthenticationLedgerMacKeys {
  /**
   * 要求世代に完全一致する独立256-bit鍵を取得する。
   * @param keyVersion 現行または未完了Intent/Backupのため保持する世代。
   * @returns 対応世代と独立したMaterial。
   * @throws Provider障害、要求鍵の欠損・失効・不一致。
   */
  read(keyVersion: string): Promise<
    Readonly<{
      /** 用途誤用をRuntimeで拒否する固定値。 */
      purpose: 'auth-deletion-ledger/v1';
      /** 要求世代へ完全一致させる。 */
      keyVersion: string;
      /** 旧世代はchain検証だけに使い、新しいappendへ転用しない。 */
      lifecycle: 'current' | 'read-only';
      /** 専用の独立ランダム256-bit鍵。永続化/Logへ出さない。 */
      material: Uint8Array;
    }>
  >;
}

/** 復旧DBと独立して保持するBackup Manifestの最小値。 */
export interface AuthenticationBackupManifest {
  /** Backup取得UTC。35日超や未来を拒否する。 */
  readonly createdAt: number;
  /** 対応済みDB Schemaの版。 */
  readonly schemaVersion: number;
  /** 当時のDB鍵State CAS版。 */
  readonly keyStateVersion: number;
  /** 当時のCookie epoch。復旧後は再利用しない。 */
  readonly epoch: string;
  /** latest chainに含まれることを要求する当時のhead。 */
  readonly checkpoint: AuthenticationLedgerHead;
}

/** DB除去前にProviderがdurableに保持する全世代破棄の再開情報。 */
export interface AuthenticationDestructionTicket {
  /** 同じ処理を再照合するServer生成UUIDv4。 */
  readonly operationId: string;
  /** Providerだけが直接Key参照を保持する管理参照。 */
  readonly reference: string;
  /** 対象追加ごとの正のCAS版。 */
  readonly version: number;
  /** 未参照世代を含む完全なRegistry集合のdigest。 */
  readonly inventoryDigest: Uint8Array;
  /** DB行消失後も監視できるdurableな削除起算と最遅期限。 */
  readonly window: AuthenticationRetentionWindow;
}

/** 全世代の管理と証跡確認を行う独立した認証鍵管理境界。 */
export interface AuthenticationKeyDestructionPort {
  /**
   * 全未完了Actor票を固定snapshotの小Pageで読む。変化を欠落として隠さない。
   * @param cursor 初回はnull。以後は同Providerが発行した直前Pageの所有能力。
   * @param limit 一Pageの正の上限1〜1000。全体件数の打切りには使わない。
   * @returns snapshot内の次Pageと、完全な末尾だけnullのcursor。
   * @throws Provider障害、偽造cursor、途中での集合・版・inventory変更。先頭から再検証する。
   */
  pendingActorDeletionPage(
    cursor: AuthenticationActorDeletionCursor | null,
    limit: number,
  ): Promise<AuthenticationActorDeletionPage>;
  /**
   * DB行が消失した後も同operation/管理参照の最新ticketを再取得する。
   * @param operationId 外部削除意思と同じUUID。
   * @param reference 外部Ledgerが保持するProvider管理参照。
   * @returns 既存の全scope/全世代inventoryを持つ最新ticket。未登録ならnull。
   */
  find(
    operationId: string,
    reference: string,
  ): Promise<AuthenticationDestructionTicket | null>;
  /**
   * 対象scopeをdurable管理参照へ追加する。鍵破棄/Seal封鎖はまだしない。
   * @param operationId 同じ再試行のoperation。
   * @param scopes Lock下で確認した全対象。Materialは含まない。
   * @param window DB行消失後も再試行/監視に使う保持Window。
   * @returns 全世代を追跡する最新ticket。
   */
  prepare(
    operationId: string,
    scopes: readonly AuthenticationKeyScope[],
    window: AuthenticationRetentionWindow,
  ): Promise<AuthenticationDestructionTicket>;
  /**
   * 失敗やDB応答喪失で残ったCredential専用ticketを期限順の小Pageで列挙する。
   * @param limit 一回の正の内部上限。
   * @returns Attempt/Sessionだけの未完了ticket。Identity削除の意思は別Workflowで検証する。
   */
  pendingCredentials(
    limit: number,
  ): Promise<readonly AuthenticationDestructionTicket[]>;
  /**
   * 外部Prepared保存前後の未完了Actor票を列挙し、受付証跡の欠落を検出する。
   * @param limit 一回の正の内部上限。
   * @param selector 内部Actorまたはoperationへ絞る完全一致検索。省略時は全未完了票。
   * @returns Identity scopeを含む未完了票。Ledger不在を取消/受付成功と推測しない。
   */
  pendingActorDeletions(
    limit: number,
    selector?: Readonly<{
      /** 新規受付前に同じActorの孤児票を検出する内部ID。 */
      actorId?: string;
      /** Ledger不在の再開操作に束縛したServer UUID。 */
      operationId?: string;
    }>,
  ): Promise<readonly AuthenticationDestructionTicket[]>;
  /**
   * 管理参照から対象scopeを再取得する。CallerはDBの不存在を再確認する。
   * @param ticket 完全一致するoperation/参照/版。
   * @returns 当該ticketのscopeだけ。
   */
  scopes(
    ticket: AuthenticationDestructionTicket,
  ): Promise<readonly AuthenticationKeyScope[]>;
  /**
   * DB除去確認後だけ全世代集合をconditionalに閉じ、恒久破棄する。
   * @param ticket 操作/対象/版/全世代digestへ完全一致するticket。
   * @returns 全世代Destroyedと封鎖を検証したopaque能力。
   */
  destroy(
    ticket: AuthenticationDestructionTicket,
  ): Promise<AuthenticationVerifiedDestruction>;
  /**
   * 偽造/別Provider/部分世代/古い版の能力を拒否する。
   * @param proof destroyが発行した能力。
   * @param ticket 同じ対象と版の期待値。
   * @returns 現行・旧・未参照を含む全世代破棄と新規Seal恒久拒否が確認できる場合だけtrue。
   */
  verify(
    proof: AuthenticationVerifiedDestruction,
    ticket: AuthenticationDestructionTicket,
  ): Promise<boolean>;
}

/** 固定Codeと集約値だけの保守監視入力。 */
export interface AuthenticationMaintenanceMonitor {
  /**
   * 最古期限と失敗を記録する。ID/秘密/自由文を渡さない。
   * @param event 固定分類と期限だけ。
   */
  record(
    event: Readonly<{
      /** 保守処理の固定分類。 */
      operation: 'cleanup' | 'deletion' | 'restore';
      /** 失敗や期限到達を成功に変換しない。 */
      code: 'OK' | 'UNAVAILABLE' | 'OVERDUE' | 'QUARANTINED';
      /** 未完了対象の最古Window。不明または対象なしはnull。 */
      oldest: AuthenticationRetentionWindow | null;
    }>,
  ): Promise<void>;
}

/** 認証専用Ledgerの検証とopaque能力発行。暗号実装はInfrastructureに置く。 */
export interface AuthenticationLedgerEvidence {
  /** 外部の現行書込世代と照合する固定MAC世代。鍵Materialを公開しない。 */
  readonly writeKeyVersion: string;
  /**
   * fresh latest、両証跡、全chainと任意Manifest所属を確認する。
   * @param manifest 復旧時のBackup Manifest。通常運転では省略する。
   * @returns この検証器だけが解決できる最新head能力。
   * @throws AuthenticationCryptoUnavailable 不正形式・所有権・必要証跡の不一致。非同期操作ではProvider障害も拒否する。
   */
  latest(
    manifest?: AuthenticationBackupManifest,
  ): Promise<AuthenticationVerifiedHead>;
  /**
   * 同じ検証器のhead能力をCopyしたbindingへ解決する。
   * @param head 検証済みhead。偽造/別registryは拒否する。
   * @returns sequence/hashの独立Copy。
   * @throws AuthenticationCryptoUnavailable 不正形式・所有権・必要証跡の不一致。非同期操作ではProvider障害も拒否する。
   */
  head(head: AuthenticationVerifiedHead): AuthenticationLedgerHead;
  /**
   * 完全に検証したchainから最新状態の全削除意思を取得する。
   * @param head 全Page読了済みのhead能力。
   * @returns Prepared/Completeともに失効しない削除意思。
   * @throws AuthenticationCryptoUnavailable 不正形式・所有権・必要証跡の不一致。非同期操作ではProvider障害も拒否する。
   */
  intents(
    head: AuthenticationVerifiedHead,
  ): readonly AuthenticationVerifiedIntent[];
  /**
   * 同じoperationの最新の削除意思だけを選ぶ。
   * @param head 検証済みhead。
   * @param operationId 再開するServer生成UUIDv4。
   * @returns 存在する場合の能力。欠落時はnull。
   * @throws AuthenticationCryptoUnavailable 不正形式・所有権・必要証跡の不一致。非同期操作ではProvider障害も拒否する。
   */
  intent(
    head: AuthenticationVerifiedHead,
    operationId: string,
  ): AuthenticationVerifiedIntent | null;
  /**
   * 同じ検証器で発行した削除能力を解決する。
   * @param intent 検証済み削除意思。構造的な偽造は拒否する。
   * @returns operation/仮名/UTC/参照/状態/版の独立Copy。
   * @throws AuthenticationCryptoUnavailable 不正形式・所有権・必要証跡の不一致。非同期操作ではProvider障害も拒否する。
   */
  resolve(intent: AuthenticationVerifiedIntent): AuthenticationDeletionRecord;
  /**
   * 最新headへのconditional append後に両Storeと全chainを再検証する。
   * @param head append元の検証済みhead。
   * @param record 次の削除意思または復旧checkpoint。状態遷移も検証する。
   * @returns appendを含む新head。
   * @throws AuthenticationCryptoUnavailable 不正binding/遷移/証跡。Provider障害・片側成功・応答喪失でも拒否する。
   */
  append(
    head: AuthenticationVerifiedHead,
    record: AuthenticationDeletionRecord | AuthenticationRecoveryRecord,
  ): Promise<AuthenticationVerifiedHead>;
}
