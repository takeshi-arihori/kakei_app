import type { RecipientCodeSecret } from '../../shared/application/authentication/recipient-code-input.js';

declare const proofKeyBrand: unique symbol;
declare const proofBrand: unique symbol;

/** 認証検索/MACや既存Group Digestと独立した、GM所有の再送鍵。 */
export interface RecipientCodeRequestProofKey {
  /** Group IDを偽造せずContext全体の専用用途を使う。 */ readonly purpose: 'gm-recipient-code-request/v1';
  /** 独立生成した256-bit値。認証鍵やGroup DEKと共有しない。 */ readonly material: Uint8Array & {
    /** 鍵と証明値を混同しない。 */ readonly [proofKeyBrand]: true;
  };
}

/** Providerに要求するGM専用鍵の選択値。 */
export interface RecipientCodeRequestProofKeyQuery {
  /** 新規は選択current、成功再送は保存済みproofの世代。 */ readonly keyVersion: string;
  /** 認証Cookieではないためnull。 */ readonly epoch: null;
  /** Group IDではなく、GM-owned Namespace。 */ readonly scopeId: 'group-management';
}

/** 参照するGM operationが0件かつ関連Backupの35日window終了まで読取保持する。 */
export interface RecipientCodeRequestProofKeyPort {
  /**
   * 選択済みのGM proof専用世代だけを取得する。
   * @param query 保存proof世代または新規に選択した世代と固定Scope。
   * @returns 対応する独立鍵、または廃棄/不在を含む汎用利用不能。
   * @throws Error Provider障害。消費側が元例外を含めない汎用失敗へ変換する。
   */
  readKey(query: RecipientCodeRequestProofKeyQuery): Promise<
    | (RecipientCodeRequestProofKeyQuery & {
        /** Cryptoで返却Descriptor全体を照合する。 */ readonly status: 'available';
        /** 原コードや認証鍵を持たないGM専用鍵。 */ readonly key: RecipientCodeRequestProofKey;
      })
    | {
        /** コードRecord清掃ではこの世代を破棄しない。 */ readonly status: 'unavailable';
      }
  >;
}

/** raw codeを含めず、GM operationの既存保護Envelope内だけに保存する証明。 */
export interface RecipientCodeRequestProof extends RecipientCodeRequestProofKeyQuery {
  /** Runtimeでも認証値/既存Fingerprintと区別する。 */ readonly purpose: 'gm-recipient-code-request/v1';
  /** 固定32-byte証明。Log/Audit/例外へ出さない。 */ readonly bytes: Uint8Array & {
    /** 鍵や他用途Digestを代入しない。 */ readonly [proofBrand]: true;
  };
}

/** Crypto/Providerの詳細・秘密値・IDを公開しない固定失敗。 */
export class RecipientCodeRequestProofUnavailable extends Error {
  /** Providerの元例外をcauseへ保持しない。 */
  constructor() {
    super('Recipient code request proof unavailable');
    this.name = 'RecipientCodeRequestProofUnavailable';
  }
}

/** GMの新Commandが使う再送証明だけのPort。コード行の寿命に依存しない。 */
export interface RecipientCodeRequestProofPort {
  /**
   * canonical decoded codeのHMACを作る。
   * @param input 秘密入力VOとGM key-stateで選択した新規鍵世代。
   * @returns 原コードを含めず用途/世代/Scopeを保持したGM証明。
   * @throws RecipientCodeRequestProofUnavailable 入力・鍵障害。
   */
  create(input: {
    /** 保存しない技術入力。 */ readonly secret: RecipientCodeSecret;
    /** Lock下で選択する新規用世代。 */ readonly keyVersion: string;
  }): Promise<RecipientCodeRequestProof>;
  /**
   * 保存されたproof鍵世代で再計算し、固定32-byteを比較する。
   * @param input 入力VOと復号した保存証明。現在鍵世代を別引数にしない。
   * @returns 同内容ならtrue、別の正規入力ならfalse。
   * @throws RecipientCodeRequestProofUnavailable 形式・用途・鍵障害。
   */
  verify(input: {
    /** コード行を読まず同期Copyする入力。 */ readonly secret: RecipientCodeSecret;
    /** 保存された世代を選択根拠とする。 */ readonly saved: RecipientCodeRequestProof;
  }): Promise<boolean>;
}
