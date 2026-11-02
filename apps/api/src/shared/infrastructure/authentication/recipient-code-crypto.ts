import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  RecipientCodeCrypto,
  RecipientCodeCryptoAlert,
  RecipientCodeKeyPort,
  RecipientCodeKeyQuery,
  RecipientCodeMacFields,
  RecipientCodeMacKey,
  RecipientCodeMacKeyPorts,
  RecipientCodeMacPurpose,
  RecipientCodeMacValue,
} from '../../application/authentication/recipient-code-crypto-ports.js';
import { RecipientCodeSecret } from '../../application/authentication/recipient-code-input.js';
import {
  RecipientCodeUnavailable,
  snapshotRecipientCodeRecord,
} from '../../application/authentication/recipient-code-record.js';
import {
  authenticationKeyVersion,
  authenticationObject,
  authenticationUuid,
  encodeAuthenticationTlv,
} from './canonical-authentication.js';
import {
  encodeRecipientCodeRecord,
  snapshotRecipientCodeMacFields,
} from './canonical-recipient-code.js';

const purposes: readonly RecipientCodeMacPurpose[] = [
  'auth-recipient-code-lookup/v1',
  'auth-recipient-code-state/v1',
  'auth-audit-recipient-code/v1',
];
const fail = (): never => {
  throw new RecipientCodeUnavailable();
};
const version = (input: unknown): string => {
  const result = authenticationKeyVersion(input);
  return result.length <= 255 ? result : fail();
};
const copy32 = (input: unknown): Uint8Array => {
  try {
    if (!(input instanceof Uint8Array)) return fail();
    const result = new Uint8Array(input);
    return result.length === 32 ? result : fail();
  } catch {
    return fail();
  }
};
const secretBytes = (input: unknown): Uint8Array =>
  input instanceof RecipientCodeSecret ? copy32(input.copyBytes()) : fail();

/**
 * Providerの独立生成済み256-bit鍵をCopyして用途を付ける。
 * @param purpose コード専用の固定Namespace。
 * @param material 用途ごと、状態MACならcodeIdごとに独立した32-byte値。
 * @returns 入力とByte列を共有しない鍵。乱数独立性はProviderの契約。
 * @throws RecipientCodeUnavailable 未知用途・長さ不正。
 */
export const importRecipientCodeMacKey = <P extends RecipientCodeMacPurpose>(
  purpose: P,
  material: Uint8Array,
): RecipientCodeMacKey<P> => {
  if (!purposes.includes(purpose)) return fail();
  return Object.freeze({
    purpose,
    material: copy32(material) as RecipientCodeMacKey<P>['material'],
  });
};

const digest = async <P extends RecipientCodeMacPurpose>(
  purpose: P,
  port: RecipientCodeKeyPort<P>,
  query: RecipientCodeKeyQuery,
  canonical: Uint8Array,
): Promise<RecipientCodeMacValue<P>> => {
  const response: unknown = await port.readKey(Object.freeze({ ...query }));
  const r = authenticationObject(response, [
    'status',
    'keyVersion',
    'epoch',
    'scopeId',
    'key',
  ]);
  if (
    r.status !== 'available' ||
    r.keyVersion !== query.keyVersion ||
    r.epoch !== null ||
    r.scopeId !== query.scopeId
  )
    return fail();
  const key = authenticationObject(r.key, ['purpose', 'material']);
  if (key.purpose !== purpose) return fail();
  const material = copy32(key.material);
  try {
    const bytes = Uint8Array.from(
      createHmac('sha256', material).update(canonical).digest(),
    ) as RecipientCodeMacValue<P>['bytes'];
    return Object.freeze({ ...query, purpose, bytes });
  } finally {
    material.fill(0);
  }
};

/**
 * コード専用3用途のProviderをNode標準HMACへ適合する。
 * @param options 独立鍵の読取能力と秘密値を含まない固定Alert通知。
 * @returns 現在時刻・認可・SQL・鍵世代選択を含まない暗号操作。
 */
export const createRecipientCodeCrypto = (options: {
  /** 既存A2やGM proofの鍵を注入しない。 */ readonly keys: RecipientCodeMacKeyPorts;
  /** 通知例外も公開例外へ含めない。 */ readonly onAlert?: (
    signal: RecipientCodeCryptoAlert,
  ) => void;
}): RecipientCodeCrypto => {
  const keys = { ...options.keys };
  const onAlert = options.onAlert;
  const safe = async <T>(
    operation: RecipientCodeCryptoAlert['operation'],
    work: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await work();
    } catch {
      try {
        onAlert?.({ operation, code: 'RECIPIENT_CODE_CRYPTO_UNAVAILABLE' });
      } catch {
        /* 固定失敗を置換しない。 */
      }
      return fail();
    }
  };
  const lookup = (secret: unknown, keyVersion: unknown) => {
    const query = {
      keyVersion: version(keyVersion),
      epoch: null,
      scopeId: 'authentication',
    } as const;
    const canonical = encodeAuthenticationTlv([
      'kakei_app',
      'auth-recipient-code-lookup/v1',
      secretBytes(secret),
    ]);
    return digest(
      'auth-recipient-code-lookup/v1',
      keys.lookup,
      query,
      canonical,
    );
  };
  const state = (row: RecipientCodeMacFields) => {
    const r = snapshotRecipientCodeMacFields(row);
    return digest(
      'auth-recipient-code-state/v1',
      keys.state,
      { keyVersion: r.macKeyVersion, epoch: null, scopeId: r.codeId },
      encodeRecipientCodeRecord(r),
    );
  };
  const operations: RecipientCodeCrypto = {
    lookup: (input) =>
      safe('lookup', () => {
        const r = authenticationObject(input, ['secret', 'keyVersion']);
        return lookup(r.secret, r.keyVersion);
      }),
    verifyLookup: (input) =>
      safe('lookup', async () => {
        const r = authenticationObject(input, ['secret', 'expected']);
        const expected = authenticationObject(r.expected, [
          'purpose',
          'keyVersion',
          'epoch',
          'scopeId',
          'bytes',
        ]);
        if (
          expected.purpose !== 'auth-recipient-code-lookup/v1' ||
          expected.epoch !== null ||
          expected.scopeId !== 'authentication'
        )
          return fail();
        const actualBytes = copy32(expected.bytes);
        const calculated = await lookup(r.secret, expected.keyVersion);
        return timingSafeEqual(actualBytes, calculated.bytes);
      }),
    recordMac: (row) => safe('record-mac', () => state(row)),
    verifyRecord: (input) =>
      safe('record-mac', async () => {
        const r = snapshotRecipientCodeRecord(input);
        const { mac, ...metadata } = r;
        const calculated = await state(metadata);
        if (!timingSafeEqual(mac, calculated.bytes)) return fail();
        return true;
      }),
    audit: (input) =>
      safe('audit', () => {
        const r = authenticationObject(input, ['codeId', 'keyVersion']);
        const query = {
          keyVersion: version(r.keyVersion),
          epoch: null,
          scopeId: 'authentication',
        } as const;
        return digest(
          'auth-audit-recipient-code/v1',
          keys.audit,
          query,
          encodeAuthenticationTlv([
            'kakei_app',
            'auth-audit-recipient-code/v1',
            authenticationUuid(r.codeId),
          ]),
        );
      }),
  };
  return Object.freeze(operations);
};
