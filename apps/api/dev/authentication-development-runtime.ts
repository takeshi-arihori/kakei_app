import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { GoogleAuthenticationService } from '../src/shared/application/authentication/google-authentication-service.js';
import {
  createAuthenticationEntropy,
  createAuthenticationHttpSecurity,
} from '../src/shared/infrastructure/authentication/authentication-http-security.js';
import { createAuthenticationDigests } from '../src/shared/infrastructure/authentication/authentication-digests.js';
import { createAuthenticationRecordCodec } from '../src/shared/infrastructure/authentication/authentication-record-codec.js';
import { GoogleIdTokenVerifier } from '../src/shared/infrastructure/authentication/google-id-token-verifier.js';
import { createAuthenticationTransactionScopes } from '../src/shared/infrastructure/authentication/postgres/authentication-transaction-scopes.js';
import { createPostgresAuthenticationStore } from '../src/shared/infrastructure/authentication/postgres/postgres-authentication-store.js';
import { createPostgresAuthenticationHttpRate } from '../src/shared/infrastructure/authentication/postgres/postgres-authentication-http-rate.js';
import {
  createAuthenticationHttp,
  type AuthenticationHttpHandler,
} from '../src/presentation/http/authentication/authentication-http.js';
import { readAuthenticationDevelopmentConfig } from './authentication-development-config.js';
import { createAuthenticationDevelopmentKeys } from './authentication-development-keys.js';

/** 単一process leaseと使い捨て鍵の有効期間を持つ開発専用Runtime。 */
export interface AuthenticationDevelopmentRuntime {
  /** lease喪失後は保存やSDKへ進めず503を返す。 */
  readonly authentication: AuthenticationHttpHandler;
  /** HTTP停止後に呼び、鍵・Timer・lease・Poolを解放する。 */
  close(): Promise<void>;
}

/**
 * 明示準備された空の専用DBを実pg/Google SDKへ接続する。自動resetはしない。
 * @param env 値を診断へ出さない開発設定。
 * @param onLeaseLost 同期的にHTTP受付を止める通知。秘密や例外を渡さない。
 * @returns 起動条件が成立した使い捨てRuntime。
 * @throws 設定、PG17/専用DB、lease、非空状態、初期化障害は固定文言で拒否する。
 */
