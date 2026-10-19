import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Client, Pool, type QueryResult } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  AuthenticationMacKeyPorts,
  AuthenticationMacPurpose,
} from '../src/shared/application/authentication/authentication-crypto-keys.js';
import type {
  AuthenticationDestructionTicket,
  AuthenticationKeyDestructionPort,
} from '../src/shared/application/authentication/authentication-maintenance-ports.js';
import {
  createAuthenticationDigests,
  importAuthenticationMacKey,
} from '../src/shared/infrastructure/authentication/authentication-digests.js';
import { createAuthenticationRecordCodec } from '../src/shared/infrastructure/authentication/authentication-record-codec.js';
import { createPostgresAuthenticationCleanup } from '../src/shared/infrastructure/authentication/postgres/postgres-authentication-cleanup.js';
import { createPostgresAuthenticationDeletion } from '../src/shared/infrastructure/authentication/postgres/postgres-authentication-deletion.js';
import { createPostgresAuthenticationRestore } from '../src/shared/infrastructure/authentication/postgres/postgres-authentication-restore.js';
import { createAuthenticationTransactionScopes } from '../src/shared/infrastructure/authentication/postgres/authentication-transaction-scopes.js';
import { createPostgresAuthenticationStore } from '../src/shared/infrastructure/authentication/postgres/postgres-authentication-store.js';
import { ids } from '../src/shared/infrastructure/authentication/test/authentication-crypto-fixtures.js';
import { syntheticAuthenticationLedger } from '../src/shared/infrastructure/authentication/test/authentication-maintenance-ledger-fixtures.js';
import { syntheticAuthenticationManagedKeys } from '../src/shared/infrastructure/authentication/test/authentication-maintenance-key-fixtures.js';
import { syntheticAuthenticationRestoreControl } from '../src/shared/infrastructure/authentication/test/authentication-maintenance-control-fixtures.js';
import { createAuthenticationDeletionService } from '../src/shared/application/authentication/authentication-deletion-service.js';
import { createAuthenticationRestoreService } from '../src/shared/application/authentication/authentication-restore-service.js';
import { createAuthenticationCleanupService } from '../src/shared/application/authentication/authentication-cleanup-service.js';
import type { AuthenticationConnectionPool } from '../src/shared/infrastructure/authentication/postgres/authentication-transactions.js';
import { authenticationDatabaseRow } from '../src/shared/infrastructure/authentication/postgres/authentication-database-values.js';
import { readStoredAuthenticationIdentity } from '../src/shared/infrastructure/authentication/postgres/authentication-record-rows.js';

const secret = (n: number) => Buffer.alloc(32, n).toString('base64url');
const key = <P extends AuthenticationMacPurpose>(purpose: P, n: number) => ({
  readKey: ({
    keyVersion,
    epoch,
  }: {
    keyVersion: string;
    epoch: string | null;
  }) =>
    Promise.resolve({
      status: 'available' as const,
      keyVersion,
      epoch,
      key: importAuthenticationMacKey(
        purpose,
        Buffer.alloc(32, n + (keyVersion === 'v2' ? 100 : 0)),
      ),
    }),
});
const keys: AuthenticationMacKeyPorts = {
  identity: key('auth-google-identity/v1', 1),
  attemptCookie: key('auth-attempt-cookie/v1', 2),
  sessionCookie: key('auth-session-cookie/v1', 3),
  actorState: key('auth-actor-state/v1', 4),
  auditActor: key('auth-audit-actor/v1', 5),
  auditAttempt: key('auth-audit-attempt/v1', 6),
  auditSession: key('auth-audit-session/v1', 7),
  deletedActor: key('auth-deleted-actor/v1', 8),
};
const purposes = [
  'google-identity-search',
  'login-attempt-cookie',
  'session-cookie',
  'actor-state-mac',
  'audit-actor',
  'audit-attempt',
  'audit-session',
  'deleted-actor',
  'deletion-ledger-mac',
];

