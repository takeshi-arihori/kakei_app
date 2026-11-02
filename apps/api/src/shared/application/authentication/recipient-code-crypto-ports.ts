import type { RecipientCodeSecret } from './recipient-code-input.js';
import type {
  RecipientCodeBytes,
  RecipientCodeRecord,
} from './recipient-code-record.js';

declare const keyBrand: unique symbol;

/** A2の既存用途やGM再送proofと共有しないコード専用Namespace。 */
export type RecipientCodeMacPurpose =
  | 'auth-recipient-code-lookup/v1'
  | 'auth-recipient-code-state/v1'
  | 'auth-audit-recipient-code/v1';

/** Providerが独立生成する用途別256-bit鍵。出力Digestではない。 */
export interface RecipientCodeMacKey<P extends RecipientCodeMacPurpose> {
  /** Runtimeでも要求用途との一致を確認する。 */
  readonly purpose: P;
  /** 用途/Record間で共有・IDから再導出しない鍵Material。 */
  readonly material: Uint8Array & {
    /** 異用途やDigestの代入を防ぐ。 */ readonly [keyBrand]: P;
  };
}

/** Lock下の鍵Stateから呼出し側が選ぶ世代と所有範囲。 */
export interface RecipientCodeKeyQuery {
  /** 新規はcurrent、検証は保存済みの世代。Cryptoは世代を選択しない。 */
  readonly keyVersion: string;
  /** Cookie用途ではないためnull。RecordのepochはMAC本文へ束縛する。 */
  readonly epoch: null;
  /** lookup/Auditはauthentication、状態MACはcodeId UUIDv4。 */
  readonly scopeId: string;
}

/** 不在・廃棄・障害を同じ失敗とするProvider返却値。 */
export type RecipientCodeKeyResult<P extends RecipientCodeMacPurpose> =
  | (RecipientCodeKeyQuery & {
      /** 要求Descriptorと鍵を照合した後だけ暗号操作へ進める。 */
      readonly status: 'available';
      /** Namespaceごと、状態MACはcodeIdごとに独立した鍵。 */
      readonly key: RecipientCodeMacKey<P>;
    })
  | {
      /** 廃棄世代はBackupからも復活させない。 */ readonly status: 'unavailable';
    };

/** 固定用途だけの読取能力。inventory/破棄権限を暗号部品へ渡さない。 */
export interface RecipientCodeKeyPort<P extends RecipientCodeMacPurpose> {
  /**
   * 指定用途・世代・Scopeに完全一致する独立鍵だけを取得する。
   * @param query 非Cookieのnull epoch、選択済み世代とScope。
   * @returns 一致候補または利用不能。例外もCrypto境界で汎用失敗へ変換する。
   * @throws Error Provider障害。消費側が元例外を含めない汎用失敗へ変換する。
   */
  readKey(query: RecipientCodeKeyQuery): Promise<RecipientCodeKeyResult<P>>;
}

/** Lookupの退役は全参照0件かつ関連Backup window終了後。状態MAC清掃とは別管理。 */
export interface RecipientCodeMacKeyPorts {
  /** 独立した全体検索鍵。原コードの再HashやRecord鍵と共有しない。 */
  readonly lookup: RecipientCodeKeyPort<'auth-recipient-code-lookup/v1'>;
  /** codeId別の独立鍵。終端/期限/Actor無効化後24h以内の全世代破棄がBackup保持に優先。 */
  readonly state: RecipientCodeKeyPort<'auth-recipient-code-state/v1'>;
  /** コードIDのAudit仮名専用。検索値・状態MACをAuditへ転用しない。 */
  readonly audit: RecipientCodeKeyPort<'auth-audit-recipient-code/v1'>;
}

type ValueKind<P extends RecipientCodeMacPurpose> =
  P extends 'auth-recipient-code-lookup/v1'
    ? 'lookup'
    : P extends 'auth-recipient-code-state/v1'
      ? 'record-mac'
      : 'audit';

