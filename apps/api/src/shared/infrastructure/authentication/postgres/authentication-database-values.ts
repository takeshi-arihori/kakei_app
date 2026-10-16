import { AuthenticationCryptoUnavailable } from '../../../application/authentication/authentication-record-protection.js';

/**
 * pg境界のRowを未信頼値として扱う。
 * @param value DB Driverが返した値。
 * @returns 自身のdata propertyだけを持つRow。
 * @throws Object以外やAccessorの場合。
 */
export const authenticationDatabaseRow = (
  value: unknown,
): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new AuthenticationCryptoUnavailable();
  const copy: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !('value' in descriptor))
      throw new AuthenticationCryptoUnavailable();
    copy[key] = descriptor.value as unknown;
  }
  return copy;
};

/**
 * DB bigintを丸めずsafe integerへ復元する。pg parserの暗黙変換に依存しない。
 * @param value Canonical十進文字列、または既に精度が保証された整数。
 * @param minimum 版は1、時刻は0。
 * @returns 精度を失っていない整数。
 * @throws 不正表記・範囲外・負のゼロの場合。
 */
export const authenticationDatabaseInteger = (
  value: unknown,
  minimum: number,
): number => {
  if (typeof value === 'string') {
    if (!/^(0|[1-9][0-9]*)$/.test(value))
      throw new AuthenticationCryptoUnavailable();
    value = Number(value);
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    Object.is(value, -0)
  )
    throw new AuthenticationCryptoUnavailable();
  return value;
};

/**
 * Driver BufferをCopyしDB結果と暗号入力の可変参照を共有しない。
 * @param value 未信頼のbytea。
 * @param length 固定長。省略時は非空ciphertext。
 * @returns 独立したByte列。
 * @throws 不正型・長さの場合。
 */
export const authenticationDatabaseBytes = (
  value: unknown,
  length?: number,
): Uint8Array => {
  if (
    !(value instanceof Uint8Array) ||
    (length === undefined ? value.length === 0 : value.length !== length)
  )
    throw new AuthenticationCryptoUnavailable();
  return Uint8Array.from(value);
};
