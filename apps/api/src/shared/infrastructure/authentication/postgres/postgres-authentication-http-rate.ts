import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type {
  AuthenticationHttpOperation,
  AuthenticationHttpRate,
  AuthenticationHttpRateDecision,
} from '../../../application/authentication/authentication-http-ports.js';
import {
  authenticationDatabaseInteger,
  authenticationDatabaseRow,
} from './authentication-database-values.js';
import {
  createAuthenticationTransactionScopes,
  type AuthenticationQueryConnection,
} from './authentication-transaction-scopes.js';
import {
  createAuthenticationTransactions,
  type AuthenticationConnectionPool,
} from './authentication-transactions.js';

const limits: Record<AuthenticationHttpOperation, readonly [number, number]> = {
  attempt: [10, 120],
  login: [20, 300],
  session: [120, 600],
  logout: [30, 300],
};
const timeSql =
  'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms';
const failure = (): never => {
  throw new Error('認証Rate能力を利用できません');
};
const canonicalPeer = (value: string): string => {
  if (typeof value !== 'string') return failure();
  const peer =
    value.startsWith('::ffff:') && isIP(value.slice(7)) === 4
      ? value.slice(7)
      : value;
  const kind = isIP(peer);
  if (!kind) return failure();
  return kind === 6 ? new URL(`http://[${peer}]/`).hostname.slice(1, -1) : peer;
};

/** Rate期限行の小Batch清掃結果。認証Recordの削除証跡とは別の技術状態。 */
export type AuthenticationHttpRateCleanup =
  | Readonly<{
      /** commit済みの期限行削除。 */ status: 'cleaned';
      /** 実際に削除した行数。 */ deleted: number;
      /** 24h以上遅れた行が残る場合はtrue。 */ overdue: boolean;
    }>
  | Readonly<{ /** 結果不明も含め成功を主張しない。 */ status: 'unavailable' }>;
/** Composition/保守だけが初期化・清掃を行う。HTTP Callerへはreserveのみを渡す。 */
export interface PostgresAuthenticationHttpRate extends AuthenticationHttpRate {
  /**
   * 共有Policyを明示初期化する。既存予算と鍵/Namespaceを上書きしない。
   * @throws DB/鍵/Policy不一致、commit結果不明。
   */
  initialize(): Promise<void>;
  /**
   * 現Windowの予算を戻さず期限行だけを削除する。
   * @param limit 正の小Batch、最大1000。
   * @returns commit済み件数とoverdue、または障害。
   */
  cleanup(limit: number): Promise<AuthenticationHttpRateCleanup>;
}
/**
 * 専用HMAC・DB時刻・同一Transactionで全instanceのHTTP予算を共有する。
 * @param options Compositionが固定した接続/用途別鍵/公開namespace。
 * @returns HTTP予約能力と、HTTPへ公開しない初期化/保守能力。
 * @throws 不正な鍵/世代/namespace設定。
 */
