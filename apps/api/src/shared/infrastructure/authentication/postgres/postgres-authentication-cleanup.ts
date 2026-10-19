import { randomUUID } from 'node:crypto';

import type { AuthenticationDigests } from '../../../application/authentication/authentication-digest-ports.js';
import type {
  AuthenticationCleanupCommit,
  AuthenticationCleanupDatabase,
} from '../../../application/authentication/authentication-maintenance-database.js';
import type {
  AuthenticationDestructionTicket,
  AuthenticationKeyDestructionPort,
} from '../../../application/authentication/authentication-maintenance-ports.js';
import type { AuthenticationClock } from '../../../application/authentication/authentication-ports.js';
import {
  AuthenticationCryptoUnavailable,
  type AuthenticationRecordCodec,
} from '../../../application/authentication/authentication-record-protection.js';
import {
  authenticationRetentionState,
  authenticationRetentionWindow,
  type AuthenticationRetentionWindow,
} from '../../../application/authentication/authentication-retention-policy.js';
import { authenticationUuid } from '../canonical-authentication.js';
import { insertAuthenticationAudit } from './authentication-audit.js';
import {
  authenticationDatabaseInteger,
  authenticationDatabaseRow,
} from './authentication-database-values.js';
import { readAuthenticationMaintenanceKeyState } from './authentication-key-state.js';
import {
  authenticationMaintenanceScope,
  prepareAuthenticationDestruction,
} from './authentication-maintenance-values.js';
import {
  readStoredAuthenticationActor,
  readStoredAuthenticationAttempt,
  readStoredAuthenticationSession,
} from './authentication-record-rows.js';
import { createAuthenticationTransactionScopes } from './authentication-transaction-scopes.js';
import {
  createAuthenticationTransactions,
  type AuthenticationConnectionPool,
} from './authentication-transactions.js';

const day = 86_400_000;

/**
 * 認証専用Schemaだけの小Batch清掃。DB除去と外部鍵破棄を混同しない。
 * @param options 同一接続Pool、Codec/Digest、durable鍵管理とClock。
 * @returns DELETE/Audit共通commit、再試行用0-row照合とDB隔離能力。
 */