/** 用途/世代/所有範囲をRuntimeにも保持した32-byte値。鍵へ代入しない。 */
export interface RecipientCodeMacValue<
  P extends RecipientCodeMacPurpose,
> extends RecipientCodeKeyQuery {
  /** 誤用途の保存値を比較前に拒否する。 */
  readonly purpose: P;
  /** #236の保存Inventoryへ渡せる用途別Copy。Log/例外へ出さない。 */
  readonly bytes: RecipientCodeBytes<ValueKind<P>>;
}

/** 自己参照するMAC自身だけを除いた、R4で保護する全Metadata。 */
export type RecipientCodeMacFields = Omit<RecipientCodeRecord, 'mac'>;

/** 永続化や現在認可を所有しないコード専用暗号Port。 */
export interface RecipientCodeCrypto {
  /**
   * canonical decoded codeから選択済み世代の検索値を作る。
   * @param input 正規形の入力値と検索鍵世代。
   * @returns 検索用途だけの32-byte値。
   * @throws RecipientCodeUnavailable 入力不正またはProvider障害。
   */
  lookup(input: {
    /** 原値を永続化しない入力VO。 */ readonly secret: RecipientCodeSecret;
    /** Lock下で選択した検索世代。 */ readonly keyVersion: string;
  }): Promise<RecipientCodeMacValue<'auth-recipient-code-lookup/v1'>>;
  /**
   * 保存検索値の用途・Descriptorを検証して固定長比較する。
   * @param input 入力VOと選択した保存検索値。
   * @returns 正しい用途・世代・Scopeで一致するときだけtrue。
   * @throws RecipientCodeUnavailable 不正Descriptor・入力・鍵障害。
   */
  verifyLookup(input: {
    /** 同期Copyする秘密入力。 */ readonly secret: RecipientCodeSecret;
    /** 保存行から構成した検索用途の値。 */ readonly expected: RecipientCodeMacValue<'auth-recipient-code-lookup/v1'>;
  }): Promise<boolean>;
  /**
   * codeId別鍵で全Metadataを認証する。AEAD/Nonceは使わない。
   * @param row 自己MACを除く全Metadata。現在の有効性は別のPolicyで判断する。
   * @returns codeIdと保存MAC世代に束縛した状態MAC。
   * @throws RecipientCodeUnavailable 形式・鍵・Scope不正。
   */
  recordMac(
    row: RecipientCodeMacFields,
  ): Promise<RecipientCodeMacValue<'auth-recipient-code-state/v1'>>;
  /**
   * 選択行の全Metadataと保存MACを検証する。
   * @param row 構造だけでは信頼しない最小Inventory。
   * @returns MACが一致した場合だけtrue。形式不正や鍵障害は成功へ変換しない。
   * @throws RecipientCodeUnavailable 不正形式・MAC不一致・鍵障害。
   */
  verifyRecord(row: RecipientCodeRecord): Promise<boolean>;
  /**
   * 直接codeIdをAuditへ出さない独立仮名を作る。
   * @param input codeIdとAudit世代。原コードを渡さない。
   * @returns Audit専用の仮名。
   * @throws RecipientCodeUnavailable 入力・鍵障害。
   */
  audit(input: {
    /** Server生成UUIDv4。 */ readonly codeId: string;
    /** Audit用の独立世代。 */ readonly keyVersion: string;
  }): Promise<RecipientCodeMacValue<'auth-audit-recipient-code/v1'>>;
}

/** Log/Auditへ秘密や直接IDを含めない、固定分類だけの障害通知。 */
export interface RecipientCodeCryptoAlert {
  /** 操作対象値を含めない。 */ readonly operation:
    'lookup' | 'record-mac' | 'audit';
  /** 詳細原因やProvider例外を複製しない。 */ readonly code: 'RECIPIENT_CODE_CRYPTO_UNAVAILABLE';
}
