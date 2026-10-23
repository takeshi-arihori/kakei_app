import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AuthenticationDataKeyPort,
  AuthenticationKeyScope,
  AuthenticationMacKeyPorts,
  AuthenticationMacPurpose,
} from '../src/shared/application/authentication/authentication-crypto-keys.js';
import { importAuthenticationDataKey } from '../src/shared/infrastructure/authentication/authentication-record-codec.js';
import { importAuthenticationMacKey } from '../src/shared/infrastructure/authentication/authentication-digests.js';
import { authenticationUuid } from '../src/shared/infrastructure/authentication/canonical-authentication.js';

/** 再起動後に復元できないlocalhost専用の能力。永続Providerとして利用しない。 */
export interface AuthenticationDevelopmentKeys {
  /** process固有の公開世代。旧DBを再利用するための鍵ではない。 */
  readonly epoch: string;
  /** HMACのprocess固有世代。用途ごとにMaterialは独立する。 */
  readonly keyVersion: string;
  /** process内でのみNonceを単調割当する、承認済みdurability例外。 */
  readonly dataKeys: AuthenticationDataKeyPort;
  /** 8用途それぞれ独立したOS乱数鍵。 */
  readonly macKeys: AuthenticationMacKeyPorts;
  /** 認証HMAC/DEKと独立したHTTP予算専用鍵のCopy。 */
  readonly rateKey: Uint8Array;
  /** 終了後の再利用を拒否し、所有する鍵Materialを消去する。 */
  dispose(): void;
}

/**
 * 空の専用DBで単一process leaseを得た開発Compositionだけが生成する。
 * @returns 再起動やDB rollbackでは再生成・復元しない使い捨て鍵群。
 */
export const createAuthenticationDevelopmentKeys =
  (): AuthenticationDevelopmentKeys => {
    const epoch = randomUUID(),
      keyVersion = randomUUID();
    let active = true;
    const rate = randomBytes(32);
    const material: Uint8Array[] = [rate];
    const records = new Map<
      string,
      { key: Uint8Array; count: bigint; disabled: boolean }
    >();
    const namespace = (scope: AuthenticationKeyScope) => {
      if (
        !['google-identity', 'login-attempt', 'session'].includes(
          scope.recordKind,
        )
      )
        throw new Error('開発鍵Scopeが不正です');
      return JSON.stringify([
        scope.recordKind,
        authenticationUuid(scope.keyScopeId),
      ]);
    };
    const port = <P extends AuthenticationMacPurpose>(
      purpose: P,
      cookie = false,
    ) => {
      const bytes = randomBytes(32);
      material.push(bytes);
      return {
        readKey: async (input: {
          keyVersion: string;
          epoch: string | null;
        }) => {
          await Promise.resolve();
          if (
            !active ||
            input.keyVersion !== keyVersion ||
            input.epoch !== (cookie ? epoch : null)
          )
            return { status: 'unavailable' as const };
          return {
            status: 'available' as const,
            keyVersion,
            epoch: input.epoch,
            key: importAuthenticationMacKey(purpose, bytes),
          };
        },
      };
    };
    const macKeys: AuthenticationMacKeyPorts = {
      identity: port('auth-google-identity/v1'),
      attemptCookie: port('auth-attempt-cookie/v1', true),
      sessionCookie: port('auth-session-cookie/v1', true),
      auditActor: port('auth-audit-actor/v1'),
      auditAttempt: port('auth-audit-attempt/v1'),
      auditSession: port('auth-audit-session/v1'),
      deletedActor: port('auth-deleted-actor/v1'),
      actorState: port('auth-actor-state/v1'),
    };
    const dataKeys: AuthenticationDataKeyPort = {
      async allocateForSeal(scope) {
        await Promise.resolve();
        if (!active) return { status: 'key-lost', keyVersion };
        const name = namespace(scope);
        let state = records.get(name);
        if (state === undefined) {
          const key = randomBytes(32);
          material.push(key);
          state = { key, count: 0n, disabled: false };
          records.set(name, state);
        }
        if (state.disabled || state.count >= (1n << 31n) - 1n)
          return { status: 'seal-disabled', keyVersion };
        // await前に割当をburnする。同processの外側Transactionで戻してはならない。
        const count = ++state.count;
        const nonce = Buffer.alloc(12);
        nonce.writeBigUInt64BE(count, 4);
        return {
          status: 'allocated',
          scope: { ...scope },
          lifecycle: 'current',
          key: importAuthenticationDataKey(state.key),
          keyVersion,
          nonce,
          sealCount: count,
        };
      },
      async readKey(input) {
        await Promise.resolve();
        if (!active || input.keyVersion !== keyVersion)
          return { status: 'unavailable' };
        const state = records.get(namespace(input.scope));
        if (!state) return { status: 'unavailable' };
        return {
          status: 'available',
          scope: { ...input.scope },
          keyVersion,
          lifecycle: state.disabled ? 'read-only' : 'current',
          key: importAuthenticationDataKey(state.key),
        };
      },
      async requestRotation(input) {
        await Promise.resolve();
        const state = records.get(namespace(input.scope));
        if (state && input.keyVersion === keyVersion) state.disabled = true;
        // 使い捨てProviderは自動Rotation/旧DB再利用を実装しない。明示reset後の新processが必要。
        throw new Error('開発鍵の再起動には専用DBの明示resetが必要です');
      },
    };
    return {
      epoch,
      keyVersion,
      dataKeys,
      macKeys,
      get rateKey() {
        return Uint8Array.from(rate);
      },
      dispose() {
        active = false;
        for (const bytes of material) bytes.fill(0);
        records.clear();
      },
    };
  };
