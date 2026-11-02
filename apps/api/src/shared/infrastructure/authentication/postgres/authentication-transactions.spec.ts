import type { QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createAuthenticationTransactionScopes } from './authentication-transaction-scopes.js';
import { createAuthenticationTransactions } from './authentication-transactions.js';

const empty: QueryResult = {
  command: '',
  rowCount: 0,
  oid: 0,
  fields: [],
  rows: [],
};
const fixture = () => {
  const events: string[] = [];
  const query = vi.fn((sql: string) =>
    Promise.resolve().then(() => {
      events.push(sql);
      return empty;
    }),
  );
  const release = vi.fn((destroy?: boolean) => {
    events.push(destroy ? 'destroy' : 'release');
  });
  const pool = { connect: vi.fn(() => Promise.resolve({ query, release })) };
  const scopes = createAuthenticationTransactionScopes();
  return {
    events,
    query,
    release,
    pool,
    scopes,
    runner: createAuthenticationTransactions(pool, scopes),
  };
};

describe('認証Transaction Outcome', () => {
  it('queryがない間のDriver errorも原因を漏らさず中断/破棄する', async () => {
    const f = fixture();
    let listener: ((error: unknown) => void) | undefined;
    const run = createAuthenticationTransactions(
      {
        connect: () =>
          Promise.resolve({
            query: f.query,
            release: f.release,
            on: (_event, handler) => {
              listener = handler;
            },
          }),
      },
      f.scopes,
    );
    const result = await run.run(() => {
      listener?.(new Error('合成接続秘密'));
      return new Promise<never>(() => {});
    });
    expect(result).toEqual({ status: 'unavailable' });
    expect(f.release).toHaveBeenCalledWith(true);
    expect(f.events).not.toContain('COMMIT');
  });
  it('専用上限をDBへ設定し、期限前の成功だけcommitする', async () => {
    const f = fixture();
    expect(
      (
        await f.runner.run(() => Promise.resolve(1), {
          lockTimeoutMs: 10,
          statementTimeoutMs: 20,
          transactionTimeoutMs: 1000,
        })
      ).status,
    ).toBe('committed');
    expect(f.query).toHaveBeenCalledWith(
      expect.stringContaining("set_config('lock_timeout'"),
      ['10', '20', '1000'],
    );
  });
  it.each(['cancel', 'timeout'] as const)(
    '%sでCallbackが戻らなくても破棄し、遅延SQLを拒否する',
    async (kind) => {
      const f = fixture();
      const control = new AbortController();
      let resume!: () => void;
      let late: Promise<unknown> | undefined;
      const hold = new Promise<void>((done) => {
        resume = done;
      });
      const result = f.runner.run(
        async (connection) => {
          if (kind === 'cancel') control.abort();
          await hold;
          late = connection.query('SELECT 99');
          await late.catch(() => {});
          return 1;
        },
        {
          lockTimeoutMs: 10,
          statementTimeoutMs: 20,
          transactionTimeoutMs: kind === 'timeout' ? 10 : 1000,
          signal: control.signal,
        },
      );
      expect(await result).toEqual({ status: 'unavailable' });
      expect(f.release).toHaveBeenCalledWith(true);
      expect(f.events).not.toContain('COMMIT');
      resume();
      await Promise.resolve();
      await expect(late).rejects.toThrow();
      expect(f.events).not.toContain('SELECT 99');
    },
  );
  it('事前cancelまたは不正な上限で接続もCallbackも取得しない', async () => {
    const f = fixture();
    const control = new AbortController();
    control.abort();
    const callback = vi.fn(() => Promise.resolve(1));
    expect(
      await f.runner.run(callback, {
        lockTimeoutMs: 1,
        statementTimeoutMs: 1,
        transactionTimeoutMs: 1,
        signal: control.signal,
      }),
    ).toEqual({ status: 'unavailable' });
    expect(
      await f.runner.run(callback, {
        lockTimeoutMs: 0,
        statementTimeoutMs: 1,
        transactionTimeoutMs: 1,
      }),
    ).toEqual({ status: 'unavailable' });
    expect(f.pool.connect).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });
  it.each(['40P01', '40001'] as const)(
    '%sは自動再試行せずrollbackして利用不能にする',
    async (code) => {
      const f = fixture();
      expect(
        await f.runner.run(() =>
          Promise.reject(Object.assign(new Error('合成競合'), { code })),
        ),
      ).toEqual({ status: 'unavailable' });
      expect(f.pool.connect).toHaveBeenCalledTimes(1);
      expect(f.events).toContain('ROLLBACK');
    },
  );
  it('同一接続でBEGINからcommitまで保持し、確定後だけ値を返す', async () => {
    const f = fixture();
    expect(
      await f.runner.run(async (connection, lease) => {
        await connection.query('SELECT 1');
        const handle = lease.scope.serialize({ allowed: true });
        lease.seal();
        lease.assertResult(handle);
        return handle;
      }),
    ).toEqual({ status: 'committed', value: { body: '{"allowed":true}' } });
    expect(f.events).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      'SELECT 1',
      'COMMIT',
      'release',
    ]);
    expect(f.pool.connect).toHaveBeenCalledTimes(1);
  });

  it('commit前の失敗はrollbackし値を返さない', async () => {
    const f = fixture();
    expect(
      await f.runner.run(() =>
        Promise.resolve().then(() => {
          throw new Error('合成秘密詳細');
        }),
      ),
    ).toEqual({ status: 'unavailable' });
    expect(f.events).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      'ROLLBACK',
      'release',
    ]);
  });

  it('AliasのUnique敗者だけは確認済みrollback後の再試行を許す', async () => {
    const f = fixture();
    const conflict = Object.assign(new Error('合成Unique競合'), {
      code: '23505',
      constraint: 'identity_alias_pkey',
    });
    expect(
      await f.runner.run(() =>
        Promise.resolve().then(() => {
          throw conflict;
        }),
      ),
    ).toEqual({ status: 'identity-conflict' });
    expect(f.events.at(-2)).toBe('ROLLBACK');
    expect(
      await f.runner.run(() =>
        Promise.resolve().then(() => {
          throw Object.assign(new Error('合成Session競合'), {
            ...conflict,
            constraint: 'session_record_pkey',
          });
        }),
      ),
    ).toEqual({ status: 'unavailable' });
  });

  it.each(['commit', 'rollback'] as const)(
    '%sの結果不明では接続を破棄し再試行しない',
    async (point) => {
      const f = fixture();
      f.query.mockImplementation((sql) =>
        Promise.resolve().then(() => {
          f.events.push(sql);
          if (sql === point.toUpperCase()) throw new Error('合成応答喪失');
          return empty;
        }),
      );
      expect(
        await f.runner.run(() =>
          Promise.resolve().then(() => {
            if (point === 'rollback')
              throw Object.assign(new Error('合成Unique競合'), {
                code: '23505',
                constraint: 'identity_alias_pkey',
              });
            return '合成秘密値';
          }),
        ),
      ).toEqual({ status: 'unavailable' });
      expect(f.release).toHaveBeenCalledWith(true);
      if (point === 'commit') expect(f.events).not.toContain('ROLLBACK');
    },
  );

  it('Callbackが握り潰したserialization失敗もrollbackする', async () => {
    const f = fixture();
    expect(
      await f.runner.run((_connection, lease) =>
        Promise.resolve().then(() => {
          const handle = lease.scope.serialize(null);
          try {
            lease.scope.serialize(undefined);
          } catch {
            /* 合成Callbackによる握り潰し */
          }
          return handle;
        }),
      ),
    ).toEqual({ status: 'unavailable' });
    expect(f.events).not.toContain('COMMIT');
  });
});
