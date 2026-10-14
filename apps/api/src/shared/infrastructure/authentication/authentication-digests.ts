import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  AuthenticationActorState,
  AuthenticationCryptoAlert,
  AuthenticationDigest,
  AuthenticationMacKey,
  AuthenticationMacKeyPorts,
  AuthenticationMacPurpose,
} from '../../application/authentication/authentication-crypto-keys.js';
import type {
  AuthenticationActorMacInput,
  AuthenticationCookieDigestInput,
  AuthenticationDigests,
  AuthenticationIdentityDigestInput,
  AuthenticationPseudonymInput,
} from '../../application/authentication/authentication-digest-ports.js';
import { AuthenticationCryptoUnavailable } from '../../application/authentication/authentication-record-protection.js';
import {
  authenticationKeyVersion,
  authenticationObject,
  authenticationText,
  authenticationUuid,
  encodeAuthenticationTlv,
  parseAuthenticationSecret,
} from './canonical-authentication.js';

const purposes: readonly AuthenticationMacPurpose[] = [
  'auth-google-identity/v1',
  'auth-attempt-cookie/v1',
  'auth-session-cookie/v1',
  'auth-audit-actor/v1',
  'auth-audit-attempt/v1',
  'auth-audit-session/v1',
  'auth-deleted-actor/v1',
  'auth-actor-state/v1',
];
const fail = (): never => {
  throw new AuthenticationCryptoUnavailable();
};

/**
 * 独立Namespaceの256-bit鍵をCopyし、他用途やDEKとの混同を拒否する。
 * @param purpose Accepted A2の固定用途。
 * @param bytes Providerが用途ごとに独立生成した32-byte値。
 * @returns Runtime用途とBrandを持ち、入力を共有しない鍵。
 * @throws AuthenticationCryptoUnavailable 未知用途・長さ不正の場合。
 */
export const importAuthenticationMacKey = <P extends AuthenticationMacPurpose>(
  purpose: P,
  bytes: Uint8Array,
): AuthenticationMacKey<P> => {
  if (
    !purposes.includes(purpose) ||
    !(bytes instanceof Uint8Array) ||
    bytes.length !== 32
  )
    return fail();
  return {
    purpose,
    material: Uint8Array.from(bytes) as AuthenticationMacKey<P>['material'],
  };
};

/**
 * 固定32-byteをNode標準の定数時間比較で照合する。
 * @param left 信頼前の比較値。
 * @param right 信頼前の比較値。
 * @returns 両方が32-byteで完全一致する場合だけtrue。
 */
export const authenticationBytesEqual = (
  left: unknown,
  right: unknown,
): boolean =>
  left instanceof Uint8Array &&
  right instanceof Uint8Array &&
  left.length === 32 &&
  right.length === 32 &&
  timingSafeEqual(left, right);

/**
 * Base64URLの32-byte秘密値を補正せず定数時間比較する。
 * @param left Browserまたは復号値の秘密値。
 * @param right 対応するServer期待値。
 * @returns Canonicalな固定長値が一致する場合だけtrue。
 */
export const authenticationSecretsEqual = (
  left: unknown,
  right: unknown,
): boolean => {
  try {
    return authenticationBytesEqual(
      parseAuthenticationSecret(left),
      parseAuthenticationSecret(right),
    );
  } catch {
    return false;
  }
};

const actorFields = (input: AuthenticationActorState): (string | null)[] => {
  const r = authenticationObject(input, [
    'actorId',
    'version',
    'state',
    'createdAt',
    'disabledAt',
  ]);
  if (
    typeof r.version !== 'number' ||
    !Number.isSafeInteger(r.version) ||
    r.version < 1 ||
    typeof r.createdAt !== 'number' ||
    !Number.isSafeInteger(r.createdAt) ||
    r.createdAt < 0 ||
    Object.is(r.createdAt, -0)
  )
    return fail();
  if (r.state !== 'active' && r.state !== 'disabled') return fail();
  if (
    r.disabledAt !== null &&
    (typeof r.disabledAt !== 'number' ||
      !Number.isSafeInteger(r.disabledAt) ||
      r.disabledAt < r.createdAt ||
      Object.is(r.disabledAt, -0))
  )
    return fail();
  if ((r.state === 'active') !== (r.disabledAt === null)) return fail();
  return [
    authenticationUuid(r.actorId),
    String(r.version),
    r.state,
    String(r.createdAt),
    r.disabledAt === null ? null : String(r.disabledAt),
  ];
};

/**
 * 用途ごとの独立ProviderとNode HMACで認証用Digest Portを作る。
 * @param options 固定用途のPort群。省略した用途の呼出しは汎用失敗にする。
 * @returns Scopeや用途を固定したHMACと状態MACの操作。
 */