export const openAuthenticationDevelopmentRuntime = async (
  env: Readonly<Record<string, string | undefined>>,
  onLeaseLost: () => void,
): Promise<AuthenticationDevelopmentRuntime> => {
  const config = readAuthenticationDevelopmentConfig(env);
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 8,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
    application_name: 'kakei-auth-disposable-development',
  });
  pool.on('error', () => {
    /* Poolの待機接続障害は各操作で汎用失敗とする。値を記録しない。 */
  });
  const keys = createAuthenticationDevelopmentKeys();
  let active = false,
    closed = false,
    lost = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let guard: PoolClient | undefined;
  const lose = () => {
    if (lost || closed) return;
    lost = true;
    active = false;
    keys.dispose();
    if (timer) clearInterval(timer);
    if (cleanupTimer) clearInterval(cleanupTimer);
    try {
      onLeaseLost();
    } catch {
      /* 固定通知の失敗でも受付を再開しない。 */
    }
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    active = false;
    keys.dispose();
    if (timer) clearInterval(timer);
    if (cleanupTimer) clearInterval(cleanupTimer);
    guard?.release(true);
    guard = undefined;
    await pool.end();
  };
  try {
    guard = await pool.connect();
    guard.on('error', lose);
    await guard.query("SET application_name='kakei-auth-development-lease'");
    const info = (
      await guard.query<{ name: string; version: string }>(
        "SELECT current_database() AS name,current_setting('server_version_num') AS version",
      )
    ).rows[0];
    if (
      !info ||
      info.name !== new URL(config.databaseUrl).pathname.slice(1) ||
      !info.name.endsWith('_auth_dev') ||
      Number(info.version) < 170000 ||
      Number(info.version) >= 180000
    )
      throw new Error();
    const lease = await guard.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(1801546597,218) AS acquired',
    );
    if (lease.rows[0]?.acquired !== true) throw new Error();
    await guard.query('BEGIN');
    await guard.query(
      'LOCK TABLE authentication.key_state IN ACCESS EXCLUSIVE MODE',
    );
    const state = (
      await guard.query<{
        status: string;
        generation_version: string;
        epoch: string | null;
      }>(
        'SELECT status,generation_version,epoch FROM authentication.key_state WHERE state_id=1 FOR UPDATE',
      )
    ).rows;
    if (
      state.length !== 1 ||
      state[0].status !== 'uninitialized' ||
      state[0].generation_version !== '1' ||
      state[0].epoch !== null
    )
      throw new Error();
    // Metadataも既存Dataである。新しいprocessの鍵で以前の状態を引き継がない。
    for (const table of [
      'actor',
      'google_identity',
      'identity_alias',
      'login_attempt',
      'session_record',
      'audit_event',
      'key_generation',
      'deletion_intent',
    ]) {
      if (
        (await guard.query(`SELECT 1 FROM authentication.${table} LIMIT 1`))
          .rows.length
      )
        throw new Error();
    }
    for (const table of ['rate_policy', 'rate_window']) {
      if (
        (
          await guard.query(
            `SELECT 1 FROM authentication_http.${table} LIMIT 1`,
          )
        ).rows.length
      )
        throw new Error();
    }
    for (const purpose of [
      'google-identity-search',
      'login-attempt-cookie',
      'session-cookie',
      'actor-state-mac',
      'audit-actor',
      'audit-attempt',
      'audit-session',
      'deleted-actor',
    ]) {
      await guard.query(
        'INSERT INTO authentication.key_generation(generation_id,purpose,key_version,epoch,searchable,write_required) VALUES($1,$2,$3,$4,true,true)',
        [
          randomUUID(),
          purpose,
          keys.keyVersion,
          purpose.endsWith('cookie') ? keys.epoch : null,
        ],
      );
    }
    await guard.query(
      "UPDATE authentication.key_state SET status='active',epoch=$1 WHERE state_id=1",
      [keys.epoch],
    );
    await guard.query('COMMIT');
    const rate = createPostgresAuthenticationHttpRate({
      pool,
      key: keys.rateKey,
      keyVersion: keys.keyVersion,
      namespace: 'localhost-disposable-development',
    });
    await rate.initialize();
    const service = new GoogleAuthenticationService(
      new GoogleIdTokenVerifier({ allowedAudiences: [config.googleClientId] }),
      createPostgresAuthenticationStore({
        pool,
        codec: createAuthenticationRecordCodec({ keys: keys.dataKeys }),
        digests: createAuthenticationDigests({ keys: keys.macKeys }),
        scopes: createAuthenticationTransactionScopes(),
      }),
      createAuthenticationEntropy(),
      { now: Date.now },
    );
    const handler = createAuthenticationHttp({
      service,
      rate,
      security: createAuthenticationHttpSecurity(),
      origin: config.origin,
      profile: 'local-development',
      clock: { now: Date.now },
    });
    if (lost) throw new Error();
    active = true;
    let probing = false;
    timer = setInterval(() => {
      if (probing || !active || !guard) return;
      probing = true;
      void guard
        .query('SELECT 1')
        .catch(lose)
        .finally(() => {
          probing = false;
        });
    }, 1000);
    let cleaning = false;
    cleanupTimer = setInterval(() => {
      if (cleaning || !active) return;
      cleaning = true;
      void (async () => {
        let overdue = false;
        for (let batch = 0; batch < 20 && active; batch++) {
          const result = await rate.cleanup(500);
          if (result.status === 'unavailable') {
            console.error('AUTH_HTTP_RATE_CLEANUP_UNAVAILABLE');
            return;
          }
          overdue ||= result.overdue;
          if (result.deleted < 500 || batch === 19) {
            if (overdue) console.error('AUTH_HTTP_RATE_CLEANUP_UNAVAILABLE');
            return;
          }
        }
      })()
        .catch(() => {
          console.error('AUTH_HTTP_RATE_CLEANUP_UNAVAILABLE');
        })
        .finally(() => {
          cleaning = false;
        });
    }, 60_000);
    const unavailable = () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'AUTHENTICATION_UNAVAILABLE',
            requestId: randomUUID(),
          },
        }),
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        },
      );
    return {
      authentication: async (request, peer) => {
        if (!active) return unavailable();
        const response = await handler(request, peer);
        return active ? response : unavailable();
      },
      close,
    };
  } catch {
    await close();
    throw new Error('開発認証を起動できません');
  }
};
