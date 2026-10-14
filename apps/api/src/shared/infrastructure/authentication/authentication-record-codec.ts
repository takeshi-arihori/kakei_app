import { createCipheriv, createDecipheriv } from 'node:crypto';

import type {
  AuthenticationCryptoAlert,
  AuthenticationDataKey,
  AuthenticationDataKeyPort,
  AuthenticationKeyScope,
  AuthenticationRotationReason,
} from '../../application/authentication/authentication-crypto-keys.js';
import {
  AuthenticationCryptoUnavailable,
  type AuthenticationRecordCodec,
  type AuthenticationRecordHeader,
} from '../../application/authentication/authentication-record-protection.js';
import {
  authenticationHeader,
  authenticationKeyVersion,
  authenticationObject,
  encodeAuthenticationAad,
  parseAuthenticationRow,
} from './canonical-authentication.js';
import {
  decodeAuthenticationPayload,
  encodeAuthenticationPayload,
} from './authentication-payload.js';

const fail = (): never => {
  throw new AuthenticationCryptoUnavailable();
};
const rotationThreshold = 1n << 31n;
const sealLimit = 1n << 32n;

/**
 * 認証専用の独立256-bit DEKをCopyし、Digest鍵との誤用を防ぐ。
 * @param bytes Providerから取得した32-byte鍵。DB／Logへ保存しない。
 * @returns 入力を共有しないBrand付きDEK。
 * @throws AuthenticationCryptoUnavailable 鍵長・型不正の場合。
 */
export const importAuthenticationDataKey = (
  bytes: Uint8Array,
): AuthenticationDataKey => {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return fail();
  return Uint8Array.from(bytes) as AuthenticationDataKey;
};

const scopeMatches = (
  input: AuthenticationKeyScope,
  expected: AuthenticationKeyScope,
): boolean => {
  const scope = authenticationObject(input, ['recordKind', 'keyScopeId']);
  return (
    scope.recordKind === expected.recordKind &&
    scope.keyScopeId === expected.keyScopeId
  );
};
const copyBytes = (input: unknown, length?: number): Uint8Array => {
  if (
    !(input instanceof Uint8Array) ||
    input.length === 0 ||
    (length !== undefined && input.length !== length)
  )
    return fail();
  return Uint8Array.from(input);
};
const copyHeader = (input: unknown): AuthenticationRecordHeader =>
  authenticationObject(input, [
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
  ]) as unknown as AuthenticationRecordHeader;

/**
 * 認証専用AES-256-GCM境界を組み立てる。認可・Transaction・時刻判断はStoreが所有する。
 * @param options durable割当／鍵読取Portと固定Code監視通知。
 * @returns CallerにNonceを選ばせない、行束縛のCodec。
 */