export const createAuthenticationDigests = (options: {
  /** 必要な用途だけを注入できる。未接続を本番接続済みと扱わない。 */
  keys: Partial<AuthenticationMacKeyPorts>;
  /** 例外やIDを含まない固定失敗通知。通知自体の失敗は公開しない。 */
  onAlert?: (signal: AuthenticationCryptoAlert) => void;
}): AuthenticationDigests => {
  const emit = (): void => {
    try {
      options.onAlert?.({ operation: 'digest', code: 'KEY_UNAVAILABLE' });
    } catch {
      /* 汎用失敗を置換しない。 */
    }
  };
  const digest = async <P extends AuthenticationMacPurpose>(
    purpose: P,
    name: keyof AuthenticationMacKeyPorts,
    keyVersion: string,
    epoch: string | null,
    fields: readonly (string | Uint8Array | null)[],
  ): Promise<AuthenticationDigest<P>> => {
    try {
      const version = authenticationKeyVersion(keyVersion);
      const selectedEpoch = epoch === null ? null : authenticationUuid(epoch);
      // await前にCanonical Byte列へCopyし、入力の後続Mutationを受けない。
      const canonical = encodeAuthenticationTlv([
        'kakei_app',
        purpose,
        ...fields,
      ]);
      const port = options.keys[name];
      if (port === undefined) return fail();
      const result = await port.readKey({
        keyVersion: version,
        epoch: selectedEpoch,
      });
      if (
        result.status !== 'available' ||
        result.keyVersion !== version ||
        result.epoch !== selectedEpoch ||
        result.key.purpose !== purpose ||
        !(result.key.material instanceof Uint8Array) ||
        result.key.material.length !== 32
      )
        return fail();
      const material = Uint8Array.from(result.key.material);
      try {
        const output = createHmac('sha256', material)
          .update(canonical)
          .digest();
        return {
          purpose,
          keyVersion: version,
          bytes: Uint8Array.from(output) as AuthenticationDigest<P>['bytes'],
        };
      } finally {
        material.fill(0);
      }
    } catch {
      emit();
      return fail();
    }
  };
  const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch {
      return fail();
    }
  };
  const identity = (input: AuthenticationIdentityDigestInput) =>
    safe(() => {
      const value = authenticationObject(input.identity, ['issuer', 'subject']);
      if (value.issuer !== 'https://accounts.google.com') return fail();
      const subject = authenticationText(value.subject);
      if (subject.length > 255) return fail();
      return digest(
        'auth-google-identity/v1',
        'identity',
        input.keyVersion,
        null,
        ['google', value.issuer, subject],
      );
    });
  const cookie = <
    P extends 'auth-attempt-cookie/v1' | 'auth-session-cookie/v1',
  >(
    purpose: P,
    name: 'attemptCookie' | 'sessionCookie',
    input: AuthenticationCookieDigestInput,
  ) =>
    safe(() => {
      const epoch = authenticationUuid(input.epoch);
      return digest(purpose, name, input.keyVersion, epoch, [
        epoch,
        parseAuthenticationSecret(input.secret),
      ]);
    });
  const pseudonym = <
    P extends
      | 'auth-audit-actor/v1'
      | 'auth-audit-attempt/v1'
      | 'auth-audit-session/v1'
      | 'auth-deleted-actor/v1',
  >(
    purpose: P,
    name: 'auditActor' | 'auditAttempt' | 'auditSession' | 'deletedActor',
    input: AuthenticationPseudonymInput,
  ) =>
    safe(() =>
      digest(purpose, name, input.keyVersion, null, [
        authenticationUuid(input.subjectId),
      ]),
    );
  const actorState = (input: AuthenticationActorMacInput) =>
    safe(() =>
      digest(
        'auth-actor-state/v1',
        'actorState',
        input.keyVersion,
        null,
        actorFields(input.row),
      ),
    );
  return Object.freeze({
    identity,
    attemptCookie: (input: AuthenticationCookieDigestInput) =>
      cookie('auth-attempt-cookie/v1', 'attemptCookie', input),
    sessionCookie: (input: AuthenticationCookieDigestInput) =>
      cookie('auth-session-cookie/v1', 'sessionCookie', input),
    auditActor: (input: AuthenticationPseudonymInput) =>
      pseudonym('auth-audit-actor/v1', 'auditActor', input),
    auditAttempt: (input: AuthenticationPseudonymInput) =>
      pseudonym('auth-audit-attempt/v1', 'auditAttempt', input),
    auditSession: (input: AuthenticationPseudonymInput) =>
      pseudonym('auth-audit-session/v1', 'auditSession', input),
    deletedActor: (input: AuthenticationPseudonymInput) =>
      pseudonym('auth-deleted-actor/v1', 'deletedActor', input),
    actorState,
    async verifyActorState(
      input: AuthenticationActorMacInput & { mac: Uint8Array },
    ) {
      const mac =
        input.mac instanceof Uint8Array
          ? Uint8Array.from(input.mac)
          : input.mac;
      const expected = await actorState(input);
      return authenticationBytesEqual(mac, expected.bytes);
    },
  });
};
