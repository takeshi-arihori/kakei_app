const alphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 認証や参加権限を持たない技術入力値。秘密値を通常のDTOへ展開しない。 */
export class RecipientCodeSecret {
  readonly #bytes: Uint8Array;

  private constructor(value: string) {
    const bytes = new Uint8Array(32);
    let bits = 0;
    let buffer = 0;
    let offset = 0;
    for (const char of value) {
      buffer = (buffer << 6) | alphabet.indexOf(char);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes[offset++] = (buffer >> bits) & 255;
        buffer &= (1 << bits) - 1;
      }
    }
    this.#bytes = bytes;
    Object.freeze(this);
  }

  /**
   * await前に呼び、入力Objectから切り離す。trimやcase変換は行わない。
   * @param value 外部の未検証値。32-byteを表す正規形43文字だけを受理する。
   * @returns 独立した秘密値、または形式拒否のnull。入力を例外へ含めない。
   */
  static parse(value: unknown): RecipientCodeSecret | null {
    // 最後のsextetの下位2bit=0はdecode後32-byteの再Encode一致と等価。
    if (
      typeof value !== 'string' ||
      value.length !== 43 ||
      !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)
    )
      return null;
    return new RecipientCodeSecret(value);
  }

  /**
   * 暗号Adapterへ渡すたびにCopyする。返却配列を保存やLogへ渡さない。
   * @returns canonical decode済み32-byteの独立Copy。
   */
  copyBytes(): Uint8Array {
    return this.#bytes.slice();
  }

  /** @returns 文字列へ変換しても秘密値を含めない固定表現。 */
  toString(): string {
    return '[RecipientCodeSecret]';
  }
}
