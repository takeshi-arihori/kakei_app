import {
  AuthenticationCryptoUnavailable,
  type AuthenticationRow,
  type AuthenticationRecordHeader,
} from '../../application/authentication/authentication-record-protection.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const fail = (): never => {
  throw new AuthenticationCryptoUnavailable();
};

/**
 * 許可Fieldだけを持つ通常Objectを検査する。Getterの再評価に依存しない。
 * @param input 境界から受け取った未検証値。
 * @param fields 重複も追加も認めないField集合。
 * @returns 自身のData Propertyから作った参照を共有しないObject。
 * @throws AuthenticationCryptoUnavailable Object形式やField集合が不正な場合。
 */
export const authenticationObject = (
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return fail();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  )
    return fail();
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of fields) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (property === undefined || !('value' in property)) return fail();
    result[key] = property.value as unknown;
  }
  return result;
};

/**
 * Unicodeや空白を補正せずCanonical文字列を検査する。
 * @param value 非空・制御文字なしの文字列。
 * @returns 入力と同じ文字列。
 * @throws AuthenticationCryptoUnavailable 不正文字・空白・surrogateの場合。
 */
export const authenticationText = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value)
    return fail();
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      return fail();
  }
  return value;
};

/**
 * Server生成UUIDv4のcanonical表記を要求する。
 * @param value 小文字UUIDv4とRFC variantの文字列。
 * @returns 検証済みの同じID。
 * @throws AuthenticationCryptoUnavailable 表記・version・variant不正の場合。
 */
export const authenticationUuid = (value: unknown): string => {
  const text = authenticationText(value);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      text,
    )
  )
    return fail();
  return text;
};

/**
 * 既存Schemaと同じ鍵世代表記を要求する。
 * @param value 空ではないASCII鍵世代。
 * @returns 検証済み世代。
 * @throws AuthenticationCryptoUnavailable 未許可文字の場合。
 */
export const authenticationKeyVersion = (value: unknown): string => {
  const text = authenticationText(value);
  if (!/^[A-Za-z0-9._:-]+$/.test(text)) return fail();
  return text;
};

const integer = (value: unknown, minimum: number): number => {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    Object.is(value, -0)
  )
    return fail();
  return value;
};
const bytes = (value: unknown, size: number): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.length !== size) return fail();
  return Uint8Array.from(value);
};

/**
 * 32-byte秘密値を正規化せず復号する。
 * @param value 43文字のcanonical unpadded Base64URL。
 * @returns 入力から独立した固定長Byte列。
 * @throws AuthenticationCryptoUnavailable 長さ・文字・pad bitが不正な場合。
 */
export const parseAuthenticationSecret = (value: unknown): Uint8Array => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value))
    return fail();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== value)
    return fail();
  return Uint8Array.from(decoded);
};

/**
 * 認証行の全Fieldと状態・期限整合を検証してCopyする。現在の有効性は判断しない。
 * @param input Storeから選択した未検証行。
 * @returns Mutable Bufferを共有しない認証行。
 * @throws AuthenticationCryptoUnavailable 未知Field・形式・状態・期限不整合の場合。
 */
