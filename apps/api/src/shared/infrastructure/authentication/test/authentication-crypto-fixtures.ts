import type {
  AuthenticationDataKeyPort,
  AuthenticationKeyScope,
  AuthenticationReadKeyResult,
  AuthenticationSealAllocation,
} from '../../../application/authentication/authentication-crypto-keys.js';
import type {
  AuthenticationRow,
  AuthenticationSecrets,
} from '../../../application/authentication/authentication-record-protection.js';
import { importAuthenticationDataKey } from '../authentication-record-codec.js';

/** 公開用の架空UUIDv4。実在Actorや運用世代を参照しない。 */
export const ids = {
  /** 合成Identity参照。 */
  identity: '00000000-0000-4000-8000-000000000001',
  /** 合成本人性。 */
  actor: '00000000-0000-4000-8000-000000000002',
  /** 合成Restore世代。 */
  epoch: '00000000-0000-4000-8000-000000000003',
  /** 合成Login Attempt参照。 */
  attempt: '00000000-0000-4000-8000-000000000004',
  /** 合成Session参照。 */
  session: '00000000-0000-4000-8000-000000000005',
  /** 差替え拒否を検証する別参照。 */
  other: '00000000-0000-4000-8000-000000000006',
};
/** 公開用の既知合成32-byte値。本番秘密値ではない。 */
export const secret = Buffer.alloc(32, 7).toString('base64url');
/** 秘密値間の独立性を確認する別の既知合成値。 */
export const csrf = Buffer.alloc(32, 8).toString('base64url');
/** 同じ契約を3kindすべてへ適用する公開合成Case。 */
export const cases: {
  /** 暗号へ束縛する合成Metadata。 */
  row: AuthenticationRow;
  /** kindに必要な最小秘密項目の合成値。 */
  secrets: AuthenticationSecrets;
}[] = [
  {
    row: {
      recordKind: 'google-identity',
      identityId: ids.identity,
      actorId: ids.actor,
      version: 1,
    },
    secrets: {
      issuer: 'https://accounts.google.com',
      subject: 'Synthetic-Subject-é',
    },
  },
  {
    row: {
      recordKind: 'login-attempt',
      attemptId: ids.attempt,
      version: 1,
      epoch: ids.epoch,
      createdAt: 0,
      expiresAt: 300_000,
      state: 'ready',
      terminalAt: null,
      cookieDigestKeyVersion: 'digest-1',
      cookieDigest: new Uint8Array(32).fill(9),
    },
    secrets: { nonce: secret, csrf },
  },
  {
    row: {
      recordKind: 'session',
      sessionId: ids.session,
      actorId: ids.actor,
      version: 1,
      epoch: ids.epoch,
      createdAt: 0,
      absoluteExpiresAt: 604_800_000,
      idleExpiresAt: 86_400_000,
      state: 'active',
      terminalAt: null,
      cookieDigestKeyVersion: 'digest-1',
      cookieDigest: new Uint8Array(32).fill(10),
    },
    secrets: { csrf },
  },
];

type State = {
  key: ReturnType<typeof importAuthenticationDataKey>;
  count: bigint;
  mode: 'current' | 'read-only' | 'destroyed';
  regressed: boolean;
  lost: boolean;
};
/**
 * Provider instance外の合成Registry。外側rollback／再生成でも割当を戻さない。
 * 実際の耐障害永続性や独立Failure domainを証明するFakeではない。
 */
export class SyntheticKeyRegistry {
  private readonly keys = new Map<string, Map<string, State>>();
  private readonly current = new Map<string, string>();
  private sequence = 0;
  /** Providerが受けた固定Rotation要求を検証する履歴。 */
  rotations: {
    /** 故障注入した合成Scope。 */
    scope: AuthenticationKeyScope;
    /** 要求対象の合成鍵世代。 */
    keyVersion: string;
    /** 要求理由の固定分類。 */
    reason: string;
  }[] = [];
  private namespace(scope: AuthenticationKeyScope): string {
    return `${scope.recordKind}/${scope.keyScopeId}`;
  }
  /**
   * 境界Testのため初期化または故障注入するStateを得る。
   * @param scope 合成kindと所有ID。
   * @returns Testだけが変更できるCounter／鍵状態。
   */
  state(scope: AuthenticationKeyScope): State {
    const namespace = this.namespace(scope);
    if (!this.current.has(namespace)) this.rotate(scope);
    return this.keys.get(namespace)!.get(this.current.get(namespace)!)!;
  }
  /**
   * 合成の独立新鍵を発行し、旧鍵を読取専用にする。
   * @param scope 切替対象の合成所有範囲。
   */
  rotate(scope: AuthenticationKeyScope): void {
    const namespace = this.namespace(scope);
    const all = this.keys.get(namespace) ?? new Map<string, State>();
    for (const state of all.values())
      if (state.mode === 'current') state.mode = 'read-only';
    const version = `key-${all.size + 1}`;
    all.set(version, {
      key: importAuthenticationDataKey(
        new Uint8Array(32).fill(++this.sequence),
      ),
      count: 0n,
      mode: 'current',
      regressed: false,
      lost: false,
    });
    this.keys.set(namespace, all);
    this.current.set(namespace, version);
  }
  /**
   * 同じ合成Registryを共有する別Provider instanceを作る。
   * @returns Nonce burnと鍵Scopeを検証するTest-only Port。
   */
  provider(): AuthenticationDataKeyPort {
    return {
      allocateForSeal: async (scope): Promise<AuthenticationSealAllocation> => {
        await Promise.resolve();
        const state = this.state(scope);
        const keyVersion = this.current.get(this.namespace(scope))!;
        if (state.regressed) {
          state.mode = 'read-only';
          return { status: 'counter-regressed', keyVersion };
        }
        if (state.lost) {
          state.mode = 'read-only';
          return { status: 'key-lost', keyVersion };
        }
        if (state.mode !== 'current')
          return { status: 'seal-disabled', keyVersion };
        const count = ++state.count;
        const nonce = Buffer.alloc(12);
        nonce.writeBigUInt64BE(count, 4);
        return {
          status: 'allocated',
          scope: { ...scope },
          lifecycle: 'current',
          key: state.key,
          keyVersion,
          nonce,
          sealCount: count,
        };
      },
      readKey: async ({
        scope,
        keyVersion,
      }): Promise<AuthenticationReadKeyResult> => {
        await Promise.resolve();
        const state = this.keys.get(this.namespace(scope))?.get(keyVersion);
        if (state === undefined || state.mode === 'destroyed' || state.lost)
          return { status: 'unavailable' };
        return {
          status: 'available',
          scope: { ...scope },
          keyVersion,
          lifecycle: state.mode,
          key: state.key,
        };
      },
      requestRotation: async (input): Promise<void> => {
        await Promise.resolve();
        this.rotations.push({ ...input, scope: { ...input.scope } });
        if (input.reason !== 'seal-threshold') {
          const state = this.keys
            .get(this.namespace(input.scope))
            ?.get(input.keyVersion);
          if (state?.mode === 'current') state.mode = 'read-only';
        }
      },
    };
  }
}
