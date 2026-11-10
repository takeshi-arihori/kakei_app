import type { AuthenticationDigests } from '../../../application/authentication/authentication-digest-ports.js';
import type { AuthenticationClock } from '../../../application/authentication/authentication-ports.js';
import type { RecipientCodeDeletionDatabase } from '../../../application/authentication/recipient-code-actor-deletion.js';
import type { RecipientCodeCleanupDatabase } from '../../../application/authentication/recipient-code-cleanup-service.js';
import type { RecipientCodeCrypto } from '../../../application/authentication/recipient-code-crypto-ports.js';
import type { RecipientCodeKeyScope } from '../../../application/authentication/recipient-code-maintenance-ports.js';
import { RecipientCodeUnavailable } from '../../../application/authentication/recipient-code-record.js';
import { authenticationUuid } from '../canonical-authentication.js';
import { insertAuthenticationAudit } from './authentication-audit.js';
import {
  authenticationDatabaseInteger,
  authenticationDatabaseRow,
} from './authentication-database-values.js';
import {
  quarantineAuthenticationKeyState,
  readRecipientCodeMaintenanceKeyState,
} from './authentication-key-state.js';
import { readStoredAuthenticationActor } from './authentication-record-rows.js';
import { createAuthenticationTransactionScopes } from './authentication-transaction-scopes.js';
import type { AuthenticationQueryConnection } from './authentication-transaction-scopes.js';
import {
  createAuthenticationTransactions,
  type AuthenticationConnectionPool,
  type AuthenticationTransactionLimits,
} from './authentication-transactions.js';
import { readRecipientCode } from './recipient-code-selection.js';
import {
  authenticationActorColumns,
  authenticationRecipientCodeColumns,
} from './authentication-columns.js';

type Integrity = 'valid' | 'mismatch' | 'unverifiable';

type MaintenanceState = Awaited<
  ReturnType<typeof readRecipientCodeMaintenanceKeyState>
>;

const worse = (a: Integrity, b: Integrity): Integrity => {
  if (a === 'mismatch' || b === 'mismatch') return 'mismatch';
  return a === 'unverifiable' || b === 'unverifiable'
    ? 'unverifiable'
    : 'valid';
};

/**
 * R4のLock順で本人Actorを最初からFOR UPDATEする。既存の認証清掃のFOR SHAREは流用しない。
 * @param connection 所有者のTransaction接続。
 * @param scope Providerが束縛したActorとcodeId。
 * @returns 公開読取世代と、Lock済みのActor行の生の値。
 * @throws Error key-state不正、Actor不在、SQL障害。
 */
const lockActor = async (
  connection: AuthenticationQueryConnection,
  scope: RecipientCodeKeyScope,
): Promise<{ state: MaintenanceState; actor: unknown }> => {
  const state = await readRecipientCodeMaintenanceKeyState(connection);
  const actor = await connection.query(
    `SELECT ${authenticationActorColumns} FROM authentication.actor WHERE actor_id=$1 FOR UPDATE`,
    [authenticationUuid(scope.recipientActorId)],
  );
  if (actor.rows.length !== 1) throw new RecipientCodeUnavailable();
  return { state, actor: actor.rows[0] };
};

/**
 * Actor Lockの後でコード行をSKIP LOCKEDで取得する。候補を固定してからActorへ戻らない（R4）。
 * @param connection 所有者のTransaction接続。
 * @param codeId 対象のUUIDv4。
 * @returns 行の有無と、別接続がLock中か。
 */
const lockCode = async (
  connection: AuthenticationQueryConnection,
  codeId: string,
): Promise<
  | { status: 'locked-by-other' | 'absent' }
  | { status: 'locked'; stored: unknown }
> => {
  const id = authenticationUuid(codeId);
  const code = await connection.query(
    `SELECT ${authenticationRecipientCodeColumns} FROM authentication.recipient_code WHERE code_id=$1 FOR UPDATE SKIP LOCKED`,
    [id],
  );
  if (code.rows.length === 1) return { status: 'locked', stored: code.rows[0] };
  const exists = await connection.query(
    'SELECT 1 FROM authentication.recipient_code WHERE code_id=$1 LIMIT 1',
    [id],
  );
  return { status: exists.rows.length > 0 ? 'locked-by-other' : 'absent' };
};

/**
 * コード清掃のPG境界。Pool全体のqueryやTransaction制御を外へ渡さない。
 * @param options 接続取得能力、MAC検証、purge Audit、Lock後Clock、Lockと実行の上限。
 * @returns コード清掃とActor削除のUse Caseが使うDB境界。
 */
