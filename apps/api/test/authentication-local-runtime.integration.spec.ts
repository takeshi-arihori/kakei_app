import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
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
import { openAuthenticationDevelopmentRuntime } from '../dev/authentication-development-runtime.js';
import { createAuthenticationDevelopmentServer } from '../dev/authentication-development-server.js';

const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';
describe('専用開発DBの実起動とprocess lease', () => {
  const observer = new Client({ connectionString: url });
  let databaseName = '';
  let owned = false;
  let database: Client | undefined;
  let connectionString: string;
  const env = () => ({
    NODE_ENV: 'development',
    AUTH_DEV_DATABASE_URL: connectionString,
    GOOGLE_CLIENT_ID: 'synthetic-client.apps.googleusercontent.com',
  });
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
      'synthetic_218_' + randomUUID().replaceAll('-', '') + '_auth_dev';
    await observer.query('CREATE DATABASE ' + databaseName);
    owned = true;
    const target = new URL(url);
    target.pathname = '/' + databaseName;
    connectionString = target.toString();
    database = new Client({ connectionString });
    await database.connect();
    await migrateAuthenticationDevelopmentDatabase(env());
    await migrateAuthenticationDevelopmentDatabase(env());
  });
  afterEach(async () => {
    await database?.end();
    if (owned)
      await observer.query('DROP DATABASE ' + databaseName + ' WITH (FORCE)');
    owned = false;
  });
  afterAll(async () => {
    await observer.end();
  });
  it.each([1, 500, 501])(
    '実Timerで超過%i行を全削除しても1回だけ通知し、次回の遅延なし清掃では通知しない',
    async (count) => {
      const intervals = vi.spyOn(globalThis, 'setInterval');
      const notification = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      let runtime:
        | Awaited<ReturnType<typeof openAuthenticationDevelopmentRuntime>>
        | undefined;
      try {
        runtime = await openAuthenticationDevelopmentRuntime(env(), vi.fn());
        const tick = intervals.mock.calls.find(([, ms]) => ms === 60_000)?.[0];
        if (typeof tick !== 'function')
          throw new Error('1分清掃Timerの登録が必要');
        await database!.query(
          "INSERT INTO authentication_http.rate_window(operation,kind,subject_digest,window_start_ms,count,expires_at_ms) SELECT 'attempt','peer',decode(lpad(to_hex(n),64,'0'),'hex'),0,1,60000 FROM generate_series(1,$1::int) AS n",
          [count],
        );
        tick();
        await vi.waitFor(() =>
          expect(notification).toHaveBeenCalledExactlyOnceWith(
            'AUTH_HTTP_RATE_CLEANUP_UNAVAILABLE',
          ),
        );
        expect(
          (
            await database!.query(
              'SELECT * FROM authentication_http.rate_window',
            )
          ).rows,
        ).toEqual([]);
        // 別sweepの完了を、削除した期限内行の不在から確認する。
        await database!.query(
          "INSERT INTO authentication_http.rate_window(operation,kind,subject_digest,window_start_ms,count,expires_at_ms) SELECT 'attempt','peer',decode(repeat('ff',32),'hex'),start,1,start+60000 FROM (SELECT (floor(extract(epoch FROM clock_timestamp())/60)*60000-60000)::bigint AS start) AS expired",
        );
        tick();
        await vi.waitFor(async () =>
          expect(
            (
              await database!.query(
                'SELECT * FROM authentication_http.rate_window',
              )
            ).rows,
          ).toEqual([]),
        );
        expect(notification).toHaveBeenCalledTimes(1);
      } finally {
        try {
          await runtime?.close();
        } finally {
          intervals.mockRestore();
          notification.mockRestore();
        }
      }
    },
  );
  it('実Runtimeの1分Timerで500行20Batchを上限に清掃し、遅延とDB障害を固定通知して再試行する', async () => {
    // 実Timerと実DBを保ち、登録された60秒callbackだけを制御して起動する。
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const notification = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    let runtime:
      | Awaited<ReturnType<typeof openAuthenticationDevelopmentRuntime>>
      | undefined;
    try {
      runtime = await openAuthenticationDevelopmentRuntime(env(), vi.fn());
      const cleanupTick = intervals.mock.calls.find(
        ([, milliseconds]) => milliseconds === 60_000,
      )?.[0];
      if (typeof cleanupTick !== 'function')
        throw new Error('1分清掃Timerの登録が必要');
      await database!.query(
        "INSERT INTO authentication_http.rate_window(operation,kind,subject_digest,window_start_ms,count,expires_at_ms) SELECT 'attempt','peer',decode(lpad(to_hex(n),64,'0'),'hex'),0,1,60000 FROM generate_series(1,10001) AS n",
      );
      const liveStart = (
        await database!.query<{ start: string }>(
          'SELECT (floor(extract(epoch FROM clock_timestamp()) / 60) * 60000 + 60000)::bigint::text AS start',
        )
      ).rows[0].start;
      await database!.query(
        "INSERT INTO authentication_http.rate_window(operation,kind,subject_digest,window_start_ms,count,expires_at_ms) VALUES('attempt','peer',decode(repeat('ff',32),'hex'),$1,1,$1::bigint+60000)",
        [liveStart],
      );
      const expiredCount = async () =>
        (
          await database!.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM authentication_http.rate_window WHERE window_start_ms=0',
          )
        ).rows[0].count;
      const liveRows = async () =>
        (
          await database!.query<Record<string, unknown>>(
            'SELECT * FROM authentication_http.rate_window WHERE window_start_ms=$1',
            [liveStart],
          )
        ).rows;
      const live = await liveRows();
      cleanupTick();
      cleanupTick(); // 実行中の重複起動は20Batchの上限を増やさない。
      await vi.waitFor(
        async () => {
          expect(await expiredCount()).toBe(1);
          expect(notification).toHaveBeenCalledExactlyOnceWith(
            'AUTH_HTTP_RATE_CLEANUP_UNAVAILABLE',
          );
        },
        { timeout: 5000 },
      );
      expect(await liveRows()).toEqual(live);
      cleanupTick();
      await vi.waitFor(async () => {
        expect(await expiredCount()).toBe(0);
        expect(notification).toHaveBeenCalledTimes(2);
      });
      await database!.query(
        "INSERT INTO authentication_http.rate_window(operation,kind,subject_digest,window_start_ms,count,expires_at_ms) VALUES('attempt','peer',decode(repeat('01',32),'hex'),0,1,60000)",
      );
      await database!.query(
        "CREATE FUNCTION authentication_http.synthetic_cleanup_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic/private-cleanup'; END; $$",
      );
      await database!.query(
        'CREATE TRIGGER synthetic_cleanup_fail BEFORE DELETE ON authentication_http.rate_window FOR EACH ROW EXECUTE FUNCTION authentication_http.synthetic_cleanup_fail()',
      );
      cleanupTick();
      await vi.waitFor(() => expect(notification).toHaveBeenCalledTimes(3));
      expect(await expiredCount()).toBe(1);
      expect(notification.mock.calls).toEqual([
        ['AUTH_HTTP_RATE_CLEANUP_UNAVAILABLE'],
        ['AUTH_HTTP_RATE_CLEANUP_UNAVAILABLE'],
        ['AUTH_HTTP_RATE_CLEANUP_UNAVAILABLE'],
      ]);
      await database!.query(
        'DROP TRIGGER synthetic_cleanup_fail ON authentication_http.rate_window',
      );
      await database!.query(
        'DROP FUNCTION authentication_http.synthetic_cleanup_fail()',
      );
      cleanupTick();
      await vi.waitFor(async () => expect(await expiredCount()).toBe(0));
      expect(await liveRows()).toEqual(live);
      expect(notification).toHaveBeenCalledTimes(4);
    } finally {
      try {
        await runtime?.close();
      } finally {
        intervals.mockRestore();
        notification.mockRestore();
      }
    }
  }, 20_000);
  it('実NodeでBody送信が停止しても5秒期限で固定400を返し、Cookieと認証Recordを変えない', async () => {
    const runtime = await openAuthenticationDevelopmentRuntime(env(), vi.fn());
    const server = createAuthenticationDevelopmentServer(
      runtime.authentication,
    );
    const snapshot = async () => {
      const tables = (
        await database!.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema='authentication' AND table_type='BASE TABLE' ORDER BY table_name",
        )
      ).rows;
      const records: Record<string, unknown> = {};
      for (const { table_name: name } of tables) {
        if (!/^[a-z_]+$/.test(name)) throw new Error('試験Table名が必要');
        records[name] = (
          await database!.query<Record<string, unknown>>(
            'SELECT row_to_json(t) AS value FROM authentication."' +
              name +
              '" AS t ORDER BY row_to_json(t)::text',
          )
        ).rows;
      }
      return records;
    };
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('試験Portが必要');
      const before = await snapshot();
      const started = performance.now();
      const response = await new Promise<string>((resolve, reject) => {
        const socket = createConnection(address.port, '127.0.0.1');
        let received = '';
        socket.setTimeout(8500, () => {
          socket.destroy();
          reject(new Error('Body期限の応答が必要'));
        });
        socket.on('connect', () =>
          socket.write(
            'POST /auth/google/attempt HTTP/1.1\r\nHost: localhost:3001\r\nOrigin: http://localhost:3000\r\nX-Kakei-Request: 1\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{',
          ),
        );
        socket.on('data', (chunk) => {
          received += chunk.toString();
        });
        socket.on('end', () => resolve(received));
        socket.on('error', reject);
      });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(4500);
      expect(elapsed).toBeLessThan(8500);
      expect(response).toMatch(/^HTTP\/1\.1 400 /);
      expect(response.toLowerCase()).toContain('cache-control: no-store');
      expect(response.toLowerCase()).not.toContain('set-cookie:');
      const body: unknown = JSON.parse(response.split('\r\n\r\n')[1]);
      expect(body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
      expect(JSON.stringify(body)).toMatch(
        /^\{"error":\{"code":"INVALID_REQUEST","requestId":"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"\}\}$/,
      );
      expect(await snapshot()).toEqual(before);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await runtime.close();
    }
  }, 15_000);
  it('実Node接続から4操作を実Storeへ通し、Forwardedではなく接続Peerの共有Rateを消費する', async () => {
    const runtime = await openAuthenticationDevelopmentRuntime(env(), vi.fn());
    const peers = new Set<string | null>();
    const server = createAuthenticationDevelopmentServer((request, peer) => {
      peers.add(peer);
      return runtime.authentication(request, peer);
    });
    const verifier = vi
      .spyOn(GoogleIdTokenVerifier.prototype, 'verify')
      .mockResolvedValue({
        status: 'verified',
        identity: {
          issuer: 'https://accounts.google.com',
          subject: 'Synthetic-218-Node-Identity',
        },
      });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('試験Portが必要');
      const send = (
        path: string,
        body?: string,
        headers: Record<string, string> = {},
      ) =>
        fetch('http://127.0.0.1:' + address.port + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Origin: 'http://localhost:3000',
            'X-Kakei-Request': '1',
            'X-Forwarded-For': '203.0.113.218',
            Forwarded: 'for=203.0.113.218',
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
            ...headers,
          },
          body,
        });
      const begin = await send('/auth/google/attempt', '{}');
      expect(begin.status).toBe(201);
      const attempt: unknown = await begin.json();
      if (
        typeof attempt !== 'object' ||
        attempt === null ||
        !('nonce' in attempt) ||
        typeof attempt.nonce !== 'string' ||
        !('csrfToken' in attempt) ||
        typeof attempt.csrfToken !== 'string'
      )
        throw new Error('試験開始本文が必要');
      const login = await send(
        '/auth/google/login',
        '{"credential":"synthetic-node-valid"}',
        {
          Cookie: begin.headers.getSetCookie()[0].split(';')[0],
          'X-CSRF-Token': attempt.csrfToken,
        },
      );
      expect(login.status).toBe(204);
      expect(verifier).toHaveBeenCalledExactlyOnceWith({
        idToken: 'synthetic-node-valid',
        expectedNonce: attempt.nonce,
      });
      expect(login.headers.getSetCookie()).toHaveLength(2);
      const session = login.headers
        .getSetCookie()
        .find((value) => value.startsWith('kakei_dev_auth_session='))!
        .split(';')[0];
      const inspected = await send('/auth/session', undefined, {
        Cookie: session,
      });
      expect(inspected.status).toBe(200);
      const body: unknown = await inspected.json();
      if (
        typeof body !== 'object' ||
        body === null ||
        !('csrfToken' in body) ||
        typeof body.csrfToken !== 'string'
      )
        throw new Error('試験Session本文が必要');
      const logout = await send('/auth/logout', '{}', {
        Cookie: session,
        'X-CSRF-Token': body.csrfToken,
      });
      expect(logout.status).toBe(204);
      expect(logout.headers.getSetCookie()[0]).toContain('Max-Age=0');
      expect(peers).toEqual(new Set(['127.0.0.1']));
      const rate = (
        await database!.query<{ operation: string; kind: string }>(
          'SELECT DISTINCT operation,kind FROM authentication_http.rate_window ORDER BY operation,kind',
        )
      ).rows;
      expect(rate).toEqual(
        ['attempt', 'login', 'logout', 'session'].flatMap((operation) =>
          ['global', 'peer'].map((kind) => ({ operation, kind })),
        ),
      );
      expect(
        (
          await database!.query<{ state: string }>(
            'SELECT state FROM authentication.login_attempt',
          )
        ).rows,
      ).toEqual([{ state: 'consumed' }]);
      expect(
        (
          await database!.query<{ state: string }>(
            'SELECT state FROM authentication.session_record',
          )
        ).rows,
      ).toEqual([{ state: 'revoked' }]);
      expect(inspected.headers.get('cache-control')).toBe('no-store');
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      verifier.mockRestore();
      await runtime.close();
    }
  });
  it('単一processだけが空DBを初期化し、lease喪失で受付停止を通知し、再起動で旧DBを使わない', async () => {
    const lost = vi.fn();
    const runtime = await openAuthenticationDevelopmentRuntime(env(), lost);
    try {
      const response = await runtime.authentication(
        new Request('http://localhost:3000/auth/google/attempt', {
          method: 'POST',
          headers: {
            Origin: 'http://localhost:3000',
            'X-Kakei-Request': '1',
            'Content-Type': 'application/json',
          },
          body: '{}',
        }),
        '127.0.0.1',
      );
      expect(response.status).toBe(201);
      expect(response.headers.get('set-cookie')).toContain(
        'kakei_dev_auth_attempt=',
      );
      const send = (
        path: string,
        body?: string,
        headers: Record<string, string> = {},
      ) =>
        runtime.authentication(
          new Request('http://localhost:3000' + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              Origin: 'http://localhost:3000',
              'X-Kakei-Request': '1',
              ...(body === undefined
                ? {}
                : { 'Content-Type': 'application/json' }),
              ...headers,
            },
            body,
          }),
          '127.0.0.1',
        );
      const cookie = (r: Response, name: string) => {
        const value = r.headers
          .getSetCookie()
          .find((v) => v.startsWith(name + '='))
          ?.split(';')[0];
        if (!value) throw new Error('試験Cookieが必要');
        return value;
      };
      const attemptBody: unknown = await response.json();
      const parseBody = (
        value: unknown,
      ): { nonce: string; csrfToken: string } => {
        if (
          typeof value !== 'object' ||
          value === null ||
          !('nonce' in value) ||
          typeof value.nonce !== 'string' ||
          !('csrfToken' in value) ||
          typeof value.csrfToken !== 'string'
        )
          throw new Error('試験開始本文が必要');
        return { nonce: value.nonce, csrfToken: value.csrfToken };
      };
      const first = parseBody(attemptBody);
      const expected = new Set([first.nonce]);
      // 本番Codeへhookを追加せず、署名検証Port境界だけを試験で差し替える。
      const verifier = vi
        .spyOn(GoogleIdTokenVerifier.prototype, 'verify')
        .mockImplementation((input) =>
          Promise.resolve(
            input.idToken === 'synthetic-valid' &&
              expected.has(input.expectedNonce)
              ? {
                  status: 'verified',
                  identity: {
                    issuer: 'https://accounts.google.com',
                    subject: 'Synthetic-218-Identity',
                  },
                }
              : { status: 'invalid-credential' },
          ),
        );
      try {
        const login = await send(
          '/auth/google/login',
          '{"credential":"synthetic-valid"}',
          {
            Cookie: cookie(response, 'kakei_dev_auth_attempt'),
            'X-CSRF-Token': first.csrfToken,
          },
        );
        expect(login.status).toBe(204);
        expect(verifier).toHaveBeenCalledWith({
          idToken: 'synthetic-valid',
          expectedNonce: first.nonce,
        });
        const session = cookie(login, 'kakei_dev_auth_session');
        const before = (
          await database!.query<Record<string, unknown>>(
            'SELECT idle_expires_at_ms FROM authentication.session_record',
          )
        ).rows;
        const inspected = await send('/auth/session', undefined, {
          Cookie: session,
        });
        expect(inspected.status).toBe(200);
        const inspectedBody: unknown = await inspected.json();
        if (
          typeof inspectedBody !== 'object' ||
          inspectedBody === null ||
          !('csrfToken' in inspectedBody) ||
          typeof inspectedBody.csrfToken !== 'string'
        )
          throw new Error('試験Session本文が必要');
        expect(Object.keys(inspectedBody).sort()).toEqual([
          'authenticated',
          'csrfToken',
          'expiresAt',
        ]);
        expect(
          (
            await database!.query<Record<string, unknown>>(
              'SELECT idle_expires_at_ms FROM authentication.session_record',
            )
          ).rows,
        ).toEqual(before);
        const beginOther = await send('/auth/google/attempt', '{}');
        expect(beginOther.status).toBe(201);
        const second = parseBody(await beginOther.json());
        expected.add(second.nonce);
        const loginOther = await send(
          '/auth/google/login',
          '{"credential":"synthetic-valid"}',
          {
            Cookie: cookie(beginOther, 'kakei_dev_auth_attempt'),
            'X-CSRF-Token': second.csrfToken,
          },
        );
        expect(loginOther.status).toBe(204);
        const otherSession = cookie(loginOther, 'kakei_dev_auth_session');
        expect(
          (
            await database!.query<{ count: number }>(
              'SELECT count(*)::int AS count FROM authentication.actor',
            )
          ).rows[0].count,
        ).toBe(1);
        const rejected = await send('/auth/logout', '{}', {
          Cookie: session,
          'X-CSRF-Token': Buffer.alloc(32, 8).toString('base64url'),
        });
        expect(rejected.status).toBe(403);
        expect(rejected.headers.has('set-cookie')).toBe(false);
        const loggedOut = await send('/auth/logout', '{}', {
          Cookie: session,
          'X-CSRF-Token': inspectedBody.csrfToken,
        });
        expect(loggedOut.status).toBe(204);
        expect(loggedOut.headers.get('set-cookie')).toContain('Max-Age=0');
        expect(
          (await send('/auth/session', undefined, { Cookie: session })).status,
        ).toBe(401);
        expect(
          (await send('/auth/session', undefined, { Cookie: otherSession }))
            .status,
        ).toBe(200);
        expect(
          (await send('/auth/logout', '{}', { Cookie: session })).status,
        ).toBe(204);
        await database!.query(
          "CREATE FUNCTION authentication.synthetic_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic/private-audit'; END; $$",
        );
        await database!.query(
          'CREATE TRIGGER synthetic_audit_fail BEFORE INSERT ON authentication.audit_event FOR EACH ROW EXECUTE FUNCTION authentication.synthetic_audit_fail()',
        );
        try {
          const failed = await send('/auth/google/attempt', '{}');
          expect(failed.status).toBe(503);
          expect(failed.headers.has('set-cookie')).toBe(false);
          expect(await failed.text()).not.toMatch(/private|synthetic|Identity/);
        } finally {
          await database!.query(
            'DROP TRIGGER synthetic_audit_fail ON authentication.audit_event',
          );
          await database!.query(
            'DROP FUNCTION authentication.synthetic_audit_fail()',
          );
        }
        const check = (
          await database!.query<{ key_check: Buffer }>(
            'SELECT key_check FROM authentication_http.rate_policy',
          )
        ).rows[0].key_check;
        await database!.query(
          'UPDATE authentication_http.rate_policy SET key_check=$1',
          [Buffer.alloc(32, 0)],
        );
        try {
          const failed = await send('/auth/google/attempt', '{}');
          expect(failed.status).toBe(503);
          expect(failed.headers.has('set-cookie')).toBe(false);
        } finally {
          await database!.query(
            'UPDATE authentication_http.rate_policy SET key_check=$1',
            [check],
          );
        }
        const stored = (
          await database!.query<Record<string, unknown>>(
            'SELECT * FROM authentication.audit_event',
          )
        ).rows;
        expect(JSON.stringify(stored)).not.toMatch(
          /Synthetic-218-Identity|synthetic-valid|127\.0\.0\.1/,
        );
      } finally {
        verifier.mockRestore();
      }
      await expect(
        openAuthenticationDevelopmentRuntime(env(), vi.fn()),
      ).rejects.toThrow('開発認証を起動できません');
      await expect(
        migrateAuthenticationDevelopmentDatabase(env()),
      ).rejects.toThrow('開発認証Migrationを適用できません');
      const pid = (
        await database!.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='kakei-auth-development-lease'",
        )
      ).rows;
      expect(pid).toHaveLength(1);
      await database!.query('SELECT pg_terminate_backend($1)', [pid[0].pid]);
      await vi.waitFor(() => expect(lost).toHaveBeenCalledTimes(1));
      expect(
        (
          await runtime.authentication(
            new Request('http://localhost:3000/auth/session', {
              headers: { 'X-Kakei-Request': '1' },
            }),
            '127.0.0.1',
          )
        ).status,
      ).toBe(503);
    } finally {
      await runtime.close();
    }
    await expect(
      openAuthenticationDevelopmentRuntime(env(), vi.fn()),
    ).rejects.toThrow('開発認証を起動できません');
    expect(
      (
        await database!.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM authentication.login_attempt',
        )
      ).rows[0].count,
    ).toBe(2);
  });
  it('実保存DIでもHTTP前提違反と鍵障害を公開Errorだけに制限する', async () => {
    const runtime = await openAuthenticationDevelopmentRuntime(env(), vi.fn());
    const verifier = vi
      .spyOn(GoogleIdTokenVerifier.prototype, 'verify')
      .mockResolvedValue({ status: 'invalid-credential' });
    try {
      const send = (request: Request) =>
        runtime.authentication(request, '127.0.0.1');
      const snapshot = async () =>
        (
          await database!.query<Record<string, unknown>>(
            'SELECT * FROM authentication.login_attempt',
          )
        ).rows;
      for (const [origin, body, extra, expected] of [
        [undefined, '{}', {}, 403],
        ['null', '{}', {}, 403],
        ['http://localhost:3001', '{}', {}, 403],
        ['https://localhost:3000', '{}', {}, 403],
        ['http://localhost:3000, http://localhost:3000', '{}', {}, 403],
        ['http://localhost:3000', '{}', { 'X-Kakei-Request': '2' }, 403],
        [
          'http://localhost:3000',
          '{}',
          { 'Sec-Fetch-Site': 'cross-site' },
          403,
        ],
        ['http://localhost:3000', '{"actor":"synthetic"}', {}, 400],
        [
          'http://localhost:3000',
          '{"credential":"a","\\u0063redential":"b"}',
          {},
          400,
        ],
        [
          'http://localhost:3000',
          '{}',
          { 'Content-Type': 'application/x-www-form-urlencoded' },
          415,
        ],
        ['http://localhost:3000', '{}', { 'Content-Encoding': 'gzip' }, 415],
        ['http://localhost:3000', ' '.repeat(18433), {}, 413],
        [
          'http://localhost:3000',
          '{}',
          { Cookie: 'kakei_dev_auth_attempt=x; kakei_dev_auth_attempt=y' },
          400,
        ],
      ] as const) {
        const before = await snapshot();
        const response = await send(
          new Request('http://localhost:3000/auth/google/attempt', {
            method: 'POST',
            headers: {
              'X-Kakei-Request': '1',
              'Content-Type': 'application/json',
              ...(origin ? { Origin: origin } : {}),
              ...extra,
            },
            body,
          }),
        );
        expect(response.status).toBe(expected);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.has('set-cookie')).toBe(false);
        expect(await response.text()).not.toMatch(/synthetic|credential|actor/);
        expect(await snapshot()).toEqual(before);
      }
      const before = await snapshot();
      await database!.query('UPDATE authentication.key_state SET epoch=$1', [
        randomUUID(),
      ]);
      const failed = await send(
        new Request('http://localhost:3000/auth/google/attempt', {
          method: 'POST',
          headers: {
            Origin: 'http://localhost:3000',
            'X-Kakei-Request': '1',
            'Content-Type': 'application/json',
          },
          body: '{}',
        }),
      );
      expect(failed.status).toBe(503);
      expect(failed.headers.has('set-cookie')).toBe(false);
      expect(await snapshot()).toEqual(before);
      expect(verifier).not.toHaveBeenCalled();
    } finally {
      verifier.mockRestore();
      await runtime.close();
    }
  });

  it('実保存のCSRF不一致/消費済み/不在/期限等値を409へ揃え、Session失効を401へ写像する', async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const runtime = await openAuthenticationDevelopmentRuntime(env(), vi.fn());
    const verifier = vi
      .spyOn(GoogleIdTokenVerifier.prototype, 'verify')
      .mockResolvedValue({
        status: 'verified',
        identity: {
          issuer: 'https://accounts.google.com',
          subject: 'Synthetic-218-Expiry',
        },
      });
    const send = (
      path: string,
      body?: string,
      headers: Record<string, string> = {},
    ) =>
      runtime.authentication(
        new Request('http://localhost:3000' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'X-Kakei-Request': '1',
            ...(body === undefined
              ? {}
              : {
                  Origin: 'http://localhost:3000',
                  'Content-Type': 'application/json',
                }),
            ...headers,
          },
          body,
        }),
        '127.0.0.1',
      );
    const attempt = async () => {
      const response = await send('/auth/google/attempt', '{}');
      expect(response.status).toBe(201);
      const body: unknown = await response.json();
      if (
        typeof body !== 'object' ||
        body === null ||
        !('csrfToken' in body) ||
        typeof body.csrfToken !== 'string'
      )
        throw new Error('試験開始本文が必要');
      return {
        cookie: response.headers.getSetCookie()[0].split(';')[0],
        csrf: body.csrfToken,
      };
    };
    const login = (cookie: string, csrf: string) =>
      send('/auth/google/login', '{"credential":"synthetic-valid"}', {
        Cookie: cookie,
        'X-CSRF-Token': csrf,
      });
    const restart = async (response: Response) => {
      expect(response.status).toBe(409);
      expect(response.headers.getSetCookie()).toHaveLength(1);
      expect(response.headers.get('set-cookie')).toContain(
        'kakei_dev_auth_attempt=; Max-Age=0',
      );
      const body: unknown = await response.json();
      expect(body).toMatchObject({ error: { code: 'LOGIN_RESTART_REQUIRED' } });
    };
    try {
      const a = await attempt();
      await restart(
        await login(a.cookie, Buffer.alloc(32, 33).toString('base64url')),
      );
      expect(verifier).not.toHaveBeenCalled();
      const successful = await login(a.cookie, a.csrf);
      expect(successful.status).toBe(204);
      const session = successful.headers
        .getSetCookie()
        .find((c) => c.startsWith('kakei_dev_auth_session='))!
        .split(';')[0];
      await restart(await login(a.cookie, a.csrf));
      await restart(
        await login(
          'kakei_dev_auth_attempt=' +
            Buffer.alloc(32, 34).toString('base64url'),
          a.csrf,
        ),
      );
      const expiring = await attempt();
      now += 300_000;
      await restart(await login(expiring.cookie, expiring.csrf));
      expect(verifier).toHaveBeenCalledTimes(1);
      now = 1_000_000 + 86_400_000;
      const idle = await send('/auth/session', undefined, { Cookie: session });
      expect(idle.status).toBe(401);
      expect(idle.headers.get('set-cookie')).toContain(
        'kakei_dev_auth_session=; Max-Age=0',
      );
      const idempotent = await send('/auth/logout', '{}', { Cookie: session });
      expect(idempotent.status).toBe(204);
    } finally {
      verifier.mockRestore();
      await runtime.close();
      clock.mockRestore();
    }
  });
});
