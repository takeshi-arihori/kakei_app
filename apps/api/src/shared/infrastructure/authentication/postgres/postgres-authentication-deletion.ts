import type { AuthenticationKeyScope } from '../../../application/authentication/authentication-crypto-keys.js';
import type { AuthenticationDigests } from '../../../application/authentication/authentication-digest-ports.js';
import type { AuthenticationDeletionDatabase } from '../../../application/authentication/authentication-maintenance-database.js';
import type {
  AuthenticationDeletionRecord,
  AuthenticationKeyDestructionPort,
  AuthenticationLedgerEvidence,
} from '../../../application/authentication/authentication-maintenance-ports.js';
import type { AuthenticationClock } from '../../../application/authentication/authentication-ports.js';
import {
  AuthenticationCryptoUnavailable,
  type AuthenticationRecordCodec,
} from '../../../application/authentication/authentication-record-protection.js';
import {
  authenticationKeyVersion,
  authenticationUuid,
} from '../canonical-authentication.js';
import { authenticationBytesEqual } from '../authentication-digests.js';
import { insertAuthenticationAudit } from './authentication-audit.js';
import {
  assertAuthenticationDeletionIntent,
  ensureAuthenticationDeletionIntent,
  resolveAuthenticationDeletionTarget,
} from './authentication-deletion-intents.js';
import {
  authenticationDatabaseInteger,
  authenticationDatabaseRow,
} from './authentication-database-values.js';
import {
  readAuthenticationMaintenanceKeyState,
  type AuthenticationStoreKeyState,
} from './authentication-key-state.js';
import { prepareAuthenticationDestruction } from './authentication-maintenance-values.js';
import {
  readStoredAuthenticationActor,
  readStoredAuthenticationIdentity,
  readStoredAuthenticationSession,
  updateAuthenticationRecord,
} from './authentication-record-rows.js';
import {
  createAuthenticationTransactionScopes,
  type AuthenticationQueryConnection,
} from './authentication-transaction-scopes.js';
import {
  createAuthenticationTransactions,
  type AuthenticationConnectionPool,
} from './authentication-transactions.js';

const fail = (): never => {
  throw new AuthenticationCryptoUnavailable();
};

/**
 * Ledgerの不可逆意思へDB無効化と物理除去を束縛する。GroupへCascadeしない。
 * @param options 認証Pool/Codec/Digestと、同じ外部証跡検証器/鍵管理。
 * @returns Actor終端・全Session失効・Intent/Audit共通commitと後続CAS。
 */