export const createPostgresRecipientCodeCleanup = (
  options: Readonly<{
    /** 操作ごとに一つの接続を取得する能力。 */
    pool: AuthenticationConnectionPool;
    /** Record MACの照合だけを使う。 */
    crypto: Pick<RecipientCodeCrypto, 'checkRecord'>;
    /** Actor状態MACとpurge Auditの独立用途Digest。 */
    digests: Pick<
      AuthenticationDigests,
      'verifyActorState' | 'auditActor' | 'auditAttempt' | 'auditSession'
    >;
    /** Lock取得後に期限を再検証する。 */
    clock: AuthenticationClock;
    /** Actor Lockを無期限に待たない上限。 */
    limits: AuthenticationTransactionLimits;
  }>,
): RecipientCodeCleanupDatabase & RecipientCodeDeletionDatabase => {
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
  /** 形式不正と確定した不一致はmismatch、鍵障害はunverifiableとし、値を起算へ使わない。 */
  const readActor = async (
    state: MaintenanceState,
    value: unknown,
  ): Promise<{ disabledAt: number | null; integrity: Integrity }> => {
    let actor: ReturnType<typeof readStoredAuthenticationActor>;
    try {
      actor = readStoredAuthenticationActor(authenticationDatabaseRow(value));
    } catch {
      return { disabledAt: null, integrity: 'mismatch' };
    }
    if (!state.actorRead.includes(actor.keyVersion))
      return { disabledAt: null, integrity: 'mismatch' };
    try {
      return (await options.digests.verifyActorState({
        row: actor.row,
        keyVersion: actor.keyVersion,
        mac: actor.mac,
      }))
        ? { disabledAt: actor.row.disabledAt, integrity: 'valid' }
        : { disabledAt: null, integrity: 'mismatch' };
    } catch {
      return { disabledAt: null, integrity: 'unverifiable' };
    }
  };
  const readCode = async (
    state: MaintenanceState,
    value: unknown,
  ): Promise<{ terminalAt: number | null; integrity: Integrity }> => {
    let row: ReturnType<typeof readRecipientCode>;
    try {
      row = readRecipientCode(value);
    } catch {
      return { terminalAt: null, integrity: 'mismatch' };
    }
    if (!state.codeMac.includes(row.macKeyVersion))
      return { terminalAt: null, integrity: 'mismatch' };
    try {
      return (await options.crypto.checkRecord(row)) === 'valid'
        ? { terminalAt: row.terminalAt, integrity: 'valid' }
        : { terminalAt: null, integrity: 'mismatch' };
    } catch {
      return { terminalAt: null, integrity: 'unverifiable' };
    }
  };
  return {
    inspect: (scope) =>
      run(async (connection) => {
        const { state, actor } = await lockActor(connection, scope);
        const { disabledAt, integrity } = await readActor(state, actor);
        const code = await lockCode(connection, scope.codeId);
        if (code.status === 'locked-by-other') return { status: 'locked' };
        const verified =
          code.status === 'locked'
            ? await readCode(state, code.stored)
            : { terminalAt: null, integrity: 'valid' as const };
        return {
          status: 'read',
          disabledAt,
          terminalAt: verified.terminalAt,
          integrity: worse(integrity, verified.integrity),
        };
      }),
    remove: (scope, dueAt) =>
      run(async (connection) => {
        const { state } = await lockActor(connection, scope);
        const code = await lockCode(connection, scope.codeId);
        if (code.status === 'locked-by-other') return 'locked';
        // Lock待機の間に判断が古くならないよう、Lock後のClockで期限を再検証する。
        const now = authenticationDatabaseInteger(options.clock.now(), 0);
        if (now < dueAt) return 'retained';
        if (code.status !== 'locked') return 'removed';
        // 登録済みticketを根拠に、MACを検証できない行も残さない。版だけをCASにする。
        const removed = await connection.query(
          'DELETE FROM authentication.recipient_code WHERE code_id=$1 AND record_version=$2',
          [scope.codeId, authenticationDatabaseRow(code.stored).record_version],
        );
        if (removed.rowCount !== 1) throw new RecipientCodeUnavailable();
        await insertAuthenticationAudit(connection, options.digests, state, {
          action: 'purge',
          decision: 'allow',
          reason: 'success',
          now,
          subjects: { actorId: scope.recipientActorId },
        });
        return 'removed';
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
    actorAbsent: (recipientActorId) =>
      run(async (connection) => {
        await readRecipientCodeMaintenanceKeyState(connection);
        const found = await connection.query(
          'SELECT 1 FROM authentication.recipient_code WHERE recipient_actor_id=$1 LIMIT 1',
          [authenticationUuid(recipientActorId)],
        );
        return found.rows.length === 0;
      }),
    dueHints: (now, limit) =>
      run(async (connection) => {
        await readRecipientCodeMaintenanceKeyState(connection);
        const found = await connection.query(
          'SELECT c.code_id,c.recipient_actor_id,' +
            'LEAST(c.expires_at_ms,c.terminal_at_ms,a.disabled_at_ms) AS due_at ' +
            'FROM authentication.recipient_code c ' +
            'JOIN authentication.actor a ON a.actor_id=c.recipient_actor_id ' +
            'WHERE LEAST(c.expires_at_ms,c.terminal_at_ms,a.disabled_at_ms) <= $1 ' +
            'ORDER BY due_at,c.code_id LIMIT $2',
          [now, limit],
        );
        return found.rows.map((value: unknown) => {
          const row = authenticationDatabaseRow(value);
          return Object.freeze({
            scope: Object.freeze({
              codeId: authenticationUuid(row.code_id),
              recipientActorId: authenticationUuid(row.recipient_actor_id),
            }),
            dueAt: authenticationDatabaseInteger(row.due_at, 0),
          });
        });
      }),
    disabledHints: (actorIds) =>
      run(async (connection) => {
        await readRecipientCodeMaintenanceKeyState(connection);
        const found = await connection.query(
          'SELECT actor_id,disabled_at_ms FROM authentication.actor ' +
            'WHERE disabled_at_ms IS NOT NULL AND actor_id=ANY($1::uuid[])',
          [actorIds.map(authenticationUuid)],
        );
        return new Map(
          found.rows.map((value: unknown) => {
            const row = authenticationDatabaseRow(value);
            return [
              authenticationUuid(row.actor_id),
              authenticationDatabaseInteger(row.disabled_at_ms, 0),
            ] as const;
          }),
        );
      }),
    quarantine: () => run(quarantineAuthenticationKeyState),
  };
};