export const parseAuthenticationRow = (input: unknown): AuthenticationRow => {
  if (typeof input !== 'object' || input === null) return fail();
  const descriptor = Object.getOwnPropertyDescriptor(input, 'recordKind');
  const kind: unknown = descriptor?.value;
  if (kind === 'google-identity') {
    const r = authenticationObject(input, [
      'recordKind',
      'identityId',
      'actorId',
      'version',
    ]);
    return {
      recordKind: kind,
      identityId: authenticationUuid(r.identityId),
      actorId: authenticationUuid(r.actorId),
      version: integer(r.version, 1),
    };
  }
  const common = [
    'recordKind',
    'version',
    'epoch',
    'createdAt',
    'state',
    'terminalAt',
    'cookieDigestKeyVersion',
    'cookieDigest',
  ];
  const fields =
    kind === 'login-attempt'
      ? [...common, 'attemptId', 'expiresAt']
      : kind === 'session'
        ? [
            ...common,
            'sessionId',
            'actorId',
            'absoluteExpiresAt',
            'idleExpiresAt',
          ]
        : fail();
  const r = authenticationObject(input, fields);
  const version = integer(r.version, 1);
  const epoch = authenticationUuid(r.epoch);
  const createdAt = integer(r.createdAt, 0);
  const terminalAt = r.terminalAt === null ? null : integer(r.terminalAt, 0);
  const cookieDigestKeyVersion = authenticationKeyVersion(
    r.cookieDigestKeyVersion,
  );
  const cookieDigest = bytes(r.cookieDigest, 32);
  if (terminalAt !== null && terminalAt < createdAt) return fail();
  const facts = {
    version,
    epoch,
    createdAt,
    terminalAt,
    cookieDigestKeyVersion,
    cookieDigest,
  };
  if (kind === 'login-attempt') {
    const expiresAt = integer(r.expiresAt, 0);
    if (
      expiresAt - createdAt !== 300_000 ||
      (r.state !== 'ready' &&
        r.state !== 'consumed' &&
        r.state !== 'replaced') ||
      (r.state === 'ready') !== (terminalAt === null)
    )
      return fail();
    return {
      ...facts,
      recordKind: kind,
      attemptId: authenticationUuid(r.attemptId),
      expiresAt,
      state: r.state,
    };
  }
  const absoluteExpiresAt = integer(r.absoluteExpiresAt, 0);
  const idleExpiresAt = integer(r.idleExpiresAt, 0);
  if (
    absoluteExpiresAt <= createdAt ||
    absoluteExpiresAt - createdAt > 604_800_000 ||
    idleExpiresAt <= createdAt ||
    idleExpiresAt > absoluteExpiresAt ||
    (r.state !== 'active' && r.state !== 'revoked') ||
    (r.state === 'active') !== (terminalAt === null)
  )
    return fail();
  return {
    ...facts,
    recordKind: 'session',
    sessionId: authenticationUuid(r.sessionId),
    actorId: authenticationUuid(r.actorId),
    absoluteExpiresAt,
    idleExpiresAt,
    state: r.state,
  };
};

/** Canonical TLVのField種別。binaryとabsenceの許可を明示する。 */
export type AuthenticationTlvFieldKind = 'text' | 'binary' | 'nullable-text';

/**
 * 記載順tagを持つ認証専用Canonical TLVへ符号化する。
 * @param values nullはnullable、Byte列はbinary、他は厳格文字列。
 * @returns tag順が一意な独立Byte列。
 * @throws AuthenticationCryptoUnavailable 文字列・Field数・長さ不正の場合。
 */
