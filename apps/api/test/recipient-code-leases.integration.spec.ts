import { authenticationDatabaseRow } from '../src/shared/infrastructure/authentication/postgres/authentication-database-values.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client, Pool, type PoolClient, type QueryResult } from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { applySqlMigrations } from '../src/group-management/infrastructure/postgres/sql-migration.js';
import type {
  AuthenticationMacPurpose,
  AuthenticationMacKeyPorts,
} from '../src/shared/application/authentication/authentication-crypto-keys.js';
import type { AuthenticationSessionRow } from '../src/shared/application/authentication/authentication-record-protection.js';
import type {
  AuthenticationSerializedValue,
  AuthenticationTransactionScope,
} from '../src/shared/application/authentication/authentication-transaction-scope.js';
import { RecipientCodeSecret } from '../src/shared/application/authentication/recipient-code-input.js';
import type {
  RecipientCodeKeyQuery,
  RecipientCodeMacPurpose,
} from '../src/shared/application/authentication/recipient-code-crypto-ports.js';
import type { RecipientCodeRecord } from '../src/shared/application/authentication/recipient-code-record.js';
import type { RecipientCodeUseCallbacks } from '../src/shared/application/authentication/recipient-code-ports.js';
import {
  createAuthenticationDigests,
  importAuthenticationMacKey,
} from '../src/shared/infrastructure/authentication/authentication-digests.js';
import { createAuthenticationRecordCodec } from '../src/shared/infrastructure/authentication/authentication-record-codec.js';
import {
  createRecipientCodeCrypto,
  importRecipientCodeMacKey,
} from '../src/shared/infrastructure/authentication/recipient-code-crypto.js';
import { createAuthenticationTransactionScopes } from '../src/shared/infrastructure/authentication/postgres/authentication-transaction-scopes.js';
import { createRecipientCodeTransactionScopes } from '../src/shared/infrastructure/authentication/postgres/recipient-code-transaction-scopes.js';
import { createPostgresRecipientCodeLeases } from '../src/shared/infrastructure/authentication/postgres/postgres-recipient-code-leases.js';
import {
  insertAuthenticationRecord,
  readStoredAuthenticationActor,
  readStoredAuthenticationSession,
  updateAuthenticationRecord,
} from '../src/shared/infrastructure/authentication/postgres/authentication-record-rows.js';
import type { AuthenticationConnectionPool } from '../src/shared/infrastructure/authentication/postgres/authentication-transactions.js';
import {
  SyntheticKeyRegistry,
  ids,
} from '../src/shared/infrastructure/authentication/test/authentication-crypto-fixtures.js';