export const createAuthenticationRecordCodec = (options: {
  /** 外側rollbackでもNonceを戻さず、Destroyed鍵を恒久拒否するProvider。 */
  keys: AuthenticationDataKeyPort;
  /** ID・鍵・Payload・SDK例外を含めない監視通知。 */
  onAlert?: (signal: AuthenticationCryptoAlert) => void;
}): AuthenticationRecordCodec => {
  const emit = (
    operation: 'seal' | 'open',
    code: AuthenticationCryptoAlert['code'],
  ): void => {
    try {
      options.onAlert?.(Object.freeze({ operation, code }));
    } catch {
      /* Alert障害で汎用失敗を置換しない。 */
    }
  };
  return Object.freeze({
    async seal(input: Parameters<AuthenticationRecordCodec['seal']>[0]) {
      let code: AuthenticationCryptoAlert['code'] = 'INVALID_INPUT';
      let material: AuthenticationDataKey | undefined;
      try {
        const command = authenticationObject(input, ['row', 'secrets']);
        const row = parseAuthenticationRow(command.row);
        // await前に全Metadataと秘密項目を検証・Copyする。
        const plaintext = encodeAuthenticationPayload(row, command.secrets);
        const base = authenticationHeader(row, 'pending');
        const scope: AuthenticationKeyScope = {
          recordKind: base.recordKind,
          keyScopeId: base.keyScopeId,
        };
        code = 'KEY_UNAVAILABLE';
        const allocation = await options.keys.allocateForSeal({ ...scope });
        const keyVersion = authenticationKeyVersion(allocation.keyVersion);
        const rotate = async (
          reason: AuthenticationRotationReason,
        ): Promise<void> => {
          const previous = code;
          code = 'ROTATION_FAILED';
          await options.keys.requestRotation({
            scope: { ...scope },
            keyVersion,
            reason,
          });
          code = previous;
        };
        if (allocation.status !== 'allocated') {
          code =
            allocation.status === 'counter-regressed'
              ? 'COUNTER_REGRESSION'
              : 'KEY_UNAVAILABLE';
          const reason =
            allocation.status === 'counter-regressed'
              ? 'counter-regression'
              : allocation.status === 'seal-disabled'
                ? 'seal-disabled'
                : 'key-lost';
          await rotate(reason);
          return fail();
        }
        code = 'ALLOCATION_INVALID';
        if (
          !(allocation.key instanceof Uint8Array) ||
          allocation.key.length !== 32 ||
          !(allocation.nonce instanceof Uint8Array) ||
          allocation.nonce.length !== 12
        ) {
          await rotate('allocation-invalid');
          return fail();
        }
        // Provider参照をRotation await越しに保持しない。
        material = importAuthenticationDataKey(allocation.key);
        const nonce = copyBytes(allocation.nonce, 12);
        const sealCount = allocation.sealCount;
        if (
          !scopeMatches(allocation.scope, scope) ||
          allocation.lifecycle !== 'current' ||
          typeof sealCount !== 'bigint'
        ) {
          await rotate('allocation-invalid');
          return fail();
        }
        if (sealCount <= 0n) {
          code = 'COUNTER_REGRESSION';
          await rotate('counter-regression');
          return fail();
        }
        if (sealCount >= sealLimit) {
          code = 'SEAL_LIMIT';
          await rotate('seal-limit');
          return fail();
        }
        if (sealCount >= rotationThreshold) await rotate('seal-threshold');
        const header = authenticationHeader(row, keyVersion);
        const aad = encodeAuthenticationAad(header, row);
        const cipher = createCipheriv('aes-256-gcm', material, nonce, {
          authTagLength: 16,
        });
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([
          cipher.update(plaintext),
          cipher.final(),
        ]);
        return {
          header,
          nonce,
          ciphertext: Uint8Array.from(ciphertext),
          authenticationTag: Uint8Array.from(cipher.getAuthTag()),
        };
      } catch {
        emit('seal', code);
        return fail();
      } finally {
        material?.fill(0);
      }
    },
    async open(input: Parameters<AuthenticationRecordCodec['open']>[0]) {
      let code: AuthenticationCryptoAlert['code'] = 'INVALID_INPUT';
      let material: AuthenticationDataKey | undefined;
      try {
        const command = authenticationObject(input, ['row', 'envelope']);
        const row = parseAuthenticationRow(command.row);
        const raw = authenticationObject(command.envelope, [
          'header',
          'nonce',
          'ciphertext',
          'authenticationTag',
        ]);
        const storedHeader = copyHeader(raw.header);
        const aad = encodeAuthenticationAad(storedHeader, row);
        const header = authenticationHeader(row, storedHeader.keyVersion);
        const nonce = copyBytes(raw.nonce, 12);
        const tag = copyBytes(raw.authenticationTag, 16);
        const ciphertext = copyBytes(raw.ciphertext);
        const scope: AuthenticationKeyScope = {
          recordKind: header.recordKind,
          keyScopeId: header.keyScopeId,
        };
        code = 'KEY_UNAVAILABLE';
        const result = await options.keys.readKey({
          scope: { ...scope },
          keyVersion: header.keyVersion,
        });
        if (
          result.status !== 'available' ||
          result.keyVersion !== header.keyVersion ||
          !scopeMatches(result.scope, scope) ||
          (result.lifecycle !== 'current' && result.lifecycle !== 'read-only')
        )
          return fail();
        material = importAuthenticationDataKey(result.key);
        code = 'AUTHENTICATION_FAILED';
        const decipher = createDecipheriv('aes-256-gcm', material, nonce, {
          authTagLength: 16,
        });
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);
        return decodeAuthenticationPayload(plaintext, row);
      } catch {
        emit('open', code);
        return fail();
      } finally {
        material?.fill(0);
      }
    },
  });
};
