import type { QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createAuthenticationTransactionScopes } from './authentication-transaction-scopes.js';

const result: QueryResult = {
  command: 'SELECT',
  rowCount: 0,
  oid: 0,
  fields: [],
  rows: [],
};
const client = () => ({ query: vi.fn(() => Promise.resolve(result)) });

describe('認証TransactionScopeと確定本文', () => {
  it.each([
    'SELECT 1 INTO TEMP TABLE synthetic_scope_probe',
    'select 1 into synthetic_scope_probe',
    'SELECT 1 INTO\nUNLOGGED TABLE synthetic_scope_probe',
  ])('Tableを作成するSELECT INTOはSQL実行前に拒否する: %s', async (sql) => {
    const scopes = createAuthenticationTransactionScopes();
    const connection = client();
    const lease = scopes.open(connection);
    await expect(scopes.participants.query(lease.scope, sql)).rejects.toThrow();
    expect(connection.query).not.toHaveBeenCalled();
    lease.seal();
    expect(() => lease.assertCommittable()).toThrow();
  });
  it('open中に本文を固定しsealed中にも同じScopeのhandleだけを認める', () => {
    const scopes = createAuthenticationTransactionScopes();
    const lease = scopes.open(client());
    const original = { items: [1, { label: '合成値' }] };
    const handle = lease.scope.serialize(original);
    original.items.push(2);
    lease.seal();
    expect(() => lease.assertResult(handle)).not.toThrow();
    expect(() => lease.assertCommittable()).not.toThrow();
    expect(handle.body).toBe('{"items":[1,{"label":"合成値"}]}');
    expect(Object.getPrototypeOf(handle)).toBeNull();
    expect(Object.isFrozen(handle)).toBe(true);
    expect(Reflect.ownKeys(handle)).toEqual(['body']);
    lease.close();
    expect(() => lease.assertResult(handle)).toThrow();
  });

  it('同じ本文でも別Scopeのhandleと偽造Objectを拒否する', () => {
    const scopes = createAuthenticationTransactionScopes();
    const one = scopes.open(client());
    const two = scopes.open(client());
    const foreign = one.scope.serialize({ allowed: true });
    const own = two.scope.serialize({ allowed: true });
    two.seal();
    expect(foreign.body).toBe(own.body);
    expect(() => two.assertResult(foreign)).toThrow();
    expect(() => two.assertResult({ body: own.body })).toThrow();
    expect(() => two.assertResult(own.body)).toThrow();
  });

  it.each(['sealed', 'closed'] as const)(
    '%s後はJSONの評価もSQL実行も始めない',
    async (phase) => {
      const scopes = createAuthenticationTransactionScopes();
      const connection = client();
      const lease = scopes.open(connection);
      const handle = lease.scope.serialize(null);
      const getter = vi.fn(() => '遅延値');
      lease.seal();
      if (phase === 'closed') lease.close();
      expect(() =>
        lease.scope.serialize({
          get value() {
            return getter();
          },
        }),
      ).toThrow();
      await expect(
        scopes.participants.query(lease.scope, 'SELECT 1'),
      ).rejects.toThrow();
      expect(getter).not.toHaveBeenCalled();
      expect(connection.query).not.toHaveBeenCalled();
      if (phase === 'sealed') {
        expect(() => lease.assertResult(handle)).not.toThrow();
        expect(() => lease.assertCommittable()).not.toThrow();
      }
    },
  );

  it.each([
    undefined,
    1n,
    NaN,
    Infinity,
    () => null,
    Symbol('合成値'),
    { value: undefined },
    { toJSON: () => '遅延値' },
    new Date(0),
    Object.create({ inherited: true }) as unknown,
    new Array(2),
  ])('JSON-safeでない値のcase %# は握り潰してもcommit不可', (value) => {
    const lease = createAuthenticationTransactionScopes().open(client());
    const handle = lease.scope.serialize(null);
    expect(() => lease.scope.serialize(value)).toThrow();
    lease.seal();
    expect(() => lease.assertResult(handle)).not.toThrow();
    expect(() => lease.assertCommittable()).toThrow();
  });

  it('getter・toJSONを実行せず循環とSymbol keyも拒否する', () => {
    const getter = vi.fn(() => '遅延値');
    const toJSON = vi.fn(() => '遅延値');
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [
      {
        get value() {
          return getter();
        },
      },
      { toJSON },
      cycle,
      { [Symbol('非JSON')]: true },
    ]) {
      const lease = createAuthenticationTransactionScopes().open(client());
      expect(() => lease.scope.serialize(value)).toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('Scope偽造・別registryとTransaction制御をSQL実行前に拒否する', async () => {
    const scopes = createAuthenticationTransactionScopes();
    const connection = client();
    const lease = scopes.open(connection);
    const foreign = createAuthenticationTransactionScopes().open(client());
    for (const scope of [foreign.scope, {} as typeof lease.scope]) {
      await expect(
        scopes.participants.query(scope, 'SELECT 1'),
      ).rejects.toThrow();
    }
    for (const sql of [
      'BEGIN',
      'COMMIT',
      'ROLLBACK',
      'SAVEPOINT a',
      'RELEASE a',
      'SELECT 1; COMMIT',
    ]) {
      await expect(
        scopes.participants.query(lease.scope, sql),
      ).rejects.toThrow();
    }
    await expect(
      scopes.participants.query(lease.scope, {
        text: 'COMMIT',
        toString: () => 'SELECT 1',
      } as unknown as string),
    ).rejects.toThrow();
    expect(connection.query).not.toHaveBeenCalled();
    lease.seal();
    expect(() => lease.assertCommittable()).toThrow();
    expect(Reflect.ownKeys(scopes.participants)).toEqual(['query']);
  });

  it('参加queryは同じ接続へ束縛され、失敗を握り潰してもcommit不可', async () => {
    const scopes = createAuthenticationTransactionScopes();
    const connection = client();
    const lease = scopes.open(connection);
    await scopes.participants.query(lease.scope, 'SELECT $1', ['合成値']);
    expect(connection.query).toHaveBeenCalledWith('SELECT $1', ['合成値']);
    connection.query.mockRejectedValueOnce(new Error('合成DB障害'));
    await expect(
      scopes.participants.query(lease.scope, 'SELECT 1'),
    ).rejects.toThrow();
    lease.seal();
    expect(() => lease.assertCommittable()).toThrow();
  });

  it('未awaitのqueryがあれば受付停止後に収束してもcommit不可', async () => {
    let finish!: (value: QueryResult) => void;
    const pending = new Promise<QueryResult>((resolve) => {
      finish = resolve;
    });
    const scopes = createAuthenticationTransactionScopes();
    const connection = { query: vi.fn(() => pending) };
    const lease = scopes.open(connection);
    const query = scopes.participants.query(lease.scope, 'SELECT 1');
    lease.seal();
    expect(() => lease.assertCommittable()).toThrow();
    finish(result);
    await lease.drain();
    await query;
    expect(() => lease.assertCommittable()).toThrow();
  });
});