export const createPostgresAuthenticationHttpRate = (
  options: Readonly<{
    /** Transaction全期間で一つの接続を所有する。 */ pool: AuthenticationConnectionPool;
    /** 他用途と共有しない独立256-bit鍵。DBに保存しない。 */ key: Uint8Array;
    /** 全instanceで一致する共有Rate鍵の世代。 */ keyVersion: string;
    /** 独立Deployment間で予算を混同しない公開識別子。 */ namespace: string;
  }>,
): PostgresAuthenticationHttpRate => {
  if (
    !(options.key instanceof Uint8Array) ||
    options.key.length !== 32 ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(options.keyVersion) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(options.namespace)
  )
    return failure();
  const key = Buffer.from(options.key);
  const namespace = options.namespace,
    keyVersion = options.keyVersion;
  const digest = (parts: readonly (string | number)[]) =>
    createHmac('sha256', key)
      .update(
        JSON.stringify(['auth-http-rate-subject/v1', namespace, ...parts]),
      )
      .digest();
  const check = digest(['policy', keyVersion, 1, JSON.stringify(limits)]);
  const transactions = createAuthenticationTransactions(
    options.pool,
    createAuthenticationTransactionScopes(),
  );
  const policy = async (
    connection: AuthenticationQueryConnection,
    lock: 'FOR SHARE' | 'FOR UPDATE',
  ) => {
    const rows = (
      await connection.query(
        'SELECT * FROM authentication_http.rate_policy WHERE state_id=1 ' +
          lock,
      )
    ).rows;
    if (rows.length !== 1) return failure();
    const row = authenticationDatabaseRow(rows[0]);
    if (
      row.state_id !== 1 ||
      row.policy_version !== 1 ||
      row.deployment_namespace !== namespace ||
      row.key_version !== keyVersion ||
      !(row.key_check instanceof Uint8Array) ||
      row.key_check.length !== 32 ||
      !timingSafeEqual(check, row.key_check)
    )
      return failure();
  };
  const now = async (connection: AuthenticationQueryConnection) => {
    const rows = (await connection.query(timeSql)).rows;
    if (rows.length !== 1) return failure();
    const value = authenticationDatabaseInteger(
      authenticationDatabaseRow(rows[0]).now_ms,
      0,
    );
    if (value > Number.MAX_SAFE_INTEGER - 60_000) return failure();
    return value;
  };
  return {
    async initialize() {
      const outcome = await transactions.run(async (connection) => {
        await connection.query(
          'INSERT INTO authentication_http.rate_policy(state_id,policy_version,deployment_namespace,key_version,key_check) VALUES(1,1,$1,$2,$3) ON CONFLICT (state_id) DO NOTHING',
          [namespace, keyVersion, check],
        );
        await policy(connection, 'FOR UPDATE');
      });
      if (outcome.status !== 'committed') return failure();
    },
    async reserve(operation, peer) {
      let address: string;
      try {
        if (!Object.hasOwn(limits, operation)) return { status: 'unavailable' };
        address = canonicalPeer(peer);
      } catch {
        return { status: 'unavailable' };
      }
      const outcome = await transactions.run<AuthenticationHttpRateDecision>(
        async (connection) => {
          await policy(connection, 'FOR SHARE');
          const time = await now(connection),
            start = Math.floor(time / 60_000) * 60_000;
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil((start + 60_000 - time) / 1000),
          );
          for (const kind of ['global', 'peer'] as const) {
            const limit = limits[operation][kind === 'peer' ? 0 : 1];
            const subject = digest([
              operation,
              kind,
              kind === 'peer' ? address : 'global',
              start,
            ]);
            const rows = (
              await connection.query(
                'INSERT INTO authentication_http.rate_window(operation,kind,subject_digest,window_start_ms,count,expires_at_ms) VALUES($1,$2,$3,$4,1,$5) ON CONFLICT (operation,kind,subject_digest,window_start_ms) DO UPDATE SET count=LEAST(authentication_http.rate_window.count+1,$6) RETURNING count',
                [operation, kind, subject, start, start + 60_000, limit + 1],
              )
            ).rows;
            if (rows.length !== 1) return failure();
            const count = authenticationDatabaseInteger(
              authenticationDatabaseRow(rows[0]).count,
              1,
            );
            if (count > limit) return { status: 'limited', retryAfterSeconds };
          }
          return { status: 'allowed' };
        },
      );
      return outcome.status === 'committed'
        ? outcome.value
        : { status: 'unavailable' };
    },
    async cleanup(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        return { status: 'unavailable' };
      const outcome = await transactions.run<AuthenticationHttpRateCleanup>(
        async (connection) => {
          await policy(connection, 'FOR SHARE');
          const time = await now(connection);
          const removed = await connection.query(
            'DELETE FROM authentication_http.rate_window WHERE (operation,kind,subject_digest,window_start_ms) IN (SELECT operation,kind,subject_digest,window_start_ms FROM authentication_http.rate_window WHERE expires_at_ms <= $1 ORDER BY expires_at_ms,operation,kind,subject_digest,window_start_ms FOR UPDATE SKIP LOCKED LIMIT $2)',
            [time, limit],
          );
          if (
            removed.rowCount === null ||
            !Number.isSafeInteger(removed.rowCount) ||
            removed.rowCount < 0
          )
            return failure();
          const overdue =
            (
              await connection.query(
                'SELECT 1 FROM authentication_http.rate_window WHERE expires_at_ms + 86400000 <= $1 LIMIT 1',
                [time],
              )
            ).rows.length > 0;
          return { status: 'cleaned', deleted: removed.rowCount, overdue };
        },
      );
      return outcome.status === 'committed'
        ? outcome.value
        : { status: 'unavailable' };
    },
  };
};
