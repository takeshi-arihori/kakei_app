import { readFile } from 'node:fs/promises';
import { Client, Pool } from 'pg';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import type { AuthenticationConnectionPool } from '../src/shared/infrastructure/authentication/postgres/authentication-transactions.js';
import { createPostgresAuthenticationHttpRate } from '../src/shared/infrastructure/authentication/postgres/postgres-authentication-http-rate.js';

const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';
describe('HTTP共有Rateの実PostgreSQL境界', () => {
  const observer = new Client({ connectionString: url });
  const pool = new Pool({ connectionString: url, max: 4 });
  let owned = false;
  const namespace = 'synthetic-218';
  const key = Buffer.alloc(32, 218);
  let now = 1_000_000;
  const fixedPool: AuthenticationConnectionPool = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql, values) =>
          sql ===
          'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms'
            ? {
                rows: [{ now_ms: String(now) }],
                rowCount: 1,
                command: 'SELECT',
                oid: 0,
                fields: [],
              }
            : client.query(sql, values),
        release: (destroy) => client.release(destroy),
      };
    },
  };
  const rate = () =>
    createPostgresAuthenticationHttpRate({
      pool: fixedPool,
      namespace,
      keyVersion: 'v1',
      key,
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
      throw new Error('PG17末尾_test専用DBが必要');
    await observer.query('SELECT pg_advisory_lock(1801546597,1635087464)');
    if (
      (
        await observer.query<{ present: boolean }>(
          "SELECT to_regnamespace('authentication_http') IS NOT NULL AS present",
        )
      ).rows[0].present
    )
      throw new Error('既存Rate Schemaを変更しない');
    await observer.query(
      await readFile(
        new URL(
          '../migrations/authentication/0007_authentication_http_rate.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    owned = true;
  });
  beforeEach(async () => {
    if (!owned) throw new Error('Suite所有Schemaが必要');
    now = 1_000_000;
    await observer.query(
      'TRUNCATE authentication_http.rate_window,authentication_http.rate_policy',
    );
  });
  afterAll(async () => {
    await pool.end();
    if (owned) await observer.query('DROP SCHEMA authentication_http CASCADE');
    await observer.end();
  });
  it('Policy未初期化/別鍵/別namespaceは認証予算を許可しない', async () => {
    expect(await rate().reserve('attempt', '127.0.0.1')).toEqual({
      status: 'unavailable',
    });
    await rate().initialize();
    const wrongKey = createPostgresAuthenticationHttpRate({
      pool,
      namespace,
      keyVersion: 'v1',
      key: Buffer.alloc(32, 1),
    });
    const wrongNamespace = createPostgresAuthenticationHttpRate({
      pool,
      namespace: 'other-synthetic',
      keyVersion: 'v1',
      key,
    });
    expect(await wrongKey.reserve('attempt', '127.0.0.1')).toEqual({
      status: 'unavailable',
    });
    expect(await wrongNamespace.reserve('attempt', '127.0.0.1')).toEqual({
      status: 'unavailable',
    });
    expect(
      (
        await observer.query<Record<string, unknown>>(
          'SELECT * FROM authentication_http.rate_window',
        )
      ).rows,
    ).toEqual([]);
  });
  it('別instanceの同じPeerで最後の1枠を共有し、失敗認証でも予算を戻さない', async () => {
    const a = rate(),
      b = rate();
    await a.initialize();
    await b.initialize();
    for (let n = 0; n < 9; n++)
      expect(await a.reserve('attempt', '127.0.0.1')).toEqual({
        status: 'allowed',
      });
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const backendIds = new Set<number>();
    const barrierPool: AuthenticationConnectionPool = {
      connect: async () => {
        const client = await fixedPool.connect();
        try {
          const row: unknown = (
            await client.query('SELECT pg_backend_pid() AS pid')
          ).rows[0];
          if (
            typeof row !== 'object' ||
            row === null ||
            !('pid' in row) ||
            typeof row.pid !== 'number'
          )
            throw new Error('独立接続のPIDが必要');
          backendIds.add(row.pid);
          if (backendIds.size === 2) releaseGate();
          await gate;
          return client;
        } catch (error) {
          client.release(true);
          throw error;
        }
      },
    };
    const competing = () =>
      createPostgresAuthenticationHttpRate({
        pool: barrierPool,
        namespace,
        keyVersion: 'v1',
        key,
      });
    const outcomes = await Promise.all([
      competing().reserve('attempt', '127.0.0.1'),
      competing().reserve('attempt', '127.0.0.1'),
    ]);
    expect(backendIds.size).toBe(2);
    expect(outcomes.filter((v) => v.status === 'allowed')).toHaveLength(1);
    expect(outcomes.filter((v) => v.status === 'limited')).toHaveLength(1);
    expect(await a.reserve('attempt', '127.0.0.1')).toMatchObject({
      status: 'limited',
      retryAfterSeconds: 20,
    });
    const stored = (
      await observer.query<Record<string, unknown>>(
        'SELECT * FROM authentication_http.rate_window',
      )
    ).rows;
    expect(JSON.stringify(stored)).not.toContain('127.0.0.1');
  });
  it('別Peerにもglobal上限を適用し、偽のPeer形式を許可しない', async () => {
    const a = rate();
    await a.initialize();
    for (let n = 0; n < 120; n++)
      expect(await a.reserve('attempt', `10.0.0.${n + 1}`)).toEqual({
        status: 'allowed',
      });
    expect(await a.reserve('attempt', '10.0.1.1')).toMatchObject({
      status: 'limited',
    });
    expect(await a.reserve('attempt', 'spoofed-forwarded-host')).toEqual({
      status: 'unavailable',
    });
  });
  it('期限行だけを小Batchで削除し、現Windowを維持する', async () => {
    const a = rate();
    await a.initialize();
    await a.reserve('attempt', '127.0.0.1');
    // 正しい32-byte合成仮名で、現Windowとは独立した期限行を用意する。
    await observer.query(
      "INSERT INTO authentication_http.rate_window(operation,kind,subject_digest,window_start_ms,count,expires_at_ms) VALUES('attempt','peer',$1,0,1,60000)",
      [Buffer.alloc(32, 1)],
    );
    expect(await a.cleanup(1)).toMatchObject({ status: 'cleaned', deleted: 1 });
    expect(
      (
        await observer.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM authentication_http.rate_window',
        )
      ).rows[0].count,
    ).toBe(2);
  });
  it('分境界の直前まで拒否し、等値から新しいWindowだけを許可する', async () => {
    const a = rate();
    await a.initialize();
    now = 0;
    for (let n = 0; n < 10; n++)
      expect(await a.reserve('attempt', '::ffff:127.0.0.1')).toEqual({
        status: 'allowed',
      });
    now = 59_999;
    expect(await a.reserve('attempt', '127.0.0.1')).toEqual({
      status: 'limited',
      retryAfterSeconds: 1,
    });
    now = 60_000;
    expect(await a.reserve('attempt', '127.0.0.1')).toEqual({
      status: 'allowed',
    });
    const windows = (
      await observer.query(
        'SELECT DISTINCT window_start_ms FROM authentication_http.rate_window ORDER BY window_start_ms',
      )
    ).rows;
    expect(windows).toEqual([
      { window_start_ms: '0' },
      { window_start_ms: '60000' },
    ]);
  });
  it('commit応答喪失は503相当とし、確定済み予算を復元/再試行しない', async () => {
    const a = rate();
    await a.initialize();
    for (let n = 0; n < 9; n++) await a.reserve('attempt', '127.0.0.1');
    let lost = false;
    const uncertainPool: AuthenticationConnectionPool = {
      connect: async () => {
        const client = await fixedPool.connect();
        return {
          query: async (sql, values) => {
            const value = await client.query(sql, values);
            if (sql === 'COMMIT' && !lost) {
              lost = true;
              throw new Error('synthetic-commit-response-loss');
            }
            return value;
          },
          release: (destroy) => client.release(destroy),
        };
      },
    };
    const uncertain = createPostgresAuthenticationHttpRate({
      pool: uncertainPool,
      namespace,
      keyVersion: 'v1',
      key,
    });
    expect(await uncertain.reserve('attempt', '127.0.0.1')).toEqual({
      status: 'unavailable',
    });
    expect(lost).toBe(true);
    expect(await a.reserve('attempt', '127.0.0.1')).toMatchObject({
      status: 'limited',
    });
    expect(
      (
        await observer.query(
          "SELECT count FROM authentication_http.rate_window WHERE kind='peer'",
        )
      ).rows,
    ).toEqual([{ count: '11' }]);
  });
  it('別鍵での再初期化と改竄Policyを拒否し、カウンタを空にしない', async () => {
    const a = rate();
    await a.initialize();
    await a.reserve('attempt', '127.0.0.1');
    const wrong = createPostgresAuthenticationHttpRate({
      pool: fixedPool,
      namespace,
      keyVersion: 'v2',
      key: Buffer.alloc(32, 9),
    });
    await expect(wrong.initialize()).rejects.toThrow(
      '認証Rate能力を利用できません',
    );
    await observer.query(
      'UPDATE authentication_http.rate_policy SET key_check=$1',
      [Buffer.alloc(32, 0)],
    );
    expect(await a.reserve('attempt', '127.0.0.1')).toEqual({
      status: 'unavailable',
    });
    expect(
      (
        await observer.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM authentication_http.rate_window',
        )
      ).rows[0].count,
    ).toBe(2);
  });
  it('保守Batchが追いつかない24h遅延と接続障害を固定結果だけで返す', async () => {
    const a = rate();
    await a.initialize();
    now = 86_500_000;
    for (let n = 1; n < 3; n++)
      await observer.query(
        "INSERT INTO authentication_http.rate_window(operation,kind,subject_digest,window_start_ms,count,expires_at_ms) VALUES('attempt','peer',$1,0,1,60000)",
        [Buffer.alloc(32, n)],
      );
    expect(await a.cleanup(1)).toEqual({
      status: 'cleaned',
      deleted: 1,
      overdue: true,
    });
    expect(await a.cleanup(1)).toEqual({
      status: 'cleaned',
      deleted: 1,
      overdue: false,
    });
    const failing = createPostgresAuthenticationHttpRate({
      pool: {
        connect: () => Promise.reject(new Error('synthetic/private-dsn')),
      },
      namespace,
      keyVersion: 'v1',
      key,
    });
    expect(await failing.reserve('login', '127.0.0.1')).toEqual({
      status: 'unavailable',
    });
    expect(await failing.cleanup(10)).toEqual({ status: 'unavailable' });
  });
});
