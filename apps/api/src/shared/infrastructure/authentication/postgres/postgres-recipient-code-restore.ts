import type { AuthenticationDigests } from '../../../application/authentication/authentication-digest-ports.js';
import type { AuthenticationRestoreFence } from '../../../application/authentication/authentication-maintenance-ports.js';
import type { AuthenticationClock } from '../../../application/authentication/authentication-ports.js';
import type { AuthenticationRestoreControl } from '../../../application/authentication/authentication-restore-control.js';
import type { RecipientCodeRestoreDatabase } from '../../../application/authentication/recipient-code-restore-discard.js';
import { RecipientCodeUnavailable } from '../../../application/authentication/recipient-code-record.js';
import { authenticationUuid } from '../canonical-authentication.js';
import { insertAuthenticationAudit } from './authentication-audit.js';
import {
  authenticationDatabaseInteger,
  authenticationDatabaseRow,
} from './authentication-database-values.js';
import { readRecipientCodeRestoreKeyState } from './authentication-key-state.js';
import {
  createAuthenticationTransactionScopes,
  type AuthenticationQueryConnection,
} from './authentication-transaction-scopes.js';
import {
  createAuthenticationTransactions,
  type AuthenticationConnectionPool,
} from './authentication-transactions.js';

const reject = (): never => {
  throw new RecipientCodeUnavailable();
};

/**
 * Restoreだけが使うコード表のPG境界。外部fenceの閉鎖とrestoring状態を毎回確認し、
 * 期限・MACに関係なく行を除去する。通常の清掃・削除・HTTPへ公開しない。
 * @param options 接続取得能力、purge Audit、外部閉鎖の確認、Lock後Clock。
 * @returns Restore専用のコード参加が使うDB境界。
 */
export const createPostgresRecipientCodeRestore = (
  options: Readonly<{
    /** 操作ごとに一つの接続を取得する能力。 */
    pool: AuthenticationConnectionPool;
    /** purge Auditの独立用途Digest。 */
    digests: Pick<
      AuthenticationDigests,
      'auditActor' | 'auditAttempt' | 'auditSession'
    >;
    /** 同runの閉鎖を確認する独立能力。 */
    control: Pick<AuthenticationRestoreControl, 'verifyClosed'>;
    /** purge Auditの時刻。 */
    clock: AuthenticationClock;
  }>,
): RecipientCodeRestoreDatabase => {
  const transactions = createAuthenticationTransactions(
    options.pool,
    createAuthenticationTransactionScopes(),
  );
  const closed = async (fence: AuthenticationRestoreFence) => {
    if (!(await options.control.verifyClosed(fence))) reject();
  };
  /** 外部閉鎖を前後で確認し、key_stateの排他Lock下でrestoringだけを許可する。 */
  const restoring = async <T>(
    fence: AuthenticationRestoreFence,
    work: (
      connection: AuthenticationQueryConnection,
      state: Awaited<ReturnType<typeof readRecipientCodeRestoreKeyState>>,
    ) => Promise<T>,
  ): Promise<T> => {
    await closed(fence);
    const result = await transactions.run(async (connection) => {
      const selected = await connection.query(
        'SELECT status FROM authentication.key_state WHERE state_id=1 FOR UPDATE',
      );
      if (
        selected.rows.length !== 1 ||
        authenticationDatabaseRow(selected.rows[0]).status !== 'restoring'
      )
        return reject();
      const value = await work(
        connection,
        await readRecipientCodeRestoreKeyState(connection),
      );
      await closed(fence);
      return value;
    });
    return result.status === 'committed' ? result.value : reject();
  };
  return {
    rows: async (fence, after, limit) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        return reject();
      const cursor = after === null ? null : authenticationUuid(after);
      return restoring(fence, async (connection) => {
        const found = await connection.query(
          'SELECT code_id,recipient_actor_id FROM authentication.recipient_code ' +
            'WHERE $1::uuid IS NULL OR code_id>$1::uuid ORDER BY code_id LIMIT $2',
          [cursor, limit],
        );
        return Object.freeze(
          found.rows.map((value: unknown) => {
            const row = authenticationDatabaseRow(value);
            return Object.freeze({
              codeId: authenticationUuid(row.code_id),
              recipientActorId: authenticationUuid(row.recipient_actor_id),
            });
          }),
        );
      });
    },
    remove: async (fence, scope) => {
      const codeId = authenticationUuid(scope.codeId);
      const actorId = authenticationUuid(scope.recipientActorId);
      return restoring(fence, async (connection, state) => {
        const found = await connection.query(
          'SELECT recipient_actor_id,record_version FROM authentication.recipient_code WHERE code_id=$1 FOR UPDATE',
          [codeId],
        );
        if (found.rows.length === 0) return;
        const row = authenticationDatabaseRow(found.rows[0]);
        // Providerの束縛と異なるActorの行は、inventoryへ束縛できないので除去せず止める。
        if (authenticationUuid(row.recipient_actor_id) !== actorId) reject();
        const removed = await connection.query(
          'DELETE FROM authentication.recipient_code WHERE code_id=$1 AND record_version=$2',
          [codeId, row.record_version],
        );
        if (removed.rowCount !== 1) reject();
        await insertAuthenticationAudit(connection, options.digests, state, {
          action: 'purge',
          decision: 'allow',
          reason: 'success',
          now: authenticationDatabaseInteger(options.clock.now(), 0),
          subjects: { actorId },
        });
      });
    },
    absent: async (fence, codeId) => {
      const id = authenticationUuid(codeId);
      return restoring(fence, async (connection) => {
        const found = await connection.query(
          'SELECT 1 FROM authentication.recipient_code WHERE code_id=$1 LIMIT 1',
          [id],
        );
        return found.rows.length === 0;
      });
    },
    empty: (fence) =>
      restoring(fence, async (connection) => {
        const found = await connection.query(
          'SELECT 1 FROM authentication.recipient_code LIMIT 1',
        );
        return found.rows.length === 0;
      }),
  };
};
