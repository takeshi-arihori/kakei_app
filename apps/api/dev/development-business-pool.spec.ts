import { EventEmitter } from 'node:events';
import type { PoolConfig } from 'pg';
import { describe, expect, it } from 'vitest';
import type { GraphQLAuthenticationService } from '../src/presentation/graphql/authenticated-operation.js';
import {
  businessPoolSettings,
  createDevelopmentBusinessPool,
} from './development-business-pool.js';

/** 接続の成否を試験から決める、pgのClient互換の最小Fake。DBへ接続しない。 */
const fakeClient = (mode: { fail: boolean }): PoolConfig['Client'] =>
  // pg-poolが使う接続・終了・Eventだけを持つ。型はpgのClientBase全体を要求する。
  class FakeClient extends EventEmitter {
    connect(callback: (error?: Error) => void) {
      setImmediate(() =>
        callback(mode.fail ? new Error('synthetic/refused') : undefined),
      );
    }
    isConnected() {
      return !mode.fail;
    }
    query(
      _text: string,
      _values: unknown,
      callback: (e: null, r: object) => void,
    ) {
      setImmediate(() => callback(null, { rows: [] }));
    }
    end(callback?: () => void) {
      callback?.();
      return Promise.resolve();
    }
  } as unknown as PoolConfig['Client'];

/** 共有認証の契約（Callbackの例外はrollbackしてunavailable）を模すFake。 */
const fakeService = () => {
  const commits: string[] = [];
  const service: GraphQLAuthenticationService = {
    async withAuthenticatedActor(_secret, _usage, callback) {
      try {
        const value = await callback(
          { actorSubject: 'synthetic-actor', csrf: 'x', absoluteExpiresAt: 0 },
          { serialize: (v: unknown) => JSON.stringify(v) } as never,
        );
        commits.push('commit');
        return { status: 'authenticated', value };
      } catch {
        commits.push('rollback');
        return { status: 'unavailable' };
      }
    },
  };
  return { service, commits };
};

const run = (
  service: GraphQLAuthenticationService,
  work: () => Promise<void>,
) =>
  service.withAuthenticatedActor('secret', 'activity', async () => {
    await work();
    return 'value' as never;
  });

describe('開発用業務Poolの分離と接続待機', () => {
  it('認証と別のapplication_name、接続待機・Lock・Statementの上限を持つ', () => {
    const business = createDevelopmentBusinessPool({
      databaseUrl: 'postgresql://user@127.0.0.1:5432/synthetic_auth_dev',
    });
    try {
      expect(business.pool.options).toMatchObject({
        max: businessPoolSettings.max,
        connectionTimeoutMillis: businessPoolSettings.connectionTimeoutMillis,
        query_timeout: businessPoolSettings.queryTimeoutMillis,
        application_name: 'kakei-group-disposable-development',
        lock_timeout: businessPoolSettings.lockTimeoutMillis,
        statement_timeout: businessPoolSettings.statementTimeoutMillis,
        idle_in_transaction_session_timeout:
          businessPoolSettings.idleInTransactionTimeoutMillis,
      });
      // 接続待機はLock待機より短く、Lockを待つ間に無期限に並ばない。
      expect(businessPoolSettings.connectionTimeoutMillis).toBeLessThan(
        businessPoolSettings.lockTimeoutMillis,
      );
      expect(businessPoolSettings.lockTimeoutMillis).toBeLessThan(
        businessPoolSettings.statementTimeoutMillis,
      );
    } finally {
      void business.end();
    }
  });

  it('lease内の接続取得に失敗したら、業務側が握り潰しても認証leaseをrollbackする', async () => {
    const business = createDevelopmentBusinessPool({
      databaseUrl: 'postgresql://user@127.0.0.1:5432/synthetic_auth_dev',
      client: fakeClient({ fail: true }),
    });
    const { service, commits } = fakeService();
    const guarded = business.guard(service);
    try {
      // connect()とPool.query()の両経路を確かめる。
      expect(
        await run(guarded, async () => {
          await business.pool.connect().catch(() => undefined);
        }),
      ).toEqual({ status: 'unavailable' });
      expect(
        await run(guarded, async () => {
          await business.pool.query('SELECT 1').catch(() => undefined);
        }),
      ).toEqual({ status: 'unavailable' });
      expect(commits).toEqual(['rollback', 'rollback']);
    } finally {
      await business.end();
    }
  });

  it('接続待機のtimeoutでもrollbackし、並行する他のleaseと取得に成功したleaseは変えない', async () => {
    const business = createDevelopmentBusinessPool({
      databaseUrl: 'postgresql://user@127.0.0.1:5432/synthetic_auth_dev',
      client: fakeClient({ fail: false }),
      max: 1,
      connectionTimeoutMillis: 30,
    });
    const { service, commits } = fakeService();
    const guarded = business.guard(service);
    try {
      let releaseHeld: () => void = () => undefined;
      const held = run(guarded, async () => {
        const client = await business.pool.connect();
        await new Promise<void>((resolve) => {
          releaseHeld = resolve;
        });
        client.release();
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const started = performance.now();
      const waiting = await run(guarded, async () => {
        await business.pool.connect().catch(() => undefined);
      });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(waiting).toEqual({ status: 'unavailable' });
      releaseHeld();
      expect(await held).toEqual({ status: 'authenticated', value: 'value' });
      expect(commits).toEqual(['rollback', 'commit']);
      // lease外の取得失敗は他のleaseへ波及しない。
      expect(
        await run(guarded, async () => {
          (await business.pool.connect()).release();
        }),
      ).toEqual({ status: 'authenticated', value: 'value' });
    } finally {
      await business.end();
    }
  });

  it('end後はlease外でも内でも取得を拒否し、lease内ならrollbackする', async () => {
    const business = createDevelopmentBusinessPool({
      databaseUrl: 'postgresql://user@127.0.0.1:5432/synthetic_auth_dev',
      client: fakeClient({ fail: false }),
    });
    const { service, commits } = fakeService();
    const guarded = business.guard(service);
    // end前は同じFake Clientで取得できる。以後の拒否はPool終了だけが原因になる。
    (await business.pool.connect()).release();
    await business.end();
    await expect(business.pool.connect()).rejects.toThrow();
    expect(
      await run(guarded, async () => {
        await business.pool.query('SELECT 1').catch(() => undefined);
      }),
    ).toEqual({ status: 'unavailable' });
    expect(commits).toEqual(['rollback']);
  });
});
