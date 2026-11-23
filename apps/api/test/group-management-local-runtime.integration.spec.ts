import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from 'pg';
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
import { GoogleIdTokenVerifier } from '../src/shared/infrastructure/authentication/google-id-token-verifier.js';
import { migrateAuthenticationDevelopmentDatabase } from '../dev/authentication-development-migrations.js';
import {
  groupManagementDevelopmentTables,
  openAuthenticationDevelopmentRuntime,
} from '../dev/authentication-development-runtime.js';
import { createAuthenticationDevelopmentServer } from '../dev/authentication-development-server.js';
import { businessPoolSettings } from '../dev/development-business-pool.js';

const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';
const origin = 'http://localhost:3000';
const businessApplication = 'kakei-group-disposable-development';
const leaseApplication = 'kakei-auth-development-lease';
const canonicalUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Runtime = Awaited<ReturnType<typeof openAuthenticationDevelopmentRuntime>>;
type GraphQLBody = {
  data?: Record<string, unknown> | null;
  errors?: { extensions?: { code?: string } }[];
};

describe('開発用CompositionのGroup Managementと業務GraphQL（#314）', () => {
  const observer = new Client({ connectionString: url });
  let databaseName = '';
  let owned = false;
  let database: Client | undefined;
  let connectionString = '';
  const env = () => ({
    NODE_ENV: 'development',
    AUTH_DEV_DATABASE_URL: connectionString,
    GOOGLE_CLIENT_ID: 'synthetic-client.apps.googleusercontent.com',
  });
  const migrationVersions = async () =>
    (
      await database!.query<{ version: string }>(
        'SELECT version::text AS version FROM app_schema_migrations ORDER BY version::bigint',
      )
    ).rows.map((row) => Number(row.version));
  const locatorVersion = async () =>
    (
      await database!.query<{ current_key_version: string | null }>(
        'SELECT current_key_version FROM group_operation_locator_key_state WHERE id=1',
      )
    ).rows[0]?.current_key_version;
  const authenticationStatus = async () =>
    (
      await database!.query<{ status: string }>(
        'SELECT status FROM authentication.key_state WHERE state_id=1',
      )
    ).rows[0]?.status;
  const count = async (table: string) => {
    if (!/^[a-z_]+(\.[a-z_]+)?$/.test(table))
      throw new Error('試験Table名が必要');
    return (
      await database!.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${table}`,
      )
    ).rows[0].count;
  };
  const connections = async (application: string) =>
    (
      await observer.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND application_name=$2',
        [databaseName, application],
      )
    ).rows[0].count;

  beforeAll(async () => {
    await observer.connect();
    const info = (
      await observer.query<{ name: string; version: string }>(
        "SELECT current_database() AS name,current_setting('server_version_num') AS version",
      )
    ).rows[0];
    if (
      !info.name.endsWith('_test') ||
      Number(info.version) < 170000 ||
      Number(info.version) >= 180000
    )
      throw new Error('専用PG17 Test DBが必要');
  });
  beforeEach(async () => {
    databaseName =
      'synthetic_314_' + randomUUID().replaceAll('-', '') + '_auth_dev';
    await observer.query('CREATE DATABASE ' + databaseName);
    owned = true;
    const target = new URL(url);
    target.pathname = '/' + databaseName;
    connectionString = target.toString();
    database = new Client({ connectionString });
    await database.connect();
    await migrateAuthenticationDevelopmentDatabase(env());
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await database?.end();
    if (owned)
      await observer.query('DROP DATABASE ' + databaseName + ' WITH (FORCE)');
    owned = false;
  });
  afterAll(async () => {
    await observer.end();
  });

  /** 実Node Serverへ業務能力を注入して待ち受け、loopbackのURLを返す。 */
  const listen = async (runtime: Runtime) => {
    const server = createAuthenticationDevelopmentServer(runtime);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    return { server, base: 'http://127.0.0.1:' + port };
  };
  const closeServer = (server: Server) =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  const mockGoogle = () =>
    vi
      .spyOn(GoogleIdTokenVerifier.prototype, 'verify')
      .mockImplementation((input) => {
        const token = typeof input.idToken === 'string' ? input.idToken : '';
        return Promise.resolve(
          token.startsWith('synthetic-314-')
            ? {
                status: 'verified',
                identity: {
                  issuer: 'https://accounts.google.com',
                  subject: 'Synthetic-' + token.slice(14),
                },
              }
            : { status: 'invalid-credential' },
        );
      });
  /** 合成のGoogle本人でログインし、Session CookieとCSRF Tokenを返す。 */
  const login = async (base: string, who: string) => {
    const headers = {
      Origin: origin,
      'X-Kakei-Request': '1',
      'Content-Type': 'application/json',
    };
    const begin = await fetch(base + '/auth/google/attempt', {
      method: 'POST',
      headers,
      body: '{}',
    });
    const attempt = (await begin.json()) as { csrfToken: string };
    const done = await fetch(base + '/auth/google/login', {
      method: 'POST',
      headers: {
        ...headers,
        Cookie: begin.headers.getSetCookie()[0].split(';')[0],
        'X-CSRF-Token': attempt.csrfToken,
      },
      body: JSON.stringify({ credential: 'synthetic-314-' + who }),
    });
    expect(done.status).toBe(204);
    const cookie = done.headers
      .getSetCookie()
      .find((value) => value.startsWith('kakei_dev_auth_session='))!
      .split(';')[0];
    const session = await fetch(base + '/auth/session', {
      headers: { 'X-Kakei-Request': '1', Cookie: cookie },
    });
    const { csrfToken } = (await session.json()) as { csrfToken: string };
    return { cookie, csrfToken };
  };
  const graphql = async (
    base: string,
    query: string,
    options: { cookie?: string; csrfToken?: string; variables?: object } = {},
  ) => {
    const response = await fetch(base + '/graphql', {
      method: 'POST',
      headers: {
        Origin: origin,
        'X-Kakei-Request': '1',
        'Content-Type': 'application/json',
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.csrfToken ? { 'X-CSRF-Token': options.csrfToken } : {}),
      },
      body: JSON.stringify({ query, variables: options.variables }),
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    return {
      status: response.status,
      body: (await response.json()) as GraphQLBody,
    };
  };
  const createGroup = (
    base: string,
    actor: { cookie: string; csrfToken: string },
    operationId: string,
  ) =>
    graphql(
      base,
      'mutation Create($input: CreateGroupInput!) { createGroup(input: $input) { groupId } }',
      { ...actor, variables: { input: { operationId } } },
    );
  const myGroups = (base: string, actor?: { cookie: string }) =>
    graphql(
      base,
      'query Mine { myGroups { items { groupId lifecycle myRole activeParticipantCount } hasMore } }',
      actor,
    );
  const code = (body: GraphQLBody) => body.errors?.[0]?.extensions?.code;

  it('Migrationは認証5〜7とGM 0001〜0004・0012だけを適用し、再実行で差分がない', async () => {
    await migrateAuthenticationDevelopmentDatabase(env());
    expect(await migrationVersions()).toEqual([1, 2, 3, 4, 5, 6, 7, 12]);
    const absent = (
      await database!.query<{
        invitation: string | null;
        proof: string | null;
      }>(
        "SELECT to_regclass('public.group_recipient_invitation_audit_record')::text AS invitation,to_regclass('public.group_recipient_code_proof_key_state')::text AS proof",
      )
    ).rows[0];
    expect(absent).toEqual({ invitation: null, proof: null });
    expect(await locatorVersion()).toBeNull();
  });

  it('空DB検査の対象はGM Migrationが作る業務表のすべてで、鍵状態だけを別に検査する', async () => {
    const tables = (
      await database!.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT IN ('app_schema_migrations','group_operation_locator_key_state') ORDER BY table_name",
      )
    ).rows.map((row) => row.table_name);
    expect([...groupManagementDevelopmentTables].sort()).toEqual(tables);
    expect(groupManagementDevelopmentTables).toContain(
      'group_actor_membership_index',
    );
  });

  it.each([
    [
      'Actor単位Group索引に行がある',
      // FKを外さずに索引だけの残存を再現する（使い捨てDBの合成行）。
      "SET session_replication_role = replica; INSERT INTO group_actor_membership_index(actor_digest,digest_key_version,group_id,created_at) VALUES ('\\x01','synthetic-v1','00000000-0000-4000-8000-000000000314',now()); SET session_replication_role = origin",
    ],
    [
      'locator鍵状態が初期化済み',
      "UPDATE group_operation_locator_key_state SET current_key_version='synthetic-previous' WHERE id=1",
    ],
    ['Group Managementの表がない', 'DROP TABLE group_actor_membership_index'],
  ])(
    '%sDBでは固定文言で起動を拒否し、認証の初期化もcommitしない',
    async (_case, sql) => {
      await database!.query(sql);
      const before = await locatorVersion().catch(() => 'missing');
      await expect(
        openAuthenticationDevelopmentRuntime(env(), vi.fn()),
      ).rejects.toThrow('開発認証を起動できません');
      expect(await authenticationStatus()).toBe('uninitialized');
      expect(await count('authentication.key_generation')).toBe(0);
      expect(await locatorVersion().catch(() => 'missing')).toBe(before);
      expect(await connections(businessApplication)).toBe(0);
    },
  );

  it('ログインした本人がcreateGroupで作ったGroupをmyGroupsで取得でき、再送は同じgroupIdで、他Actorには見えない', async () => {
    const runtime = await openAuthenticationDevelopmentRuntime(env(), vi.fn());
    const { server, base } = await listen(runtime);
    mockGoogle();
    try {
      expect(await locatorVersion()).toMatch(canonicalUuid);
      const owner = await login(base, 'owner');
      const other = await login(base, 'other');

      // 未認証・CSRF不一致・CSRFなしは業務を実行しない。
      expect(code((await myGroups(base)).body)).toBe('AUTHENTICATION_REQUIRED');
      expect(
        code(
          (
            await createGroup(
              base,
              { cookie: owner.cookie, csrfToken: other.csrfToken },
              randomUUID(),
            )
          ).body,
        ),
      ).toBe('REQUEST_REJECTED');
      const withoutCsrf = await graphql(
        base,
        'mutation { createGroup(input: { operationId: "' +
          randomUUID() +
          '" }) { groupId } }',
        { cookie: owner.cookie },
      );
      expect(withoutCsrf.status).toBe(403);
      expect(await count('group_aggregate_record')).toBe(0);

      const operationId = randomUUID();
      const created = await createGroup(base, owner, operationId);
      expect(created.status).toBe(200);
      expect(created.body.errors).toBeUndefined();
      const { groupId } = (
        created.body.data as {
          createGroup: { groupId: string };
        }
      ).createGroup;
      expect(groupId).toMatch(canonicalUuid);

      const replay = await createGroup(base, owner, operationId);
      expect(replay.body.data).toEqual({ createGroup: { groupId } });
      expect(await count('group_aggregate_record')).toBe(1);
      expect(await count('group_actor_membership_index')).toBe(1);

      expect((await myGroups(base, owner)).body).toEqual({
        data: {
          myGroups: {
            items: [
              {
                groupId,
                lifecycle: 'ACTIVE',
                myRole: 'OWNER',
                activeParticipantCount: 1,
              },
            ],
            hasMore: false,
          },
        },
      });
      expect((await myGroups(base, other)).body).toEqual({
        data: { myGroups: { items: [], hasMore: false } },
      });

      // 保存したRecordに平文のActorやGoogle値を残さない。
      const stored = JSON.stringify(
        (
          await database!.query(
            'SELECT a.*, m.* FROM group_aggregate_record a JOIN group_actor_membership_index m USING (group_id)',
          )
        ).rows,
      );
      expect(stored).not.toMatch(/Synthetic-owner|synthetic-314/);
      // 業務は認証とは別のapplication_nameの接続で行った。
      expect(await connections(businessApplication)).toBeGreaterThan(0);
    } finally {
      await closeServer(server);
      await runtime.close();
    }
  });

  it('業務Lockを待つOperationは業務PoolのLock timeoutでSERVICE_UNAVAILABLEになり、Groupを作らない', async () => {
    const runtime = await openAuthenticationDevelopmentRuntime(env(), vi.fn());
    const { server, base } = await listen(runtime);
    mockGoogle();
    const blocker = new Client({ connectionString });
    await blocker.connect();
    try {
      const owner = await login(base, 'owner');
      await blocker.query('BEGIN');
      await blocker.query(
        'LOCK TABLE group_operation_locator_key_state IN ACCESS EXCLUSIVE MODE',
      );
      const started = performance.now();
      const pending = createGroup(base, owner, randomUUID());
      // 業務接続が認証とは別のapplication_nameでLockを待っている。
      await vi.waitFor(async () => {
        const waiting = (
          await observer.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND wait_event_type='Lock'",
            [databaseName, businessApplication],
          )
        ).rows[0].count;
        expect(waiting).toBe(1);
      });
      const result = await pending;
      const elapsed = performance.now() - started;
      expect(code(result.body)).toBe('SERVICE_UNAVAILABLE');
      expect(JSON.stringify(result.body)).not.toMatch(
        /lock|timeout|synthetic/i,
      );
      expect(elapsed).toBeGreaterThanOrEqual(
        businessPoolSettings.lockTimeoutMillis - 100,
      );
      expect(elapsed).toBeLessThan(businessPoolSettings.statementTimeoutMillis);
      await blocker.query('ROLLBACK');
      expect(await count('group_aggregate_record')).toBe(0);
      // Lockが外れれば、同じ本人の次のOperationは成功する。
      expect(
        (await createGroup(base, owner, randomUUID())).body.errors,
      ).toBeUndefined();
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
      await closeServer(server);
      await runtime.close();
    }
  }, 15_000);

  it('lease喪失後は業務GraphQLもSERVICE_UNAVAILABLEになり、closeで両Poolの接続を閉じる', async () => {
    const lost = vi.fn();
    const runtime = await openAuthenticationDevelopmentRuntime(env(), lost);
    const { server, base } = await listen(runtime);
    mockGoogle();
    try {
      const owner = await login(base, 'owner');
      expect(
        (await createGroup(base, owner, randomUUID())).body.errors,
      ).toBeUndefined();
      expect(await connections(businessApplication)).toBeGreaterThan(0);
      const pid = (
        await observer.query<{ pid: number }>(
          'SELECT pid FROM pg_stat_activity WHERE datname=$1 AND application_name=$2',
          [databaseName, leaseApplication],
        )
      ).rows;
      expect(pid).toHaveLength(1);
      await observer.query('SELECT pg_terminate_backend($1)', [pid[0].pid]);
      await vi.waitFor(() => expect(lost).toHaveBeenCalledTimes(1));
      const before = await count('group_aggregate_record');
      expect(code((await myGroups(base, owner)).body)).toBe(
        'SERVICE_UNAVAILABLE',
      );
      expect(code((await createGroup(base, owner, randomUUID())).body)).toBe(
        'SERVICE_UNAVAILABLE',
      );
      expect(await count('group_aggregate_record')).toBe(before);
    } finally {
      await closeServer(server);
      await runtime.close();
    }
    await vi.waitFor(async () => {
      expect(await connections(businessApplication)).toBe(0);
      expect(await connections('kakei-auth-disposable-development')).toBe(0);
    });
    // 鍵は失われたので、同じDBでの再起動は拒否する（明示resetが必要）。
    await expect(
      openAuthenticationDevelopmentRuntime(env(), vi.fn()),
    ).rejects.toThrow('開発認証を起動できません');
  });
});