export const createPostgresAuthenticationCleanup = (
  options: Readonly<{
    /** 他Contextやpool.queryを混ぜない接続取得能力。 */
    pool: AuthenticationConnectionPool;
    /** 信頼前の期限/stateをAEADで検証する能力。 */
    codec: AuthenticationRecordCodec;
    /** Actor状態とpurge Auditの独立用途Digest。 */
    digests: AuthenticationDigests;
    /** 行を消す前に全世代をdurableに追跡するProvider。 */
    keys: AuthenticationKeyDestructionPort;
    /** Lock後の現在時刻を取得する。 */
    clock: AuthenticationClock;
  }>,
): AuthenticationCleanupDatabase => {
  const tx = createAuthenticationTransactions(
    options.pool,
    createAuthenticationTransactionScopes(),
  );
  return {
    async deleteExpired(limit): Promise<AuthenticationCleanupCommit> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        return { status: 'unavailable' };
      const result = await tx.run(
        async (connection): Promise<AuthenticationCleanupCommit> => {
          const state = await readAuthenticationMaintenanceKeyState(connection);
          const hintNow = authenticationDatabaseInteger(options.clock.now(), 0);
          let afterActor: string | null = null;
          let actors = new Set<string>();
          let sessions: ReturnType<typeof readStoredAuthenticationSession>[] =
            [];
          // 空PageのActor Lockはsavepoint rollbackで解放し、次Pageでも順序を保つ。
          for (;;) {
            const candidates = await connection.query(
              'SELECT DISTINCT actor_id FROM authentication.session_record ' +
                'WHERE LEAST(idle_expires_at_ms,absolute_expires_at_ms,terminal_at_ms) <= $1 ' +
                'AND ($2::uuid IS NULL OR actor_id > $2::uuid) ORDER BY actor_id LIMIT $3',
              [hintNow, afterActor, limit],
            );
            const hints = candidates.rows.map((value: unknown) =>
              authenticationUuid(authenticationDatabaseRow(value).actor_id),
            );
            if (hints.length === 0) break;
            afterActor = hints.at(-1)!;
            await connection.query('SAVEPOINT authentication_cleanup_page');
            actors = new Set<string>();
            for (const actorId of hints) {
              const selected = await connection.query(
                'SELECT * FROM authentication.actor WHERE actor_id=$1 FOR SHARE SKIP LOCKED',
                [actorId],
              );
              if (selected.rows.length === 0) continue;
              const actor = readStoredAuthenticationActor(selected.rows[0]);
              if (
                !state.actorRead.includes(actor.keyVersion) ||
                !(await options.digests.verifyActorState({
                  row: actor.row,
                  keyVersion: actor.keyVersion,
                  mac: actor.mac,
                }))
              )
                throw new AuthenticationCryptoUnavailable();
              actors.add(actorId);
            }
            const selectedSessions = await connection.query(
              'SELECT * FROM authentication.session_record WHERE actor_id=ANY($1::uuid[]) ' +
                'AND LEAST(idle_expires_at_ms,absolute_expires_at_ms,terminal_at_ms) <= $2 ' +
                'ORDER BY session_id LIMIT $3 FOR UPDATE SKIP LOCKED',
              [[...actors], hintNow, limit],
            );
            sessions = selectedSessions.rows.map(
              readStoredAuthenticationSession,
            );
            if (sessions.length > 0) {
              await connection.query(
                'RELEASE SAVEPOINT authentication_cleanup_page',
              );
              break;
            }
            await connection.query(
              'ROLLBACK TO SAVEPOINT authentication_cleanup_page',
            );
            await connection.query(
              'RELEASE SAVEPOINT authentication_cleanup_page',
            );
          }
          const selectedAttempts = await connection.query(
            'SELECT * FROM authentication.login_attempt ' +
              'WHERE COALESCE(terminal_at_ms,expires_at_ms) <= $1 ' +
              'ORDER BY attempt_id LIMIT $2 FOR UPDATE SKIP LOCKED',
            [hintNow, limit],
          );
          const attempts = selectedAttempts.rows.map(
            readStoredAuthenticationAttempt,
          );
          const tickets: AuthenticationDestructionTicket[] = [];
          for (const stored of [...sessions, ...attempts]) {
            const row = stored.row;
            if (
              row.epoch !== state.epoch ||
              (row.recordKind === 'session' && !actors.has(row.actorId))
            )
              throw new AuthenticationCryptoUnavailable();
            await options.codec.open(stored);
            const window = authenticationRetentionWindow(row);
            const now = authenticationDatabaseInteger(options.clock.now(), 0);
            if (authenticationRetentionState(window, now) === 'retained')
              continue;
            const id =
              row.recordKind === 'session' ? row.sessionId : row.attemptId;
            const ticket = await prepareAuthenticationDestruction(
              options.keys,
              randomUUID(),
              [
                {
                  recordKind: row.recordKind,
                  keyScopeId: id,
                },
              ],
              window,
            );
            const table =
              row.recordKind === 'session' ? 'session_record' : 'login_attempt';
            const column =
              row.recordKind === 'session' ? 'session_id' : 'attempt_id';
            const removed = await connection.query(
              'DELETE FROM authentication.' +
                table +
                ' WHERE ' +
                column +
                '=$1 AND version=$2',
              [id, row.version],
            );
            if (removed.rowCount !== 1)
              throw new AuthenticationCryptoUnavailable();
            await insertAuthenticationAudit(
              connection,
              options.digests,
              state,
              {
                action: 'purge',
                decision: 'allow',
                reason: 'success',
                now,
                subjects:
                  row.recordKind === 'session'
                    ? { actorId: row.actorId, sessionId: row.sessionId }
                    : { attemptId: row.attemptId },
              },
            );
            tickets.push(ticket);
          }
          const auditNow = authenticationDatabaseInteger(
            options.clock.now(),
            0,
          );
          const auditRows = await connection.query(
            'SELECT event_id,occurred_at_ms FROM authentication.audit_event ' +
              'WHERE occurred_at_ms <= $1 ORDER BY event_id LIMIT $2 FOR UPDATE SKIP LOCKED',
            [auditNow - 90 * day, limit],
          );
          let auditCount = 0;
          for (const value of auditRows.rows as unknown[]) {
            const r = authenticationDatabaseRow(value);
            const occurredAt = authenticationDatabaseInteger(
              r.occurred_at_ms,
              0,
            );
            const now = authenticationDatabaseInteger(options.clock.now(), 0);
            if (
              authenticationRetentionState(
                authenticationRetentionWindow({
                  recordKind: 'audit-event',
                  occurredAt,
                }),
                now,
              ) === 'retained'
            )
              continue;
            const removed = await connection.query(
              'DELETE FROM authentication.audit_event WHERE event_id=$1 AND occurred_at_ms=$2',
              [authenticationUuid(r.event_id), occurredAt],
            );
            if (removed.rowCount !== 1)
              throw new AuthenticationCryptoUnavailable();
            auditCount += 1;
          }
          if (auditCount > 0)
            await insertAuthenticationAudit(
              connection,
              options.digests,
              state,
              {
                action: 'purge',
                decision: 'allow',
                reason: 'success',
                now: authenticationDatabaseInteger(options.clock.now(), 0),
                subjects: {},
              },
            );
          // SKIP LOCKEDしない監視Queryで、取り残した期限行を隠さない。
          const observed = await connection.query(
            'SELECT MIN(due_at) AS due_at FROM (' +
              'SELECT COALESCE(terminal_at_ms,expires_at_ms) AS due_at FROM authentication.login_attempt ' +
              'UNION ALL SELECT LEAST(idle_expires_at_ms,absolute_expires_at_ms,terminal_at_ms) FROM authentication.session_record ' +
              'UNION ALL SELECT occurred_at_ms+' +
              String(90 * day) +
              ' FROM authentication.audit_event ' +
              ') AS deadlines WHERE due_at <= $1',
            [authenticationDatabaseInteger(options.clock.now(), 0)],
          );
          const dueAt = authenticationDatabaseRow(observed.rows[0])?.due_at;
          let oldest: AuthenticationRetentionWindow | null = null;
          if (dueAt !== null && dueAt !== undefined) {
            const time = authenticationDatabaseInteger(dueAt, 0);
            oldest = Object.freeze({
              dueAt: time,
              deadline: authenticationDatabaseInteger(time + day, 0),
            });
          }
          return { status: 'committed', tickets, auditCount, oldest };
        },
      );
      return result.status === 'committed'
        ? result.value
        : { status: 'unavailable' };
    },
    async absent(inputScopes) {
      const scopes = inputScopes.map(authenticationMaintenanceScope);
      const result = await tx.run(async (connection) => {
        const state = await connection.query(
          'SELECT state_id,status,epoch FROM authentication.key_state WHERE state_id=1 FOR SHARE',
        );
        if (
          state.rows.length !== 1 ||
          authenticationDatabaseRow(state.rows[0]).status === 'uninitialized'
        )
          throw new AuthenticationCryptoUnavailable();
        authenticationUuid(authenticationDatabaseRow(state.rows[0]).epoch);
        for (const scope of scopes) {
          const target =
            scope.recordKind === 'google-identity'
              ? ['google_identity', 'actor_id']
              : scope.recordKind === 'session'
                ? ['session_record', 'session_id']
                : ['login_attempt', 'attempt_id'];
          const found = await connection.query(
            'SELECT 1 FROM authentication.' +
              target[0] +
              ' WHERE ' +
              target[1] +
              '=$1 LIMIT 1',
            [scope.keyScopeId],
          );
          if (found.rows.length > 0) return false;
        }
        return true;
      });
      if (result.status !== 'committed')
        throw new AuthenticationCryptoUnavailable();
      return result.value;
    },
    async quarantine() {
      const result = await tx.run(async (connection) => {
        const rows = await connection.query(
          'SELECT status,generation_version FROM authentication.key_state WHERE state_id=1 FOR UPDATE',
        );
        if (
          rows.rows.length !== 1 ||
          authenticationDatabaseRow(rows.rows[0]).status === 'uninitialized'
        )
          return false;
        if (
          authenticationDatabaseRow(rows.rows[0]).status === 'quarantined' ||
          authenticationDatabaseRow(rows.rows[0]).status === 'restoring'
        )
          return true;
        const version = authenticationDatabaseInteger(
          authenticationDatabaseRow(rows.rows[0]).generation_version,
          1,
        );
        const next = authenticationDatabaseInteger(version + 1, 1);
        const changed = await connection.query(
          "UPDATE authentication.key_state SET status='quarantined',generation_version=$1 WHERE state_id=1 AND generation_version=$2",
          [next, version],
        );
        return changed.rowCount === 1;
      });
      return result.status === 'committed' && result.value;
    },
  };
};
