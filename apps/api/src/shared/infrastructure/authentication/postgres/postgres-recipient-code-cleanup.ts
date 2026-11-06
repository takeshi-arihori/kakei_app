import type { RecipientCodeCleanupDatabase } from '../../../application/authentication/recipient-code-cleanup-service.js';
import type { RecipientCodeCrypto } from '../../../application/authentication/recipient-code-crypto-ports.js';
import type { RecipientCodeKeyScope } from '../../../application/authentication/recipient-code-maintenance-ports.js';
import { RecipientCodeUnavailable } from '../../../application/authentication/recipient-code-record.js';
import { authenticationUuid } from '../canonical-authentication.js';
import { readRecipientCodeMaintenanceKeyState } from './authentication-key-state.js';
import { createAuthenticationTransactionScopes } from './authentication-transaction-scopes.js';
import type { AuthenticationQueryConnection } from './authentication-transaction-scopes.js';
import {
  createAuthenticationTransactions,
  type AuthenticationConnectionPool,
  type AuthenticationTransactionLimits,
} from './authentication-transactions.js';
import { readRecipientCode } from './recipient-code-selection.js';
import { authenticationRecipientCodeColumns } from './authentication-columns.js';

/**
 * R4のLock順で本人Actorを最初からFOR UPDATEし、その後でコード行を読む。
 * 既存の認証清掃のFOR SHAREとSKIP LOCKEDは流用しない。
 * @param connection 所有者のTransaction接続。
 * @param scope Providerが束縛したActorとcodeId。
 * @returns 公開読取世代と、Lock済みのコード行の生の値。行がなければundefined。
 * @throws Error key-state不正、Actor不在、SQL障害。
 */
const lockCode = async (
  connection: AuthenticationQueryConnection,
  scope: RecipientCodeKeyScope,
): Promise<{ codeMac: readonly string[]; stored: unknown }> => {
  const { codeMac } = await readRecipientCodeMaintenanceKeyState(connection);
  const actor = await connection.query(
    'SELECT actor_id FROM authentication.actor WHERE actor_id=$1 FOR UPDATE',
    [authenticationUuid(scope.recipientActorId)],
  );
  if (actor.rows.length !== 1) throw new RecipientCodeUnavailable();
  const code = await connection.query(
    `SELECT ${authenticationRecipientCodeColumns} FROM authentication.recipient_code WHERE code_id=$1 FOR UPDATE`,
    [authenticationUuid(scope.codeId)],
  );
  return { codeMac, stored: code.rows[0] };
};

/**
 * コード清掃のPG境界。Pool全体のqueryやTransaction制御を外へ渡さない。
 * @param options 接続取得能力、コードのRecord MAC検証、Lockと実行の上限。
 * @returns コード清掃Use Caseが使うDB境界。
 */
export const createPostgresRecipientCodeCleanup = (
  options: Readonly<{
    /** 操作ごとに一つの接続を取得する能力。 */
    pool: AuthenticationConnectionPool;
    /** Record MACの検証だけを使う。 */
    crypto: Pick<RecipientCodeCrypto, 'verifyRecord'>;
    /** Actor Lockを無期限に待たない上限。 */
    limits: AuthenticationTransactionLimits;
  }>,
): RecipientCodeCleanupDatabase => {
  const tx = createAuthenticationTransactions(
    options.pool,
    createAuthenticationTransactionScopes(),
  );
  const run = async <T>(
    work: (connection: AuthenticationQueryConnection) => Promise<T>,
  ): Promise<T> => {
    const result = await tx.run(work, options.limits);
    if (result.status !== 'committed') throw new RecipientCodeUnavailable();
    return result.value;
  };
  return {
    verifiedTerminalAt: (scope) =>
      run(async (connection) => {
        const { codeMac, stored } = await lockCode(connection, scope);
        if (stored === undefined) return null;
        try {
          const row = readRecipientCode(stored);
          return codeMac.includes(row.macKeyVersion) &&
            (await options.crypto.verifyRecord(row))
            ? row.terminalAt
            : null;
        } catch {
          // 鍵の喪失や改竄で行を残さない。起算はProviderが保持する期限へ倒す（R5）。
          return null;
        }
      }),
    remove: (scope) =>
      run(async (connection) => {
        await lockCode(connection, scope);
        // 除去できたかはUse Caseがコード専用の0-row照合で確かめる。
        await connection.query(
          'DELETE FROM authentication.recipient_code WHERE code_id=$1',
          [scope.codeId],
        );
      }),
    absent: (codeId) =>
      run(async (connection) => {
        await readRecipientCodeMaintenanceKeyState(connection);
        const found = await connection.query(
          'SELECT 1 FROM authentication.recipient_code WHERE code_id=$1 LIMIT 1',
          [authenticationUuid(codeId)],
        );
        return found.rows.length === 0;
      }),
  };
};
