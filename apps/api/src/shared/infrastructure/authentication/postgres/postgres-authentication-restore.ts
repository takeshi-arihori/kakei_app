import { randomUUID } from 'node:crypto';

import type { AuthenticationDigests } from '../../../application/authentication/authentication-digest-ports.js';
import type { AuthenticationRestoreDatabase } from '../../../application/authentication/authentication-maintenance-database.js';
import type {
  AuthenticationKeyDestructionPort,
  AuthenticationLedgerEvidence,
  AuthenticationRestoreFence,
} from '../../../application/authentication/authentication-maintenance-ports.js';
import type { AuthenticationClock } from '../../../application/authentication/authentication-ports.js';
import {
  AuthenticationCryptoUnavailable,
  type AuthenticationRecordCodec,
} from '../../../application/authentication/authentication-record-protection.js';
import type {
  AuthenticationRestoreControl,
  AuthenticationRestorePublication,
} from '../../../application/authentication/authentication-restore-control.js';
import {
  authenticationObject,
  authenticationUuid,
} from '../canonical-authentication.js';
import { authenticationBytesEqual } from '../authentication-digests.js';
import { insertAuthenticationAudit } from './authentication-audit.js';
import {
  authenticationDatabaseInteger,
  authenticationDatabaseRow,
} from './authentication-database-values.js';
import {
  assertAuthenticationDeletionIntent,
  ensureAuthenticationDeletionIntent,
  resolveAuthenticationDeletionTarget,
} from './authentication-deletion-intents.js';
import { readAuthenticationRestoreKeyState } from './authentication-key-state.js';
import { prepareAuthenticationDestruction } from './authentication-maintenance-values.js';
import {
  readStoredAuthenticationActor,
  readStoredAuthenticationAttempt,
  readStoredAuthenticationIdentity,
  readStoredAuthenticationSession,
  updateAuthenticationRecord,
} from './authentication-record-rows.js';
import { authenticationRestoreFingerprint } from './authentication-restore-fingerprint.js';
import { authenticationRestorePublication } from './authentication-restore-publication.js';
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
 * 外部閉鎖能力が確認できるRestoreだけに全破棄/移行/開通CASを許可する。
 * @param options 認証DB/暗号/証跡と、独立した外部所有制御。
 * @returns 通常清掃やHTTPへ公開しない隔離専用DB操作。
 */
