import type {
  AuthenticationQueryConnection,
  AuthenticationTransactionLease,
  AuthenticationTransactionScopes,
} from './authentication-transaction-scopes.js';

/** Storeが所有する接続。結果不明の接続をPoolへ戻さない。 */
export interface AuthenticationOwnedConnection extends AuthenticationQueryConnection {
  /**
   * Outcomeを処理した後にだけ解放する。
   * @param destroy trueならcommit／rollback結果不明の接続を破棄する。
   */
  release(destroy?: boolean): void;
}

/** Pool全体のqueryを公開せず、操作ごとに一つの接続を取得する。 */
export interface AuthenticationConnectionPool {
  /**
   * @returns Transaction全期間の所有権を持つ接続。
   * @throws Poolまたは接続障害。
   */
  connect(): Promise<AuthenticationOwnedConnection>;
}

/** 成功値はdurable commitを確認した場合だけ返す。 */
export type AuthenticationTransactionOutcome<T> =
  | {
      /** 共通commitを確認した。 */
      readonly status: 'committed';
      /** commit済み操作の結果。 */
      readonly value: T;
    }
  | {
      /** Alias Unique敗者で、全rollbackが確認できた場合だけ。 */
      readonly status: 'identity-conflict';
    }
  | {
      /** 結果不明を含む。秘密値・Callback値・SQL詳細を返さない。 */
      readonly status: 'unavailable';
    };

/** Store専用Transaction境界。Callbackを自動再実行しない。 */
export interface AuthenticationTransactions {
  /**
   * 同じ接続・leaseで操作を実行し、成功commit後にだけ値を返す。
   * @param operation Store所有のSQL・Scope処理。leaseの参加能力だけを外へ渡す。
   * @returns 共通commit済み結果、確認済みAlias競合、または結果不明を含む障害。
   */
  run<T>(
    operation: (
      connection: AuthenticationQueryConnection,
      lease: AuthenticationTransactionLease,
    ) => Promise<T>,
  ): Promise<AuthenticationTransactionOutcome<T>>;
}

const isAliasConflict = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  const constraint: unknown = Object.getOwnPropertyDescriptor(
    error,
    'constraint',
  )?.value;
  return (
    code === '23505' &&
    (constraint === 'identity_alias_pkey' ||
      constraint === 'identity_alias_identity_id_digest_key_version_key')
  );
};

/**
 * READ COMMITTEDとScopeのOutcomeを一箇所で管理する。commit送信後はrollback済みと推測しない。
 * @param pool queryを持たない接続取得能力。
 * @param scopes Store所有のScope registry。
 * @returns 自動再試行を行わないTransaction境界。
 */
export const createAuthenticationTransactions = (
  pool: AuthenticationConnectionPool,
  scopes: AuthenticationTransactionScopes,
): AuthenticationTransactions => ({
  async run<T>(
    operation: (
      connection: AuthenticationQueryConnection,
      lease: AuthenticationTransactionLease,
    ) => Promise<T>,
  ): Promise<AuthenticationTransactionOutcome<T>> {
    let connection: AuthenticationOwnedConnection;
    try {
      connection = await pool.connect();
    } catch {
      return { status: 'unavailable' };
    }
    const lease = scopes.open(connection);
    let began = false;
    let commitSent = false;
    let destroy = false;
    try {
      await connection.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      began = true;
      const value = await operation(connection, lease);
      lease.seal();
      lease.assertCommittable();
      commitSent = true;
      await connection.query('COMMIT');
      return { status: 'committed', value };
    } catch (error) {
      lease.seal();
      await lease.drain();
      if (commitSent || !began) {
        destroy = true;
        return { status: 'unavailable' };
      }
      try {
        await connection.query('ROLLBACK');
      } catch {
        destroy = true;
        return { status: 'unavailable' };
      }
      return {
        status: isAliasConflict(error) ? 'identity-conflict' : 'unavailable',
      };
    } finally {
      lease.close();
      connection.release(destroy);
    }
  },
});
