import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
  RecipientCodeKeyQuery,
  RecipientCodeMacPurpose,
} from '../src/shared/application/authentication/recipient-code-crypto-ports.js';
import type { RecipientCodeSessionLeasePort } from '../src/shared/application/authentication/recipient-code-ports.js';
import { RecipientCodeSecret } from '../src/shared/application/authentication/recipient-code-input.js';
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
import { createPostgresRecipientCodeStore } from '../src/shared/infrastructure/authentication/postgres/postgres-recipient-code-store.js';
import {
  insertAuthenticationRecord,
  readStoredAuthenticationSession,
  updateAuthenticationRecord,
} from '../src/shared/infrastructure/authentication/postgres/authentication-record-rows.js';
import { readRecipientCode } from '../src/shared/infrastructure/authentication/postgres/recipient-code-selection.js';
import type { AuthenticationConnectionPool } from '../src/shared/infrastructure/authentication/postgres/authentication-transactions.js';
import {
  SyntheticKeyRegistry,
  ids,
} from '../src/shared/infrastructure/authentication/test/authentication-crypto-fixtures.js';
const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';
const caller = '10000000-0000-4000-8000-000000000020';
const other = '10000000-0000-4000-8000-000000000010';
const secondSession = '10000000-0000-4000-8000-000000000099';
const secret = (byte: number) => Buffer.alloc(32, byte).toString('base64url');
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

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('コード管理Storeの実PG17原子性 #240（GMと公開経路なし）', () => {
  const observer = new Client({ connectionString: url });
  const pool = new Pool({ connectionString: url, max: 4 });
  const discarded = new WeakSet<PoolClient>();
  const unexpectedPoolErrors: string[] = [];
  pool.on('error', (e: Error & { code?: string }, client) => {
    if (e.code !== '25P04' || !discarded.has(client))
      unexpectedPoolErrors.push(e.code ?? 'unknown');
  });
  let owned = false;
  let schema = '';
  let now = 1_000_000;
  const clock = { now: () => now };
  let codec: ReturnType<typeof createAuthenticationRecordCodec>;
  let digests: ReturnType<typeof createAuthenticationDigests>;
  let crypto: ReturnType<typeof createRecipientCodeCrypto>;
  let scopes: ReturnType<typeof createRecipientCodeTransactionScopes>;
  let store: ReturnType<typeof createPostgresRecipientCodeStore>;
  const materials = new Map<string, Uint8Array>();
  const allocated = new Map<string, number>();
  const alerts = vi.fn();
  const sqls: { sql: string; values: unknown[]; pid: number }[] = [];
  const serializedBodies: string[] = [];
  const provision = (
    purpose: RecipientCodeMacPurpose,
    scopeId: string,
    version: string,
  ) => {
    const id = `${purpose}/${scopeId}/${version}`;
    if (materials.has(id)) throw new Error('合成: 重複鍵発行');
    materials.set(id, randomBytes(32));
  };
  const codeKey = <P extends RecipientCodeMacPurpose>(purpose: P) => ({
    readKey: (query: RecipientCodeKeyQuery) => {
      const material = materials.get(
        `${purpose}/${query.scopeId}/${query.keyVersion}`,
      );
      return Promise.resolve(
        material
          ? {
              status: 'available' as const,
              ...query,
              key: importRecipientCodeMacKey(purpose, material),
            }
          : { status: 'unavailable' as const },
      );
    },
  });
  const stateKeys = {
    allocate: vi.fn(
      (input: { codeId: string; keyVersion: string; expiresAt: number }) => {
        const id = `${input.codeId}/${input.keyVersion}`;
        if (allocated.has(id))
          return Promise.resolve(
            allocated.get(id) === input.expiresAt
              ? { status: 'allocated' as const, ...input, created: false }
              : { status: 'unavailable' as const },
          );
        provision(
          'auth-recipient-code-state/v1',
          input.codeId,
          input.keyVersion,
        );
        allocated.set(id, input.expiresAt);
        return Promise.resolve({
          status: 'allocated' as const,
          ...input,
          created: true,
        });
      },
    ),
  };
  type Intercept = (
    sql: string,
    values: unknown[] | undefined,
    run: () => Promise<QueryResult>,
    pid: number,
  ) => Promise<QueryResult>;
  const wrap = (
    intercept: Intercept = async (_s, _v, run) => run(),
  ): AuthenticationConnectionPool => ({
    connect: async () => {
      const c = await pool.connect();
      const pid = (
        await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0].pid;
      return {
        on: c.on.bind(c),
        removeListener: c.removeListener.bind(c),
        query: (sql: string, values?: unknown[]) => {
          sqls.push({ sql, values: values ?? [], pid });
          return intercept(sql, values, () => c.query(sql, values), pid);
        },
        release: (destroy?: boolean) => {
          if (destroy) discarded.add(c);
          c.release(destroy);
        },
      };
    },
  });
  const make = (
    connections: AuthenticationConnectionPool = wrap(),
    entropy?: { generate: () => Uint8Array; codeId: () => string },
  ) => {
    const leases = createPostgresRecipientCodeLeases({
      pool: connections,
      scopes,
      codec,
      digests,
      crypto,
      limits: {
        lockTimeoutMs: 1500,
        statementTimeoutMs: 3000,
        transactionTimeoutMs: 10000,
      },
      consume: () => Promise.reject(new Error('GMなし')),
      onAlert: alerts,
    });
    const observedLeases: Pick<
      RecipientCodeSessionLeasePort,
      'withActor' | 'inspectActor'
    > = {
      withActor: (secret, clock, callback, signal) =>
        leases.withActor(
          secret,
          clock,
          async (caller, scope) => {
            const value = await callback(caller, scope);
            serializedBodies.push(value.body);
            return value;
          },
          signal,
        ),
      inspectActor: leases.inspectActor.bind(leases),
    };
    return createPostgresRecipientCodeStore({
      leases: observedLeases,
      participants: scopes.scopes.participants,
      guard: scopes.guard.bind(scopes),
      crypto,
      digests,
      stateKeys,
      entropy,
      onAlert: alerts,
    });
  };
  const rows = async () =>
    (
      await observer.query(
        'SELECT * FROM authentication.recipient_code ORDER BY code_id',
      )
    ).rows.map(readRecipientCode);
  const session = async (id = ids.session) =>
    readStoredAuthenticationSession(
      (
        await observer.query(
          'SELECT * FROM authentication.session_record WHERE session_id=$1',
          [id],
        )
      ).rows[0],
    );
  const audits = async () =>
    (
      await observer.query<Record<string, unknown>>(
        "SELECT action,decision,reason,code_digest_key_version,code_digest,actor_digest_key_version,actor_digest FROM authentication.audit_event WHERE action::text LIKE 'recipient-code-%' ORDER BY occurred_at_ms,event_id",
      )
    ).rows;
  const issue = async () => {
    const result = await store.issue(secret(10), clock);
    expect(result.status).toBe('issued');
    if (result.status !== 'issued') throw new Error('合成: 発行失敗');
    return result;
  };
  const actor = async (id: string, state: 'active' | 'disabled' = 'active') => {
    const row = {
      actorId: id,
      version: state === 'active' ? 1 : 2,
      state,
      createdAt: 0,
      disabledAt: state === 'active' ? null : now,
    };
    const mac = await digests.actorState({ row, keyVersion: 'v1' });
    await observer.query(
      "INSERT INTO authentication.actor(actor_id,state,version,created_at_ms,disabled_at_ms,control_key_version,state_mac) VALUES($1,$2,$3,0,$4,'v1',$5) ON CONFLICT(actor_id) DO UPDATE SET state=$2,version=$3,disabled_at_ms=$4,state_mac=$5",
      [id, state, row.version, row.disabledAt, Buffer.from(mac.bytes)],
    );
  };
  const addSession = async (id: string, byte: number, actorId = caller) => {
    const digest = await digests.sessionCookie({
      secret: secret(byte),
      epoch: ids.epoch,
      keyVersion: 'v1',
    });
    const row: AuthenticationSessionRow = {
      recordKind: 'session',
      sessionId: id,
      actorId,
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
      row,
      await codec.seal({ row, secrets: { csrf: secret(byte + 1) } }),
    );
  };
  const waitBlocked = async (pid: number, blocker: number) => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (
        (
          await observer.query<{ pids: number[] }>(
            'SELECT pg_blocking_pids($1) AS pids',
            [pid],
          )
        ).rows[0].pids.includes(blocker)
      )
        return;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('合成: 実接続間のLock待機なし');
  };
  beforeAll(async () => {
    await observer.connect();
    const info = (
      await observer.query<{ db: string; version: string }>(
        "SELECT current_database() AS db,current_setting('server_version_num') AS version",
      )
    ).rows[0];
    if (
      !info.db.endsWith('_test') ||
      Number(info.version) < 170000 ||
      Number(info.version) >= 180000
    )
      throw new Error('専用PG17 _test DBだけを使用する');
    await observer.query('SELECT pg_advisory_lock(1801546597,1635087464)');
    if (
      (
        await observer.query<{ ns: string | null }>(
          "SELECT to_regnamespace('authentication') AS ns",
        )
      ).rows[0].ns !== null
    )
      throw new Error('既存Schemaを変更しない');
    schema = `test_issue240_${randomUUID().replaceAll('-', '')}`;
    await observer.query(`CREATE SCHEMA ${schema}`);
    owned = true;
    await observer.query(`SET search_path TO ${schema}`);
    const names = [
      '0005_authentication_schema',
      '0006_authentication_inventory',
      '0008_recipient_code_schema',
      '0009_recipient_code_audit',
    ];
    await applySqlMigrations(
      observer,
      await Promise.all(
        names.map(async (name) => ({
          version: Number(name.slice(0, 4)),
          name,
          sql: await readFile(
            new URL(
              `../migrations/authentication/${name}.sql`,
              import.meta.url,
            ),
            'utf8',
          ),
        })),
      ),
    );
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    stateKeys.allocate.mockClear();
    alerts.mockReset();
    sqls.length = 0;
    serializedBodies.length = 0;
    materials.clear();
    allocated.clear();
    now = 1_000_000;
    await observer.query(
      'TRUNCATE authentication.recipient_code,authentication.audit_event,authentication.session_record,authentication.actor,authentication.key_generation CASCADE',
    );
    await observer.query(
      "UPDATE authentication.key_state SET status='active',generation_version=1,epoch=$1",
      [ids.epoch],
    );
    for (const purpose of purposes)
      await observer.query(
        "INSERT INTO authentication.key_generation(generation_id,purpose,key_version,epoch,searchable,write_required) VALUES($1,$2,'v1',$3,true,true)",
        [randomUUID(), purpose, purpose.endsWith('cookie') ? ids.epoch : null],
      );
    codec = createAuthenticationRecordCodec({
      keys: new SyntheticKeyRegistry().provider(),
    });
    digests = createAuthenticationDigests({ keys });
    for (const version of ['v1', 'v2']) {
      provision('auth-recipient-code-lookup/v1', 'authentication', version);
      provision('auth-audit-recipient-code/v1', 'authentication', version);
    }
    crypto = {
      ...createRecipientCodeCrypto({
        keys: {
          lookup: codeKey('auth-recipient-code-lookup/v1'),
          state: codeKey('auth-recipient-code-state/v1'),
          audit: codeKey('auth-audit-recipient-code/v1'),
        },
      }),
    };
    scopes = createRecipientCodeTransactionScopes(
      createAuthenticationTransactionScopes(),
    );
    await actor(caller);
    await actor(other);
    await addSession(ids.session, 10);
    await addSession(secondSession, 20);
    store = make();
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

  it('初回/再発行は32byteの秘密値をcommit後だけ返し、旧Issued/MAC/監査/Sessionを一括更新する', async () => {
    const first = await issue();
    const decoded = first.code.copyBytes();
    expect(decoded).toHaveLength(32);
    expect(
      RecipientCodeSecret.parse(Buffer.from(decoded).toString('base64url')),
    ).not.toBeNull();
    expect(first.expiresAt).toBe(now + 600000);
    now += 100;
    const second = await issue();
    expect(second.codeId).not.toBe(first.codeId);
    expect(second.code.copyBytes()).not.toEqual(decoded);
    const records = await rows();
    expect(records.find((r) => r.codeId === first.codeId)?.status).toBe(
      'replaced',
    );
    expect(
      records.filter((r) => r.status === 'issued').map((r) => r.codeId),
    ).toEqual([second.codeId]);
    for (const row of records)
      expect(await crypto.verifyRecord(row)).toBe(true);
    expect((await session()).row.version).toBe(3);
    expect((await audits()).map((r) => r.decision)).toEqual(['allow', 'allow']);
    const writes = sqls.filter((x) => /INSERT|UPDATE/.test(x.sql));
    const raw = Buffer.from(decoded).toString('base64url');
    expect(
      writes.every(
        (x) =>
          !JSON.stringify(x.values).includes(raw) &&
          !x.values.some(
            (v) =>
              v instanceof Uint8Array &&
              Buffer.from(v).equals(Buffer.from(decoded)),
          ),
      ),
    ).toBe(true);
    const inspect = await store.inspect(secret(10), clock);
    expect(inspect).toEqual({
      status: 'found',
      code: {
        codeId: second.codeId,
        state: 'issued',
        expiresAt: second.expiresAt,
      },
    });
    expect(JSON.stringify(inspect)).not.toContain(raw);
    expect(serializedBodies.every((body) => !body.includes(raw))).toBe(true);
    expect(Object.keys((await audits())[0]).sort()).not.toContain('code_id');
    const audit = (await audits()).find(
      (r) => r.action === 'recipient-code-issue',
    );
    expect(audit?.code_digest).toHaveLength(32);
    expect(audit?.actor_digest).toHaveLength(32);
    expect(audit?.code_digest).not.toEqual(audit?.actor_digest);
    expect(audit?.code_digest).not.toEqual(
      records.find((r) => r.codeId === first.codeId)?.lookupDigest,
    );
  });
  it('状態確認は不在/最小状態を返し、idle/Session版/コード期限を延長しない', async () => {
    expect(await store.inspect(secret(10), clock)).toEqual({
      status: 'no-code',
    });
    const issued = await issue();
    const before = await session();
    now += 1234;
    await store.inspect(secret(10), clock);
    expect(await session()).toEqual(before);
    expect((await rows())[0].expiresAt).toBe(issued.expiresAt);
  });
  it('本人取消は一回終端化し、終端/清掃後/他人/不存在を同じAlreadyInactiveにする', async () => {
    const issued = await issue();
    expect(await store.revoke(secret(10), issued.codeId, clock)).toEqual({
      status: 'revoked',
    });
    expect((await rows())[0].status).toBe('revoked');
    expect(await crypto.verifyRecord((await rows())[0])).toBe(true);
    for (const id of [issued.codeId, randomUUID()])
      expect(await store.revoke(secret(10), id, clock)).toEqual({
        status: 'already-inactive',
      });
    await observer.query('DELETE FROM authentication.recipient_code');
    expect(await store.revoke(secret(10), issued.codeId, clock)).toEqual({
      status: 'already-inactive',
    });
    expect(await store.revoke(secret(20), issued.codeId, clock)).toEqual({
      status: 'already-inactive',
    });
  });
  it('別人codeIdと不在は同じ結果/監査形であり、他人行を更新しない', async () => {
    await addSession(randomUUID(), 30, other);
    const theirs = await store.issue(secret(30), clock);
    if (theirs.status !== 'issued') throw new Error('合成');
    const before = await rows();
    for (const id of [theirs.codeId, randomUUID()])
      expect(await store.revoke(secret(10), id, clock)).toEqual({
        status: 'already-inactive',
      });
    expect(await rows()).toEqual(before);
    expect(
      (await audits())
        .filter((r) => r.action === 'recipient-code-revoke')
        .map((r) => [
          r.decision,
          r.reason,
          r.code_digest,
          r.code_digest_key_version,
        ]),
    ).toEqual([
      ['allow', 'success', null, null],
      ['allow', 'success', null, null],
    ]);
  });
  it('期限等値はExpired/AlreadyInactive、再発行時は期限超過IssuedもReplacedにする', async () => {
    const first = await issue();
    now = first.expiresAt;
    expect(await store.inspect(secret(10), clock)).toEqual({
      status: 'found',
      code: {
        codeId: first.codeId,
        state: 'expired',
        expiresAt: first.expiresAt,
      },
    });
    expect(await store.revoke(secret(10), first.codeId, clock)).toEqual({
      status: 'already-inactive',
    });
    const next = await issue();
    expect(next.expiresAt).toBe(now + 600000);
    expect((await rows()).find((r) => r.codeId === first.codeId)?.status).toBe(
      'replaced',
    );
  });
  it('発行元のlogoutはコードを変更せず、別の有効な本人Sessionで管理できる', async () => {
    const issued = await issue();
    const previous = await session();
    const updated = {
      ...previous.row,
      version: previous.row.version + 1,
      state: 'revoked' as const,
      terminalAt: now,
    };
    const opened = await codec.open(previous);
    await updateAuthenticationRecord(
      observer,
      updated,
      await codec.seal({ row: updated, secrets: opened }),
      previous.row.version,
    );
    expect(await store.inspect(secret(10), clock)).toEqual({
      status: 'unauthenticated',
    });
    expect(await store.inspect(secret(20), clock)).toEqual({
      status: 'found',
      code: {
        codeId: issued.codeId,
        state: 'issued',
        expiresAt: issued.expiresAt,
      },
    });
    expect((await rows())[0].status).toBe('issued');
  });
  it.each(['issue', 'inspect', 'revoke'] as const)(
    '%sは無効Sessionで秘密/鍵/コードSQLを扱わない',
    async (action) => {
      const result =
        action === 'revoke'
          ? await store.revoke(secret(99), randomUUID(), clock)
          : await store[action](secret(99), clock);
      expect(result).toEqual({ status: 'unauthenticated' });
      expect(stateKeys.allocate).not.toHaveBeenCalled();
      expect(sqls.some((x) => x.sql.includes('recipient_code WHERE'))).toBe(
        false,
      );
    },
  );
  it('Actor無効化は新規発行と管理を拒否し、既存コードを復活させない', async () => {
    const first = await issue();
    const before = await rows();
    await actor(caller, 'disabled');
    expect(await store.issue(secret(20), clock)).toEqual({
      status: 'unauthenticated',
    });
    expect(await store.revoke(secret(10), first.codeId, clock)).toEqual({
      status: 'unauthenticated',
    });
    expect(await rows()).toEqual(before);
  });
  it.each([
    'mac',
    'actor',
    'epoch',
    'lookup-generation',
    'mac-generation',
  ] as const)('%s不整合は成功/部分更新を返さない', async (kind) => {
    const issued = await issue();
    const statements = {
      mac: 'UPDATE authentication.recipient_code SET state_mac=$1',
      actor: 'UPDATE authentication.recipient_code SET recipient_actor_id=$1',
      epoch: 'UPDATE authentication.recipient_code SET epoch=$1',
      'lookup-generation':
        'UPDATE authentication.recipient_code SET lookup_key_version=$1',
      'mac-generation':
        'UPDATE authentication.recipient_code SET mac_key_version=$1',
    };
    const value =
      kind === 'mac'
        ? randomBytes(32)
        : kind === 'actor'
          ? other
          : kind === 'epoch'
            ? randomUUID()
            : 'unknown';
    await observer.query(statements[kind], [value]);
    if (kind === 'actor') await addSession(randomUUID(), 30, other);
    const result =
      kind === 'actor'
        ? await store.inspect(secret(30), clock)
        : await store.issue(secret(10), clock);
    void issued;
    // 選択した行の所有Actor差替えもMACで拒否する。
    expect(result).toEqual({
      status: 'unavailable',
    });
    expect(await rows()).toHaveLength(1);
  });
  it.each(['lookup', 'recordMac', 'audit', 'allocate'] as const)(
    '%s鍵障害は旧有効コード/Sessionを保ち拒否Auditだけを許す',
    async (kind) => {
      await issue();
      const before = await rows();
      const beforeSession = await session();
      if (kind === 'allocate')
        stateKeys.allocate.mockRejectedValueOnce(
          new Error('synthetic secret must not escape'),
        );
      else
        vi.spyOn(crypto, kind).mockRejectedValueOnce(
          new Error('synthetic secret must not escape'),
        );
      expect(await store.issue(secret(10), clock)).toEqual({
        status: 'unavailable',
      });
      expect(await rows()).toEqual(before);
      expect(await session()).toEqual(beforeSession);
      expect((await audits()).some((r) => r.decision === 'deny')).toBe(true);
      expect(
        alerts.mock.calls.every(([v]) =>
          JSON.stringify(v).match(
            /^\{"code":"RECIPIENT_CODE_(STORE|LEASE)_UNAVAILABLE"\}$/,
          ),
        ),
      ).toBe(true);
    },
  );
  it.each([
    'UPDATE authentication.recipient_code',
    'INSERT INTO authentication.recipient_code',
    'INSERT INTO authentication.audit_event',
  ] as const)('%s障害は旧IssuedとSessionをrollbackする', async (fragment) => {
    await issue();
    const before = await rows();
    const beforeSession = await session();
    let failed = false;
    store = make(
      wrap(async (sql, _v, run) => {
        if (!failed && sql.includes(fragment)) {
          failed = true;
          throw new Error('synthetic SQL failure');
        }
        return run();
      }),
    );
    expect(await store.issue(secret(10), clock)).toEqual({
      status: 'unavailable',
    });
    expect(failed).toBe(true);
    expect(await rows()).toEqual(before);
    expect(await session()).toEqual(beforeSession);
  });
  it.each(['before', 'after'] as const)(
    'COMMIT %s応答障害は原値を返さず、自動再発行/復元しない',
    async (mode) => {
      await issue();
      const before = await rows();
      const allocations = stateKeys.allocate.mock.calls.length;
      let failed = false;
      store = make(
        wrap(async (sql, _v, run) => {
          if (sql === 'COMMIT' && !failed) {
            failed = true;
            if (mode === 'after') await run();
            throw new Error('synthetic commit response loss');
          }
          return run();
        }),
      );
      expect(await store.issue(secret(10), clock)).toEqual({
        status: 'unavailable',
      });
      expect(stateKeys.allocate.mock.calls.length).toBe(allocations + 1);
      const current = await rows();
      expect(current.length).toBe(mode === 'before' ? 1 : 2);
      if (mode === 'before') expect(current).toEqual(before);
      const result = await store.inspect(secret(20), clock);
      expect(result.status).toBe('found');
      expect(Object.keys(result)).toEqual(['status', 'code']);
      expect(allocated.size).toBe(2); // rollback後も孤立鍵inventoryを消さない。
    },
  );
  it('全searchable旧世代の衝突を拒否し、一度の生成で旧状態を保つ', async () => {
    const issued = await issue();
    await observer.query(
      "UPDATE authentication.key_generation SET write_required=false WHERE purpose='recipient-code-lookup'",
    );
    await observer.query(
      "INSERT INTO authentication.key_generation(generation_id,purpose,key_version,epoch,searchable,write_required) VALUES($1,'recipient-code-lookup','v2',NULL,true,true)",
      [randomUUID()],
    );
    const generate = vi.fn(() => issued.code.copyBytes());
    const before = await rows();
    store = make(undefined, { generate, codeId: randomUUID });
    expect(await store.issue(secret(10), clock)).toEqual({
      status: 'unavailable',
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual(before);
  });
  it('検索全世代の複数hitは任意の一件を選ばない', async () => {
    const issued = await issue();
    await addSession(randomUUID(), 30, other);
    await store.issue(secret(30), clock);
    const otherRow = (await rows()).find((r) => r.recipientActorId === other)!;
    const lookup = await crypto.lookup({
      secret: issued.code,
      keyVersion: 'v2',
    });
    await observer.query(
      "UPDATE authentication.recipient_code SET lookup_key_version='v2',lookup_digest=$1 WHERE code_id=$2",
      [Buffer.from(lookup.bytes), otherRow.codeId],
    );
    await observer.query(
      "INSERT INTO authentication.key_generation(generation_id,purpose,key_version,epoch,searchable,write_required) VALUES($1,'recipient-code-lookup','v2',NULL,true,false)",
      [randomUUID()],
    );
    const before = await rows();
    const verify = vi.spyOn(crypto, 'verifyRecord');
    store = make(undefined, {
      generate: () => issued.code.copyBytes(),
      codeId: randomUUID,
    });
    expect(await store.issue(secret(10), clock)).toEqual({
      status: 'unavailable',
    });
    expect(await rows()).toEqual(before);
    expect(verify).toHaveBeenCalledTimes(1); // 既存本人行の検証だけ。hit候補のMAC鍵は読まない。
  });
  it('旧MACを検証して現行write世代で終端化し、旧期限を延長しない', async () => {
    const issued = await issue();
    await observer.query(
      "UPDATE authentication.key_generation SET write_required=false WHERE purpose='recipient-code-state-mac'",
    );
    await observer.query(
      "INSERT INTO authentication.key_generation(generation_id,purpose,key_version,epoch,searchable,write_required) VALUES($1,'recipient-code-state-mac','v2',NULL,true,true)",
      [randomUUID()],
    );
    await issue();
    const old = (await rows()).find((r) => r.codeId === issued.codeId)!;
    expect(old.macKeyVersion).toBe('v2');
    expect(old.expiresAt).toBe(issued.expiresAt);
    expect(await crypto.verifyRecord(old)).toBe(true);
  });
  it.each(['serialize', 'commit'] as const)(
    '%s前の発行コード期限等値を最終guardでrollbackする',
    async (boundary) => {
      await issue();
      const before = await rows();
      const beforeSession = await session();
      store = make(
        wrap(async (sql, _v, run) => {
          const result = await run();
          if (
            (boundary === 'serialize' &&
              sql.includes('INSERT INTO authentication.audit_event')) ||
            (boundary === 'commit' &&
              sql.includes('UPDATE authentication.session_record'))
          )
            now += 600000;
          return result;
        }),
      );
      expect(await store.issue(secret(10), clock)).toEqual({
        status: 'unavailable',
      });
      expect(await rows()).toEqual(before);
      expect(await session()).toEqual(beforeSession);
    },
  );
  it('二端末発行は実Actor Lockで直列化し、最後の一コードだけをIssuedにする', async () => {
    const entered = deferred(),
      resume = deferred(),
      secondStarted = deferred();
    let firstPid = 0,
      secondPid = 0;
    const first = make(
      wrap(async (sql, _v, run, pid) => {
        const result = await run();
        if (sql.includes('recipient_code WHERE recipient_actor_id')) {
          firstPid = pid;
          entered.resolve();
          await resume.promise;
        }
        return result;
      }),
    );
    const second = make(
      wrap(async (sql, _v, run, pid) => {
        if (sql.includes('authentication.actor WHERE')) {
          secondPid = pid;
          secondStarted.resolve();
        }
        return run();
      }),
    );
    const pending = first.issue(secret(10), clock);
    await entered.promise;
    const later = second.issue(secret(20), clock);
    await secondStarted.promise;
    try {
      await waitBlocked(secondPid, firstPid);
    } finally {
      resume.resolve();
    }
    const results = await Promise.all([pending, later]);
    expect(results.map((r) => r.status)).toEqual(['issued', 'issued']);
    expect((await rows()).filter((r) => r.status === 'issued')).toHaveLength(1);
    expect((await rows()).filter((r) => r.status === 'replaced')).toHaveLength(
      1,
    );
    expect(firstPid).not.toBe(secondPid);
  }, 10000);
  it('再発行と旧codeId取消が競合しても新コードを取消しない', async () => {
    const old = await issue();
    const [next, revoke] = await Promise.all([
      store.issue(secret(20), clock),
      store.revoke(secret(10), old.codeId, clock),
    ]);
    expect(next.status).toBe('issued');
    expect(['revoked', 'already-inactive']).toContain(revoke.status);
    expect((await rows()).filter((r) => r.status === 'issued')).toHaveLength(1);
  });
  it.each(['length', 'type', 'id', 'ack'] as const)(
    '%s発行入力/鍵Ack不正は旧状態を保つ',
    async (kind) => {
      await issue();
      const before = await rows();
      const beforeSession = await session();
      if (kind === 'ack')
        stateKeys.allocate.mockResolvedValueOnce({
          status: 'allocated',
          created: true,
          codeId: randomUUID(),
          keyVersion: 'wrong',
          expiresAt: 0,
        });
      store = make(undefined, {
        generate: () =>
          kind === 'length'
            ? new Uint8Array(31)
            : kind === 'type'
              ? ([] as unknown as Uint8Array)
              : randomBytes(32),
        codeId: () => (kind === 'id' ? 'bad' : randomUUID()),
      });
      expect(await store.issue(secret(10), clock)).toEqual({
        status: 'unavailable',
      });
      expect(await rows()).toEqual(before);
      expect(await session()).toEqual(beforeSession);
    },
  );
  it('codeId重複は旧コード/Sessionを保ち、鍵も自動再生成しない', async () => {
    const old = await issue();
    const before = await rows();
    const beforeSession = await session();
    store = make(undefined, {
      generate: () => randomBytes(32),
      codeId: () => old.codeId,
    });
    expect(await store.issue(secret(10), clock)).toEqual({
      status: 'unavailable',
    });
    expect(await rows()).toEqual(before);
    expect(await session()).toEqual(beforeSession);
    expect(allocated.size).toBe(1);
  });
  it('取消判断後の期限等値では取消/Session更新を全rollbackする', async () => {
    const old = await issue();
    const before = await rows();
    const beforeSession = await session();
    store = make(
      wrap(async (sql, _v, run) => {
        const result = await run();
        if (sql.includes('UPDATE authentication.recipient_code'))
          now = old.expiresAt;
        return result;
      }),
    );
    expect(await store.revoke(secret(10), old.codeId, clock)).toEqual({
      status: 'unavailable',
    });
    expect(await rows()).toEqual(before);
    expect(await session()).toEqual(beforeSession);
  });
  it('通知Callbackの例外と拒否Audit障害でも秘密や許可結果を返さない', async () => {
    alerts.mockImplementation(() => {
      throw new Error('synthetic private error');
    });
    await issue();
    const before = await rows();
    const beforeSession = await session();
    store = make(
      wrap(async (sql, _v, run) => {
        if (sql.includes('INSERT INTO authentication.audit_event'))
          throw new Error('synthetic audit unavailable');
        return run();
      }),
    );
    expect(await store.issue(secret(10), clock)).toEqual({
      status: 'unavailable',
    });
    expect(await rows()).toEqual(before);
    expect(await session()).toEqual(beforeSession);
  });
  it('Actor無効化が先行すると待機した発行は未認証になり、後付けLockしない', async () => {
    const control = await pool.connect();
    const started = deferred();
    let pid = 0;
    await control.query('BEGIN');
    await control.query(
      'SELECT actor_id FROM authentication.actor WHERE actor_id=$1 FOR UPDATE',
      [caller],
    );
    const blocker = (
      await control.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    ).rows[0].pid;
    store = make(
      wrap(async (sql, _v, run, p) => {
        if (sql.includes('authentication.actor WHERE')) {
          pid = p;
          started.resolve();
        }
        return run();
      }),
    );
    const pending = store.issue(secret(10), clock);
    await started.promise;
    try {
      await waitBlocked(pid, blocker);
      const row = {
        actorId: caller,
        version: 2,
        state: 'disabled' as const,
        createdAt: 0,
        disabledAt: now,
      };
      const mac = await digests.actorState({ row, keyVersion: 'v1' });
      await control.query(
        "UPDATE authentication.actor SET state='disabled',version=2,disabled_at_ms=$1,state_mac=$2 WHERE actor_id=$3",
        [now, Buffer.from(mac.bytes), caller],
      );
      await control.query('COMMIT');
    } finally {
      await control.query('ROLLBACK');
      control.release();
    }
    expect(await pending).toEqual({ status: 'unauthenticated' });
    expect(await rows()).toEqual([]);
    expect(stateKeys.allocate).not.toHaveBeenCalled();
  }, 10000);
  it('旧Recordの新世代鍵確保後にrollbackしても、明示再発行で既存鍵を再生成せず利用する', async () => {
    await issue();
    await observer.query(
      "UPDATE authentication.key_generation SET write_required=false WHERE purpose='recipient-code-state-mac'",
    );
    await observer.query(
      "INSERT INTO authentication.key_generation(generation_id,purpose,key_version,epoch,searchable,write_required) VALUES($1,'recipient-code-state-mac','v2',NULL,true,true)",
      [randomUUID()],
    );
    let fail = true;
    store = make(
      wrap(async (sql, _v, run) => {
        if (fail && sql.includes('INSERT INTO authentication.recipient_code')) {
          fail = false;
          throw new Error('synthetic rollback after allocation');
        }
        return run();
      }),
    );
    expect(await store.issue(secret(10), clock)).toEqual({
      status: 'unavailable',
    });
    const allocatedBefore = new Map(materials);
    expect((await rows())[0].macKeyVersion).toBe('v1');
    expect((await store.issue(secret(10), clock)).status).toBe('issued');
    for (const [id, key] of allocatedBefore)
      expect(materials.get(id)).toEqual(key);
  });

  it('code/Session/コード監査/認証監査は同じbackendとxminで確定する', async () => {
    await issue();
    const pids = new Set(
      sqls.filter((x) => /INSERT|UPDATE/.test(x.sql)).map((x) => x.pid),
    );
    expect(pids.size).toBe(1);
    const txs = (
      await observer.query<{ tx: string }>(
        'SELECT xmin::text AS tx FROM authentication.recipient_code UNION ALL SELECT xmin::text FROM authentication.session_record WHERE session_id=$1 UNION ALL SELECT xmin::text FROM authentication.audit_event',
        [ids.session],
      )
    ).rows;
    expect(txs.length).toBe(4);
    expect(new Set(txs.map((r) => r.tx)).size).toBe(1);
  });
  it('Consumedは最小終端状態として確認でき、取消で復活/変更しない', async () => {
    const issued = await issue();
    const row = (await rows())[0];
    const { mac: old, ...fields } = row;
    void old;
    const updated = {
      ...fields,
      status: 'consumed' as const,
      recordVersion: 2,
      terminalAt: now,
    };
    const mac = await crypto.recordMac(updated);
    await observer.query(
      "UPDATE authentication.recipient_code SET state='consumed',record_version=2,terminal_at_ms=$1,state_mac=$2",
      [now, Buffer.from(mac.bytes)],
    );
    expect(await store.inspect(secret(10), clock)).toEqual({
      status: 'found',
      code: {
        codeId: issued.codeId,
        state: 'consumed',
        expiresAt: issued.expiresAt,
      },
    });
    expect(await store.revoke(secret(10), issued.codeId, clock)).toEqual({
      status: 'already-inactive',
    });
    expect((await rows())[0].recordVersion).toBe(2);
  });
  it('状態確認中に期限等値へ進んだIssuedを有効状態として返さない', async () => {
    const old = await issue();
    const before = await session();
    store = make(
      wrap(async (sql, _v, run) => {
        const result = await run();
        if (sql.includes('INSERT INTO authentication.audit_event'))
          now = old.expiresAt;
        return result;
      }),
    );
    expect(await store.inspect(secret(10), clock)).toEqual({
      status: 'unavailable',
    });
    expect(await session()).toEqual(before);
    expect((await rows())[0].status).toBe('issued');
  });
});