export const createPostgresAuthenticationRestore = (
  options: Readonly<{
    /** 全Transactionを同一接続に所有させるPool。 */
    pool: AuthenticationConnectionPool;
    /** 保持Identityだけを復号/新世代へ再Sealする。 */
    codec: AuthenticationRecordCodec;
    /** Actor MAC、削除仮名、現行Alias、固定Audit。 */
    digests: AuthenticationDigests;
    /** DB消失後も全鍵を保持し追跡するRegistry。 */
    keys: AuthenticationKeyDestructionPort;
    /** 外部Prepared/Completeの唯一の所有verifier。 */
    ledger: AuthenticationLedgerEvidence;
    /** 同runの閉鎖/epoch/Nonce世代を確認する独立能力。 */
    control: AuthenticationRestoreControl;
    /** Lock取得後の現在UTC。 */
    clock: AuthenticationClock;
  }>,
): AuthenticationRestoreDatabase => {
  const transactions = createAuthenticationTransactions(
    options.pool,
    createAuthenticationTransactionScopes(),
  );
  const completions = new WeakMap<
    AuthenticationRestoreFence,
    {
      version: number;
      epoch: string;
      digest: Uint8Array;
      publication: AuthenticationRestorePublication;
    }
  >();
  const closed = async (fence: AuthenticationRestoreFence) => {
    if (!(await options.control.verifyClosed(fence))) return fail();
  };
  const restoring = async <T>(
    fence: AuthenticationRestoreFence,
    operation: (
      connection: AuthenticationQueryConnection,
      version: number,
      epoch: string,
    ) => Promise<T>,
  ): Promise<T> => {
    await closed(fence);
    const result = await transactions.run(async (connection) => {
      const selected = await connection.query(
        'SELECT status,generation_version,epoch FROM authentication.key_state WHERE state_id=1 FOR UPDATE',
      );
      if (
        selected.rows.length !== 1 ||
        authenticationDatabaseRow(selected.rows[0]).status !== 'restoring'
      )
        return fail();
      const row = authenticationDatabaseRow(selected.rows[0]);
      const value = await operation(
        connection,
        authenticationDatabaseInteger(row.generation_version, 1),
        authenticationUuid(row.epoch),
      );
      await closed(fence);
      return value;
    });
    return result.status === 'committed' ? result.value : fail();
  };
  const checkActor = async (raw: unknown) => {
    const stored = readStoredAuthenticationActor(raw);
    if (
      !(await options.digests.verifyActorState({
        row: stored.row,
        keyVersion: stored.keyVersion,
        mac: stored.mac,
      }))
    )
      return fail();
    return stored;
  };
  const credentialsAbsent = async (
    connection: AuthenticationQueryConnection,
  ) => {
    const result = await connection.query(
      'SELECT 1 FROM authentication.session_record UNION ALL SELECT 1 FROM authentication.login_attempt LIMIT 1',
    );
    if (result.rows.length !== 0) return fail();
  };
  return {
    async isolate(fence, manifest) {
      completions.delete(fence);
      await closed(fence);
      const m = authenticationObject(manifest, [
        'createdAt',
        'schemaVersion',
        'keyStateVersion',
        'epoch',
        'checkpoint',
      ]);
      if (m.schemaVersion !== 6) return fail();
      const oldEpoch = authenticationUuid(m.epoch);
      const backupVersion = authenticationDatabaseInteger(m.keyStateVersion, 1);
      const checkpoint = authenticationObject(m.checkpoint, [
        'sequence',
        'hash',
      ]);
      const checkpointSequence = authenticationDatabaseInteger(
        checkpoint.sequence,
        0,
      );
      if (
        typeof checkpoint.hash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(checkpoint.hash) ||
        (checkpointSequence === 0 && checkpoint.hash !== '0'.repeat(64))
      )
        return fail();
      const checkedManifest = {
        createdAt: authenticationDatabaseInteger(m.createdAt, 0),
        schemaVersion: 6,
        keyStateVersion: backupVersion,
        epoch: oldEpoch,
        checkpoint: { sequence: checkpointSequence, hash: checkpoint.hash },
      };
      const result = await transactions.run(async (connection) => {
        const selected = await connection.query(
          'SELECT status,generation_version,epoch FROM authentication.key_state WHERE state_id=1 FOR UPDATE',
        );
        if (
          selected.rows.length !== 1 ||
          authenticationDatabaseRow(selected.rows[0]).status === 'uninitialized'
        )
          return fail();
        const row = authenticationDatabaseRow(selected.rows[0]);
        const version = authenticationDatabaseInteger(
          row.generation_version,
          backupVersion,
        );
        if (
          row.status !== 'active' &&
          row.status !== 'rotating' &&
          row.status !== 'quarantined' &&
          row.status !== 'restoring'
        )
          return fail();
        const epoch = authenticationUuid(row.epoch);
        if (epoch !== oldEpoch) {
          const published = await options.control.currentPublication(fence);
          if (
            published === null ||
            published.epoch !== epoch ||
            !(await options.control.verifyPublication(fence, published))
          )
            return fail();
        }
        const next = authenticationDatabaseInteger(
          await options.control.authorizeIsolation(fence, checkedManifest, {
            version,
            epoch,
            status: row.status,
          }),
          1,
        );
        if (
          next !==
          (row.status === 'restoring'
            ? version
            : authenticationDatabaseInteger(version + 1, 1))
        )
          return fail();
        if (row.status !== 'restoring') {
          const changed = await connection.query(
            "UPDATE authentication.key_state SET status='restoring',generation_version=$1 WHERE state_id=1 AND generation_version=$2",
            [next, version],
          );
          if (changed.rowCount !== 1) return fail();
        }
        await closed(fence);
        return next;
      });
      return result.status === 'committed' ? result.value : fail();
    },
    async reapplyDeletion(fence, intent) {
      completions.delete(fence);
      const record = options.ledger.resolve(intent);
      const target = await resolveAuthenticationDeletionTarget(
        options.keys,
        options.digests,
        record,
      );
      return restoring(fence, async (connection) => {
        const state = await readAuthenticationRestoreKeyState(connection);
        const actorRows = await connection.query(
          'SELECT * FROM authentication.actor WHERE actor_id=$1 FOR UPDATE',
          [target.actorId],
        );
        const actor =
          actorRows.rows.length === 0
            ? null
            : await checkActor(authenticationDatabaseRow(actorRows.rows[0]));
        const sessionRows = await connection.query(
          'SELECT * FROM authentication.session_record WHERE actor_id=$1 ORDER BY session_id FOR UPDATE',
          [target.actorId],
        );
        const sessions = sessionRows.rows.map(readStoredAuthenticationSession);
        const identityRows = await connection.query(
          'SELECT * FROM authentication.google_identity WHERE actor_id=$1 FOR UPDATE',
          [target.actorId],
        );
        const identities = identityRows.rows.map(
          readStoredAuthenticationIdentity,
        );
        const now = authenticationDatabaseInteger(
          options.clock.now(),
          record.preparedAt,
        );
        const scopes = new Map(
          target.scopes.map((scope) => [
            scope.recordKind + '/' + scope.keyScopeId,
            scope,
          ]),
        );
        for (const stored of sessions)
          scopes.set('session/' + stored.row.sessionId, {
            recordKind: 'session',
            keyScopeId: stored.row.sessionId,
          });
        const ticket = await prepareAuthenticationDestruction(
          options.keys,
          record.operationId,
          [...scopes.values()],
          {
            dueAt: record.preparedAt,
            deadline: record.preparedAt + 86_400_000,
          },
        );
        if (ticket.reference !== record.targetReference) return fail();
        if (actor !== null && actor.row.state === 'active') {
          const disabled = {
            ...actor.row,
            state: 'disabled' as const,
            disabledAt: now,
            version: authenticationDatabaseInteger(actor.row.version + 1, 1),
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
              actor.row.version,
            ],
          );
          if (changed.rowCount !== 1) return fail();
        }
        await ensureAuthenticationDeletionIntent(connection, record, now);
        // 全復旧Cookieは外部閉鎖下で拒否済み。破棄済みDEKを復号せず再除去する。
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
        if (record.state === 'complete') {
          const current = await connection.query(
            'SELECT * FROM authentication.deletion_intent WHERE operation_id=$1 FOR UPDATE',
            [record.operationId],
          );
          if (current.rows.length !== 1) return fail();
          assertAuthenticationDeletionIntent(
            authenticationDatabaseRow(current.rows[0]),
            record,
          );
          if (authenticationDatabaseRow(current.rows[0]).state !== 'complete') {
            const changed = await connection.query(
              "UPDATE authentication.deletion_intent SET state='complete',version=$1,updated_at_ms=$2 WHERE operation_id=$3 AND version=1 AND state='prepared'",
              [record.version, now, record.operationId],
            );
            if (changed.rowCount !== 1) return fail();
          }
        }
        await insertAuthenticationAudit(connection, options.digests, state, {
          action: 'purge',
          decision: 'allow',
          reason: 'success',
          now,
          subjects: actor === null ? {} : { actorId: target.actorId },
        });
        return ticket;
      });
    },
    async discardCredentials(fence) {
      completions.delete(fence);
      return restoring(fence, async (connection) => {
        const state = await readAuthenticationRestoreKeyState(connection);
        const actors = await connection.query(
          'SELECT * FROM authentication.actor ORDER BY actor_id FOR SHARE',
        );
        for (const value of actors.rows as unknown[]) await checkActor(value);
        const sessionRows = await connection.query(
          'SELECT * FROM authentication.session_record ORDER BY session_id FOR UPDATE',
        );
        const sessions = sessionRows.rows.map(readStoredAuthenticationSession);
        const attemptRows = await connection.query(
          'SELECT * FROM authentication.login_attempt ORDER BY attempt_id FOR UPDATE',
        );
        const attempts = attemptRows.rows.map(readStoredAuthenticationAttempt);
        const tickets = [];
        for (const stored of [...sessions, ...attempts]) {
          const row = stored.row;
          const now = authenticationDatabaseInteger(options.clock.now(), 0);
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
            {
              dueAt: now,
              deadline: authenticationDatabaseInteger(now + 86_400_000, 0),
            },
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
          if (removed.rowCount !== 1) return fail();
          tickets.push(ticket);
          await insertAuthenticationAudit(connection, options.digests, state, {
            action: 'purge',
            decision: 'allow',
            reason: 'success',
            now,
            subjects:
              row.recordKind === 'session'
                ? { actorId: row.actorId, sessionId: row.sessionId }
                : { attemptId: row.attemptId },
          });
        }
        return tickets;
      });
    },
    async migrateIdentity(fence, input) {
      completions.delete(fence);
      const publication = authenticationRestorePublication(input);
      if (!(await options.control.verifyPublication(fence, publication)))
        return fail();
      const result = await restoring(fence, async (connection, version) => {
        const selectedActors = await connection.query(
          'SELECT * FROM authentication.actor ORDER BY actor_id FOR UPDATE',
        );
        const actors = [];
        for (const value of selectedActors.rows as unknown[])
          actors.push(await checkActor(value));
        await credentialsAbsent(connection);
        const epochChanged = await connection.query(
          'UPDATE authentication.key_state SET epoch=$1 WHERE state_id=1 AND generation_version=$2 AND status=$3',
          [publication.epoch, version, 'restoring'],
        );
        if (epochChanged.rowCount !== 1) return fail();
        await connection.query('DELETE FROM authentication.key_generation');
        for (const generation of publication.generations) {
          await connection.query(
            'INSERT INTO authentication.key_generation(generation_id,purpose,key_version,epoch,searchable,write_required,retired_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [
              randomUUID(),
              generation.purpose,
              generation.keyVersion,
              generation.epoch,
              generation.searchable,
              generation.writeRequired,
              generation.retiredAt,
            ],
          );
        }
        const state = await readAuthenticationRestoreKeyState(connection);
        const activeActors = new Set<string>();
        for (const stored of actors) {
          if (!state.actorRead.includes(stored.keyVersion)) return fail();
          if (stored.row.state === 'active')
            activeActors.add(stored.row.actorId);
          if (stored.keyVersion === state.actorWrite) continue;
          const row = {
            ...stored.row,
            version: authenticationDatabaseInteger(stored.row.version + 1, 1),
          };
          const mac = await options.digests.actorState({
            row,
            keyVersion: state.actorWrite,
          });
          const changed = await connection.query(
            'UPDATE authentication.actor SET version=$1,control_key_version=$2,state_mac=$3 WHERE actor_id=$4 AND version=$5',
            [
              row.version,
              mac.keyVersion,
              Buffer.from(mac.bytes),
              row.actorId,
              stored.row.version,
            ],
          );
          if (changed.rowCount !== 1) return fail();
        }
        const selected = await connection.query(
          'SELECT * FROM authentication.google_identity ORDER BY identity_id FOR UPDATE',
        );
        const identities = selected.rows.map(readStoredAuthenticationIdentity);
        for (const stored of identities) {
          if (!activeActors.has(stored.row.actorId)) return fail();
          const secrets = await options.codec.open(stored);
          if (!('issuer' in secrets)) return fail();
          await options.control.rotateIdentity(
            fence,
            {
              recordKind: 'google-identity',
              keyScopeId: stored.row.actorId,
            },
            stored.envelope.header.keyVersion,
          );
          const row = {
            ...stored.row,
            version: authenticationDatabaseInteger(stored.row.version + 1, 1),
          };
          const envelope = await options.codec.seal({ row, secrets });
          if (envelope.header.keyVersion === stored.envelope.header.keyVersion)
            return fail();
          await updateAuthenticationRecord(
            connection,
            row,
            envelope,
            stored.row.version,
          );
          await connection.query(
            'DELETE FROM authentication.identity_alias WHERE identity_id=$1',
            [row.identityId],
          );
          for (const keyVersion of state.identityWrite) {
            const digest = await options.digests.identity({
              identity: secrets,
              keyVersion,
            });
            await connection.query(
              'INSERT INTO authentication.identity_alias(purpose,digest_key_version,digest,identity_id) VALUES($1,$2,$3,$4)',
              [
                digest.purpose,
                digest.keyVersion,
                Buffer.from(digest.bytes),
                row.identityId,
              ],
            );
          }
        }
        for (const keyVersion of state.identityWrite) {
          const missing = await connection.query(
            'SELECT 1 FROM authentication.google_identity g LEFT JOIN authentication.identity_alias a ' +
              'ON a.identity_id=g.identity_id AND a.digest_key_version=$1 WHERE a.identity_id IS NULL LIMIT 1',
            [keyVersion],
          );
          if (missing.rows.length !== 0) return fail();
        }
        if (!(await options.control.verifyPublication(fence, publication)))
          return fail();
        return {
          version,
          digest: await authenticationRestoreFingerprint(connection),
        };
      });
      completions.set(fence, {
        version: result.version,
        epoch: publication.epoch,
        digest: Uint8Array.from(result.digest),
        publication,
      });
      return Uint8Array.from(result.digest);
    },
    async activate(fence, generationVersion, epoch) {
      const complete = completions.get(fence);
      if (
        complete === undefined ||
        complete.version !== generationVersion ||
        complete.epoch !== epoch
      )
        return false;
      if (
        !(await options.control.verifyPublication(fence, complete.publication))
      )
        return false;
      const activated = await restoring(
        fence,
        async (connection, version, currentEpoch) => {
          if (version !== generationVersion || currentEpoch !== epoch)
            return false;
          await credentialsAbsent(connection);
          const pending = await connection.query(
            "SELECT 1 FROM authentication.deletion_intent WHERE state='prepared' LIMIT 1",
          );
          if (pending.rows.length !== 0) return false;
          await readAuthenticationRestoreKeyState(connection);
          if (
            !authenticationBytesEqual(
              await authenticationRestoreFingerprint(connection),
              complete.digest,
            )
          )
            return false;
          const next = authenticationDatabaseInteger(version + 1, 1);
          const changed = await connection.query(
            "UPDATE authentication.key_state SET status='active',generation_version=$1 WHERE state_id=1 AND status='restoring' AND generation_version=$2 AND epoch=$3",
            [next, version, epoch],
          );
          return changed.rowCount === 1;
        },
      );
      if (activated) completions.delete(fence);
      return activated;
    },
  };
};