export const createPostgresAuthenticationDeletion = (
  options: Readonly<{
    /** 同一Transaction接続だけを取得する能力。 */
    pool: AuthenticationConnectionPool;
    /** Sessionの失効版再Sealと行束縛検証。 */
    codec: AuthenticationRecordCodec;
    /** Actor MAC・独立削除照合・AuditのHMAC。 */
    digests: AuthenticationDigests;
    /** DB除去後にも全scopeを再発見する外部Registry。 */
    keys: AuthenticationKeyDestructionPort;
    /** 最新証跡とopaque intentの唯一の所有registry。 */
    ledger: AuthenticationLedgerEvidence;
    /** Lock後のUTC判断点。 */
    clock: AuthenticationClock;
  }>,
): AuthenticationDeletionDatabase => {
  const transactions = createAuthenticationTransactions(
    options.pool,
    createAuthenticationTransactionScopes(),
  );
  const run = async <T>(
    operation: (
      connection: AuthenticationQueryConnection,
      state: AuthenticationStoreKeyState,
    ) => Promise<T>,
  ): Promise<T> => {
    const result = await transactions.run(async (connection) =>
      operation(
        connection,
        await readAuthenticationMaintenanceKeyState(connection),
      ),
    );
    return result.status === 'committed' ? result.value : fail();
  };
  const binding = (record: AuthenticationDeletionRecord) =>
    resolveAuthenticationDeletionTarget(options.keys, options.digests, record);
  const actor = async (
    connection: AuthenticationQueryConnection,
    state: AuthenticationStoreKeyState,
    actorId: string,
  ) => {
    const found = await connection.query(
      'SELECT * FROM authentication.actor WHERE actor_id=$1 FOR UPDATE',
      [actorId],
    );
    if (found.rows.length !== 1) return fail();
    const stored = readStoredAuthenticationActor(
      authenticationDatabaseRow(found.rows[0]),
    );
    if (
      !state.actorRead.includes(stored.keyVersion) ||
      !(await options.digests.verifyActorState({
        row: stored.row,
        keyVersion: stored.keyVersion,
        mac: stored.mac,
      }))
    )
      return fail();
    return stored;
  };

  return {
    async plan(inputActorId) {
      const actorId = authenticationUuid(inputActorId);
      return run(async (connection, state) => {
        const selected = await connection.query(
          'SELECT * FROM authentication.actor WHERE actor_id=$1 FOR SHARE',
          [actorId],
        );
        if (selected.rows.length !== 1) return fail();
        const row = readStoredAuthenticationActor(
          authenticationDatabaseRow(selected.rows[0]),
        );
        if (
          row.row.state !== 'active' ||
          !state.actorRead.includes(row.keyVersion) ||
          !(await options.digests.verifyActorState({
            row: row.row,
            keyVersion: row.keyVersion,
            mac: row.mac,
          }))
        )
          return fail();
        const versions = await connection.query(
          "SELECT key_version FROM authentication.key_generation WHERE purpose='deleted-actor' AND epoch IS NULL AND write_required AND searchable AND retired_at_ms IS NULL",
        );
        if (versions.rows.length !== 1) return fail();
        const keyVersion = authenticationKeyVersion(
          authenticationDatabaseRow(versions.rows[0]).key_version,
        );
        const digest = await options.digests.deletedActor({
          subjectId: actorId,
          keyVersion,
        });
        if (digest.keyVersion !== keyVersion) return fail();
        return { keyVersion, digest: Uint8Array.from(digest.bytes) };
      });
    },
    async disable(intent) {
      const record = options.ledger.resolve(intent);
      const target = await binding(record);
      return run(async (connection, state) => {
        const storedActor = await actor(connection, state, target.actorId);
        const selected = await connection.query(
          'SELECT * FROM authentication.session_record WHERE actor_id=$1 ORDER BY session_id FOR UPDATE',
          [target.actorId],
        );
        const sessions = selected.rows.map(readStoredAuthenticationSession);
        const verified = [];
        for (const stored of sessions) {
          if (
            stored.row.epoch !== state.epoch ||
            stored.row.actorId !== target.actorId
          )
            return fail();
          verified.push({ stored, secrets: await options.codec.open(stored) });
        }
        const now = authenticationDatabaseInteger(
          options.clock.now(),
          record.preparedAt,
        );
        if (storedActor.row.state === 'active') {
          const disabled = {
            ...storedActor.row,
            state: 'disabled' as const,
            version: authenticationDatabaseInteger(
              storedActor.row.version + 1,
              1,
            ),
            disabledAt: now,
          };
          const mac = await options.digests.actorState({
            row: disabled,
            keyVersion: state.actorWrite,
          });
          const changed = await connection.query(
            "UPDATE authentication.actor SET state='disabled',version=$1,disabled_at_ms=$2,control_key_version=$3,state_mac=$4 WHERE actor_id=$5 AND version=$6",
            [
              disabled.version,
              now,
              mac.keyVersion,
              Buffer.from(mac.bytes),
              target.actorId,
              storedActor.row.version,
            ],
          );
          if (changed.rowCount !== 1) return fail();
        }
        for (const { stored, secrets } of verified) {
          if (stored.row.state === 'revoked') continue;
          const revoked = {
            ...stored.row,
            state: 'revoked' as const,
            version: authenticationDatabaseInteger(stored.row.version + 1, 1),
            terminalAt: now,
          };
          await updateAuthenticationRecord(
            connection,
            revoked,
            await options.codec.seal({ row: revoked, secrets }),
            stored.row.version,
          );
        }
        const all = new Map<string, AuthenticationKeyScope>();
        for (const scope of [
          ...target.scopes,
          ...sessions.map((stored) => ({
            recordKind: 'session' as const,
            keyScopeId: stored.row.sessionId,
          })),
        ])
          all.set(scope.recordKind + '/' + scope.keyScopeId, scope);
        const ticket = await prepareAuthenticationDestruction(
          options.keys,
          record.operationId,
          [...all.values()],
          {
            dueAt: record.preparedAt,
            deadline: record.preparedAt + 86_400_000,
          },
        );
        if (ticket.reference !== record.targetReference) return fail();
        await ensureAuthenticationDeletionIntent(connection, record, now);
        await insertAuthenticationAudit(connection, options.digests, state, {
          action: 'disable',
          decision: 'allow',
          reason: 'success',
          now,
          subjects: { actorId: target.actorId },
        });
        return Object.freeze({ actorId: target.actorId, ticket });
      });
    },
    async remove(intent, disabled) {
      const record = options.ledger.resolve(intent);
      const target = await binding(record);
      if (
        disabled.actorId !== target.actorId ||
        disabled.ticket.operationId !== record.operationId ||
        disabled.ticket.reference !== target.ticket.reference ||
        disabled.ticket.version !== target.ticket.version ||
        !authenticationBytesEqual(
          disabled.ticket.inventoryDigest,
          target.ticket.inventoryDigest,
        )
      )
        return fail();
      return run(async (connection, state) => {
        const storedActor = await actor(connection, state, target.actorId);
        if (storedActor.row.state !== 'disabled') return fail();
        const selectedSessions = await connection.query(
          'SELECT * FROM authentication.session_record WHERE actor_id=$1 ORDER BY session_id FOR UPDATE',
          [target.actorId],
        );
        const sessions = selectedSessions.rows.map(
          readStoredAuthenticationSession,
        );
        for (const stored of sessions) {
          if (
            stored.row.state !== 'revoked' ||
            !target.scopes.some(
              (scope) =>
                scope.recordKind === 'session' &&
                scope.keyScopeId === stored.row.sessionId,
            )
          )
            return fail();
          await options.codec.open(stored);
        }
        const selectedIdentities = await connection.query(
          'SELECT * FROM authentication.google_identity WHERE actor_id=$1 FOR UPDATE',
          [target.actorId],
        );
        const identities = selectedIdentities.rows.map(
          readStoredAuthenticationIdentity,
        );
        for (const identity of identities) await options.codec.open(identity);
        const now = authenticationDatabaseInteger(
          options.clock.now(),
          record.preparedAt,
        );
        await ensureAuthenticationDeletionIntent(connection, record, now);
        for (const stored of sessions) {
          const removed = await connection.query(
            'DELETE FROM authentication.session_record WHERE session_id=$1 AND actor_id=$2 AND version=$3',
            [stored.row.sessionId, target.actorId, stored.row.version],
          );
          if (removed.rowCount !== 1) return fail();
        }
        for (const identity of identities) {
          await connection.query(
            'DELETE FROM authentication.identity_alias WHERE identity_id=$1',
            [identity.row.identityId],
          );
          const removed = await connection.query(
            'DELETE FROM authentication.google_identity WHERE identity_id=$1 AND actor_id=$2 AND version=$3',
            [identity.row.identityId, target.actorId, identity.row.version],
          );
          if (removed.rowCount !== 1) return fail();
        }
        await insertAuthenticationAudit(connection, options.digests, state, {
          action: 'purge',
          decision: 'allow',
          reason: 'success',
          now,
          subjects: { actorId: target.actorId },
        });
        return true;
      });
    },
    async complete(intent) {
      const record = options.ledger.resolve(intent);
      if (record.state !== 'complete') return fail();
      const target = await binding(record);
      return run(async (connection, state) => {
        const storedActor = await actor(connection, state, target.actorId);
        if (storedActor.row.state !== 'disabled') return fail();
        const present = await connection.query(
          'SELECT 1 FROM authentication.session_record WHERE actor_id=$1 UNION ALL SELECT 1 FROM authentication.google_identity WHERE actor_id=$1 LIMIT 1',
          [target.actorId],
        );
        if (present.rows.length !== 0) return fail();
        const rows = await connection.query(
          'SELECT * FROM authentication.deletion_intent WHERE operation_id=$1 FOR UPDATE',
          [record.operationId],
        );
        if (rows.rows.length !== 1) return fail();
        assertAuthenticationDeletionIntent(
          authenticationDatabaseRow(rows.rows[0]),
          record,
        );
        if (authenticationDatabaseRow(rows.rows[0]).state === 'complete')
          return true;
        const changed = await connection.query(
          "UPDATE authentication.deletion_intent SET state='complete',version=$1,updated_at_ms=$2 WHERE operation_id=$3 AND version=1 AND state='prepared'",
          [
            record.version,
            authenticationDatabaseInteger(
              options.clock.now(),
              record.preparedAt,
            ),
            record.operationId,
          ],
        );
        return changed.rowCount === 1;
      });
    },
    async reconcileIntents(intents) {
      const records = new Map(
        intents.map((intent) => {
          const record = options.ledger.resolve(intent);
          return [record.operationId, record];
        }),
      );
      const result = await transactions.run(async (connection) => {
        const state = await connection.query(
          'SELECT status,epoch FROM authentication.key_state WHERE state_id=1 FOR SHARE',
        );
        if (
          state.rows.length !== 1 ||
          authenticationDatabaseRow(state.rows[0]).status === 'uninitialized'
        )
          return fail();
        authenticationUuid(authenticationDatabaseRow(state.rows[0]).epoch);
        const rows = await connection.query(
          'SELECT * FROM authentication.deletion_intent ORDER BY operation_id',
        );
        try {
          for (const value of rows.rows as unknown[]) {
            const row = authenticationDatabaseRow(value);
            const record = records.get(authenticationUuid(row.operation_id));
            if (record === undefined) return false;
            assertAuthenticationDeletionIntent(row, record);
          }
        } catch {
          return false;
        }
        return true;
      });
      return result.status === 'committed' ? result.value : fail();
    },
  };
};