const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';
const caller = '10000000-0000-4000-8000-000000000020';
const recipient = '10000000-0000-4000-8000-000000000010';
const codeId = '10000000-0000-4000-8000-000000000030';
const operationId = '10000000-0000-4000-8000-000000000040';
const secret = (byte: number) => Buffer.alloc(32, byte).toString('base64url');
const code = () =>
  RecipientCodeSecret.parse(Buffer.alloc(32, 31).toString('base64url'))!;
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
  'recipient-code-lookup',
  'recipient-code-state-mac',
];
const authKey = <P extends AuthenticationMacPurpose>(
  purpose: P,
  byte: number,
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
      key: importAuthenticationMacKey(purpose, Buffer.alloc(32, byte)),
    }),
});
const keys: AuthenticationMacKeyPorts = {
  identity: authKey('auth-google-identity/v1', 101),
  attemptCookie: authKey('auth-attempt-cookie/v1', 102),
  sessionCookie: authKey('auth-session-cookie/v1', 103),
  actorState: authKey('auth-actor-state/v1', 104),
  auditActor: authKey('auth-audit-actor/v1', 105),
  auditAttempt: authKey('auth-audit-attempt/v1', 106),
  auditSession: authKey('auth-audit-session/v1', 107),
  deletedActor: authKey('auth-deleted-actor/v1', 108),
};
const codeKey = <P extends RecipientCodeMacPurpose>(purpose: P) => {
  const materials = new Map<string, Uint8Array>();
  return {
    readKey: (query: RecipientCodeKeyQuery) => {
      const id = `${query.scopeId}/${query.keyVersion}`;
      if (!materials.has(id)) materials.set(id, randomBytes(32));
      return Promise.resolve({
        status: 'available' as const,
        ...query,
        key: importRecipientCodeMacKey(purpose, materials.get(id)!),
      });
    },
  };
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('コード専用Session leaseの実PG17境界（GM/消費Writerは合成）', () => {
  const observer = new Client({ connectionString: url });
  const pool = new Pool({ connectionString: url, max: 4 });
  const discardedClients = new WeakSet<PoolClient>();
  const unexpectedPoolErrors: string[] = [];
  pool.on('error', (error: Error & { code?: string }, client) => {
    // release(true)後に届くPG17の終了通知もPool所有者が受け止める。
    if (error.code !== '25P04' || !discardedClients.has(client)) {
      unexpectedPoolErrors.push(error.code ?? 'unknown');
    }
  });
  let owned = false;
  let schema = '';
  let now = 1_000_000;
  const clock = { now: () => now };
  let codec: ReturnType<typeof createAuthenticationRecordCodec>;
  let digests: ReturnType<typeof createAuthenticationDigests>;
  let crypto: ReturnType<typeof createRecipientCodeCrypto>;
  let scopes: ReturnType<typeof createRecipientCodeTransactionScopes>;
  let gm: ReturnType<typeof scopes.registerGroupParticipant>;
  let row: RecipientCodeRecord;
  let leases: ReturnType<typeof createPostgresRecipientCodeLeases>;
  const alerts = vi.fn();
  const consume = vi.fn(
    async (
      scope: AuthenticationTransactionScope,
      record: RecipientCodeRecord,
      time: number,
    ) => {
      // #243の実Writerではない。registry/接続の合成参加能力だけを実証する。
      const updated = {
        ...record,
        status: 'consumed' as const,
        recordVersion: record.recordVersion + 1,
        terminalAt: time,
      };
      const { mac: previousMac, ...metadata } = updated;
      void previousMac;
      const mac = await crypto.recordMac(metadata);
      await scopes.scopes.participants.query(
        scope,
        'UPDATE authentication.recipient_code SET state = $1, record_version = $2, terminal_at_ms = $3, state_mac = $4 WHERE code_id = $5',
        [
          'consumed',
          updated.recordVersion,
          time,
          Buffer.from(mac.bytes),
          record.codeId,
        ],
      );
      await scopes.scopes.participants.query(
        scope,
        `INSERT INTO ${schema}.synthetic_write (label) VALUES ($1)`,
        ['synthetic-code-audit'],
      );
    },
  );
  const make = (
    connections: AuthenticationConnectionPool = pool,
    limits = {
      lockTimeoutMs: 1500,
      statementTimeoutMs: 3000,
      transactionTimeoutMs: 10000,
    },
  ) =>
    createPostgresRecipientCodeLeases({
      pool: connections,
      scopes,
      codec,
      digests,
      crypto,
      limits,
      consume,
      onAlert: alerts,
    });
  const callbacks =
    (): RecipientCodeUseCallbacks<AuthenticationSerializedValue> => ({
      replay: () => Promise.resolve({ status: 'no-replay' }),
      create: async (facts, handle, scope) => {
        const value = scope.serialize({
          groupId: 'synthetic-group',
          invitationId: 'synthetic-invitation',
          version: 2,
        });
        gm.beginPlan(scope, handle, {
          codeId: facts.codeId,
          recipientActorId: facts.recipientActorId,
          operationId,
          value,
        });
        await gm.query(
          scope,
          `INSERT INTO ${schema}.synthetic_write (label) VALUES ($1)`,
          ['synthetic-gm'],
        );
        const evidence = gm.attest(scope, handle, {
          codeId: facts.codeId,
          recipientActorId: facts.recipientActorId,
          operationId,
          value,
        });
        await scope.consume(handle, evidence);
        return value;
      },
    });
  const wrap = (
    intercept: (
      sql: string,
      values: unknown[] | undefined,
      run: () => Promise<QueryResult>,
      pid: number,
    ) => Promise<QueryResult>,
  ) => ({
    connect: async () => {
      const connection = await pool.connect();
      const pid = (
        await connection.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )
      ).rows[0].pid;
      return {
        on: connection.on.bind(connection),
        removeListener: connection.removeListener.bind(connection),
        query: (sql: string, values?: unknown[]) =>
          intercept(sql, values, () => connection.query(sql, values), pid),
        release: (destroy?: boolean) => {
          if (destroy) discardedClients.add(connection);
          connection.release(destroy);
        },
      };
    },
  });
  const unchanged = async () => {
    expect(
      (
        await observer.query(
          'SELECT state, record_version FROM authentication.recipient_code',
        )
      ).rows,
    ).toEqual([{ state: 'issued', record_version: '1' }]);
    expect(
      (await observer.query(`SELECT * FROM ${schema}.synthetic_write`)).rows,
    ).toEqual([]);
    expect(
      (
        await observer.query<{ version: string }>(
          'SELECT version FROM authentication.session_record',
        )
      ).rows[0].version,
    ).toBe('1');
  };
  const waitBlocked = async (pid: number, blocker: number) => {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const r = await observer.query<{ pids: number[] }>(
        'SELECT pg_blocking_pids($1) AS pids',
        [pid],
      );
      if (r.rows[0].pids.includes(blocker)) return;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('実backend間のLock待機を観測できない');
  };
  beforeAll(async () => {
    await observer.connect();
    const info = (
      await observer.query<{ db: string; version: string }>(
        "SELECT current_database() AS db, current_setting('server_version_num') AS version",
      )
    ).rows[0];
    if (
      !info.db.endsWith('_test') ||
      Number(info.version) < 170000 ||
      Number(info.version) >= 180000
    )
      throw new Error('専用PG17末尾_test DBが必要');
    await observer.query('SELECT pg_advisory_lock(1801546597,1635087464)');
    if (
      (
        await observer.query<{ ns: string | null }>(
          "SELECT to_regnamespace('authentication') AS ns",
        )
      ).rows[0].ns !== null
    )
      throw new Error('既存認証Schemaを変更しない');
    schema = `test_issue239_${randomUUID().replaceAll('-', '')}`;
    await observer.query(`CREATE SCHEMA ${schema}`);
    owned = true;
    await observer.query(`SET search_path TO ${schema}`);
    const names = [
      '0005_authentication_schema',
      '0006_authentication_inventory',
      '0008_recipient_code_schema',
    ];
    await applySqlMigrations(
      observer,
      await Promise.all(
        names.map(async (name) => ({
          version: Number(name.slice(0, 4)),
          name,
          sql: await readFile(
            resolve(
              import.meta.dirname,
              `../migrations/authentication/${name}.sql`,
            ),
            'utf8',
          ),
        })),
      ),
    );
    await observer.query(
      `CREATE TABLE ${schema}.synthetic_write (label text NOT NULL, pid integer NOT NULL DEFAULT pg_backend_pid())`,
    );
    await observer.query(
      `CREATE TABLE ${schema}.synthetic_key_state (id integer PRIMARY KEY)`,
    );
    await observer.query(
      `INSERT INTO ${schema}.synthetic_key_state VALUES (1)`,
    );
  });
  beforeEach(async () => {
    now = 1_000_000;
    vi.restoreAllMocks();
    alerts.mockClear();
    consume.mockClear();
    await observer.query(`TRUNCATE ${schema}.synthetic_write`);
    await observer.query(
      'TRUNCATE authentication.recipient_code,authentication.audit_event,authentication.session_record,authentication.actor,authentication.key_generation CASCADE',
    );
    await observer.query(
      "UPDATE authentication.key_state SET status='active',generation_version=1,epoch=$1",
      [ids.epoch],
    );
    for (const purpose of purposes)
      await observer.query(
        "INSERT INTO authentication.key_generation (generation_id,purpose,key_version,epoch,searchable,write_required) VALUES ($1,$2,'v1',$3,true,true)",
        [randomUUID(), purpose, purpose.endsWith('cookie') ? ids.epoch : null],
      );
    codec = createAuthenticationRecordCodec({
      keys: new SyntheticKeyRegistry().provider(),
    });
    digests = createAuthenticationDigests({ keys });
    crypto = {
      ...createRecipientCodeCrypto({
        keys: {
          lookup: codeKey('auth-recipient-code-lookup/v1'),
          state: codeKey('auth-recipient-code-state/v1'),
          audit: codeKey('auth-audit-recipient-code/v1'),
        },
      }),
    };
    for (const actorId of [caller, recipient]) {
      const actor = {
        actorId,
        version: 1,
        state: 'active' as const,
        createdAt: 0,
        disabledAt: null,
      };
      const mac = await digests.actorState({ row: actor, keyVersion: 'v1' });
      await observer.query(
        "INSERT INTO authentication.actor (actor_id,state,version,created_at_ms,disabled_at_ms,control_key_version,state_mac) VALUES ($1,'active',1,0,NULL,'v1',$2)",
        [actorId, Buffer.from(mac.bytes)],
      );
    }
    const digest = await digests.sessionCookie({
      secret: secret(10),
      epoch: ids.epoch,
      keyVersion: 'v1',
    });
    const session: AuthenticationSessionRow = {
      recordKind: 'session',
      sessionId: ids.session,
      actorId: caller,
      version: 1,
      epoch: ids.epoch,
      createdAt: 0,
      absoluteExpiresAt: 604800000,
      idleExpiresAt: 86400000,
      state: 'active',
      terminalAt: null,
      cookieDigestKeyVersion: 'v1',
      cookieDigest: digest.bytes,
    };
    await insertAuthenticationRecord(
      observer,
      session,
      await codec.seal({ row: session, secrets: { csrf: secret(11) } }),
    );
    const lookup = await crypto.lookup({ secret: code(), keyVersion: 'v1' });
    const fields = {
      codeId,
      recipientActorId: recipient,
      recordVersion: 1,
      epoch: ids.epoch,
      createdAt: now,
      expiresAt: now + 600000,
      status: 'issued' as const,
      terminalAt: null,
      lookupKeyVersion: 'v1',
      lookupDigest: lookup.bytes,
      macKeyVersion: 'v1',
    };
    row = { ...fields, mac: (await crypto.recordMac(fields)).bytes };
    await observer.query(
      "INSERT INTO authentication.recipient_code (code_id,recipient_actor_id,record_version,epoch,created_at_ms,expires_at_ms,state,terminal_at_ms,lookup_key_version,lookup_digest,mac_key_version,state_mac) VALUES ($1,$2,1,$3,$4,$5,'issued',NULL,'v1',$6,'v1',$7)",
      [
        codeId,
        recipient,
        ids.epoch,
        now,
        now + 600000,
        Buffer.from(row.lookupDigest),
        Buffer.from(row.mac),
      ],
    );
    scopes = createRecipientCodeTransactionScopes(
      createAuthenticationTransactionScopes(),
    );
    gm = scopes.registerGroupParticipant({
      prepare: async (scope, query) => {
        await query.query(
          scope,
          `SELECT * FROM ${schema}.synthetic_key_state WHERE id = 1 FOR SHARE`,
        );
      },
    });
    leases = make();
  });
  afterAll(async () => {
    await pool.end();
    if (owned) {
      await observer.query('SET search_path TO public');
      await observer.query('DROP SCHEMA authentication CASCADE');
      await observer.query(`DROP SCHEMA ${schema} CASCADE`);
    }
    await observer.end();
    expect(unexpectedPoolErrors).toEqual([]);
  });

  it.each(['code', 'session'] as const)(
    '保存後commit直前の%s期限等値も途中DMLと当該Auditを全rollbackする',
    async (kind) => {
      let commits = 0;
      let callbackDone = false;
      leases = make(
        wrap(async (sql, values, run) => {
          if (sql === 'COMMIT') commits += 1;
          const value = await run();
          if (
            sql.includes('INSERT INTO authentication.audit_event') &&
            values?.[3] === 'activity' &&
            values[4] === 'allow'
          ) {
            expect(callbackDone).toBe(true);
            now = kind === 'code' ? row.expiresAt : 86400000;
          }
          return value;
        }),
      );
      if (kind === 'code') {
        const cb = callbacks();
        const create = cb.create.bind(cb);
        cb.create = async (...args) => {
          const value = await create(...args);
          callbackDone = true;
          return value;
        };
        expect(await leases.use(secret(10), code(), clock, cb)).toEqual({
          status: 'unavailable',
        });
        expect(consume).toHaveBeenCalledOnce();
      } else {
        expect(
          await leases.withActor(secret(10), clock, async (_actor, scope) => {
            await scopes.scopes.participants.query(
              scope,
              `INSERT INTO ${schema}.synthetic_write (label) VALUES ($1)`,
              ['synthetic-manage-write'],
            );
            const value = scope.serialize(null);
            callbackDone = true;
            return value;
          }),
        ).toEqual({ status: 'unavailable' });
      }
      expect(callbackDone).toBe(true);
      expect(commits).toBe(kind === 'code' ? 1 : 0);
      await unchanged();
      const audits = (
        await observer.query<{ action: string }>(
          'SELECT action FROM authentication.audit_event',
        )
      ).rows;
      expect(audits).toEqual(kind === 'code' ? [{ action: 'inspect' }] : []);
    },
  );
  it('statement timeoutで途中writeを残さず、握り潰してもcommit不可', async () => {
    leases = make(pool, {
      lockTimeoutMs: 500,
      statementTimeoutMs: 20,
      transactionTimeoutMs: 3000,
    });
    expect(
      await leases.withActor(secret(10), clock, async (_caller, scope) => {
        await scopes.scopes.participants.query(
          scope,
          `INSERT INTO ${schema}.synthetic_write (label) VALUES ($1)`,
          ['synthetic-before-timeout'],
        );
        await scopes.scopes.participants
          .query(scope, 'SELECT pg_sleep($1)', [0.2])
          .catch(() => {});
        return scope.serialize(null);
      }),
    ).toEqual({ status: 'unavailable' });
    await unchanged();
  });
  it('消費Writerの鍵/監査障害は先行GM保存もrollbackする', async () => {
    consume.mockRejectedValueOnce(new Error('合成Writer障害'));
    expect(await leases.use(secret(10), code(), clock, callbacks())).toEqual({
      status: 'unavailable',
    });
    await unchanged();
  });
  it('serialize時のSession期限等値は管理Callbackの途中SQLもrollbackする', async () => {
    expect(
      await leases.withActor(secret(10), clock, async (_actor, scope) => {
        await scopes.scopes.participants.query(
          scope,
          `INSERT INTO ${schema}.synthetic_write (label) VALUES ($1)`,
          ['synthetic-before-expiry'],
        );
        now = 86400000;
        return scope.serialize(null);
      }),
    ).toEqual({ status: 'unavailable' });
    await unchanged();
  });
  it('未awaitの管理queryとserialization失敗の握り潰しを実PGでもcommitしない', async () => {
    expect(
      await leases.withActor(secret(10), clock, async (_actor, scope) => {
        void scopes.scopes.participants.query(
          scope,
          `INSERT INTO ${schema}.synthetic_write (label) VALUES ($1)`,
          ['synthetic-unawaited'],
        );
        try {
          scope.serialize(undefined);
        } catch {
          /* 合成Callbackによる握り潰し */
        }
        await Promise.resolve();
        return scope.serialize(null);
      }),
    ).toEqual({ status: 'unavailable' });
    await unchanged();
  });
  it('消費が先ならActor共有Lockが無効化の排他Lockをcommitまで待たせる', async () => {
    const entered = deferred();
    const resume = deferred();
    let ownerPid = 0;
    leases = make(
      wrap(async (sql, values, run, pid) => {
        if (
          sql.includes('authentication.recipient_code WHERE') &&
          sql.includes('FOR UPDATE')
        )
          ownerPid = pid;
        return run();
      }),
    );
    const cb = callbacks();
    const original = cb.create.bind(cb);
    cb.create = async (...args) => {
      entered.resolve();
      await resume.promise;
      return original(...args);
    };
    const pending = leases.use(secret(10), code(), clock, cb);
    await entered.promise;
    const blocker = await pool.connect();
    try {
      const blockerPid = (
        await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0].pid;
      await blocker.query('BEGIN');
      const locked = blocker.query(
        'SELECT * FROM authentication.actor WHERE actor_id=$1 FOR UPDATE',
        [recipient],
      );
      await waitBlocked(blockerPid, ownerPid);
      resume.resolve();
      expect((await pending).status).toBe('authenticated');
      await locked;
      expect(
        (
          await observer.query<{ state: string }>(
            'SELECT state FROM authentication.recipient_code',
          )
        ).rows[0].state,
      ).toBe('consumed');
    } finally {
      resume.resolve();
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
  it('Actor昇順→Session→code→合成GMを守り、同じPID/xminでのみ共通commitする', async () => {
    const events: { sql: string; values: unknown[] | undefined }[] = [];
    leases = make(
      wrap(async (sql, values, run) => {
        events.push({ sql, values });
        return run();
      }),
    );
    const result = await leases.use(secret(10), code(), clock, callbacks());
    expect(result.status, events.map((e) => e.sql).join('\n')).toBe(
      'authenticated',
    );
    const locks = events.filter((e) =>
      e.sql.includes('authentication.actor WHERE'),
    );
    expect(locks.map((e) => e.values?.[0])).toEqual([
      caller,
      recipient,
      caller,
    ]);
    expect(locks.every((e) => e.sql.endsWith('FOR SHARE'))).toBe(true);
    const newStart = events.findIndex(
      (e, i) => i > 0 && e.sql === 'BEGIN ISOLATION LEVEL READ COMMITTED',
    );
    const newEvents = events.slice(newStart).map((e) => e.sql);
    expect(
      newEvents.findIndex((sql) => sql.includes('synthetic_key_state')),
    ).toBeLessThan(
      newEvents.findIndex((sql) => sql.includes('authentication.actor WHERE')),
    );
    expect(
      newEvents.findIndex((sql) => sql.includes('session_id = $1 FOR UPDATE')),
    ).toBeLessThan(
      newEvents.findIndex((sql) => sql.includes('code_id = $1 FOR UPDATE')),
    );
    const xids = (
      await observer.query<{ xid: string }>(
        `SELECT xmin::text AS xid FROM ${schema}.synthetic_write UNION ALL SELECT xmin::text FROM authentication.recipient_code UNION ALL SELECT xmin::text FROM authentication.session_record UNION ALL SELECT xmin::text FROM authentication.audit_event WHERE action = 'activity' AND decision = 'allow'`,
      )
    ).rows;
    expect(new Set(xids.map((r) => r.xid)).size).toBe(1);
    expect(
      new Set(
        (
          await observer.query<{ pid: number }>(
            `SELECT pid FROM ${schema}.synthetic_write`,
          )
        ).rows.map((r) => r.pid),
      ).size,
    ).toBe(1);
    expect(consume).toHaveBeenCalledOnce();
  });
  it('管理はActorを最初からFOR UPDATEで固定する', async () => {
    const locks: string[] = [];
    leases = make(
      wrap(async (sql, _values, run) => {
        if (sql.includes('authentication.actor WHERE')) locks.push(sql);
        return run();
      }),
    );
    expect(
      (
        await leases.withActor(secret(10), clock, (_actor, scope) =>
          Promise.resolve(scope.serialize(null)),
        )
      ).status,
    ).toBe('authenticated');
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatch(/FOR UPDATE$/);
  });
  it('caller-only成功再送はコード行/MAC/宛先Actorへ一切依存しない', async () => {
    await observer.query('DELETE FROM authentication.recipient_code');
    await observer.query('DELETE FROM authentication.actor WHERE actor_id=$1', [
      recipient,
    ]);
    const sqls: string[] = [];
    leases = make(
      wrap(async (sql, _values, run) => {
        sqls.push(sql);
        return run();
      }),
    );
    const cb = callbacks();
    cb.replay = (_caller, scope) =>
      Promise.resolve({
        status: 'replayed',
        value: scope.serialize({ version: 2 }),
      });
    const create = vi.fn();
    cb.create = create;
    expect((await leases.use(secret(10), code(), clock, cb)).status).toBe(
      'authenticated',
    );
    expect(
      sqls.some((sql) => sql.includes('authentication.recipient_code')),
    ).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });
  it('preflight miss後の並行成功を、期限切れコードを拒否する前に再照合する', async () => {
    now = row.expiresAt;
    const cb = callbacks();
    let count = 0;
    cb.replay = (_caller, scope) =>
      Promise.resolve(
        ++count === 1
          ? { status: 'no-replay' }
          : { status: 'replayed', value: scope.serialize({ version: 2 }) },
      );
    expect((await leases.use(secret(10), code(), clock, cb)).status).toBe(
      'authenticated',
    );
    expect(count).toBe(2);
    expect(consume).not.toHaveBeenCalled();
  });
  it('code missはRecord MAC鍵と新規GM処理を呼ばない', async () => {
    const verify = vi.spyOn(crypto, 'verifyRecord');
    const cb = callbacks();
    const create = vi.fn();
    cb.create = create;
    expect(
      await leases.use(
        secret(10),
        RecipientCodeSecret.parse(Buffer.alloc(32, 32).toString('base64url'))!,
        clock,
        cb,
      ),
    ).toEqual({ status: 'unavailable-to-actor' });
    expect(verify).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    await unchanged();
  });
  it.each(['record-mac', 'actor-mac', 'epoch'] as const)(
    '%s改竄は固定unavailableと全rollback',
    async (kind) => {
      if (kind === 'record-mac')
        await observer.query(
          'UPDATE authentication.recipient_code SET state_mac=$1',
          [Buffer.alloc(32)],
        );
      if (kind === 'actor-mac')
        await observer.query(
          'UPDATE authentication.actor SET state_mac=$1 WHERE actor_id=$2',
          [Buffer.alloc(32), recipient],
        );
      if (kind === 'epoch')
        await observer.query(
          'UPDATE authentication.recipient_code SET epoch=$1',
          [randomUUID()],
        );
      expect(await leases.use(secret(10), code(), clock, callbacks())).toEqual({
        status: 'unavailable',
      });
      await unchanged();
      expect(alerts).toHaveBeenCalledWith({
        code: 'RECIPIENT_CODE_LEASE_UNAVAILABLE',
      });
    },
  );
  it('serialize直前の期限等値はGM/コード/Session/Auditの途中保存を全rollbackする', async () => {
    const cb = callbacks();
    const original = cb.create.bind(cb);
    cb.create = async (...args) => {
      now = row.expiresAt;
      return original(...args);
    };
    expect(await leases.use(secret(10), code(), clock, cb)).toEqual({
      status: 'unavailable',
    });
    await unchanged();
  });
  it('最後の認証Audit障害でも共通保存をrollbackする', async () => {
    leases = make(
      wrap(async (sql, values, run) => {
        if (
          sql.includes('INSERT INTO authentication.audit_event') &&
          values?.[3] === 'activity'
        )
          throw new Error('合成Audit障害');
        return run();
      }),
    );
    expect(await leases.use(secret(10), code(), clock, callbacks())).toEqual({
      status: 'unavailable',
    });
    await unchanged();
  });
  it('SQL障害をGMが握り潰しても証跡/共通commitを認めない', async () => {
    const cb = callbacks();
    const original = cb.create.bind(cb);
    cb.create = async (...args) => {
      await gm
        .query(args[2], 'SELECT synthetic_missing_column')
        .catch(() => {});
      return original(...args);
    };
    expect(await leases.use(secret(10), code(), clock, cb)).toEqual({
      status: 'unavailable',
    });
    await unchanged();
  });
  it('COMMIT応答喪失はunavailableで接続破棄、Callbackを再実行しない', async () => {
    let commits = 0;
    let destroyed = false;
    const wrapped = wrap(async (sql, _values, run) => {
      const value = await run();
      if (sql === 'COMMIT' && ++commits === 2)
        throw new Error('合成COMMIT応答喪失');
      return value;
    });
    leases = make({
      connect: async () => {
        const c = await wrapped.connect();
        return {
          ...c,
          release: (destroy?: boolean) => {
            destroyed = !!destroy;
            c.release(destroy);
          },
        };
      },
    });
    const cb = callbacks();
    const create = vi.fn(cb.create.bind(cb));
    cb.create = create;
    expect(await leases.use(secret(10), code(), clock, cb)).toEqual({
      status: 'unavailable',
    });
    expect(destroyed).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    expect(
      (
        await observer.query<{ state: string }>(
          'SELECT state FROM authentication.recipient_code',
        )
      ).rows[0].state,
    ).toBe('consumed');
  });
  it.each([
    'code-expiry',
    'recipient-disable',
    'session-revoke',
    'lock-timeout',
  ] as const)('2接続: %sをLock待機後に再判定する', async (kind) => {
    const blocker = await pool.connect();
    const entered = deferred();
    let waiter = 0;
    try {
      await blocker.query('BEGIN');
      const blockerPid = (
        await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0].pid;
      await blocker.query(
        'SELECT * FROM authentication.actor WHERE actor_id=$1 FOR UPDATE',
        [recipient],
      );
      leases = make(
        wrap(async (sql, values, run, pid) => {
          if (
            sql.includes('authentication.actor WHERE') &&
            values?.[0] === recipient
          ) {
            waiter = pid;
            entered.resolve();
          }
          return run();
        }),
        kind === 'lock-timeout'
          ? {
              lockTimeoutMs: 100,
              statementTimeoutMs: 1000,
              transactionTimeoutMs: 5000,
            }
          : undefined,
      );
      const pending = leases.use(secret(10), code(), clock, callbacks());
      await entered.promise;
      await waitBlocked(waiter, blockerPid);
      if (kind === 'code-expiry') now = row.expiresAt;
      if (kind === 'recipient-disable') {
        const actor = readStoredAuthenticationActor(
          (
            await blocker.query(
              'SELECT * FROM authentication.actor WHERE actor_id=$1',
              [recipient],
            )
          ).rows[0],
        );
        const disabled = {
          ...actor.row,
          state: 'disabled' as const,
          disabledAt: now,
          version: 2,
        };
        const mac = await digests.actorState({
          row: disabled,
          keyVersion: 'v1',
        });
        await blocker.query(
          "UPDATE authentication.actor SET state='disabled',disabled_at_ms=$1,version=2,state_mac=$2 WHERE actor_id=$3",
          [now, Buffer.from(mac.bytes), recipient],
        );
      }
      if (kind === 'session-revoke') {
        const session = readStoredAuthenticationSession(
          (
            await blocker.query(
              'SELECT * FROM authentication.session_record WHERE session_id=$1 FOR UPDATE',
              [ids.session],
            )
          ).rows[0],
        );
        const revoked = {
          ...session.row,
          state: 'revoked' as const,
          terminalAt: now,
          version: 2,
        };
        await updateAuthenticationRecord(
          blocker,
          revoked,
          await codec.seal({ row: revoked, secrets: { csrf: secret(11) } }),
          1,
        );
      }
      if (kind === 'lock-timeout') {
        expect(await pending).toEqual({ status: 'unavailable' });
        await blocker.query('ROLLBACK');
      } else {
        await blocker.query('COMMIT');
        expect(await pending).toEqual({
          status:
            kind === 'session-revoke'
              ? 'unauthenticated'
              : 'unavailable-to-actor',
        });
      }
      expect(consume).not.toHaveBeenCalled();
      expect(
        (await observer.query(`SELECT * FROM ${schema}.synthetic_write`)).rows,
      ).toEqual([]);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
  it('Actor Lock後にhintの宛先が変わっても追加Actorを後付けLockしない', async () => {
    let changed = false;
    const actors: string[] = [];
    leases = make(
      wrap(async (sql, values, run) => {
        if (sql.includes('authentication.actor WHERE'))
          actors.push(String(values?.[0]));
        if (
          !changed &&
          sql.includes('authentication.recipient_code WHERE') &&
          !sql.includes('FOR UPDATE')
        ) {
          const result = await run();
          if (actors.length > 1) {
            changed = true;
            return {
              ...result,
              rows: result.rows.map((r: unknown) => ({
                ...authenticationDatabaseRow(r),
                recipient_actor_id: caller,
              })),
            };
          }
          return result;
        }
        return run();
      }),
    );
    expect(await leases.use(secret(10), code(), clock, callbacks())).toEqual({
      status: 'unavailable',
    });
    expect(actors).toEqual([caller, recipient, caller]);
    await unchanged();
  });
  it.each(['cancel', 'transaction-timeout'] as const)(
    '%sはCallback待機中も接続を破棄し遅延queryを拒否する',
    async (kind) => {
      const entered = deferred();
      const resume = deferred();
      const control = new AbortController();
      let late: Promise<QueryResult> | undefined;
      leases = make(
        wrap(async (_sql, _values, run) => run()),
        {
          lockTimeoutMs: 500,
          statementTimeoutMs: 1000,
          transactionTimeoutMs: kind === 'transaction-timeout' ? 100 : 5000,
        },
      );
      const pending = leases.withActor(
        secret(10),
        clock,
        async (_actor, scope) => {
          await scopes.scopes.participants.query(
            scope,
            `INSERT INTO ${schema}.synthetic_write (label) VALUES ($1)`,
            ['before-cancel'],
          );
          entered.resolve();
          await resume.promise;
          late = scopes.scopes.participants.query(scope, 'SELECT 1');
          await late.catch(() => {});
          return scope.serialize(null);
        },
        control.signal,
      );
      await entered.promise;
      if (kind === 'cancel') control.abort();
      expect(await pending).toEqual({ status: 'unavailable' });
      resume.resolve();
      await new Promise((done) => setTimeout(done, 30));
      await expect(late).rejects.toThrow();
      await unchanged();
    },
  );
});
