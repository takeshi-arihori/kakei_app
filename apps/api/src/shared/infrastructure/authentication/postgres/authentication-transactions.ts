import type {
  AuthenticationQueryConnection,
  AuthenticationTransactionLease,
  AuthenticationTransactionScopes,
} from './authentication-transaction-scopes.js';

/** Storeが所有する接続。結果不明の接続をPoolへ戻さない。 */
export interface AuthenticationOwnedConnection extends AuthenticationQueryConnection {
  /**
   * queryがない間のPG切断も所有者へ通知する。Eventを持つAdapterは両Methodを転送する。
   * @param event 接続失敗だけを監視する固定名。
   * @param listener 原因を公開せず全leaseを中断する処理。
   * @returns Driver固有の登録結果。所有者は内容を利用しない。
   */
  on?(event: 'error', listener: (error: unknown) => void): unknown;
  /**
   * 正常返却する接続から所有者の監視だけを外す。
   * @param event 固定errorイベント。
   * @param listener この所有者が登録した同一処理。
   * @returns Driver固有の解除結果。接続解放はreleaseだけが行う。
   */
  removeListener?(event: 'error', listener: (error: unknown) => void): unknown;
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
   * @param limits 専用leaseの正の上限と任意cancel。省略時は既存通常Storeの動作を維持する。
   * @returns 共通commit済み結果、確認済みAlias競合、または結果不明を含む障害。
   */
  run<T>(
    operation: (
      connection: AuthenticationQueryConnection,
      lease: AuthenticationTransactionLease,
    ) => Promise<T>,
    limits?: AuthenticationTransactionLimits,
  ): Promise<AuthenticationTransactionOutcome<T>>;
}

/** 専用leaseの上限。通常Storeへ暗黙の運用値を設定しない。 */
export interface AuthenticationTransactionLimits {
  /** 正のmilliseconds。Lock待機をDB側で打ち切る。 */ readonly lockTimeoutMs: number;
  /** 正のmilliseconds。各SQLをDB側で打ち切る。 */ readonly statementTimeoutMs: number;
  /** 正のmilliseconds。DB TransactionとCallbackの受付を同時に打ち切る。 */ readonly transactionTimeoutMs: number;
  /** 任意の呼出し中断。中断後はcallbackの後続SQLを受け付けない。 */ readonly signal?: AbortSignal;
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
    limits?: AuthenticationTransactionLimits,
  ): Promise<AuthenticationTransactionOutcome<T>> {
    if (
      limits &&
      ([
        limits.lockTimeoutMs,
        limits.statementTimeoutMs,
        limits.transactionTimeoutMs,
      ].some(
        (value) =>
          !Number.isSafeInteger(value) || value < 1 || value > 2147483647,
      ) ||
        limits.signal?.aborted)
    )
      return { status: 'unavailable' };
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
    let accepting = true;
    let interrupted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interrupt!: () => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      interrupt = () => {
        interrupted = true;
        accepting = false;
        reject(new Error('authentication-transaction-interrupted'));
      };
    });
    // raceの開始前にabortされても未処理Rejectを生成しない。
    void cancellation.catch(() => {});
    // pgのtransaction_timeoutはquery待機がなくてもerror Eventを送る。原因は保存/公開しない。
    const connectionFailed = () => interrupt();
    connection.on?.('error', connectionFailed);
    if (limits) {
      timer = setTimeout(interrupt, limits.transactionTimeoutMs);
      limits.signal?.addEventListener('abort', interrupt, { once: true });
      if (limits.signal?.aborted) interrupt();
    }
    const borrowed: AuthenticationQueryConnection = {
      query(sql, values) {
        if (!accepting)
          return Promise.reject(
            new Error('authentication-transaction-unavailable'),
          );
        return connection.query(sql, values);
      },
    };
    try {
      if (interrupted)
        throw new Error('authentication-transaction-interrupted');
      await Promise.race([
        connection.query('BEGIN ISOLATION LEVEL READ COMMITTED'),
        cancellation,
      ]);
      began = true;
      if (limits)
        await Promise.race([
          borrowed.query(
            "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true), set_config('transaction_timeout', $3, true)",
            [
              String(limits.lockTimeoutMs),
              String(limits.statementTimeoutMs),
              String(limits.transactionTimeoutMs),
            ],
          ),
          cancellation,
        ]);
      const value = await Promise.race([
        operation(borrowed, lease),
        cancellation,
      ]);
      lease.seal();
      lease.assertCommittable();
      if (interrupted || limits?.signal?.aborted)
        throw new Error('authentication-transaction-interrupted');
      commitSent = true;
      await Promise.race([connection.query('COMMIT'), cancellation]);
      return { status: 'committed', value };
    } catch (error) {
      lease.seal();
      // cancel/期限でCallbackが帰らなくても接続破棄によりPG側で全Transactionをabortする。
      if (interrupted) {
        destroy = true;
        return { status: 'unavailable' };
      }
      try {
        await Promise.race([lease.drain(), cancellation]);
      } catch {
        destroy = true;
        return { status: 'unavailable' };
      }
      if (commitSent || !began) {
        destroy = true;
        return { status: 'unavailable' };
      }
      try {
        await Promise.race([connection.query('ROLLBACK'), cancellation]);
      } catch {
        destroy = true;
        return { status: 'unavailable' };
      }
      return {
        status: isAliasConflict(error) ? 'identity-conflict' : 'unavailable',
      };
    } finally {
      accepting = false;
      clearTimeout(timer);
      limits?.signal?.removeEventListener('abort', interrupt);
      lease.close();
      // 破棄中のsocket errorも吸収するため、破棄接続では閉鎖まで監視を残す。
      if (!destroy) connection.removeListener?.('error', connectionFailed);
      connection.release(destroy);
    }
  },
});
