import {
  AuthenticationCryptoUnavailable,
  type AuthenticationRow,
  type AuthenticationSecrets,
} from '../../application/authentication/authentication-record-protection.js';
import {
  authenticationObject,
  authenticationText,
  encodeAuthenticationRow,
  parseAuthenticationRow,
  parseAuthenticationSecret,
} from './canonical-authentication.js';

const fail = (): never => {
  throw new AuthenticationCryptoUnavailable();
};
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// JSON.parse単独ではescape表記を含むduplicate Keyが消えるため、構文を読む時点で拒否する。
// PayloadのObject深さはroot／rowだけ。配列や任意の深いObjectを受け入れない。
const parseStrictJson = (text: string): unknown => {
  let offset = 0;
  const whitespace = (): void => {
    while (/[\x20\t\r\n]/.test(text[offset] ?? '') && offset < text.length)
      offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '\\') {
        offset++;
        continue;
      }
      if (character === '"') {
        const value: unknown = JSON.parse(text.slice(start, offset));
        return authenticationText(value);
      }
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    whitespace();
    if (text[offset] === '"') return string();
    if (text[offset] === '{') {
      if (depth > 1) return fail();
      offset++;
      const object: Record<string, unknown> = Object.create(null) as Record<
        string,
        unknown
      >;
      const keys = new Set<string>();
      whitespace();
      if (text[offset] === '}') {
        offset++;
        return object;
      }
      while (offset < text.length) {
        whitespace();
        if (text[offset] !== '"') return fail();
        const key = string();
        if (keys.has(key)) return fail();
        keys.add(key);
        whitespace();
        if (text[offset++] !== ':') return fail();
        object[key] = value(depth + 1);
        whitespace();
        if (text[offset] === '}') {
          offset++;
          return object;
        }
        if (text[offset++] !== ',') return fail();
      }
      return fail();
    }
    if (text.slice(offset, offset + 4) === 'null') {
      offset += 4;
      return null;
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      text.slice(offset),
    );
    if (number === null) return fail();
    offset += number[0].length;
    return Number(number[0]);
  };
  const result = value(0);
  whitespace();
  if (offset !== text.length) return fail();
  return result;
};

const secretFields = (row: AuthenticationRow): string[] =>
  row.recordKind === 'google-identity'
    ? ['issuer', 'subject']
    : row.recordKind === 'login-attempt'
      ? ['nonce', 'csrf']
      : ['csrf'];

const validateSecrets = (
  row: AuthenticationRow,
  input: unknown,
): AuthenticationSecrets => {
  const secrets = authenticationObject(input, secretFields(row));
  if (row.recordKind === 'google-identity') {
    if (secrets.issuer !== 'https://accounts.google.com') return fail();
    const subject = authenticationText(secrets.subject);
    // 既存Verifierと同じ上限。新しい外部入力方針を追加しない。
    if (subject.length > 255) return fail();
    return { issuer: secrets.issuer, subject };
  }
  parseAuthenticationSecret(secrets.csrf);
  const csrf = secrets.csrf as string;
  if (row.recordKind === 'login-attempt') {
    parseAuthenticationSecret(secrets.nonce);
    return { nonce: secrets.nonce as string, csrf };
  }
  return { csrf };
};

/**
 * 検証済み行と最小秘密項目をversion付きJSONにする。
 * @param inputRow 保存する全Metadata。Byte列はcanonical Base64URLへ写像する。
 * @param inputSecrets kindに対応する秘密項目だけ。
 * @returns 暗号化前のUTF-8 Payload。Cookie原値は含まない。
 * @throws AuthenticationCryptoUnavailable 不正行・秘密値・追加Fieldの場合。
 */
export const encodeAuthenticationPayload = (
  inputRow: AuthenticationRow,
  inputSecrets: unknown,
): Uint8Array => {
  try {
    const row = parseAuthenticationRow(inputRow);
    const secrets = validateSecrets(row, inputSecrets);
    const copy =
      row.recordKind === 'google-identity'
        ? row
        : {
            ...row,
            cookieDigest: Buffer.from(row.cookieDigest).toString('base64url'),
          };
    return new TextEncoder().encode(
      JSON.stringify({ payloadVersion: 1, row: copy, ...secrets }),
    );
  } catch {
    return fail();
  }
};

/**
 * duplicate・未知Fieldを拒否し、復号Payloadと期待Rowを完全照合する。
 * @param bytes AEAD認証後のPayload。UTF-8も信頼しない。
 * @param expectedRow Storeが選択した全Metadata。
 * @returns 対応kindの最小秘密項目。
 * @throws AuthenticationCryptoUnavailable JSON・version・行Copy・秘密値不正の場合。
 */
export const decodeAuthenticationPayload = (
  bytes: Uint8Array,
  expectedRow: AuthenticationRow,
): AuthenticationSecrets => {
  try {
    const row = parseAuthenticationRow(expectedRow);
    const fields = secretFields(row);
    const payload = authenticationObject(
      parseStrictJson(decoder.decode(bytes)),
      ['payloadVersion', 'row', ...fields],
    );
    if (payload.payloadVersion !== 1) return fail();
    const copy = authenticationObject(payload.row, Object.keys(row));
    if (row.recordKind !== 'google-identity')
      copy.cookieDigest = parseAuthenticationSecret(copy.cookieDigest);
    const payloadRow = parseAuthenticationRow(copy);
    if (
      !Buffer.from(encodeAuthenticationRow(row)).equals(
        Buffer.from(encodeAuthenticationRow(payloadRow)),
      ) ||
      row.recordKind !== payloadRow.recordKind
    )
      return fail();
    const secrets: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const field of fields) secrets[field] = payload[field];
    return validateSecrets(row, secrets);
  } catch {
    return fail();
  }
};
