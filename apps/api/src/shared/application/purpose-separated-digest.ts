declare const purposeSeparatedDigestBrand: unique symbol;

/** 保存Indexの用途とVersion。異なる用途間で同じDigestを再利用しない。 */
export type DigestPurpose =
  | 'group-actor-access-index/v1'
  | 'group-membership-index/v1'
  | 'group-operation-fingerprint/v1';

/** 暗号鍵と混同させない、用途別Portが返す非空DigestのBrand型。 */
export type PurposeSeparatedDigest = Uint8Array & {
  /** 構造が同じByte列との誤用を防ぐ、Module非公開の型識別子。 */
  readonly [purposeSeparatedDigestBrand]: true;
};

/**
 * 非空Byte列をコピーし、暗号鍵とは別のDigest型として扱う。
 * @param bytes 用途別PortのDigest Byte列。呼出し側の配列は変更しない。
 * @returns 入力と参照を共有しないBrand付きDigest。
 * @throws TypeError Byte列が空の場合。
 */
export const importPurposeSeparatedDigest = (
  bytes: Uint8Array,
): PurposeSeparatedDigest => {
  if (bytes.length === 0) {
    throw new TypeError('A purpose-separated digest must not be empty');
  }
  return Uint8Array.from(bytes) as PurposeSeparatedDigest;
};

/** Groupと用途へ束縛したDigestを取得するPort。具体鍵Providerと保存は別責務。 */
export interface PurposeSeparatedDigestPort {
  /**
   * 用途とGroupへ束縛したIndex値を取得する。
   * @param input 固定Purpose、Group参照、変更せず渡すCanonical Byte列。
   * @returns 非空Digestと対応鍵Version。
   */
  digest(input: {
    /** Version付きの用途識別子。別用途のDigestへの流用を禁止する。 */
    purpose: DigestPurpose;
    /** 用途別DigestのScopeとなるGroup参照。 */
    groupId: string;
    /** 呼出し側が確定した用途別Byte列。Portへ変更せず渡す。 */
    canonicalInput: Uint8Array;
  }): Promise<
    Readonly<{
      /** 指定用途・Groupに対応する非空Digest。暗号鍵として使用しない。 */
      digest: PurposeSeparatedDigest;
      /** Index照合・Rotationで使うDigest鍵のVersion。 */
      digestKeyVersion: string;
    }>
  >;
}