describe('PostgreSQL認証Dataの清掃・削除・復旧', () => {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';
  const observer = new Client({ connectionString: url });
  const pool = new Pool({ connectionString: url, max: 3 });
  let owned = false;
  let now = 1_000_000;
  const clock = { now: () => now };
  const digests = createAuthenticationDigests({ keys });
  let managed: ReturnType<typeof syntheticAuthenticationManagedKeys>;
  let codec: ReturnType<typeof createAuthenticationRecordCodec>;
  let store: ReturnType<typeof createPostgresAuthenticationStore>;
  let cleanup: ReturnType<typeof createPostgresAuthenticationCleanup>;
  let tickets: AuthenticationDestructionTicket[];
  let destruction: AuthenticationKeyDestructionPort;
  let ledger: ReturnType<typeof syntheticAuthenticationLedger>;
  let deletion: ReturnType<typeof createPostgresAuthenticationDeletion>;
  beforeAll(async () => {
    await observer.connect();
    const info = authenticationDatabaseRow(
      (
        await observer.query<{ name: string; version: string }>(
          'SELECT current_database() AS name, current_setting($1) AS version',
          ['server_version_num'],
        )
      ).rows[0],
    );
    if (
      typeof info.name !== 'string' ||
      !info.name.endsWith('_test') ||
      Number(info.version) < 170000 ||
      Number(info.version) >= 180000
    )
      throw new Error('PostgreSQL17の末尾_test専用DBが必要');
    await observer.query('SELECT pg_advisory_lock(1801546597, 1635087464)');
    const exists = authenticationDatabaseRow(
      (
        await observer.query<{ present: boolean }>(
          "SELECT to_regnamespace('authentication') IS NOT NULL AS present",
        )
      ).rows[0],
    ).present;
    if (exists) throw new Error('既存認証Schemaを変更しない');
    await observer.query(
      await readFile(
        new URL(
          '../migrations/authentication/0005_authentication_schema.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    owned = true;
    await observer.query(
      await readFile(
        new URL(
          '../migrations/authentication/0006_authentication_inventory.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
  });
  beforeEach(async () => {
    if (!owned) throw new Error('Suite所有Schemaが必要');
    await observer.query(
      'TRUNCATE authentication.actor, authentication.login_attempt, authentication.audit_event, authentication.deletion_intent CASCADE',
    );
    await observer.query('DELETE FROM authentication.key_generation');
    await observer.query(
      "UPDATE authentication.key_state SET status='active', epoch=$1, generation_version=1",
      [ids.epoch],
    );
    for (const purpose of purposes) {
      await observer.query(
        'INSERT INTO authentication.key_generation(generation_id,purpose,key_version,epoch,searchable,write_required) VALUES($1,$2,$3,$4,true,true)',
        [
          randomUUID(),
          purpose,
          'v1',
          purpose.includes('cookie') ? ids.epoch : null,
        ],
      );
    }
    now = 1_000_000;
    tickets = [];
    managed = syntheticAuthenticationManagedKeys();
    codec = createAuthenticationRecordCodec({ keys: managed.provider });
    store = createPostgresAuthenticationStore({
      pool,
      scopes: createAuthenticationTransactionScopes(),
      codec,
      digests,
    });
    destruction = {
      ...managed.keys,
      prepare: async (operationId, scopes, window) => {
        const ticket = await managed.keys.prepare(operationId, scopes, window);
        tickets.push(ticket);
        return ticket;
      },
    };
    cleanup = createPostgresAuthenticationCleanup({
      pool,
      codec,
      digests,
      keys: destruction,
      clock,
    });
    ledger = syntheticAuthenticationLedger();
    deletion = createPostgresAuthenticationDeletion({
      pool,
      codec,
      digests,
      keys: destruction,
      clock,
      ledger: ledger.evidence,
    });
  });
  afterAll(async () => {
    await pool.end();
    if (owned) await observer.query('DROP SCHEMA authentication CASCADE');
    await observer.query('SELECT pg_advisory_unlock(1801546597, 1635087464)');
    await observer.end();
  });
  const begin = async (
    base = 11,
    subject = 'Synthetic-maintenance-subject',
  ) => {
    const input = {
      attemptSecret: secret(base),
      csrf: secret(base + 1),
      nonce: secret(base + 2),
    };
    expect((await store.begin(input, clock)).status).toBe('started');
    const read = await store.readAttempt(input, clock);
    if (read.status !== 'ready') throw new Error('合成試行が必要');
    return {
      ...input,
      snapshot: read.snapshot,
      identity: { issuer: 'https://accounts.google.com' as const, subject },
      sessionSecret: secret(base + 3),
      sessionCsrf: secret(base + 4),
    };
  };
  const count = async (table: string) =>
    Number(
      authenticationDatabaseRow(
        (
          await observer.query<{ count: string }>(
            'SELECT count(*) AS count FROM authentication.' + table,
          )
        ).rows[0],
      ).count,
    );
  const login = async (
    base = 11,
    subject = 'Synthetic-maintenance-subject',
  ) => {
    const command = await begin(base, subject);
    expect((await store.complete(command, clock)).status).toBe('authenticated');
    let actorId = '';
    expect(
      (
        await store.withSession(
          command.sessionSecret,
          'inspect',
          clock,
          (actor, scope) => {
            return Promise.resolve().then(() => {
              actorId = actor.actorSubject;
              return scope.serialize(null);
            });
          },
        )
      ).status,
    ).toBe('authenticated');
    expect(actorId).not.toBe('');
    return { command, actorId };
  };
  const tables = [
    'key_state',
    'key_generation',
    'actor',
    'google_identity',
    'identity_alias',
    'session_record',
    'login_attempt',
    'audit_event',
    'deletion_intent',
  ] as const;
  const backup = async () => {
    const snapshot: Record<string, Record<string, unknown>[]> = {};
    for (const table of tables)
      snapshot[table] = (
        await observer.query(
          'SELECT * FROM authentication.' + table + ' ORDER BY 1',
        )
      ).rows.map(authenticationDatabaseRow);
    return snapshot;
  };
  const restoreBackup = async (
    snapshot: Record<string, Record<string, unknown>[]>,
    control: ReturnType<typeof syntheticAuthenticationRestoreControl>,
  ) => {
    if (!owned || !control.isClosed())
      throw new Error('Suite所有DBと外部Traffic閉鎖が必要');
    await observer.query('BEGIN');
    try {
      await observer.query(
        'TRUNCATE ' +
          tables.map((table) => 'authentication.' + table).join(',') +
          ' CASCADE',
      );
      for (const table of tables)
        for (const row of snapshot[table]) {
          const columns = Object.keys(row);
          if (columns.some((column) => !/^[a-z_]+$/.test(column)))
            throw new Error('合成Schema列が必要');
          await observer.query(
            'INSERT INTO authentication.' +
              table +
              '(' +
              columns.join(',') +
              ') VALUES(' +
              columns
                .map((_column, index) => '$' + String(index + 1))
                .join(',') +
              ')',
            Object.values(row),
          );
        }
      await observer.query('COMMIT');
    } catch (error) {
      await observer.query('ROLLBACK');
      throw error;
    }
  };
  const wrappedPool = (
    intercept: (
      sql: string,
      values: unknown[] | undefined,
      execute: () => Promise<QueryResult>,
      pid: number,
    ) => Promise<QueryResult>,
  ): AuthenticationConnectionPool & { pids: number[] } => {
    const pids: number[] = [];
    return {
      pids,
      connect: async () => {
        const connection = await pool.connect();
        const pid = Number(
          authenticationDatabaseRow(
            (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0],
          ).pid,
        );
        pids.push(pid);
        return {
          query: (sql, values) =>
            intercept(sql, values, () => connection.query(sql, values), pid),
          release: (destroy) => connection.release(destroy),
        };
      },
    };
  };
  const components = (
    connections: AuthenticationConnectionPool = pool,
    control = syntheticAuthenticationRestoreControl(managed, ledger),
  ) => {
    const dbCleanup = createPostgresAuthenticationCleanup({
      pool: connections,
      codec,
      digests,
      keys: destruction,
      clock,
    });
    const dbDeletion = createPostgresAuthenticationDeletion({
      pool: connections,
      codec,
      digests,
      keys: destruction,
      clock,
      ledger: ledger.evidence,
    });
    const dbRestore = createPostgresAuthenticationRestore({
      pool: connections,
      codec,
      digests,
      keys: destruction,
      clock,
      ledger: ledger.evidence,
      control: control.control,
    });
    const signals: unknown[] = [];
    const monitor = {
      record: (event: unknown) => {
        return Promise.resolve().then(() => {
          signals.push(event);
        });
      },
    };
    return {
      control,
      dbCleanup,
      dbDeletion,
      dbRestore,
      signals,
      deletion: createAuthenticationDeletionService({
        database: dbDeletion,
        cleanup: dbCleanup,
        keys: destruction,
        ledger: ledger.evidence,
        clock,
        monitor,
        newOperationId: () => randomUUID(),
        deletedActor: async (subjectId, keyVersion) =>
          (await digests.deletedActor({ subjectId, keyVersion })).bytes,
      }),
      restore: createAuthenticationRestoreService({
        control: control.control,
        database: dbRestore,
        deletion: dbDeletion,
        cleanup: dbCleanup,
        ledger: ledger.evidence,
        keys: destruction,
        clock,
        monitor,
      }),
    };
  };
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('合成競合の待機期限超過')),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const blockedBy = async (pid: () => number | undefined, owner: number) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const target = pid();
      if (target !== undefined) {
        expect(target).not.toBe(owner);
        const result = await observer.query<{ blockers: number[] }>(
          'SELECT pg_blocking_pids($1) AS blockers',
          [target],
        );
        if (result.rows[0].blockers.includes(owner)) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('異なるPID間のRow Lock待機を観測できない');
  };
  const proveSessionLock = async (sessionId: string, writer: number) => {
    const probe = await pool.connect();
    try {
      const pid = Number(
        authenticationDatabaseRow(
          (await probe.query('SELECT pg_backend_pid() AS pid')).rows[0],
        ).pid,
      );
      await probe.query('BEGIN');
      let cancelled = false;
      const waiting = probe
        .query(
          'SELECT 1 FROM authentication.session_record WHERE session_id=$1 FOR UPDATE',
          [sessionId],
        )
        .catch((error: unknown) => {
          cancelled =
            typeof error === 'object' &&
            error !== null &&
            Object.getOwnPropertyDescriptor(error, 'code')?.value === '57014';
        });
      try {
        await blockedBy(() => pid, writer);
      } finally {
        // このSuiteが取得したprobeだけを取消し、業務Writerへ干渉しない。
        await observer.query('SELECT pg_cancel_backend($1)', [pid]);
        await waiting;
        await probe.query('ROLLBACK');
      }
      expect(cancelled).toBe(true);
    } finally {
      probe.release();
    }
  };
  it('期限前は試行を保持し等値から全世代ticketと共通commitする', async () => {
    await begin();
    now += 299999;
    const retained = await cleanup.deleteExpired(10);
    expect(retained.status).toBe('committed');
    expect(await count('login_attempt')).toBe(1);
    expect(tickets).toHaveLength(0);
    now += 1;
    const removed = await cleanup.deleteExpired(10);
    expect(removed.status).toBe('committed');
    expect(await count('login_attempt')).toBe(0);
    expect(tickets).toHaveLength(1);
    expect(await cleanup.absent(await destruction.scopes(tickets[0]))).toBe(
      true,
    );
    expect(
      authenticationDatabaseRow(
        (
          await observer.query(
            "SELECT count(*) AS count FROM authentication.audit_event WHERE action='purge'",
          )
        ).rows[0],
      ).count,
    ).toBe('1');
  });
  it('Sessionのidle期限までは消費済み試行だけを除去する', async () => {
    const command = await begin();
    expect((await store.complete(command, clock)).status).toBe('authenticated');
    expect((await cleanup.deleteExpired(10)).status).toBe('committed');
    expect(await count('login_attempt')).toBe(0);
    expect(await count('session_record')).toBe(1);
    now += 86_400_000;
    expect((await cleanup.deleteExpired(10)).status).toBe('committed');
    expect(await count('session_record')).toBe(0);
    expect(await count('actor')).toBe(1);
    expect(await count('google_identity')).toBe(1);
  });
  it('Audit90日等値だけを清掃し新しいpurge Auditを残す', async () => {
    await begin();
    now += 90 * 86_400_000;
    const result = await cleanup.deleteExpired(10);
    expect(result.status).toBe('committed');
    if (result.status === 'committed') expect(result.auditCount).toBe(2);
    const rows = (
      await observer.query(
        'SELECT action,occurred_at_ms FROM authentication.audit_event',
      )
    ).rows;
    expect(
      rows.every((raw) => {
        const row = authenticationDatabaseRow(raw);
        return row.action === 'purge' && Number(row.occurred_at_ms) === now;
      }),
    ).toBe(true);
  });
  it('偽造期限Metadataでは行や鍵ticketを変更しない', async () => {
    await begin();
    now += 300000;
    await observer.query(
      'UPDATE authentication.login_attempt SET created_at_ms=created_at_ms-1,expires_at_ms=expires_at_ms-1',
    );
    expect(await cleanup.deleteExpired(10)).toEqual({ status: 'unavailable' });
    expect(await count('login_attempt')).toBe(1);
    expect(tickets).toHaveLength(0);
  });
  it('隔離後の通常認証を拒否し、保守清掃の再試行は許可する', async () => {
    await begin();
    now += 300000;
    expect(await cleanup.quarantine()).toBe(true);
    expect(
      await store.readAttempt(
        { attemptSecret: secret(11), csrf: secret(12) },
        clock,
      ),
    ).toEqual({ status: 'unavailable' });
    expect((await cleanup.deleteExpired(10)).status).toBe('committed');
    expect(await count('login_attempt')).toBe(0);
  });
  it('外部Preparedの照合後にActor/全Session/Intent/Auditを共通commitし、本人対応だけ除去する', async () => {
    const command = await begin();
    const authenticated = await store.complete(command, clock);
    if (authenticated.status !== 'authenticated')
      throw new Error('合成本人性が必要');
    const actorId = authenticationDatabaseRow(
      (await observer.query('SELECT actor_id FROM authentication.actor'))
        .rows[0],
    ).actor_id as string;
    const plan = await deletion.plan(actorId);
    const operationId = randomUUID();
    const ticket = await destruction.prepare(
      operationId,
      [{ recordKind: 'google-identity', keyScopeId: actorId }],
      { dueAt: now, deadline: now + 86_400_000 },
    );
    const head = await ledger.evidence.append(await ledger.evidence.latest(), {
      kind: 'actor-deletion',
      operationId,
      actorDigestKeyVersion: plan.keyVersion,
      actorDigest: plan.digest,
      preparedAt: now,
      version: 1,
      state: 'prepared',
      targetReference: ticket.reference,
    });
    const intent = ledger.evidence.intent(head, operationId)!;
    const disabled = await deletion.disable(intent);
    expect(
      authenticationDatabaseRow(
        (await observer.query('SELECT state FROM authentication.actor'))
          .rows[0],
      ).state,
    ).toBe('disabled');
    expect(
      authenticationDatabaseRow(
        (
          await observer.query(
            'SELECT state FROM authentication.session_record',
          )
        ).rows[0],
      ).state,
    ).toBe('revoked');
    expect(
      authenticationDatabaseRow(
        (
          await observer.query(
            'SELECT state FROM authentication.deletion_intent',
          )
        ).rows[0],
      ).state,
    ).toBe('prepared');
    expect(await deletion.remove(intent, disabled)).toBe(true);
    expect(await count('actor')).toBe(1);
    expect(await count('google_identity')).toBe(0);
    expect(await count('identity_alias')).toBe(0);
    expect(await count('session_record')).toBe(0);
    expect(
      authenticationDatabaseRow(
        (
          await observer.query(
            'SELECT state FROM authentication.deletion_intent',
          )
        ).rows[0],
      ).state,
    ).toBe('prepared');
    await expect(deletion.complete(intent)).rejects.toThrow();
  });
  it('外部Preparedの管理票欠落は期限内でもDBを封鎖し、同operationで回復する', async () => {
    const { command, actorId } = await login();
    const c = components();
    const plan = await deletion.plan(actorId);
    const operationId = randomUUID();
    const ticket = await destruction.prepare(
      operationId,
      [{ recordKind: 'google-identity', keyScopeId: actorId }],
      { dueAt: now, deadline: now + 86_400_000 },
    );
    await ledger.evidence.append(await ledger.evidence.latest(), {
      kind: 'actor-deletion',
      operationId,
      actorDigestKeyVersion: plan.keyVersion,
      actorDigest: plan.digest,
      preparedAt: now,
      version: 1,
      state: 'prepared',
      targetReference: ticket.reference,
    });
    const unavailableTicket = createAuthenticationDeletionService({
      database: c.dbDeletion,
      cleanup: c.dbCleanup,
      keys: { ...destruction, find: () => Promise.resolve(null) },
      ledger: ledger.evidence,
      clock,
      monitor: { record: () => Promise.resolve() },
      newOperationId: () => {
        throw new Error('同operationを再開し、新しい受付を作らない');
      },
      deletedActor: async (subjectId, keyVersion) =>
        (await digests.deletedActor({ subjectId, keyVersion })).bytes,
    });
    expect(await unavailableTicket.resume(operationId)).toEqual({
      status: 'quarantined',
      operationId,
    });
    expect(await count('session_record')).toBe(1);
    expect(await count('deletion_intent')).toBe(0);
    let invoked = false;
    const session = await store.withSession(
      command.sessionSecret,
      'inspect',
      clock,
      (_actor, scope) => {
        invoked = true;
        return Promise.resolve(scope.serialize(null));
      },
    );
    expect(session.status).not.toBe('authenticated');
    expect(invoked).toBe(false);
    expect(await c.deletion.resume(operationId)).toEqual({
      status: 'complete',
      operationId,
    });
    expect(await count('session_record')).toBe(0);
    expect(await count('google_identity')).toBe(0);
    expect(await count('actor')).toBe(1);
    const intents = ledger.evidence.intents(await ledger.evidence.latest());
    expect(intents).toHaveLength(1);
    expect(ledger.evidence.resolve(intents[0])).toMatchObject({
      operationId,
      state: 'complete',
    });
  });
  it('隔離Restoreで全Cookie行/鍵を破棄し、Identityを新DEKと現行Aliasへ移行する', async () => {
    const managed = syntheticAuthenticationManagedKeys();
    codec = createAuthenticationRecordCodec({ keys: managed.provider });
    store = createPostgresAuthenticationStore({
      pool,
      codec,
      digests,
      scopes: createAuthenticationTransactionScopes(),
    });
    destruction = managed.keys;
    cleanup = createPostgresAuthenticationCleanup({
      pool,
      codec,
      digests,
      keys: destruction,
      clock,
    });
    const control = syntheticAuthenticationRestoreControl(managed, ledger);
    const restore = createPostgresAuthenticationRestore({
      pool,
      codec,
      digests,
      keys: destruction,
      clock,
      ledger: ledger.evidence,
      control: control.control,
    });
    const command = await begin();
    expect((await store.complete(command, clock)).status).toBe('authenticated');
    const original = authenticationDatabaseRow(
      (
        await observer.query(
          'SELECT actor_id,key_version FROM authentication.google_identity',
        )
      ).rows[0],
    );
    const manifest = {
      createdAt: now,
      schemaVersion: 6,
      keyStateVersion: 1,
      epoch: ids.epoch,
      checkpoint: { sequence: 0, hash: '0'.repeat(64) },
    };
    const runId = randomUUID();
    const fence = await control.control.close(runId);
    const version = await restore.isolate(fence, manifest);
    for (const ticket of await restore.discardCredentials(fence)) {
      const proof = await destruction.destroy(ticket);
      expect(await destruction.verify(proof, ticket)).toBe(true);
    }
    expect(await count('login_attempt')).toBe(0);
    expect(await count('session_record')).toBe(0);
    const publication = await control.control.publishEpoch(fence, ids.epoch);
    const digest = await restore.migrateIdentity(fence, publication);
    const migrated = authenticationDatabaseRow(
      (
        await observer.query(
          'SELECT actor_id,key_version FROM authentication.google_identity',
        )
      ).rows[0],
    );
    expect(migrated.actor_id).toBe(original.actor_id);
    expect(migrated.key_version).not.toBe(original.key_version);
    expect(
      managed.inventory({
        recordKind: 'google-identity',
        keyScopeId: original.actor_id as string,
      })[0].mode,
    ).toBe('read-only');
    expect(await count('identity_alias')).toBe(1);
    const head = await ledger.evidence.append(await ledger.evidence.latest(), {
      kind: 'recovery',
      operationId: runId,
      epoch: publication.epoch,
      completedAt: now,
      evidenceDigest: digest,
    });
    expect(await restore.activate(fence, version, publication.epoch)).toBe(
      true,
    );
    expect(
      await control.control.open(
        fence,
        publication,
        ledger.evidence.head(head),
        digest,
      ),
    ).toBe(true);
    expect(await store.readAttempt(command, clock)).toEqual({
      status: 'restart-required',
    });
  });
  it.each(['foreign-fence', 'no-completion', 'changed-identity'] as const)(
    '%sではRestore開通CASを許可しない',
    async (fault) => {
      await login();
      const c = components();
      const fence = await c.control.control.close(randomUUID());
      const manifest = {
        createdAt: now,
        schemaVersion: 6,
        keyStateVersion: 1,
        epoch: ids.epoch,
        checkpoint: { sequence: 0, hash: '0'.repeat(64) },
      };
      if (fault === 'foreign-fence') {
        await expect(
          c.dbRestore.isolate({} as typeof fence, manifest),
        ).rejects.toThrow();
        expect(
          await c.dbRestore.activate({} as typeof fence, 1, ids.epoch),
        ).toBe(false);
        return;
      }
      const version = await c.dbRestore.isolate(fence, manifest);
      for (const ticket of await c.dbRestore.discardCredentials(fence)) {
        expect(
          await destruction.verify(await destruction.destroy(ticket), ticket),
        ).toBe(true);
      }
      const publication = await c.control.control.publishEpoch(
        fence,
        ids.epoch,
      );
      if (fault === 'changed-identity') {
        await c.dbRestore.migrateIdentity(fence, publication);
        await observer.query(
          'UPDATE authentication.google_identity SET version=version+1',
        );
      }
      expect(
        await c.dbRestore.activate(fence, version, publication.epoch),
      ).toBe(false);
      expect(c.control.isClosed()).toBe(true);
      expect(
        authenticationDatabaseRow(
          (await observer.query('SELECT status FROM authentication.key_state'))
            .rows[0],
        ).status,
      ).toBe('restoring');
    },
  );
  it('同本人の重複IdentityはAlias再構築をrollbackして隔離する', async () => {
    const first = await login(11, 'Synthetic-duplicate-subject');
    const second = await login(31, 'Synthetic-other-subject');
    const stored = readStoredAuthenticationIdentity(
      authenticationDatabaseRow(
        (
          await observer.query(
            'SELECT * FROM authentication.google_identity WHERE actor_id=$1',
            [second.actorId],
          )
        ).rows[0],
      ),
    );
    const envelope = await codec.seal({
      row: stored.row,
      secrets: first.command.identity,
    });
    // Suite所有の隔離fixtureだけを改変し、AEADは真正だが本人が重複する旧Backupを表す。
    await observer.query(
      'UPDATE authentication.google_identity SET key_version=$1,nonce=$2,ciphertext=$3,authentication_tag=$4 WHERE identity_id=$5',
      [
        envelope.header.keyVersion,
        Buffer.from(envelope.nonce),
        Buffer.from(envelope.ciphertext),
        Buffer.from(envelope.authenticationTag),
        stored.row.identityId,
      ],
    );
    const c = components();
    const result = await c.restore.run(randomUUID(), {
      createdAt: now,
      schemaVersion: 6,
      keyStateVersion: 1,
      epoch: ids.epoch,
      checkpoint: { sequence: 0, hash: '0'.repeat(64) },
    });
    expect(result.status).toBe('quarantined');
    expect(c.control.isClosed()).toBe(true);
    expect(await count('identity_alias')).toBe(2);
  });
  it.each(['session', 'actor'] as const)(
    '先頭%sをLockしても小Batchは後続Sessionを清掃する',
    async (kind) => {
      await login(11, 'Synthetic-locked-first');
      await login(31, 'Synthetic-unlocked-next');
      expect((await cleanup.deleteExpired(10)).status).toBe('committed');
      now += 86_400_000;
      const first = authenticationDatabaseRow(
        (
          await observer.query(
            'SELECT session_id,actor_id FROM authentication.session_record ORDER BY session_id LIMIT 1',
          )
        ).rows[0],
      );
      const owner = await pool.connect();
      try {
        await owner.query('BEGIN');
        await owner.query(
          kind === 'session'
            ? 'SELECT 1 FROM authentication.session_record WHERE session_id=$1 FOR UPDATE'
            : 'SELECT 1 FROM authentication.actor WHERE actor_id=$1 FOR UPDATE',
          [kind === 'session' ? first.session_id : first.actor_id],
        );
        const result = await cleanup.deleteExpired(1);
        expect(result.status).toBe('committed');
        if (result.status === 'committed')
          expect(result.tickets).toHaveLength(1);
        expect(await count('session_record')).toBe(1);
        expect(
          (
            await observer.query(
              'SELECT 1 FROM authentication.session_record WHERE session_id=$1',
              [first.session_id],
            )
          ).rows,
        ).toHaveLength(1);
      } finally {
        await owner.query('ROLLBACK');
        owner.release();
      }
    },
  );
  it('初回RestoreではManifestより進んだ同epochのDB版を拒否する', async () => {
    const c = components();
    const fence = await c.control.control.close(randomUUID());
    await observer.query(
      'UPDATE authentication.key_state SET generation_version=2',
    );
    await expect(
      c.dbRestore.isolate(fence, {
        createdAt: now,
        schemaVersion: 6,
        keyStateVersion: 1,
        epoch: ids.epoch,
        checkpoint: { sequence: 0, hash: '0'.repeat(64) },
      }),
    ).rejects.toThrow();
    expect(
      authenticationDatabaseRow(
        (await observer.query('SELECT status FROM authentication.key_state'))
          .rows[0],
      ).status,
    ).toBe('active');
  });
  it('Prepared前の孤児ticketから再受付せず元operationを隔離する', async () => {
    const target = await login();
    ledger.faults.add('before-actor-deletion-prepared-checkpoint');
    const first = await components().deletion.begin(target.actorId);
    expect(first.operationId).not.toBeNull();
    ledger.faults.clear();
    const repeated = await components().deletion.begin(target.actorId);
    expect(repeated).toEqual({
      status: 'quarantined',
      operationId: first.operationId,
    });
    expect(
      (await components().deletion.resume(first.operationId!)).status,
    ).toBe('quarantined');
    expect(ledger.entries).toHaveLength(0);
    expect(await count('google_identity')).toBe(1);
  });
  it('隔離版の再開は同runの外部記録に束縛し、別Manifest/未登録版を拒否する', async () => {
    const c = components();
    const fence = await c.control.control.close(randomUUID());
    const manifest = {
      createdAt: now,
      schemaVersion: 6,
      keyStateVersion: 1,
      epoch: ids.epoch,
      checkpoint: { sequence: 0, hash: '0'.repeat(64) },
    };
    expect(await c.dbRestore.isolate(fence, manifest)).toBe(2);
    expect(
      await components(pool, c.control).dbRestore.isolate(fence, manifest),
    ).toBe(2);
    await expect(
      c.dbRestore.isolate(fence, { ...manifest, createdAt: now - 1 }),
    ).rejects.toThrow();
    await observer.query(
      'UPDATE authentication.key_state SET generation_version=3',
    );
    await expect(c.dbRestore.isolate(fence, manifest)).rejects.toThrow();
    expect(c.control.isClosed()).toBe(true);
  });
  const crashes = [
    'before-actor-deletion-prepared-checkpoint',
    'after-actor-deletion-prepared-checkpoint',
    'before-actor-deletion-prepared-witness',
    'after-actor-deletion-prepared-witness',
    'disable-before-commit',
    'disable-after-commit',
    'remove-before-row-delete',
    'remove-after-row-delete',
    'remove-before-commit',
    'remove-after-commit',
    'before-destroy',
    'after-destroy',
    'before-destroy-version',
    'after-destroy-version',
    'before-actor-deletion-complete-checkpoint',
    'after-actor-deletion-complete-checkpoint',
    'before-actor-deletion-complete-witness',
    'after-actor-deletion-complete-witness',
    'complete-before-commit',
    'complete-after-commit',
  ] as const;
  it.each(crashes)(
    '%sから旧Backupを復旧しても削除意思/鍵/Sessionを復活させない',
    async (crash) => {
      const target = await login();
      const retained = await login(31, 'Synthetic-maintenance-retained');
      managed.rotate({
        recordKind: 'google-identity',
        keyScopeId: target.actorId,
      });
      const snapshot = await backup();
      const manifest = {
        createdAt: now,
        schemaVersion: 6,
        keyStateVersion: 1,
        epoch: ids.epoch,
        checkpoint: ledger.evidence.head(await ledger.evidence.latest()),
      };
      let fired = false;
      const fire = (point: string) => {
        if (point === crash && !fired) {
          fired = true;
          throw new Error('synthetic crash window');
        }
      };
      const phases = new Map<number, string>();
      const connections = wrappedPool(async (sql, values, execute, pid) => {
        if (sql.startsWith('BEGIN')) phases.set(pid, 'other');
        if (
          sql.startsWith('INSERT INTO authentication.audit_event') &&
          values?.[3] === 'disable'
        )
          phases.set(pid, 'disable');
        if (sql.startsWith('DELETE FROM authentication.google_identity')) {
          phases.set(pid, 'remove');
          fire('remove-before-row-delete');
        }
        if (
          sql.startsWith(
            "UPDATE authentication.deletion_intent SET state='complete'",
          )
        )
          phases.set(pid, 'complete');
        if (sql === 'COMMIT')
          fire((phases.get(pid) ?? 'other') + '-before-commit');
        const result = await execute();
        if (sql.startsWith('DELETE FROM authentication.google_identity'))
          fire('remove-after-row-delete');
        if (sql === 'COMMIT')
          fire((phases.get(pid) ?? 'other') + '-after-commit');
        return result;
      });
      if (crash.includes('checkpoint') || crash.includes('witness'))
        ledger.faults.add(crash);
      if (crash.includes('destroy')) managed.faults.add(crash);
      const first = await components(connections).deletion.begin(
        target.actorId,
      );
      expect(first.status).not.toBe('complete');
      if (crash.includes('checkpoint') || crash.includes('witness'))
        expect(ledger.events).toContain(crash);
      else if (crash.includes('destroy'))
        expect(managed.events).toContain(crash);
      else expect(fired).toBe(true);
      if (crash.includes('prepared')) {
        expect(
          authenticationDatabaseRow(
            (
              await observer.query(
                'SELECT state FROM authentication.actor WHERE actor_id=$1',
                [target.actorId],
              )
            ).rows[0],
          ).state,
        ).toBe('active');
        expect(await count('deletion_intent')).toBe(0);
        expect(
          managed
            .inventory({
              recordKind: 'google-identity',
              keyScopeId: target.actorId,
            })
            .some((version) => version.mode === 'destroyed'),
        ).toBe(false);
      }
      ledger.faults.clear();
      managed.faults.clear();
      const control = syntheticAuthenticationRestoreControl(managed, ledger);
      const runId = randomUUID();
      await control.control.close(runId);
      await restoreBackup(snapshot, control);
      ledger.evidence = ledger.restartVerifier();
      let result = await components(pool, control).restore.run(runId, manifest);
      if (crash === 'before-actor-deletion-prepared-checkpoint') {
        expect(result.status).toBe('quarantined');
        expect(control.isClosed()).toBe(true);
        expect(
          authenticationDatabaseRow(
            (
              await observer.query(
                'SELECT state FROM authentication.actor WHERE actor_id=$1',
                [target.actorId],
              )
            ).rows[0],
          ).state,
        ).toBe('active');
        expect(await count('google_identity')).toBe(2);
        return;
      }
      const partialWitness =
        crash === 'after-actor-deletion-prepared-checkpoint' ||
        crash === 'before-actor-deletion-prepared-witness' ||
        crash === 'after-actor-deletion-complete-checkpoint' ||
        crash === 'before-actor-deletion-complete-witness';
      if (partialWitness) {
        expect(result.status).toBe('quarantined');
        expect(control.isClosed()).toBe(true);
        ledger.repairWitness();
        ledger.evidence = ledger.restartVerifier();
        result = await components(pool, control).restore.run(runId, manifest);
      }
      expect(result).toEqual({ status: 'complete' });
      expect(await count('session_record')).toBe(0);
      expect(await count('login_attempt')).toBe(0);
      const targetRow = authenticationDatabaseRow(
        (
          await observer.query(
            'SELECT state FROM authentication.actor WHERE actor_id=$1',
            [target.actorId],
          )
        ).rows[0],
      );
      expect(targetRow.state).toBe('disabled');
      expect(
        (
          await observer.query(
            'SELECT 1 FROM authentication.google_identity WHERE actor_id=$1',
            [target.actorId],
          )
        ).rows,
      ).toHaveLength(0);
      const versions = managed.inventory({
        recordKind: 'google-identity',
        keyScopeId: target.actorId,
      });
      expect(versions).toHaveLength(2);
      expect(versions.every((version) => version.mode === 'destroyed')).toBe(
        true,
      );
      expect(
        authenticationDatabaseRow(
          (
            await observer.query(
              'SELECT state FROM authentication.deletion_intent WHERE operation_id=$1',
              [first.operationId],
            )
          ).rows[0],
        ).state,
      ).toBe('complete');
      expect(
        authenticationDatabaseRow(
          (
            await observer.query(
              'SELECT state FROM authentication.actor WHERE actor_id=$1',
              [retained.actorId],
            )
          ).rows[0],
        ).state,
      ).toBe('active');
      expect(
        authenticationDatabaseRow(
          (await observer.query('SELECT epoch FROM authentication.key_state'))
            .rows[0],
        ).epoch,
      ).not.toBe(ids.epoch);
      expect(
        await store.withSession(
          retained.command.sessionSecret,
          'inspect',
          clock,
          (_actor, scope) => Promise.resolve(scope.serialize(null)),
        ),
      ).toEqual({ status: 'unauthenticated' });
    },
  );
  it('活動leaseが保持するSessionをSKIPし、idle更新後の新期限で再判定する', async () => {
    const { command } = await login();
    const session = authenticationDatabaseRow(
      (
        await observer.query(
          'SELECT session_id,idle_expires_at_ms FROM authentication.session_record',
        )
      ).rows[0],
    );
    const expiry = Number(session.idle_expires_at_ms);
    now = expiry - 1;
    const entered = deferred();
    const release = deferred();
    const writers = wrappedPool(async (_sql, _values, execute) => execute());
    const active = createPostgresAuthenticationStore({
      pool: writers,
      codec,
      digests,
      scopes: createAuthenticationTransactionScopes(),
    });
    const activity = active.withSession(
      command.sessionSecret,
      'activity',
      clock,
      async (_actor, scope) => {
        entered.resolve();
        await release.promise;
        return scope.serialize(null);
      },
    );
    try {
      await bounded(entered.promise);
      await proveSessionLock(
        session.session_id as string,
        writers.pids.at(-1)!,
      );
      now = expiry;
      const cleaners = wrappedPool(async (_sql, _values, execute) => execute());
      const job = createPostgresAuthenticationCleanup({
        pool: cleaners,
        codec,
        digests,
        keys: destruction,
        clock,
      });
      const result = await job.deleteExpired(10);
      expect(result.status).toBe('committed');
      if (result.status === 'committed')
        expect(result.oldest?.dueAt).toBe(expiry);
      expect(cleaners.pids[0]).not.toBe(writers.pids.at(-1));
      expect(await count('session_record')).toBe(1);
    } finally {
      release.resolve();
    }
    expect((await bounded(activity)).status).toBe('authenticated');
    const updated = authenticationDatabaseRow(
      (
        await observer.query(
          'SELECT idle_expires_at_ms FROM authentication.session_record',
        )
      ).rows[0],
    );
    expect(Number(updated.idle_expires_at_ms)).toBeGreaterThan(expiry);
    expect((await cleanup.deleteExpired(10)).status).toBe('committed');
    expect(await count('session_record')).toBe(1);
    now = Number(updated.idle_expires_at_ms);
    expect((await cleanup.deleteExpired(10)).status).toBe('committed');
    expect(await count('session_record')).toBe(0);
  }, 15000);
  it('清掃が先ならLogoutはhint消失を拒否し、再試行は冪等成功する', async () => {
    const { command } = await login();
    now += 86_400_000;
    const entered = deferred();
    const release = deferred();
    const cleaners = wrappedPool(async (sql, _values, execute) => {
      if (sql.startsWith('DELETE FROM authentication.session_record')) {
        entered.resolve();
        await release.promise;
      }
      return execute();
    });
    const job = createPostgresAuthenticationCleanup({
      pool: cleaners,
      codec,
      digests,
      keys: destruction,
      clock,
    });
    const cleaning = job.deleteExpired(10);
    const writers = wrappedPool(async (_sql, _values, execute) => execute());
    const active = createPostgresAuthenticationStore({
      pool: writers,
      codec,
      digests,
      scopes: createAuthenticationTransactionScopes(),
    });
    let logout: ReturnType<typeof active.revoke> | undefined;
    try {
      await bounded(entered.promise);
      logout = active.revoke(command.sessionSecret, clock);
      await blockedBy(() => writers.pids.at(-1), cleaners.pids.at(-1)!);
    } finally {
      release.resolve();
    }
    expect((await bounded(cleaning)).status).toBe('committed');
    // A4bの既存契約: 非locking hintがLock取得時に消失したらunavailable。
    expect(await bounded(logout)).toEqual({ status: 'unavailable' });
    expect(await active.revoke(command.sessionSecret, clock)).toEqual({
      status: 'logged-out',
    });
    expect(await count('session_record')).toBe(0);
  }, 15000);
  it('completeのAttempt leaseを清掃が追い越さず、消費後のterminalAtへ再照合する', async () => {
    const command = await begin();
    now += 299999;
    const entered = deferred();
    const release = deferred();
    const writers = wrappedPool(async (sql, _values, execute) => {
      if (sql.startsWith('UPDATE authentication.login_attempt')) {
        entered.resolve();
        await release.promise;
      }
      return execute();
    });
    const active = createPostgresAuthenticationStore({
      pool: writers,
      codec,
      digests,
      scopes: createAuthenticationTransactionScopes(),
    });
    const completing = active.complete(command, clock);
    try {
      await bounded(entered.promise);
      now += 1;
      expect((await cleanup.deleteExpired(10)).status).toBe('committed');
      expect(await count('login_attempt')).toBe(1);
      expect(await count('actor')).toBe(0);
    } finally {
      release.resolve();
    }
    expect((await bounded(completing)).status).toBe('authenticated');
    expect((await cleanup.deleteExpired(10)).status).toBe('committed');
    expect(await count('login_attempt')).toBe(0);
    expect(await count('actor')).toBe(1);
    expect(await count('session_record')).toBe(1);
  }, 15000);
  it('Attempt清掃が先ならcompleteは実PIDで待機し、ActorやSessionを登録しない', async () => {
    const command = await begin();
    now += 300000;
    const entered = deferred();
    const release = deferred();
    const cleaners = wrappedPool(async (sql, _values, execute) => {
      if (sql.startsWith('DELETE FROM authentication.login_attempt')) {
        entered.resolve();
        await release.promise;
      }
      return execute();
    });
    const job = createPostgresAuthenticationCleanup({
      pool: cleaners,
      codec,
      digests,
      keys: destruction,
      clock,
    });
    const cleaning = job.deleteExpired(10);
    const writers = wrappedPool(async (_sql, _values, execute) => execute());
    const active = createPostgresAuthenticationStore({
      pool: writers,
      codec,
      digests,
      scopes: createAuthenticationTransactionScopes(),
    });
    let completing: ReturnType<typeof active.complete> | undefined;
    try {
      await bounded(entered.promise);
      completing = active.complete(command, clock);
      await blockedBy(() => writers.pids.at(-1), cleaners.pids.at(-1)!);
    } finally {
      release.resolve();
    }
    expect((await bounded(cleaning)).status).toBe('committed');
    expect(await bounded(completing)).toEqual({ status: 'unavailable' });
    expect(await active.complete(command, clock)).toEqual({
      status: 'restart-required',
    });
    expect(await count('actor')).toBe(0);
    expect(await count('session_record')).toBe(0);
  }, 15000);
  it('Rotation排他Lock待機後のClockで期限を再取得する', async () => {
    await begin();
    now += 299999;
    const rotation = await pool.connect();
    try {
      const pid = Number(
        authenticationDatabaseRow(
          (await rotation.query('SELECT pg_backend_pid() AS pid')).rows[0],
        ).pid,
      );
      await rotation.query('BEGIN');
      await rotation.query(
        'SELECT 1 FROM authentication.key_state WHERE state_id=1 FOR UPDATE',
      );
      const cleaners = wrappedPool(async (_sql, _values, execute) => execute());
      const job = createPostgresAuthenticationCleanup({
        pool: cleaners,
        codec,
        digests,
        keys: destruction,
        clock,
      });
      const cleaning = job.deleteExpired(10);
      try {
        await blockedBy(() => cleaners.pids.at(-1), pid);
        now += 1;
      } finally {
        await rotation.query('COMMIT');
      }
      expect((await bounded(cleaning)).status).toBe('committed');
      expect(await count('login_attempt')).toBe(0);
    } finally {
      rotation.release();
    }
  }, 15000);
  it('無効化は活動leaseの共通commitを待ち、その後だけ全Sessionを除去する', async () => {
    const { command, actorId } = await login();
    const entered = deferred();
    const release = deferred();
    const writers = wrappedPool(async (_sql, _values, execute) => execute());
    const active = createPostgresAuthenticationStore({
      pool: writers,
      codec,
      digests,
      scopes: createAuthenticationTransactionScopes(),
    });
    const activity = active.withSession(
      command.sessionSecret,
      'activity',
      clock,
      async (_actor, scope) => {
        entered.resolve();
        await release.promise;
        return scope.serialize(null);
      },
    );
    const removers = wrappedPool(async (_sql, _values, execute) => execute());
    let removing:
      | ReturnType<
          ReturnType<typeof createAuthenticationDeletionService>['begin']
        >
      | undefined;
    try {
      await bounded(entered.promise);
      removing = components(removers).deletion.begin(actorId);
      await blockedBy(() => removers.pids.at(-1), writers.pids.at(-1)!);
    } finally {
      release.resolve();
    }
    expect((await bounded(activity)).status).toBe('authenticated');
    expect((await bounded(removing)).status).toBe('complete');
    expect(await count('session_record')).toBe(0);
    expect(
      authenticationDatabaseRow(
        (await observer.query('SELECT state FROM authentication.actor'))
          .rows[0],
      ).state,
    ).toBe('disabled');
  }, 15000);
  it('Restore隔離は既存leaseをdrainし、隔離commit後のCallbackを実行しない', async () => {
    const { command } = await login();
    const entered = deferred();
    const release = deferred();
    const writers = wrappedPool(async (_sql, _values, execute) => execute());
    const active = createPostgresAuthenticationStore({
      pool: writers,
      codec,
      digests,
      scopes: createAuthenticationTransactionScopes(),
    });
    const activity = active.withSession(
      command.sessionSecret,
      'inspect',
      clock,
      async (_actor, scope) => {
        entered.resolve();
        await release.promise;
        return scope.serialize(null);
      },
    );
    const control = syntheticAuthenticationRestoreControl(managed, ledger);
    const fence = await control.control.close(randomUUID());
    const restorers = wrappedPool(async (_sql, _values, execute) => execute());
    const restore = components(restorers, control).dbRestore;
    let isolating: ReturnType<typeof restore.isolate> | undefined;
    try {
      await bounded(entered.promise);
      isolating = restore.isolate(fence, {
        createdAt: now,
        schemaVersion: 6,
        keyStateVersion: 1,
        epoch: ids.epoch,
        checkpoint: { sequence: 0, hash: '0'.repeat(64) },
      });
      await blockedBy(() => restorers.pids.at(-1), writers.pids.at(-1)!);
    } finally {
      release.resolve();
    }
    expect((await bounded(activity)).status).toBe('authenticated');
    expect(await bounded(isolating)).toBe(2);
    let callbacks = 0;
    expect(
      await active.withSession(
        command.sessionSecret,
        'inspect',
        clock,
        (_actor, scope) => {
          return Promise.resolve().then(() => {
            callbacks += 1;
            return scope.serialize(null);
          });
        },
      ),
    ).toEqual({ status: 'unavailable' });
    expect(callbacks).toBe(0);
  }, 15000);
  const restoreCrashes = [
    'before-close',
    'after-close',
    'discard-before-commit',
    'discard-after-commit',
    'before-publish',
    'after-publish',
    'before-rotate',
    'after-rotate',
    'migrate-before-commit',
    'migrate-after-commit',
    'before-recovery-checkpoint',
    'after-recovery-checkpoint',
    'before-recovery-witness',
    'after-recovery-witness',
    'activate-before-commit',
    'activate-after-commit',
    'before-open',
    'after-open',
  ] as const;
  it.each(restoreCrashes)(
    'Restoreの%sから同run/旧Backupで安全に再開する',
    async (crash) => {
      const { command, actorId } = await login();
      const snapshot = await backup();
      const manifest = {
        createdAt: now,
        schemaVersion: 6,
        keyStateVersion: 1,
        epoch: ids.epoch,
        checkpoint: ledger.evidence.head(await ledger.evidence.latest()),
      };
      const control = syntheticAuthenticationRestoreControl(managed, ledger);
      const runId = randomUUID();
      let fired = false;
      const phases = new Map<number, string>();
      const fire = (point: string) => {
        if (point === crash && !fired) {
          fired = true;
          throw new Error('synthetic restore crash');
        }
      };
      const connections = wrappedPool(async (sql, _values, execute, pid) => {
        if (sql.startsWith('BEGIN')) phases.set(pid, 'other');
        if (sql.startsWith('DELETE FROM authentication.session_record'))
          phases.set(pid, 'discard');
        if (sql.startsWith('UPDATE authentication.key_state SET epoch='))
          phases.set(pid, 'migrate');
        if (
          sql.startsWith("UPDATE authentication.key_state SET status='active'")
        )
          phases.set(pid, 'activate');
        if (sql === 'COMMIT')
          fire((phases.get(pid) ?? 'other') + '-before-commit');
        const result = await execute();
        if (sql === 'COMMIT')
          fire((phases.get(pid) ?? 'other') + '-after-commit');
        return result;
      });
      if (crash.includes('recovery')) ledger.faults.add(crash);
      else if (crash.includes('rotate')) managed.faults.add(crash);
      else if (!crash.includes('commit')) control.faults.add(crash);
      const first = await components(connections, control).restore.run(
        runId,
        manifest,
      );
      expect(first.status).toBe(
        crash === 'before-close' || crash === 'after-close'
          ? 'unavailable'
          : 'quarantined',
      );
      if (crash === 'after-open') expect(control.isClosed()).toBe(true);
      if (crash.includes('recovery')) expect(ledger.events).toContain(crash);
      else if (crash.includes('rotate'))
        expect(managed.events).toContain(crash);
      else if (!crash.includes('commit'))
        expect(control.events).toContain(crash);
      else expect(fired).toBe(true);
      ledger.faults.clear();
      managed.faults.clear();
      control.faults.clear();
      await control.control.close(runId);
      await restoreBackup(snapshot, control);
      if (
        crash === 'after-recovery-checkpoint' ||
        crash === 'before-recovery-witness'
      ) {
        expect(
          (await components(pool, control).restore.run(runId, manifest)).status,
        ).toBe('quarantined');
        expect(control.isClosed()).toBe(true);
        ledger.repairWitness();
      }
      ledger.evidence = ledger.restartVerifier();
      const result = await components(pool, control).restore.run(
        runId,
        manifest,
      );
      expect(result).toEqual({ status: 'complete' });
      expect(await count('session_record')).toBe(0);
      expect(await count('login_attempt')).toBe(0);
      expect(await count('google_identity')).toBe(1);
      expect(
        authenticationDatabaseRow(
          (
            await observer.query(
              'SELECT actor_id FROM authentication.google_identity',
            )
          ).rows[0],
        ).actor_id,
      ).toBe(actorId);
      const state = authenticationDatabaseRow(
        (
          await observer.query(
            'SELECT status,epoch FROM authentication.key_state',
          )
        ).rows[0],
      );
      expect(state.status).toBe('active');
      expect(state.epoch).not.toBe(ids.epoch);
      expect(
        managed.inventory({
          recordKind: 'google-identity',
          keyScopeId: actorId,
        })[0].mode,
      ).toBe('read-only');
      expect(
        await store.withSession(
          command.sessionSecret,
          'inspect',
          clock,
          (_actor, scope) => Promise.resolve(scope.serialize(null)),
        ),
      ).toEqual({ status: 'unauthenticated' });
      const oldSession = snapshot.session_record[0];
      expect(
        await managed.provider.readKey({
          scope: {
            recordKind: 'session',
            keyScopeId: oldSession.session_id as string,
          },
          keyVersion: oldSession.key_version as string,
        }),
      ).toEqual({ status: 'unavailable' });
    },
  );
  it.each([
    'delete',
    'audit',
    'provider-prepare',
    'before-commit',
    'after-commit',
  ] as const)(
    '清掃の%s障害は成功にせず、durable票から再試行する',
    async (fault) => {
      const command = await begin();
      now += 300000;
      const before = await backup();
      let fired = false;
      const connections = wrappedPool(async (sql, values, execute) => {
        const target =
          (fault === 'delete' &&
            sql.startsWith('DELETE FROM authentication.login_attempt')) ||
          (fault === 'audit' &&
            sql.startsWith('INSERT INTO authentication.audit_event') &&
            values?.[3] === 'purge') ||
          (fault === 'before-commit' && sql === 'COMMIT');
        if (target && !fired) {
          fired = true;
          throw new Error('synthetic cleanup failure');
        }
        const result = await execute();
        if (fault === 'after-commit' && sql === 'COMMIT' && !fired) {
          fired = true;
          throw new Error('synthetic cleanup response loss');
        }
        return result;
      });
      if (fault === 'provider-prepare') managed.faults.add('before-prepare');
      const job = createPostgresAuthenticationCleanup({
        pool: connections,
        codec,
        digests,
        keys: destruction,
        clock,
      });
      expect(await job.deleteExpired(10)).toEqual({ status: 'unavailable' });
      if (fault === 'provider-prepare')
        expect(managed.events).toContain('before-prepare');
      else expect(fired).toBe(true);
      if (fault !== 'after-commit') expect(await backup()).toEqual(before);
      else expect(await count('login_attempt')).toBe(0);
      expect(managed.events).not.toContain('before-destroy');
      managed.faults.clear();
      const service = createAuthenticationCleanupService({
        database: cleanup,
        keys: destruction,
        clock,
        monitor: { record: () => Promise.resolve(undefined) },
      });
      expect((await service.run(10)).status).toBe('complete');
      expect(await count('login_attempt')).toBe(0);
      expect(
        managed
          .inventory({
            recordKind: 'login-attempt',
            keyScopeId: command.snapshot.recordId,
          })
          .every((version) => version.mode === 'destroyed'),
      ).toBe(true);
    },
  );
  it('無効化Audit障害はDB全体をrollbackし、外部Preparedから同operationで再開する', async () => {
    const target = await login();
    const before = await backup();
    let failures = 0;
    const connections = wrappedPool(async (sql, values, execute) => {
      if (
        sql.startsWith('INSERT INTO authentication.audit_event') &&
        values?.[3] === 'disable'
      ) {
        failures += 1;
        throw new Error('synthetic disable audit failure');
      }
      return execute();
    });
    const first = await components(connections).deletion.begin(target.actorId);
    expect(first.status).toBe('unavailable');
    expect(failures).toBe(1);
    expect(await backup()).toEqual(before);
    expect(ledger.entries.at(-1)?.record.kind).toBe('actor-deletion');
    expect(managed.events).not.toContain('before-destroy');
    expect(
      (await components().deletion.resume(first.operationId!)).status,
    ).toBe('complete');
    expect(await count('session_record')).toBe(0);
    expect(await count('google_identity')).toBe(0);
  });
  it.each([
    [35 * 86_400_000 - 1, 'complete'],
    [35 * 86_400_000, 'complete'],
    [35 * 86_400_000 + 1, 'quarantined'],
  ] as const)('実DB RestoreのBackup年齢%sは%s', async (age, expected) => {
    await login();
    const manifest = {
      createdAt: now,
      schemaVersion: 6,
      keyStateVersion: 1,
      epoch: ids.epoch,
      checkpoint: ledger.evidence.head(await ledger.evidence.latest()),
    };
    now += age;
    expect(
      (await components().restore.run(randomUUID(), manifest)).status,
    ).toBe(expected);
    if (expected === 'complete') {
      expect(await count('session_record')).toBe(0);
      expect(await count('login_attempt')).toBe(0);
    }
  });
  it('削除済みGoogle本人の再登録は新Actorとなり旧Actorの過去参照を継承しない', async () => {
    const target = await login();
    expect((await components().deletion.begin(target.actorId)).status).toBe(
      'complete',
    );
    const next = await login(51);
    expect(next.actorId).not.toBe(target.actorId);
    expect(
      authenticationDatabaseRow(
        (
          await observer.query(
            'SELECT state FROM authentication.actor WHERE actor_id=$1',
            [target.actorId],
          )
        ).rows[0],
      ).state,
    ).toBe('disabled');
    expect(await count('actor')).toBe(2);
    expect(await count('google_identity')).toBe(1);
  });
  it('外部PreparedのないDB IntentはRestoreで隔離し、鍵破棄を開始しない', async () => {
    const target = await login();
    const digest = await digests.deletedActor({
      subjectId: target.actorId,
      keyVersion: 'v1',
    });
    await observer.query(
      "INSERT INTO authentication.deletion_intent(operation_id,actor_digest_key_version,actor_digest,version,state,created_at_ms,updated_at_ms) VALUES($1,$2,$3,1,'prepared',$4,$4)",
      [randomUUID(), 'v1', Buffer.from(digest.bytes), now],
    );
    const manifest = {
      createdAt: now,
      schemaVersion: 6,
      keyStateVersion: 1,
      epoch: ids.epoch,
      checkpoint: { sequence: 0, hash: '0'.repeat(64) },
    };
    expect(
      (await components().restore.run(randomUUID(), manifest)).status,
    ).toBe('quarantined');
    expect(managed.events).not.toContain('before-destroy');
    expect(await count('google_identity')).toBe(1);
  });
  it('旧Ledger MACを読取だけに退役してもBackup削除証跡を検証でき、欠損は隔離する', async () => {
    const target = await login();
    const snapshot = await backup();
    const manifest = {
      createdAt: now,
      schemaVersion: 6,
      keyStateVersion: 1,
      epoch: ids.epoch,
      checkpoint: ledger.evidence.head(await ledger.evidence.latest()),
    };
    expect((await components().deletion.begin(target.actorId)).status).toBe(
      'complete',
    );
    ledger.rotateMac('v2');
    ledger.evidence = ledger.restartVerifier();
    const control = syntheticAuthenticationRestoreControl(managed, ledger);
    const runId = randomUUID();
    await control.control.close(runId);
    await restoreBackup(snapshot, control);
    ledger.allowedVersions.delete('v1');
    expect(
      (await components(pool, control).restore.run(runId, manifest)).status,
    ).toBe('quarantined');
    ledger.allowedVersions.add('v1');
    expect(
      (await components(pool, control).restore.run(runId, manifest)).status,
    ).toBe('complete');
    expect(ledger.entries.at(-1)?.macKeyVersion).toBe('v2');
    expect(await count('google_identity')).toBe(0);
  });
  it('Logoutが先なら清掃はSessionをSKIPし、失効terminalAtの新CAS版で再開する', async () => {
    const { command } = await login();
    const session = authenticationDatabaseRow(
      (
        await observer.query(
          'SELECT session_id,idle_expires_at_ms FROM authentication.session_record',
        )
      ).rows[0],
    );
    now = Number(session.idle_expires_at_ms) - 1;
    const entered = deferred();
    const release = deferred();
    const writers = wrappedPool(async (sql, _values, execute) => {
      if (sql.startsWith('UPDATE authentication.session_record')) {
        entered.resolve();
        await release.promise;
      }
      return execute();
    });
    const active = createPostgresAuthenticationStore({
      pool: writers,
      codec,
      digests,
      scopes: createAuthenticationTransactionScopes(),
    });
    const logout = active.revoke(command.sessionSecret, clock);
    try {
      await bounded(entered.promise);
      await proveSessionLock(
        session.session_id as string,
        writers.pids.at(-1)!,
      );
      now += 1;
      expect((await cleanup.deleteExpired(10)).status).toBe('committed');
      expect(await count('session_record')).toBe(1);
    } finally {
      release.resolve();
    }
    expect(await bounded(logout)).toEqual({ status: 'logged-out' });
    const revoked = authenticationDatabaseRow(
      (
        await observer.query(
          'SELECT state,terminal_at_ms,version FROM authentication.session_record',
        )
      ).rows[0],
    );
    expect(revoked.state).toBe('revoked');
    expect(Number(revoked.terminal_at_ms)).toBe(now - 1);
    expect(Number(revoked.version)).toBe(2);
    expect((await cleanup.deleteExpired(10)).status).toBe('committed');
    expect(await count('session_record')).toBe(0);
  }, 15000);
  it('清掃の共有key-state leaseが終わるまでRotation公開は待機する', async () => {
    await begin();
    now += 300000;
    const entered = deferred();
    const release = deferred();
    const cleaners = wrappedPool(async (sql, _values, execute) => {
      if (sql.startsWith('DELETE FROM authentication.login_attempt')) {
        entered.resolve();
        await release.promise;
      }
      return execute();
    });
    const job = createPostgresAuthenticationCleanup({
      pool: cleaners,
      codec,
      digests,
      keys: destruction,
      clock,
    });
    const cleaning = job.deleteExpired(10);
    const rotation = await pool.connect();
    const pid = Number(
      authenticationDatabaseRow(
        (await rotation.query('SELECT pg_backend_pid() AS pid')).rows[0],
      ).pid,
    );
    let rotating: Promise<void> | undefined;
    try {
      await bounded(entered.promise);
      rotating = (async () => {
        await rotation.query('BEGIN');
        await rotation.query(
          'SELECT 1 FROM authentication.key_state WHERE state_id=1 FOR UPDATE',
        );
        await rotation.query(
          'UPDATE authentication.key_state SET generation_version=generation_version+1 WHERE state_id=1',
        );
        await rotation.query('COMMIT');
      })();
      await blockedBy(() => pid, cleaners.pids.at(-1)!);
    } finally {
      release.resolve();
    }
    try {
      expect((await bounded(cleaning)).status).toBe('committed');
      await bounded(rotating);
      expect(
        Number(
          authenticationDatabaseRow(
            (
              await observer.query(
                'SELECT generation_version FROM authentication.key_state',
              )
            ).rows[0],
          ).generation_version,
        ),
      ).toBe(2);
    } finally {
      rotation.release();
    }
  }, 15000);
  it('無効化commitが先なら待機したSession照会のCallbackを実行しない', async () => {
    const { command, actorId } = await login();
    const entered = deferred();
    const release = deferred();
    const remove = deferred();
    const phases = new Map<number, string>();
    let disabled = false;
    const removers = wrappedPool(async (sql, values, execute, pid) => {
      if (sql.startsWith('BEGIN')) phases.set(pid, 'other');
      if (
        sql.startsWith('INSERT INTO authentication.audit_event') &&
        values?.[3] === 'disable'
      )
        phases.set(pid, 'disable');
      if (sql === 'COMMIT' && phases.get(pid) === 'disable') {
        entered.resolve();
        await release.promise;
      }
      if (
        disabled &&
        sql.includes('FROM authentication.actor WHERE actor_id=$1 FOR UPDATE')
      )
        await remove.promise;
      const result = await execute();
      if (sql === 'COMMIT' && phases.get(pid) === 'disable') disabled = true;
      return result;
    });
    const removing = components(removers).deletion.begin(actorId);
    const readers = wrappedPool(async (_sql, _values, execute) => execute());
    const active = createPostgresAuthenticationStore({
      pool: readers,
      codec,
      digests,
      scopes: createAuthenticationTransactionScopes(),
    });
    let callbacks = 0;
    try {
      await bounded(entered.promise);
      const reading = active.withSession(
        command.sessionSecret,
        'inspect',
        clock,
        (_actor, scope) => {
          return Promise.resolve().then(() => {
            callbacks += 1;
            return scope.serialize(null);
          });
        },
      );
      await blockedBy(() => readers.pids.at(-1), removers.pids.at(-1)!);
      release.resolve();
      expect(await bounded(reading)).toEqual({ status: 'unauthenticated' });
      expect(callbacks).toBe(0);
    } finally {
      release.resolve();
      remove.resolve();
    }
    expect((await bounded(removing)).status).toBe('complete');
    expect(await count('session_record')).toBe(0);
  }, 15000);
  it('最古overdueをSKIP LOCKEDで隠さず監視し、lease drain後にDBを封鎖する', async () => {
    await login();
    // 消費済みAttemptを先に除去して、Sessionだけの期限監視を確認する。
    expect((await cleanup.deleteExpired(10)).status).toBe('committed');
    for (const ticket of await destruction.pendingCredentials(10)) {
      const proof = await destruction.destroy(ticket);
      expect(await destruction.verify(proof, ticket)).toBe(true);
    }
    now += 2 * 86_400_000;
    const owner = await pool.connect();
    const signals = deferred();
    const cleaners = wrappedPool(async (sql, _values, execute) => {
      if (
        sql ===
        'SELECT status,generation_version FROM authentication.key_state WHERE state_id=1 FOR UPDATE'
      )
        signals.resolve();
      return execute();
    });
    const alerts: string[] = [];
    const job = createPostgresAuthenticationCleanup({
      pool: cleaners,
      codec,
      digests,
      keys: destruction,
      clock,
    });
    const service = createAuthenticationCleanupService({
      database: job,
      keys: destruction,
      clock,
      monitor: {
        record: (event) => {
          return Promise.resolve().then(() => {
            alerts.push(event.code);
          });
        },
      },
    });
    let running: ReturnType<typeof service.run> | undefined;
    try {
      const pid = Number(
        authenticationDatabaseRow(
          (await owner.query('SELECT pg_backend_pid() AS pid')).rows[0],
        ).pid,
      );
      await owner.query('BEGIN');
      await owner.query(
        'SELECT 1 FROM authentication.key_state WHERE state_id=1 FOR SHARE',
      );
      await owner.query(
        'SELECT 1 FROM authentication.session_record FOR UPDATE',
      );
      running = service.run(10);
      await bounded(signals.promise);
      await blockedBy(() => cleaners.pids.at(-1), pid);
      expect(await count('session_record')).toBe(1);
    } finally {
      await owner.query('ROLLBACK');
      owner.release();
    }
    expect(await bounded(running)).toEqual({ status: 'quarantined' });
    expect(alerts).toContain('OVERDUE');
    expect(
      authenticationDatabaseRow(
        (await observer.query('SELECT status FROM authentication.key_state'))
          .rows[0],
      ).status,
    ).toBe('quarantined');
    expect((await cleanup.deleteExpired(10)).status).toBe('committed');
    expect(await count('session_record')).toBe(0);
  }, 15000);
});
