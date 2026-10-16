import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Client, Pool, type QueryResult } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { applySqlMigrations } from '../src/group-management/infrastructure/postgres/sql-migration.js';
import type {
  AuthenticationMacKeyPorts,
  AuthenticationMacPurpose,
} from '../src/shared/application/authentication/authentication-crypto-keys.js';
import { authenticationLifetime as ttl } from '../src/shared/application/authentication/authentication-ports.js';
import type {
  AuthenticationSerializedValue,
  AuthenticationTransactionScope,
} from '../src/shared/application/authentication/authentication-transaction-scope.js';
import {
  createAuthenticationDigests,
  importAuthenticationMacKey,
} from '../src/shared/infrastructure/authentication/authentication-digests.js';
import { createAuthenticationRecordCodec } from '../src/shared/infrastructure/authentication/authentication-record-codec.js';
import { createAuthenticationTransactionScopes } from '../src/shared/infrastructure/authentication/postgres/authentication-transaction-scopes.js';
import { createPostgresAuthenticationStore } from '../src/shared/infrastructure/authentication/postgres/postgres-authentication-store.js';
import {
  readStoredAuthenticationActor,
  readStoredAuthenticationSession,
  updateAuthenticationRecord,
} from '../src/shared/infrastructure/authentication/postgres/authentication-record-rows.js';
import type { AuthenticationConnectionPool } from '../src/shared/infrastructure/authentication/postgres/authentication-transactions.js';
import {
  SyntheticKeyRegistry,
  ids,
} from '../src/shared/infrastructure/authentication/test/authentication-crypto-fixtures.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';
const secret = (value: number) => Buffer.alloc(32, value).toString('base64url');
const identity = {
  issuer: 'https://accounts.google.com' as const,
  subject: 'Synthetic-store-subject',
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
] as const;

const keyPort = <P extends AuthenticationMacPurpose>(
  purpose: P,
  material: number,
) => ({
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
        Buffer.alloc(32, material + (keyVersion === 'v2' ? 100 : 0)),
      ),
    }),
});
const keys: AuthenticationMacKeyPorts = {
  identity: keyPort('auth-google-identity/v1', 101),
  attemptCookie: keyPort('auth-attempt-cookie/v1', 102),
  sessionCookie: keyPort('auth-session-cookie/v1', 103),
  actorState: keyPort('auth-actor-state/v1', 104),
  auditActor: keyPort('auth-audit-actor/v1', 105),
  auditAttempt: keyPort('auth-audit-attempt/v1', 106),
  auditSession: keyPort('auth-audit-session/v1', 107),
  deletedActor: keyPort('auth-deleted-actor/v1', 108),
};

