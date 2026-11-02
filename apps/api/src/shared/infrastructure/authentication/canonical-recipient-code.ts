import type { RecipientCodeMacFields } from '../../application/authentication/recipient-code-crypto-ports.js';
import {
  RecipientCodeUnavailable,
  snapshotRecipientCodeRecord,
} from '../../application/authentication/recipient-code-record.js';
import {
  authenticationKeyVersion,
  authenticationObject,
  decodeAuthenticationTlv,
  encodeAuthenticationTlv,
} from './canonical-authentication.js';

const fields = [
  'codeId',
  'recipientActorId',
  'recordVersion',
  'epoch',
  'createdAt',
  'expiresAt',
  'status',
  'terminalAt',
  'lookupKeyVersion',
  'lookupDigest',
  'macKeyVersion',
];
const fail = (): never => {
  throw new RecipientCodeUnavailable();
};

/**
 * 自己MACを除いたMetadataを補正せず同期Copyする。
 * @param input 未知field/accessorを許可しない全Metadata。
 * @returns Byte列を共有しない、構造検証済みのMetadata。
 * @throws RecipientCodeUnavailable 不正形式・鍵世代表記・負のzeroの場合。
 */
export const snapshotRecipientCodeMacFields = (
  input: unknown,
): RecipientCodeMacFields => {
  try {
    if (!input || typeof input !== 'object') return fail();
    const prototype: unknown = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return fail();
    if (
      fields.some(
        (key) => !Object.getOwnPropertyDescriptor(input, key)?.enumerable,
      )
    )
      return fail();
    const r = authenticationObject(input, fields);
    const parsed = snapshotRecipientCodeRecord({
      ...r,
      mac: new Uint8Array(32),
    });
    for (const value of [
      parsed.createdAt,
      parsed.expiresAt,
      parsed.terminalAt,
      parsed.recordVersion,
    ])
      if (Object.is(value, -0)) return fail();
    for (const value of [parsed.lookupKeyVersion, parsed.macKeyVersion])
      if (value.length > 255 || authenticationKeyVersion(value) !== value)
        return fail();
    const { mac, ...metadata } = parsed;
    void mac;
    return Object.freeze(metadata);
  } catch {
    return fail();
  }
};

/**
 * Accepted R4の13tagを記載順に固定する。既存A2のTLV形式は変更しない。
 * @param input 自己MACを除くコードMetadata。
 * @returns app/purposeと全Metadataを含むCanonical TLV。
 * @throws RecipientCodeUnavailable Metadata不正の場合。
 */
export const encodeRecipientCodeRecord = (
  input: RecipientCodeMacFields,
): Uint8Array => {
  const r = snapshotRecipientCodeMacFields(input);
  return encodeAuthenticationTlv([
    'kakei_app',
    'auth-recipient-code-state/v1',
    r.codeId,
    r.recipientActorId,
    String(r.recordVersion),
    r.epoch,
    r.lookupKeyVersion,
    r.lookupDigest,
    String(r.createdAt),
    String(r.expiresAt),
    r.status,
    r.terminalAt === null ? null : String(r.terminalAt),
    r.macKeyVersion,
  ]);
};

const decimal = (value: unknown): number => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
    return fail();
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : fail();
};

/**
 * 新形式だけを読み、未知/欠落/余剰/非正規tag・数値を拒否する。
 * @param input 信頼前のTLV。自己MACや秘密値を追加できない。
 * @returns 構造検証済みMetadata。MAC認証済みとは扱わない。
 * @throws RecipientCodeUnavailable 非Canonical入力の場合。
 */
export const decodeRecipientCodeRecord = (
  input: Uint8Array,
): RecipientCodeMacFields => {
  try {
    const v = decodeAuthenticationTlv(input, [
      'text',
      'text',
      'text',
      'text',
      'text',
      'text',
      'text',
      'binary',
      'text',
      'text',
      'text',
      'nullable-text',
      'text',
    ]);
    if (v[0] !== 'kakei_app' || v[1] !== 'auth-recipient-code-state/v1')
      return fail();
    return snapshotRecipientCodeMacFields({
      codeId: v[2],
      recipientActorId: v[3],
      recordVersion: decimal(v[4]),
      epoch: v[5],
      lookupKeyVersion: v[6],
      lookupDigest: v[7],
      createdAt: decimal(v[8]),
      expiresAt: decimal(v[9]),
      status: v[10],
      terminalAt: v[11] === null ? null : decimal(v[11]),
      macKeyVersion: v[12],
    });
  } catch {
    return fail();
  }
};