export const encodeAuthenticationTlv = (
  values: readonly (string | Uint8Array | null)[],
): Uint8Array => {
  if (values.length === 0 || values.length > 255) return fail();
  const chunks = values.map((value, index) => {
    const content =
      value === null
        ? new Uint8Array()
        : value instanceof Uint8Array
          ? Uint8Array.from(value)
          : encoder.encode(authenticationText(value));
    if ((value !== null && content.length === 0) || content.length > 0xffffffff)
      return fail();
    const chunk = new Uint8Array(6 + content.length);
    chunk[0] = index + 1;
    chunk[1] = value === null ? 0 : 1;
    new DataView(chunk.buffer).setUint32(2, content.length, false);
    chunk.set(content, 6);
    return chunk;
  });
  const result = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

/**
 * 順序・長さ・presence・UTF-8を検証してCanonical TLVを読む。
 * @param input 信頼前のByte列。
 * @param kinds 許可するField集合とnullable／binary指定。
 * @returns Fieldごとの検証済み値。
 * @throws AuthenticationCryptoUnavailable 非Canonical表現の場合。
 */
export const decodeAuthenticationTlv = (
  input: Uint8Array,
  kinds: readonly AuthenticationTlvFieldKind[],
): (string | Uint8Array | null)[] => {
  try {
    if (
      !(input instanceof Uint8Array) ||
      kinds.length === 0 ||
      kinds.length > 255
    )
      return fail();
    const data = Uint8Array.from(input);
    let offset = 0;
    const result = kinds.map((kind, index) => {
      if (offset + 6 > data.length || data[offset] !== index + 1) return fail();
      const presence = data[offset + 1];
      const length = new DataView(data.buffer).getUint32(offset + 2, false);
      offset += 6;
      if (length > data.length - offset) return fail();
      const content = data.slice(offset, offset + length);
      offset += length;
      if (presence === 0) {
        if (kind !== 'nullable-text' || length !== 0) return fail();
        return null;
      }
      if (presence !== 1) return fail();
      if (kind === 'binary') {
        if (length === 0) return fail();
        return content;
      }
      return authenticationText(decoder.decode(content));
    });
    if (offset !== data.length) return fail();
    return result;
  } catch {
    return fail();
  }
};

/**
 * 全平文MetadataをA2記載順のbinary Row Bindingへ変換する。
 * @param input 選択した認証行。未知Fieldは拒否する。
 * @returns Headerのtag11へ入れるCanonical TLV。
 * @throws AuthenticationCryptoUnavailable Rowが不正な場合。
 */
export const encodeAuthenticationRow = (
  input: AuthenticationRow,
): Uint8Array => {
  const r = parseAuthenticationRow(input);
  if (r.recordKind === 'google-identity')
    return encodeAuthenticationTlv([
      r.identityId,
      r.actorId,
      String(r.version),
    ]);
  const terminal = r.terminalAt === null ? null : String(r.terminalAt);
  if (r.recordKind === 'login-attempt')
    return encodeAuthenticationTlv([
      r.attemptId,
      String(r.version),
      r.epoch,
      String(r.createdAt),
      String(r.expiresAt),
      r.state,
      terminal,
      r.cookieDigestKeyVersion,
      r.cookieDigest,
    ]);
  return encodeAuthenticationTlv([
    r.sessionId,
    r.actorId,
    String(r.version),
    r.epoch,
    String(r.createdAt),
    String(r.absoluteExpiresAt),
    String(r.idleExpiresAt),
    r.state,
    terminal,
    r.cookieDigestKeyVersion,
    r.cookieDigest,
  ]);
};

/**
 * 選択行と鍵世代から信頼可能な期待Headerを再構成する。
 * @param input 全Metadataを含む選択行。
 * @param keyVersion 認証するProvider鍵世代。
 * @returns 行のScope／ID／版を束縛したHeader。
 * @throws AuthenticationCryptoUnavailable 行・鍵世代が不正な場合。
 */
export const authenticationHeader = (
  input: AuthenticationRow,
  keyVersion: string,
): AuthenticationRecordHeader => {
  const row = parseAuthenticationRow(input);
  const id =
    row.recordKind === 'google-identity'
      ? row.identityId
      : row.recordKind === 'login-attempt'
        ? row.attemptId
        : row.sessionId;
  return {
    envelopeVersion: 1,
    algorithmId: 'AES-256-GCM',
    app: 'kakei_app',
    owner: 'authentication',
    recordKind: row.recordKind,
    keyScopeId: row.recordKind === 'google-identity' ? row.actorId : id,
    logicalRecordId: id,
    schemaVersion: 1,
    keyVersion: authenticationKeyVersion(keyVersion),
    recordVersion: row.version,
  };
};

/**
 * Header全Fieldの整合を検証し、選択行からAADを再構成する。
 * @param header 信頼前の保存Header。
 * @param row Storeが選択した期待行。
 * @returns Row Bindingを含むCanonical AAD。
 * @throws AuthenticationCryptoUnavailable Headerや行の不一致の場合。
 */
export const encodeAuthenticationAad = (
  header: AuthenticationRecordHeader,
  row: AuthenticationRow,
): Uint8Array => {
  const fields = [
    'envelopeVersion',
    'algorithmId',
    'app',
    'owner',
    'recordKind',
    'keyScopeId',
    'logicalRecordId',
    'schemaVersion',
    'keyVersion',
    'recordVersion',
  ];
  const actual = authenticationObject(header, fields);
  const expected = authenticationHeader(
    row,
    authenticationKeyVersion(actual.keyVersion),
  );
  for (const key of fields)
    if (actual[key] !== expected[key as keyof AuthenticationRecordHeader])
      return fail();
  return encodeAuthenticationTlv([
    String(expected.envelopeVersion),
    expected.algorithmId,
    expected.app,
    expected.owner,
    expected.recordKind,
    expected.keyScopeId,
    expected.logicalRecordId,
    String(expected.schemaVersion),
    expected.keyVersion,
    String(expected.recordVersion),
    encodeAuthenticationRow(row),
  ]);
};