describe('PostgreSQL認証Store', () => {
  const observer = new Client({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  let owned = false;
  let migrationSchema = '';
  let now = 1_000_000;
  const clock = { now: () => now };
  let registry: SyntheticKeyRegistry;
  let scopes: ReturnType<typeof createAuthenticationTransactionScopes>;
  let store: ReturnType<typeof createPostgresAuthenticationStore>;
  let codec: ReturnType<typeof createAuthenticationRecordCodec>;
  let digests: ReturnType<typeof createAuthenticationDigests>;
  const makeStore = (connections: AuthenticationConnectionPool = pool) =>
    createPostgresAuthenticationStore({
      pool: connections,
      scopes,
      digests,
      codec,
    });
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const rows = async () => {
    const result: Record<string, unknown> = {};
    for (const table of [
      'actor',
      'google_identity',
      'identity_alias',
      'session_record',
      'login_attempt',
      'audit_event',
    ]) {
      result[table] = (
        await observer.query(
          `SELECT * FROM authentication.${table} ORDER BY 1, 2`,
        )
      ).rows;
    }
    return result;
  };
  const wrappedPool = (
    intercept: (
      sql: string,
      execute: () => Promise<QueryResult>,
      pid: number,
    ) => Promise<QueryResult>,
  ): AuthenticationConnectionPool & { pids: number[] } => {
    const pids: number[] = [];
    return {
      pids,
      connect: async () => {
        const connection = await pool.connect();
        const pid = (
          await connection.query<{ pid: number }>(
            'SELECT pg_backend_pid() AS pid',
          )
        ).rows[0].pid;
        pids.push(pid);
        return {
          query: (sql: string, values?: unknown[]) =>
            intercept(sql, () => connection.query(sql, values), pid),
          release: (destroy?: boolean) => connection.release(destroy),
        };
      },
    };
  };
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('合成barrierの待機期限超過')),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const waitForBlock = async (
    waiter: () => number | undefined,
    owner: number,
  ) => {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const pid = waiter();
      if (pid !== undefined) {
        const result = await observer.query<{ blockers: number[] }>(
          'SELECT pg_blocking_pids($1) AS blockers',
          [pid],
        );
        if (result.rows[0]?.blockers.includes(owner)) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('異なるbackend間のLock待機を観測できない');
  };
  const disableActor = async (
    actorId: string,
    onConnect: (pid: number) => void,
  ) => {
    const connection = await pool.connect();
    try {
      onConnect(
        (
          await connection.query<{ pid: number }>(
            'SELECT pg_backend_pid() AS pid',
          )
        ).rows[0].pid,
      );
      await connection.query('BEGIN');
      await connection.query(
        'SELECT * FROM authentication.key_state WHERE state_id = 1 FOR SHARE',
      );
      const actor = readStoredAuthenticationActor(
        (
          await connection.query(
            'SELECT * FROM authentication.actor WHERE actor_id = $1 FOR UPDATE',
            [actorId],
          )
        ).rows[0],
      );
      expect(
        await digests.verifyActorState({
          row: actor.row,
          keyVersion: actor.keyVersion,
          mac: actor.mac,
        }),
      ).toBe(true);
      const disabled = {
        ...actor.row,
        state: 'disabled' as const,
        version: actor.row.version + 1,
        disabledAt: now,
      };
      const mac = await digests.actorState({ row: disabled, keyVersion: 'v1' });
      await connection.query(
        "UPDATE authentication.actor SET state = 'disabled', version = $2, disabled_at_ms = $3, control_key_version = $4, state_mac = $5 WHERE actor_id = $1 AND version = $6",
        [
          actorId,
          disabled.version,
          now,
          mac.keyVersion,
          Buffer.from(mac.bytes),
          actor.row.version,
        ],
      );
      const sessions = await connection.query(
        'SELECT * FROM authentication.session_record WHERE actor_id = $1 ORDER BY session_id FOR UPDATE',
        [actorId],
      );
      for (const value of sessions.rows as unknown[]) {
        const session = readStoredAuthenticationSession(value);
        const secrets = await codec.open(session);
        if (session.row.state === 'revoked') continue;
        const revoked = {
          ...session.row,
          state: 'revoked' as const,
          version: session.row.version + 1,
          terminalAt: now,
        };
        await updateAuthenticationRecord(
          connection,
          revoked,
          await codec.seal({ row: revoked, secrets }),
          session.row.version,
        );
      }
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  };

  beforeAll(async () => {
    await observer.connect();
    const database = await observer.query<{ name: string }>(
      'SELECT current_database() AS name',
    );
    if (!database.rows[0]?.name.endsWith('_test'))
      throw new Error('末尾_testのDBが必要');
    await observer.query('SELECT pg_advisory_lock(1801546597, 1635087464)');
    const schema = await observer.query<{ oid: number | null }>(
      "SELECT to_regnamespace('authentication')::oid AS oid",
    );
    if (schema.rows[0]?.oid !== null)
      throw new Error('既存認証SchemaのあるDBでは検証不可');
    migrationSchema = `test_issue_216_${randomUUID().replaceAll('-', '')}`;
    await observer.query(`CREATE SCHEMA ${migrationSchema}`);
    owned = true;
    await observer.query(`SET search_path TO ${migrationSchema}`);
    const migrations = await Promise.all(
      ([5, 6] as const).map(async (version) => ({
        version,
        name:
          version === 5 ? 'authentication-schema' : 'authentication-inventory',
        sql: await readFile(
          resolve(
            import.meta.dirname,
            `../migrations/authentication/${version === 5 ? '0005_authentication_schema' : '0006_authentication_inventory'}.sql`,
          ),
          'utf8',
        ),
      })),
    );
    await applySqlMigrations(observer, migrations);
    await observer.query(
      `CREATE TABLE ${migrationSchema}.participant_write (label text NOT NULL, pid integer NOT NULL DEFAULT pg_backend_pid())`,
    );
  });

  beforeEach(async () => {
    now = 1_000_000;
    await observer.query(`TRUNCATE ${migrationSchema}.participant_write`);
    await observer.query(
      'TRUNCATE authentication.audit_event, authentication.identity_alias, authentication.google_identity, authentication.login_attempt, authentication.session_record, authentication.actor, authentication.key_generation',
    );
    await observer.query(
      "UPDATE authentication.key_state SET status = 'active', generation_version = 1, epoch = $1",
      [ids.epoch],
    );
    for (const purpose of purposes) {
      await observer.query(
        `INSERT INTO authentication.key_generation
        (generation_id, purpose, key_version, epoch, searchable, write_required)
        VALUES ($1, $2, 'v1', $3, true, true)`,
        [randomUUID(), purpose, purpose.endsWith('cookie') ? ids.epoch : null],
      );
    }
    registry = new SyntheticKeyRegistry();
    scopes = createAuthenticationTransactionScopes();
    codec = {
      ...createAuthenticationRecordCodec({ keys: registry.provider() }),
    };
    digests = { ...createAuthenticationDigests({ keys }) };
    store = makeStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.end();
    if (owned) {
      await observer.query('SET search_path TO public');
      await observer.query('DROP SCHEMA authentication CASCADE');
      await observer.query(`DROP SCHEMA ${migrationSchema} CASCADE`);
    }
    await observer.end();
  });

  const begin = async (value = 1) => {
    const command = {
      attemptSecret: secret(value),
      csrf: secret(value + 1),
      nonce: secret(value + 2),
    };
    expect(await store.begin(command, clock)).toEqual({
      status: 'started',
      expiresAt: now + ttl.attempt,
    });
    const read = await store.readAttempt(command, clock);
    expect(read.status).toBe('ready');
    if (read.status !== 'ready') throw new Error('合成試行が必要');
    return {
      ...command,
      snapshot: read.snapshot,
      identity,
      sessionSecret: secret(value + 3),
      sessionCsrf: secret(value + 4),
    };
  };

  it('参加SELECT INTOは実接続へ送信せず、握り潰しても共通commitしない', async () => {
    const command = await begin();
    expect((await store.complete(command, clock)).status).toBe('authenticated');
    const before = await rows();
    let ddlQueriesSent = 0;
    store = makeStore(
      wrappedPool(async (sql, execute) => {
        if (/^SELECT 1 INTO/.test(sql)) ddlQueriesSent += 1;
        return execute();
      }),
    );
    expect(
      await store.withSession(
        command.sessionSecret,
        'activity',
        clock,
        async (_actor, scope) => {
          await expect(
            scopes.participants.query(
              scope,
              `SELECT 1 INTO ${migrationSchema}.forbidden_scope_table`,
            ),
          ).rejects.toThrow();
          return scope.serialize(null);
        },
      ),
    ).toEqual({ status: 'unavailable' });
    expect(ddlQueriesSent).toBe(0);
    expect(
      (
        await observer.query<{ found: string | null }>(
          'SELECT to_regclass($1)::text AS found',
          [`${migrationSchema}.forbidden_scope_table`],
        )
      ).rows,
    ).toEqual([{ found: null }]);
    expect(await rows()).toEqual(before);
  });

  it('5操作を実保存しinspect不延長・activity延長・Logout後拒否を満たす', async () => {
    const command = await begin();
    expect(await store.complete(command, clock)).toEqual({
      status: 'authenticated',
      absoluteExpiresAt: now + ttl.absolute,
    });
    const initial = await observer.query(
      'SELECT version, idle_expires_at_ms FROM authentication.session_record',
    );
    now += 10_000;
    const response = await store.withSession(
      command.sessionSecret,
      'inspect',
      clock,
      (_actor, scope) => Promise.resolve(scope.serialize({ allowed: true })),
    );
    expect(response).toEqual({
      status: 'authenticated',
      value: { body: '{"allowed":true}' },
    });
    expect(
      (
        await observer.query(
          'SELECT version, idle_expires_at_ms FROM authentication.session_record',
        )
      ).rows,
    ).toEqual(initial.rows);
    expect(
      (
        await store.withSession(
          command.sessionSecret,
          'activity',
          clock,
          (_actor, scope) => Promise.resolve(scope.serialize(null)),
        )
      ).status,
    ).toBe('authenticated');
    expect(
      (
        await observer.query(
          'SELECT version, idle_expires_at_ms FROM authentication.session_record',
        )
      ).rows,
    ).toEqual([{ version: '2', idle_expires_at_ms: String(now + ttl.idle) }]);
    expect(await store.revoke(command.sessionSecret, clock)).toEqual({
      status: 'logged-out',
    });
    expect(
      await store.withSession(command.sessionSecret, 'inspect', clock, () =>
        Promise.resolve().then(() => {
          throw new Error('実行禁止');
        }),
      ),
    ).toEqual({ status: 'unauthenticated' });
    expect(
      (
        await observer.query(
          'SELECT action, decision FROM authentication.audit_event ORDER BY occurred_at_ms, action',
        )
      ).rowCount,
    ).toBe(7);
  });

  it('旧ready試行を置換し、Session有効時の再loginをAudit付きで拒否する', async () => {
    const first = await begin();
    const next = {
      attemptSecret: secret(11),
      nonce: secret(12),
      csrf: secret(13),
      previousAttemptSecret: first.attemptSecret,
    };
    expect((await store.begin(next, clock)).status).toBe('started');
    expect(await store.readAttempt(first, clock)).toEqual({
      status: 'restart-required',
    });
    const second = await store.readAttempt(next, clock);
    if (second.status !== 'ready') throw new Error('合成試行が必要');
    expect(
      (
        await store.complete(
          { ...first, ...next, snapshot: second.snapshot },
          clock,
        )
      ).status,
    ).toBe('authenticated');
    const snapshot = await rows();
    expect(
      await store.begin(
        {
          ...next,
          attemptSecret: secret(21),
          currentSessionSecret: first.sessionSecret,
        },
        clock,
      ),
    ).toEqual({ status: 'already-authenticated' });
    expect(
      (
        await observer.query(
          'SELECT state, version FROM authentication.login_attempt ORDER BY created_at_ms, state',
        )
      ).rows,
    ).toEqual([
      { state: 'consumed', version: '2' },
      { state: 'replaced', version: '2' },
    ]);
    expect((await rows()).session_record).toEqual(snapshot.session_record);
    expect(
      (
        await observer.query(
          "SELECT decision, reason FROM authentication.audit_event WHERE action = 'begin' AND decision = 'deny'",
        )
      ).rows,
    ).toEqual([{ decision: 'deny', reason: 'already-authenticated' }]);
  });

  it.each(['recordId', 'version', 'nonce', 'expiresAt'] as const)(
    'snapshotの%s不一致は未消費のまま拒否する',
    async (field) => {
      const command = await begin();
      const replacements = {
        recordId: ids.other,
        version: 2,
        nonce: secret(99),
        expiresAt: command.snapshot.expiresAt + 1,
      };
      expect(
        await store.complete(
          {
            ...command,
            snapshot: { ...command.snapshot, [field]: replacements[field] },
          },
          clock,
        ),
      ).toEqual({ status: 'restart-required' });
      expect(
        (
          await observer.query(
            'SELECT state, version FROM authentication.login_attempt',
          )
        ).rows,
      ).toEqual([{ state: 'ready', version: '1' }]);
      expect(
        (await observer.query('SELECT * FROM authentication.actor')).rowCount,
      ).toBe(0);
    },
  );

  it('Attempt期限等値とCSRF違反は本人性を作らず拒否する', async () => {
    const command = await begin();
    expect(
      await store.readAttempt({ ...command, csrf: secret(99) }, clock),
    ).toEqual({ status: 'restart-required' });
    now = command.snapshot.expiresAt;
    expect(await store.readAttempt(command, clock)).toEqual({
      status: 'restart-required',
    });
    expect(await store.complete(command, clock)).toEqual({
      status: 'restart-required',
    });
    expect(
      (await observer.query('SELECT * FROM authentication.session_record'))
        .rowCount,
    ).toBe(0);
  });

  it.each(['uninitialized', 'restoring', 'quarantined'] as const)(
    '鍵State %s は保存を開始しない',
    async (status) => {
      await observer.query(
        'UPDATE authentication.key_state SET status = $1, epoch = $2',
        [status, status === 'uninitialized' ? null : ids.epoch],
      );
      expect(
        await store.begin(
          { attemptSecret: secret(1), csrf: secret(2), nonce: secret(3) },
          clock,
        ),
      ).toEqual({ status: 'unavailable' });
      expect(
        (await observer.query('SELECT * FROM authentication.audit_event'))
          .rowCount,
      ).toBe(0);
    },
  );

  it('Cookie missはDEK読取・openなしで拒否Auditを保存する', async () => {
    const open = vi.spyOn(codec, 'open');
    expect(
      await store.readAttempt(
        { attemptSecret: secret(91), csrf: secret(92) },
        clock,
      ),
    ).toEqual({ status: 'restart-required' });
    expect(
      await store.withSession(secret(93), 'inspect', clock, () =>
        Promise.resolve().then(() => {
          throw new Error('実行禁止');
        }),
      ),
    ).toEqual({ status: 'unauthenticated' });
    expect(await store.revoke(secret(94), clock)).toEqual({
      status: 'logged-out',
    });
    expect(open).not.toHaveBeenCalled();
    expect(
      (
        await observer.query(
          'SELECT actor_digest, attempt_digest, session_digest FROM authentication.audit_event',
        )
      ).rows,
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        actor_digest: null,
        attempt_digest: null,
        session_digest: null,
      })),
    );
  });

  it.each([
    'actor',
    'google_identity',
    'identity_alias',
    'session_record',
    'attempt-cas',
    'audit_event',
  ] as const)(
    '%s段の故障は新規Actorから消費・Auditまで全rollbackする',
    async (point) => {
      const command = await begin();
      const original = await rows();
      store = makeStore(
        wrappedPool(async (sql, execute) => {
          const matches =
            point === 'attempt-cas'
              ? sql.startsWith('UPDATE authentication.login_attempt')
              : sql.startsWith(`INSERT INTO authentication.${point} `);
          if (matches) throw new Error('合成SQL障害');
          return execute();
        }),
      );
      expect(await store.complete(command, clock)).toEqual({
        status: 'unavailable',
      });
      expect(await rows()).toEqual(original);
    },
  );

  it('拒否Auditの失敗も成功や再開始に変換しない', async () => {
    const command = await begin();
    const original = await rows();
    store = makeStore(
      wrappedPool(async (sql, execute) => {
        if (sql.startsWith('INSERT INTO authentication.audit_event'))
          throw new Error('合成Audit障害');
        return execute();
      }),
    );
    expect(
      await store.readAttempt({ ...command, csrf: secret(99) }, clock),
    ).toEqual({ status: 'unavailable' });
    expect(await rows()).toEqual(original);
  });

  it('参加書込み・idle更新・Auditは同一backend PIDとTransactionでcommitする', async () => {
    const command = await begin();
    await store.complete(command, clock);
    now += 10_000;
    expect(
      (
        await store.withSession(
          command.sessionSecret,
          'activity',
          clock,
          async (_actor, scope) => {
            await scopes.participants.query(
              scope,
              `INSERT INTO ${migrationSchema}.participant_write (label) VALUES ($1)`,
              ['合成業務'],
            );
            const selected = await scopes.participants.query(
              scope,
              'SELECT pg_backend_pid() AS pid',
            );
            return scope.serialize(selected.rows);
          },
        )
      ).status,
    ).toBe('authenticated');
    const participant = await observer.query<{ pid: number; xid: string }>(
      `SELECT pid, xmin::text AS xid FROM ${migrationSchema}.participant_write`,
    );
    const audit = await observer.query<{ xid: string }>(
      "SELECT xmin::text AS xid FROM authentication.audit_event WHERE action = 'activity'",
    );
    const session = await observer.query<{ xid: string }>(
      'SELECT xmin::text AS xid FROM authentication.session_record',
    );
    expect(participant.rows[0]?.xid).toBe(audit.rows[0]?.xid);
    expect(session.rows[0]?.xid).toBe(audit.rows[0]?.xid);
    expect(participant.rows[0]?.pid).not.toBe(
      (await observer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]?.pid,
    );
  });

  it.each(['throw', 'serialization', 'forged', 'foreign'] as const)(
    'Callback %sは参加書込みとidle・Auditをrollbackする',
    async (failure) => {
      const command = await begin();
      await store.complete(command, clock);
      let foreign: AuthenticationSerializedValue | undefined;
      await store.withSession(
        command.sessionSecret,
        'inspect',
        clock,
        (_actor, scope) =>
          Promise.resolve().then(() => {
            foreign = scope.serialize({ allowed: true });
            return foreign;
          }),
      );
      const original = await rows();
      now += 10_000;
      const result = await store.withSession(
        command.sessionSecret,
        'activity',
        clock,
        async (_actor, scope) => {
          await scopes.participants.query(
            scope,
            `INSERT INTO ${migrationSchema}.participant_write (label) VALUES ($1)`,
            ['rollback対象'],
          );
          if (failure === 'throw') throw new Error('合成秘密詳細');
          const own = scope.serialize({ allowed: true });
          if (failure === 'serialization') {
            try {
              scope.serialize(undefined);
            } catch {
              /* 握り潰してもcommit不可。 */
            }
            return own;
          }
          if (failure === 'foreign' && foreign !== undefined) return foreign;
          return { body: own.body } as typeof own;
        },
      );
      expect(result).toEqual({ status: 'unavailable' });
      expect(await rows()).toEqual(original);
      expect(
        (
          await observer.query(
            `SELECT * FROM ${migrationSchema}.participant_write`,
          )
        ).rowCount,
      ).toBe(0);
    },
  );

  it.each(['begin', 'read-attempt', 'complete', 'activity', 'logout'] as const)(
    '%sの実COMMIT後応答喪失はDB確定済みでも成功値を返さない',
    async (action) => {
      const command =
        action === 'begin'
          ? { attemptSecret: secret(1), csrf: secret(2), nonce: secret(3) }
          : await begin();
      if (action === 'activity' || action === 'logout') {
        if (!('snapshot' in command)) throw new Error('合成試行が必要');
        await store.complete(command, clock);
      }
      const before =
        (await observer.query('SELECT * FROM authentication.audit_event'))
          .rowCount ?? 0;
      const connections = wrappedPool(async (sql, execute) => {
        const result = await execute();
        if (sql === 'COMMIT') throw new Error('合成応答喪失');
        return result;
      });
      store = makeStore(connections);
      const result =
        action === 'begin'
          ? await store.begin(command, clock)
          : action === 'read-attempt'
            ? await store.readAttempt(command, clock)
            : action === 'complete' && 'snapshot' in command
              ? await store.complete(command, clock)
              : action === 'activity' && 'sessionSecret' in command
                ? await store.withSession(
                    command.sessionSecret,
                    'activity',
                    clock,
                    (_actor, scope) =>
                      Promise.resolve(scope.serialize('合成秘密返却値')),
                  )
                : 'sessionSecret' in command
                  ? await store.revoke(command.sessionSecret, clock)
                  : null;
      expect(result).toEqual({ status: 'unavailable' });
      expect(
        (await observer.query('SELECT * FROM authentication.audit_event'))
          .rowCount,
      ).toBe(before + 1);
      if (action === 'complete')
        expect(
          (
            await observer.query(
              'SELECT state FROM authentication.login_attempt',
            )
          ).rows,
        ).toEqual([{ state: 'consumed' }]);
      if (action === 'logout')
        expect(
          (
            await observer.query(
              'SELECT state FROM authentication.session_record',
            )
          ).rows,
        ).toEqual([{ state: 'revoked' }]);
    },
  );

  it.each(['same-attempt', 'same-identity'] as const)(
    '実2接続の%sは最大一消費・同本人Actor一つを守る',
    async (race) => {
      const first = await begin();
      const second = race === 'same-attempt' ? first : await begin(11);
      const both = deferred();
      const locked = deferred();
      const finish = deferred();
      let arrived = 0;
      let ownerPid: number | undefined;
      const connections = wrappedPool(async (sql, execute, pid) => {
        const result = await execute();
        if (
          sql.includes('FROM authentication.identity_alias a JOIN') &&
          arrived < 2
        ) {
          arrived += 1;
          if (arrived === 2) both.resolve();
          await bounded(both.promise);
        }
        const fence =
          race === 'same-attempt'
            ? sql.startsWith('SELECT * FROM authentication.login_attempt') &&
              sql.includes('FOR UPDATE')
            : sql.startsWith('INSERT INTO authentication.identity_alias');
        if (fence && ownerPid === undefined) {
          ownerPid = pid;
          locked.resolve();
          await bounded(finish.promise);
        }
        return result;
      });
      store = makeStore(connections);
      const completing = Promise.all([
        store.complete(first, clock),
        store.complete(second, clock),
      ]);
      try {
        await bounded(locked.promise);
        if (ownerPid === undefined) throw new Error('合成Lock所有PIDが必要');
        await waitForBlock(
          () => connections.pids.find((pid) => pid !== ownerPid),
          ownerPid,
        );
      } finally {
        finish.resolve();
      }
      const results = await completing;
      expect(new Set(connections.pids.slice(0, 2)).size).toBe(2);
      expect(results.map((result) => result.status).sort()).toEqual(
        race === 'same-attempt'
          ? ['authenticated', 'restart-required']
          : ['authenticated', 'authenticated'],
      );
      expect(
        (await observer.query('SELECT * FROM authentication.actor')).rowCount,
      ).toBe(1);
      expect(
        (await observer.query('SELECT * FROM authentication.google_identity'))
          .rowCount,
      ).toBe(1);
      expect(
        (await observer.query('SELECT * FROM authentication.session_record'))
          .rowCount,
      ).toBe(race === 'same-attempt' ? 1 : 2);
      expect(connections.pids).toHaveLength(race === 'same-attempt' ? 2 : 3);
      expect(
        (
          await observer.query(
            "SELECT * FROM authentication.audit_event WHERE action = 'complete' AND decision = 'allow'",
          )
        ).rowCount,
      ).toBe(race === 'same-attempt' ? 1 : 2);
    },
  );

  it('Alias Unique再試行は初回を含む3Transactionで止まり、全敗者をrollbackする', async () => {
    const command = await begin();
    const before = await rows();
    const connections = wrappedPool(async (sql, execute) => {
      if (sql.startsWith('INSERT INTO authentication.identity_alias'))
        throw Object.assign(new Error('合成Unique競合'), {
          code: '23505',
          constraint: 'identity_alias_pkey',
        });
      return execute();
    });
    store = makeStore(connections);
    const seal = vi.spyOn(codec, 'seal');
    expect(await store.complete(command, clock)).toEqual({
      status: 'unavailable',
    });
    expect(connections.pids).toHaveLength(3);
    expect(await rows()).toEqual(before);
    // rollback後にもRegistryのNonce割当が残る。DB行が無いIdentity Scopeも戻さない。
    for (const call of seal.mock.calls) {
      if (call[0].row.recordKind === 'google-identity')
        expect(
          registry.state({
            recordKind: 'google-identity',
            keyScopeId: call[0].row.actorId,
          }).count,
        ).toBe(1n);
    }
    expect(
      seal.mock.calls.filter(
        ([input]) => input.row.recordKind === 'google-identity',
      ),
    ).toHaveLength(3);
  });

  it('Unique再試行の新Transactionで期限を再確認し、消費せず拒否する', async () => {
    const command = await begin();
    let injected = false;
    const connections = wrappedPool(async (sql, execute) => {
      if (
        !injected &&
        sql.startsWith('INSERT INTO authentication.identity_alias')
      ) {
        injected = true;
        now = command.snapshot.expiresAt;
        throw Object.assign(new Error('合成Unique競合'), {
          code: '23505',
          constraint: 'identity_alias_pkey',
        });
      }
      return execute();
    });
    store = makeStore(connections);
    expect(await store.complete(command, clock)).toEqual({
      status: 'restart-required',
    });
    expect(connections.pids).toHaveLength(2);
    expect(
      (await observer.query('SELECT * FROM authentication.actor')).rowCount,
    ).toBe(0);
    expect(
      (
        await observer.query(
          'SELECT state, version FROM authentication.login_attempt',
        )
      ).rows,
    ).toEqual([{ state: 'ready', version: '1' }]);
  });

  it('同Session LogoutはCallbackとserialization・commitを追い越さない', async () => {
    const command = await begin();
    await store.complete(command, clock);
    const entered = deferred();
    const finish = deferred();
    const connections = wrappedPool(async (_sql, execute) => execute());
    store = makeStore(connections);
    const use = store.withSession(
      command.sessionSecret,
      'activity',
      clock,
      async (_actor, scope) => {
        entered.resolve();
        await bounded(finish.promise);
        return scope.serialize({ allowed: true });
      },
    );
    await bounded(entered.promise);
    const logout = store.revoke(command.sessionSecret, clock);
    try {
      await waitForBlock(() => connections.pids[1], connections.pids[0]);
    } finally {
      finish.resolve();
    }
    expect((await use).status).toBe('authenticated');
    expect(await logout).toEqual({ status: 'logged-out' });
    expect(connections.pids[0]).not.toBe(connections.pids[1]);
    expect(
      await store.withSession(command.sessionSecret, 'inspect', clock, () =>
        Promise.resolve().then(() => {
          throw new Error('実行禁止');
        }),
      ),
    ).toEqual({ status: 'unauthenticated' });
  });

  it('Actor排他無効化もlease完了を待ち、無効化後の利用・新Session発行を拒否する', async () => {
    const command = await begin();
    await store.complete(command, clock);
    const next = await begin(11);
    const actorId = (
      await observer.query<{ actor_id: string }>(
        'SELECT actor_id FROM authentication.actor',
      )
    ).rows[0].actor_id;
    const entered = deferred();
    const finish = deferred();
    const connections = wrappedPool(async (_sql, execute) => execute());
    store = makeStore(connections);
    const use = store.withSession(
      command.sessionSecret,
      'inspect',
      clock,
      async (_actor, scope) => {
        entered.resolve();
        await bounded(finish.promise);
        return scope.serialize(null);
      },
    );
    await bounded(entered.promise);
    let writerPid: number | undefined;
    const disabled = disableActor(actorId, (pid) => {
      writerPid = pid;
    });
    try {
      await waitForBlock(() => writerPid, connections.pids[0]);
    } finally {
      finish.resolve();
    }
    expect((await use).status).toBe('authenticated');
    await disabled;
    expect(writerPid).not.toBe(connections.pids[0]);
    expect(
      await store.withSession(command.sessionSecret, 'inspect', clock, () =>
        Promise.resolve().then(() => {
          throw new Error('実行禁止');
        }),
      ),
    ).toEqual({ status: 'unauthenticated' });
    expect(await store.complete(next, clock)).toEqual({
      status: 'restart-required',
    });
    expect(
      (await observer.query('SELECT * FROM authentication.session_record'))
        .rowCount,
    ).toBe(1);
  });

  it('Lock待機中にAttempt期限へ達したら取得後Clockで拒否する', async () => {
    const command = await begin();
    const owner = await pool.connect();
    const ownerPid = (
      await owner.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    ).rows[0].pid;
    await owner.query('BEGIN');
    await owner.query(
      'SELECT * FROM authentication.key_state WHERE state_id = 1 FOR SHARE',
    );
    await owner.query('SELECT * FROM authentication.login_attempt FOR UPDATE');
    const connections = wrappedPool(async (_sql, execute) => execute());
    store = makeStore(connections);
    const read = store.readAttempt(command, clock);
    try {
      await waitForBlock(() => connections.pids[0], ownerPid);
      now = command.snapshot.expiresAt;
    } finally {
      await owner.query('COMMIT');
      owner.release();
    }
    expect(await read).toEqual({ status: 'restart-required' });
  });

  it('Rotation公開はkey_state共有leaseのcommitを待ち、旧AliasだけのActorへ新required Aliasを追加する', async () => {
    const command = await begin();
    await store.complete(command, clock);
    const before = await observer.query(
      'SELECT actor_id FROM authentication.actor',
    );
    const entered = deferred();
    const finish = deferred();
    const connections = wrappedPool(async (_sql, execute) => execute());
    store = makeStore(connections);
    const use = store.withSession(
      command.sessionSecret,
      'inspect',
      clock,
      async (_actor, scope) => {
        entered.resolve();
        await bounded(finish.promise);
        return scope.serialize(null);
      },
    );
    await bounded(entered.promise);
    const writer = await pool.connect();
    const writerPid = (
      await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    ).rows[0].pid;
    const rotate = (async () => {
      try {
        await writer.query('BEGIN');
        await writer.query(
          'SELECT * FROM authentication.key_state WHERE state_id = 1 FOR UPDATE',
        );
        await writer.query(
          "UPDATE authentication.key_state SET status = 'rotating', generation_version = generation_version + 1",
        );
        await writer.query(
          "INSERT INTO authentication.key_generation (generation_id, purpose, key_version, epoch, searchable, write_required) VALUES ($1, 'google-identity-search', 'v2', NULL, true, true)",
          [randomUUID()],
        );
        await writer.query('COMMIT');
      } catch (error) {
        await writer.query('ROLLBACK');
        throw error;
      } finally {
        writer.release();
      }
    })();
    try {
      await waitForBlock(() => writerPid, connections.pids[0]);
    } finally {
      finish.resolve();
    }
    expect((await use).status).toBe('authenticated');
    await rotate;
    const next = await begin(11);
    expect((await store.complete(next, clock)).status).toBe('authenticated');
    expect(
      (await observer.query('SELECT actor_id FROM authentication.actor')).rows,
    ).toEqual(before.rows);
    expect(
      (
        await observer.query(
          'SELECT digest_key_version FROM authentication.identity_alias ORDER BY digest_key_version',
        )
      ).rows,
    ).toEqual([{ digest_key_version: 'v1' }, { digest_key_version: 'v2' }]);
    const third = await begin(21);
    expect((await store.complete(third, clock)).status).toBe('authenticated');
    expect(
      (await observer.query('SELECT * FROM authentication.actor')).rowCount,
    ).toBe(1);
  });

  it('Cookie世代切替中も旧Cookieを検索し、旧世代と同じ新Cookieの衝突を再試行しない', async () => {
    const first = await begin();
    await store.complete(first, clock);
    for (const purpose of ['login-attempt-cookie', 'session-cookie']) {
      await observer.query(
        'UPDATE authentication.key_generation SET write_required = false WHERE purpose = $1',
        [purpose],
      );
      await observer.query(
        "INSERT INTO authentication.key_generation (generation_id, purpose, key_version, epoch, searchable, write_required) VALUES ($1, $2, 'v2', $3, true, true)",
        [randomUUID(), purpose, ids.epoch],
      );
    }
    expect(
      (
        await store.withSession(
          first.sessionSecret,
          'inspect',
          clock,
          (_actor, scope) => Promise.resolve(scope.serialize(null)),
        )
      ).status,
    ).toBe('authenticated');
    const second = await begin(11);
    const baseline = await rows();
    const connections = wrappedPool(async (_sql, execute) => execute());
    store = makeStore(connections);
    expect(
      await store.complete(
        { ...second, sessionSecret: first.sessionSecret },
        clock,
      ),
    ).toEqual({ status: 'unavailable' });
    expect(connections.pids).toHaveLength(1);
    expect(await rows()).toEqual(baseline);
    expect(
      await store.begin(
        {
          attemptSecret: first.attemptSecret,
          nonce: secret(91),
          csrf: secret(92),
        },
        clock,
      ),
    ).toEqual({ status: 'unavailable' });
    expect(await rows()).toEqual(baseline);
  });

  it.each([
    'actor-mac',
    'attempt-metadata',
    'session-metadata',
    'identity-ciphertext',
  ] as const)('%s改竄を認可や拒否理由として信頼しない', async (target) => {
    const command = await begin();
    if (target === 'attempt-metadata') {
      await observer.query(
        'UPDATE authentication.login_attempt SET created_at_ms = created_at_ms + 1, expires_at_ms = expires_at_ms + 1',
      );
      expect(await store.readAttempt(command, clock)).toEqual({
        status: 'unavailable',
      });
      return;
    }
    await store.complete(command, clock);
    if (target === 'identity-ciphertext') {
      const next = await begin(11);
      await observer.query(
        "UPDATE authentication.google_identity SET ciphertext = decode('01', 'hex')",
      );
      expect(await store.complete(next, clock)).toEqual({
        status: 'unavailable',
      });
    } else {
      if (target === 'actor-mac')
        await observer.query('UPDATE authentication.actor SET state_mac = $1', [
          Buffer.alloc(32),
        ]);
      else
        await observer.query(
          "UPDATE authentication.session_record SET state = 'revoked', terminal_at_ms = created_at_ms, version = version + 1",
        );
      expect(
        await store.withSession(command.sessionSecret, 'inspect', clock, () =>
          Promise.resolve().then(() => {
            throw new Error('実行禁止');
          }),
        ),
      ).toEqual({ status: 'unavailable' });
    }
  });

  it.each([
    'missing-required',
    'write-not-searchable',
    'partial-audit',
    'unknown-format',
  ] as const)('世代集合の%sは変更前にfail closed', async (failure) => {
    if (failure === 'missing-required')
      await observer.query(
        "UPDATE authentication.key_generation SET write_required = false WHERE purpose = 'session-cookie'",
      );
    if (failure === 'write-not-searchable')
      await observer.query(
        "UPDATE authentication.key_generation SET searchable = false WHERE purpose = 'google-identity-search'",
      );
    if (failure === 'partial-audit')
      await observer.query(
        "UPDATE authentication.key_generation SET key_version = 'v2' WHERE purpose = 'audit-session'",
      );
    if (failure === 'unknown-format') {
      const connections = wrappedPool(async (sql, execute) => {
        const result = await execute();
        if (sql.startsWith('SELECT state_id'))
          result.rows = [
            {
              state_id: 1,
              status: 'active',
              epoch: ids.epoch,
              generation_version: '9007199254740992',
            },
          ];
        return result;
      });
      store = makeStore(connections);
    }
    expect(
      await store.begin(
        { attemptSecret: secret(1), csrf: secret(2), nonce: secret(3) },
        clock,
      ),
    ).toEqual({ status: 'unavailable' });
    expect(
      (await observer.query('SELECT * FROM authentication.login_attempt'))
        .rowCount,
    ).toBe(0);
  });

  it.each([
    'identity',
    'attemptCookie',
    'sessionCookie',
    'actorState',
    'auditActor',
    'auditAttempt',
    'auditSession',
  ] as const)(
    '%s鍵障害では新Session・Actor・消費を確定しない',
    async (purpose) => {
      const command = await begin();
      const baseline = await rows();
      vi.spyOn(keys[purpose], 'readKey').mockResolvedValue({
        status: 'unavailable',
      });
      expect(await store.complete(command, clock)).toEqual({
        status: 'unavailable',
      });
      expect(await rows()).toEqual(baseline);
    },
  );

  it.each(['open', 'seal'] as const)(
    'Codec %s障害でも成功結果・部分保存を返さない',
    async (operation) => {
      const command = await begin();
      const baseline = await rows();
      vi.spyOn(codec, operation).mockRejectedValue(new Error('合成暗号障害'));
      expect(await store.complete(command, clock)).toEqual({
        status: 'unavailable',
      });
      expect(await rows()).toEqual(baseline);
    },
  );

  it('Session利用はIdentityを復号せず、idle／absolute期限等値でCallbackを拒否する', async () => {
    const command = await begin();
    await store.complete(command, clock);
    const open = vi.spyOn(codec, 'open');
    const identityDigest = vi
      .spyOn(digests, 'identity')
      .mockRejectedValue(new Error('Identity経路へ入らない'));
    now += ttl.idle - 1;
    expect(
      (
        await store.withSession(
          command.sessionSecret,
          'activity',
          clock,
          (_actor, scope) => Promise.resolve(scope.serialize(null)),
        )
      ).status,
    ).toBe('authenticated');
    expect(
      open.mock.calls.every(([input]) => input.row.recordKind === 'session'),
    ).toBe(true);
    for (let day = 2; day <= 7; day += 1) {
      now = 1_000_000 + day * (ttl.idle - 1);
      expect(
        (
          await store.withSession(
            command.sessionSecret,
            'activity',
            clock,
            (_actor, scope) => Promise.resolve(scope.serialize(null)),
          )
        ).status,
      ).toBe('authenticated');
    }
    expect(
      (
        await observer.query(
          'SELECT absolute_expires_at_ms, idle_expires_at_ms FROM authentication.session_record',
        )
      ).rows,
    ).toEqual([
      {
        absolute_expires_at_ms: String(1_000_000 + ttl.absolute),
        idle_expires_at_ms: String(1_000_000 + ttl.absolute),
      },
    ]);
    now = 1_000_000 + ttl.absolute;
    expect(
      await store.withSession(command.sessionSecret, 'activity', clock, () =>
        Promise.resolve().then(() => {
          throw new Error('実行禁止');
        }),
      ),
    ).toEqual({ status: 'unauthenticated' });
    identityDigest.mockRestore();
    const second = await begin(11);
    expect((await store.complete(second, clock)).status).toBe('authenticated');
    now += ttl.idle;
    expect(
      await store.withSession(second.sessionSecret, 'inspect', clock, () =>
        Promise.resolve().then(() => {
          throw new Error('実行禁止');
        }),
      ),
    ).toEqual({ status: 'unauthenticated' });
  });

  it('未await queryは収束まで待ってrollbackし、終了後ScopeからSQLを送らない', async () => {
    const command = await begin();
    await store.complete(command, clock);
    const baseline = await rows();
    const entered = deferred();
    const finish = deferred();
    let retainedScope: AuthenticationTransactionScope | undefined;
    let query: Promise<QueryResult> | undefined;
    const connections = wrappedPool(async (sql, execute) => {
      const result = await execute();
      if (sql.startsWith(`INSERT INTO ${migrationSchema}.participant_write`)) {
        entered.resolve();
        await bounded(finish.promise);
      }
      return result;
    });
    store = makeStore(connections);
    const use = store.withSession(
      command.sessionSecret,
      'activity',
      clock,
      (_actor, scope) =>
        Promise.resolve().then(() => {
          retainedScope = scope;
          query = scopes.participants.query(
            scope,
            `INSERT INTO ${migrationSchema}.participant_write (label) VALUES ($1)`,
            ['未await'],
          );
          return scope.serialize(null);
        }),
    );
    try {
      await bounded(entered.promise);
    } finally {
      finish.resolve();
    }
    expect(await use).toEqual({ status: 'unavailable' });
    await query;
    expect(await rows()).toEqual(baseline);
    if (retainedScope === undefined) throw new Error('合成Scopeが必要');
    await expect(
      scopes.participants.query(
        retainedScope,
        `INSERT INTO ${migrationSchema}.participant_write (label) VALUES ($1)`,
        ['終了後'],
      ),
    ).rejects.toThrow();
    expect(
      (
        await observer.query(
          `SELECT * FROM ${migrationSchema}.participant_write`,
        )
      ).rowCount,
    ).toBe(0);
  });

  it('参加SQL失敗をCallbackが握り潰してもidle・Auditをcommitしない', async () => {
    const command = await begin();
    await store.complete(command, clock);
    const baseline = await rows();
    store = makeStore(
      wrappedPool(async (sql, execute) => {
        if (sql.startsWith(`INSERT INTO ${migrationSchema}.participant_write`))
          throw new Error('合成参加SQL障害');
        return execute();
      }),
    );
    expect(
      await store.withSession(
        command.sessionSecret,
        'activity',
        clock,
        async (_actor, scope) => {
          try {
            await scopes.participants.query(
              scope,
              `INSERT INTO ${migrationSchema}.participant_write (label) VALUES ($1)`,
              ['失敗'],
            );
          } catch {
            /* 握り潰してもScopeが失敗を保持する。 */
          }
          return scope.serialize(null);
        },
      ),
    ).toEqual({ status: 'unavailable' });
    expect(await rows()).toEqual(baseline);
  });

  it('全保存列・Audit・通知へCookie・Token・Google識別子・直接IDを漏らさない', async () => {
    const alerts: unknown[] = [];
    store = createPostgresAuthenticationStore({
      pool,
      scopes,
      codec,
      digests,
      onAlert: (signal) => alerts.push(signal),
    });
    const command = await begin();
    await store.complete(command, clock);
    const saved = await rows();
    // byteaのJSON表現だけではUTF-8平文を見落とすため、実保存Byte列も文字列化して照合する。
    const byteaText: string[] = [];
    for (const records of Object.values(saved)) {
      if (!Array.isArray(records)) throw new Error('合成保存行が必要');
      for (const record of records as Record<string, unknown>[]) {
        for (const value of Object.values(record)) {
          if (value instanceof Uint8Array)
            byteaText.push(Buffer.from(value).toString('utf8'));
        }
      }
    }
    const serialized = JSON.stringify(saved) + byteaText.join('\n');
    for (const value of [
      command.attemptSecret,
      command.csrf,
      command.nonce,
      command.sessionSecret,
      command.sessionCsrf,
      identity.issuer,
      identity.subject,
      'synthetic-token',
    ])
      expect(serialized).not.toContain(value);
    const auditJson = JSON.stringify(saved.audit_event);
    for (const table of [
      'actor',
      'google_identity',
      'login_attempt',
      'session_record',
    ]) {
      const records = await observer.query(
        `SELECT * FROM authentication.${table}`,
      );
      for (const record of records.rows as Record<string, unknown>[]) {
        for (const [name, value] of Object.entries(record)) {
          if (name.endsWith('_id') && typeof value === 'string')
            expect(auditJson).not.toContain(value);
        }
      }
    }
    vi.spyOn(codec, 'open').mockRejectedValue(
      new Error(`合成秘密詳細:${command.sessionSecret}`),
    );
    expect(
      await store.withSession(command.sessionSecret, 'inspect', clock, () =>
        Promise.resolve().then(() => {
          throw new Error('実行禁止');
        }),
      ),
    ).toEqual({ status: 'unavailable' });
    expect(alerts).toEqual([
      { operation: 'inspect', code: 'AUTHENTICATION_STORE_UNAVAILABLE' },
    ]);
  });

  it.each(['begin', 'read-attempt', 'complete', 'activity', 'logout'] as const)(
    '%sのcommit前Audit障害は全保存状態をrollbackする',
    async (action) => {
      const command =
        action === 'begin'
          ? { attemptSecret: secret(1), csrf: secret(2), nonce: secret(3) }
          : await begin();
      if (action === 'activity' || action === 'logout') {
        if (!('snapshot' in command)) throw new Error('合成試行が必要');
        expect((await store.complete(command, clock)).status).toBe(
          'authenticated',
        );
      }
      const before = await rows();
      store = makeStore(
        wrappedPool(async (sql, execute) => {
          if (sql.startsWith('INSERT INTO authentication.audit_event'))
            throw new Error('合成commit前障害');
          return execute();
        }),
      );
      const result =
        action === 'begin'
          ? await store.begin(command, clock)
          : action === 'read-attempt'
            ? await store.readAttempt(command, clock)
            : action === 'complete' && 'snapshot' in command
              ? await store.complete(command, clock)
              : action === 'activity' && 'sessionSecret' in command
                ? await store.withSession(
                    command.sessionSecret,
                    'activity',
                    clock,
                    async (_actor, scope) => {
                      await scopes.participants.query(
                        scope,
                        `INSERT INTO ${migrationSchema}.participant_write (label) VALUES ($1)`,
                        ['Audit失敗でrollback'],
                      );
                      return scope.serialize(null);
                    },
                  )
                : 'sessionSecret' in command
                  ? await store.revoke(command.sessionSecret, clock)
                  : null;
      expect(result).toEqual({ status: 'unavailable' });
      expect(await rows()).toEqual(before);
      expect(
        (
          await observer.query(
            `SELECT * FROM ${migrationSchema}.participant_write`,
          )
        ).rowCount,
      ).toBe(0);
    },
  );

  it.each(['attempt-update', 'attempt-insert', 'audit'] as const)(
    'beginの%s故障でも旧試行の置換を部分反映しない',
    async (point) => {
      const first = await begin();
      const before = await rows();
      store = makeStore(
        wrappedPool(async (sql, execute) => {
          if (
            (point === 'attempt-update' &&
              sql.startsWith('UPDATE authentication.login_attempt')) ||
            (point === 'attempt-insert' &&
              sql.startsWith('INSERT INTO authentication.login_attempt')) ||
            (point === 'audit' &&
              sql.startsWith('INSERT INTO authentication.audit_event'))
          )
            throw new Error('合成begin障害');
          return execute();
        }),
      );
      expect(
        await store.begin(
          {
            attemptSecret: secret(21),
            csrf: secret(22),
            nonce: secret(23),
            previousAttemptSecret: first.attemptSecret,
          },
          clock,
        ),
      ).toEqual({ status: 'unavailable' });
      expect(await rows()).toEqual(before);
    },
  );

  it('Aliasの異Identity多重hitは選択せず固定Codeで拒否する', async () => {
    const first = await begin();
    expect((await store.complete(first, clock)).status).toBe('authenticated');
    const second = await begin(11);
    expect(
      (
        await store.complete(
          {
            ...second,
            identity: { ...identity, subject: 'Synthetic-other-subject' },
          },
          clock,
        )
      ).status,
    ).toBe('authenticated');
    await observer.query(
      "INSERT INTO authentication.key_generation (generation_id, purpose, key_version, epoch, searchable, write_required) VALUES ($1, 'google-identity-search', 'v2', NULL, true, true)",
      [randomUUID()],
    );
    const other = (
      await observer.query<{ identity_id: string }>(
        'SELECT identity_id FROM authentication.google_identity ORDER BY actor_id',
      )
    ).rows;
    const firstAlias = (
      await observer.query<{ identity_id: string }>(
        'SELECT identity_id FROM authentication.identity_alias WHERE digest = $1',
        [
          Buffer.from(
            (await digests.identity({ identity, keyVersion: 'v1' })).bytes,
          ),
        ],
      )
    ).rows[0].identity_id;
    const wrong = other.find(
      (row) => row.identity_id !== firstAlias,
    )!.identity_id;
    await observer.query(
      "INSERT INTO authentication.identity_alias (purpose, digest_key_version, digest, identity_id) VALUES ('auth-google-identity/v1', 'v2', $1, $2)",
      [
        Buffer.from(
          (await digests.identity({ identity, keyVersion: 'v2' })).bytes,
        ),
        wrong,
      ],
    );
    const next = await begin(21);
    const before = await rows();
    const alerts: unknown[] = [];
    store = createPostgresAuthenticationStore({
      pool,
      scopes,
      codec,
      digests,
      onAlert: (signal) => alerts.push(signal),
    });
    expect(await store.complete(next, clock)).toEqual({
      status: 'unavailable',
    });
    expect(await rows()).toEqual(before);
    expect(alerts).toContainEqual({
      operation: 'complete',
      code: 'MULTIPLE_LOOKUP_MATCHES',
    });
  });

  it('Cookie多重hitは復号前に拒否し、部分世代の鍵取得成功だけで許可しない', async () => {
    const first = await begin();
    await store.complete(first, clock);
    await observer.query(
      "UPDATE authentication.key_generation SET write_required = false WHERE purpose = 'session-cookie'",
    );
    await observer.query(
      "INSERT INTO authentication.key_generation (generation_id, purpose, key_version, epoch, searchable, write_required) VALUES ($1, 'session-cookie', 'v2', $2, true, true)",
      [randomUUID(), ids.epoch],
    );
    const open = vi.spyOn(codec, 'open');
    const normal = keys.sessionCookie.readKey.bind(keys.sessionCookie);
    const read = vi.spyOn(keys.sessionCookie, 'readKey');
    read.mockImplementation(async (input) =>
      input.keyVersion === 'v2' ? { status: 'unavailable' } : normal(input),
    );
    expect(
      await store.withSession(first.sessionSecret, 'inspect', clock, () =>
        Promise.resolve().then(() => {
          throw new Error('実行禁止');
        }),
      ),
    ).toEqual({ status: 'unavailable' });
    expect(open).not.toHaveBeenCalled();
    read.mockRestore();
    const second = await begin(11);
    await store.complete(second, clock);
    const collision = await digests.sessionCookie({
      secret: first.sessionSecret,
      epoch: ids.epoch,
      keyVersion: 'v2',
    });
    await observer.query(
      "UPDATE authentication.session_record SET cookie_digest = $1 WHERE cookie_digest_key_version = 'v2'",
      [Buffer.from(collision.bytes)],
    );
    open.mockClear();
    const alerts: unknown[] = [];
    store = createPostgresAuthenticationStore({
      pool,
      scopes,
      codec,
      digests,
      onAlert: (signal) => alerts.push(signal),
    });
    expect(
      await store.withSession(first.sessionSecret, 'inspect', clock, () =>
        Promise.resolve().then(() => {
          throw new Error('実行禁止');
        }),
      ),
    ).toEqual({ status: 'unavailable' });
    expect(open).not.toHaveBeenCalled();
    expect(alerts).toContainEqual({
      operation: 'inspect',
      code: 'MULTIPLE_LOOKUP_MATCHES',
    });
  });

  it.each([
    -1,
    -0,
    NaN,
    Infinity,
    0.5,
    '1000000',
    Number.MAX_SAFE_INTEGER,
  ] as const)('Clock契約外のcase %#は保存せず汎用障害にする', async (value) => {
    expect(
      await store.begin(
        { attemptSecret: secret(1), nonce: secret(2), csrf: secret(3) },
        { now: () => value as unknown as number },
      ),
    ).toEqual({ status: 'unavailable' });
    expect(
      (await observer.query('SELECT * FROM authentication.login_attempt'))
        .rowCount,
    ).toBe(0);
  });

  it('await前のCommand Copy後はCallerのIdentity・snapshot・秘密値変更を受けない', async () => {
    const initial = await begin();
    const input = {
      ...initial,
      snapshot: { ...initial.snapshot },
      identity: { ...identity },
    };
    const completing = store.complete(input, clock);
    input.identity.subject = 'Synthetic-mutated-subject';
    input.snapshot.version = 99;
    input.snapshot.nonce = secret(99);
    input.sessionSecret = secret(98);
    expect((await completing).status).toBe('authenticated');
    expect(
      (
        await store.withSession(
          initial.sessionSecret,
          'inspect',
          clock,
          (_actor, scope) => Promise.resolve(scope.serialize(null)),
        )
      ).status,
    ).toBe('authenticated');
    expect(
      await store.withSession(input.sessionSecret, 'inspect', clock, () =>
        Promise.reject(new Error('実行禁止')),
      ),
    ).toEqual({ status: 'unauthenticated' });
  });
});
