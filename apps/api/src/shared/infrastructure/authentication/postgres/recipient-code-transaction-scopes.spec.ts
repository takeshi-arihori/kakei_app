import { describe, expect, it, vi } from 'vitest';

import { createAuthenticationTransactionScopes } from './authentication-transaction-scopes.js';
import { createRecipientCodeTransactionScopes } from './recipient-code-transaction-scopes.js';
import type { RecipientCodeCommitEvidence } from '../../../application/authentication/recipient-code-ports.js';

const codeId = '10000000-0000-4000-8000-000000000001';
const recipientActorId = '10000000-0000-4000-8000-000000000002';
const operationId = '10000000-0000-4000-8000-000000000003';
const empty = { command: 'SELECT', rowCount: 0, oid: 0, fields: [], rows: [] };

const fixture = async () => {
  const registry = createRecipientCodeTransactionScopes(
    createAuthenticationTransactionScopes(),
  );
  const gm = registry.registerGroupParticipant({
    prepare: async (scope, query) => {
      await query.query(scope, 'SELECT 1');
    },
  });
  const connection = { query: vi.fn(() => Promise.resolve(empty)) };
  const lease = registry.scopes.open(connection);
  await registry.prepare(lease.scope);
  const consume = vi.fn(() => Promise.resolve());
  const guard = vi.fn(() => {});
  const bound = registry.bind(
    lease.scope,
    { codeId, recipientActorId },
    consume,
    guard,
  );
  await gm.query(lease.scope, 'INSERT INTO synthetic_gm VALUES (1)');
  const value = bound.scope.serialize({ invitation: 'synthetic' });
  let evidence: RecipientCodeCommitEvidence | undefined;
  return {
    registry,
    gm,
    connection,
    lease,
    consume,
    guard,
    bound,
    value,
    get evidence() {
      return (evidence ??= gm.attest(lease.scope, bound.handle, {
        codeId,
        recipientActorId,
        operationId,
        value,
      }));
    },
  };
};

describe('招待コードleaseの登録参加者と消費証跡', () => {
  it('同registryでも別ScopeのGM証跡は消費に使えない', async () => {
    const f = await fixture();
    const other = f.registry.scopes.open({
      query: () => Promise.resolve(empty),
    });
    await f.registry.prepare(other.scope);
    const b = f.registry.bind(
      other.scope,
      { codeId, recipientActorId },
      () => Promise.resolve(),
      () => {},
    );
    await f.gm.query(other.scope, 'INSERT INTO synthetic_gm VALUES (1)');
    const value = other.scope.serialize(null);
    const proof = f.gm.attest(other.scope, b.handle, {
      codeId,
      recipientActorId,
      operationId,
      value,
    });
    await expect(
      f.bound.scope.consume(f.bound.handle, proof),
    ).rejects.toThrow();
    f.lease.seal();
    expect(() => f.lease.assertCommittable()).toThrow();
  });
  it('完了済みでも未awaitのqueryがあればcommit不可', async () => {
    const f = await fixture();
    const evidence = f.evidence;
    void f.gm.query(f.lease.scope, 'SELECT 1');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await f.bound.scope.consume(f.bound.handle, evidence);
    f.lease.seal();
    expect(() => f.lease.assertCommittable()).toThrow();
  });
  it('GMのoperationIdは既存namespaceの文字列を保ち、UUIDへ制限しない', async () => {
    const f = await fixture();
    const evidence = f.gm.attest(f.lease.scope, f.bound.handle, {
      codeId,
      recipientActorId,
      operationId: 'synthetic-operation',
      value: f.value,
    });
    await f.bound.scope.consume(f.bound.handle, evidence);
    f.lease.seal();
    expect(() => f.lease.assertCommittable()).not.toThrow();
  });
  it('catch/finallyだけの未await queryを受領済みと誤認しない', async () => {
    const f = await fixture();
    const evidence = f.evidence;
    void f.gm
      .query(f.lease.scope, 'SELECT 1')
      .catch(() => {})
      .finally(() => {});
    await f.bound.scope.consume(f.bound.handle, evidence);
    f.lease.seal();
    expect(() => f.lease.assertCommittable()).toThrow();
  });
  it('同じScopeの登録GM証跡・一回消費・確定本文が揃う場合だけcommitできる', async () => {
    const registry = createRecipientCodeTransactionScopes(
      createAuthenticationTransactionScopes(),
    );
    const gm = registry.registerGroupParticipant({
      prepare: async (scope, query) => {
        await query.query(scope, 'SELECT 1');
      },
    });
    const lease = registry.scopes.open({
      query: vi.fn(() => Promise.resolve(empty)),
    });
    await registry.prepare(lease.scope);
    const consume = vi.fn(() => Promise.resolve());
    const bound = registry.bind(
      lease.scope,
      { codeId, recipientActorId },
      consume,
      () => {},
    );
    await gm.query(lease.scope, 'INSERT INTO synthetic_gm VALUES (1)');
    const value = bound.scope.serialize({ invitation: 'synthetic' });
    const evidence = gm.attest(lease.scope, bound.handle, {
      codeId,
      recipientActorId,
      operationId,
      value,
    });
    await bound.scope.consume(bound.handle, evidence);
    lease.seal();
    expect(() => lease.assertResult(value)).not.toThrow();
    expect(() => lease.assertCommittable()).not.toThrow();
    expect(consume).toHaveBeenCalledOnce();
  });

  it('GM証跡なしの消費は握り潰してもcommit不可', async () => {
    const f = await fixture();
    await expect(
      f.bound.scope.consume(f.bound.handle, {} as RecipientCodeCommitEvidence),
    ).rejects.toThrow();
    f.lease.seal();
    expect(() => f.lease.assertCommittable()).toThrow();
    expect(f.consume).not.toHaveBeenCalled();
  });
  it('成功計画の本文とcallbackが返す本文を別handleに差し替えられない', async () => {
    const f = await fixture();
    await f.bound.scope.consume(f.bound.handle, f.evidence);
    const alternate = f.bound.scope.serialize({ invitation: 'synthetic' });
    f.lease.seal();
    expect(() => f.lease.assertResult(alternate)).toThrow();
  });
  it('同scopeでも二重consumeと証跡の再使用を拒否する', async () => {
    const f = await fixture();
    await f.bound.scope.consume(f.bound.handle, f.evidence);
    await expect(
      f.bound.scope.consume(f.bound.handle, f.evidence),
    ).rejects.toThrow();
    f.lease.seal();
    expect(() => f.lease.assertCommittable()).toThrow();
    expect(f.consume).toHaveBeenCalledOnce();
  });
  it('別Scope/registryの証跡・消費handleを拒否する', async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(
      f.bound.scope.consume(other.bound.handle, other.evidence),
    ).rejects.toThrow();
    f.lease.seal();
    expect(() => f.lease.assertCommittable()).toThrow();
  });
  it.each(['codeId', 'recipientActorId'] as const)(
    'GM保存計画の%sが違えば証跡を発行しない',
    async (field) => {
      const f = await fixture();
      expect(() =>
        f.gm.attest(f.lease.scope, f.bound.handle, {
          codeId,
          recipientActorId,
          operationId,
          value: f.value,
          [field]: operationId,
        }),
      ).toThrow();
      f.lease.seal();
      expect(() => f.lease.assertCommittable()).toThrow();
    },
  );
  it('consumeなしの新規成功本文ではcommit不可', async () => {
    const f = await fixture();
    f.lease.seal();
    expect(() => f.lease.assertCommittable()).toThrow();
  });
  it('未awaitのconsumeは完了済みでもcommit不可', async () => {
    const f = await fixture();
    void f.bound.scope.consume(f.bound.handle, f.evidence);
    await Promise.resolve();
    await Promise.resolve();
    f.lease.seal();
    expect(() => f.lease.assertCommittable()).toThrow();
  });
  it('消費失敗を握り潰してもcommit不可', async () => {
    const f = await fixture();
    f.consume.mockRejectedValueOnce(new Error('合成障害'));
    await expect(
      f.bound.scope.consume(f.bound.handle, f.evidence),
    ).rejects.toThrow();
    f.lease.seal();
    expect(() => f.lease.assertCommittable()).toThrow();
  });
  it('serialize最終期限の失敗を握り潰してもcommit不可', async () => {
    const f = await fixture();
    f.guard.mockImplementation(() => {
      throw new Error('合成期限等値');
    });
    expect(() => f.bound.scope.serialize(null)).toThrow();
    f.lease.seal();
    expect(() => f.lease.assertCommittable()).toThrow();
  });
  it('sealed後queryはSQLを送らずcommit不可にする', async () => {
    const f = await fixture();
    await f.bound.scope.consume(f.bound.handle, f.evidence);
    f.lease.seal();
    const count = f.connection.query.mock.calls.length;
    await expect(f.gm.query(f.lease.scope, 'SELECT 1')).rejects.toThrow();
    expect(f.connection.query.mock.calls.length).toBe(count);
    expect(() => f.lease.assertCommittable()).toThrow();
  });
  it('GM prepareなし/業務queryなしの自己申告証跡を拒否する', async () => {
    const registry = createRecipientCodeTransactionScopes(
      createAuthenticationTransactionScopes(),
    );
    const gm = registry.registerGroupParticipant({
      prepare: () => Promise.resolve(),
    });
    const lease = registry.scopes.open({ query: () => Promise.resolve(empty) });
    await registry.prepare(lease.scope);
    const b = registry.bind(
      lease.scope,
      { codeId, recipientActorId },
      () => Promise.resolve(),
      () => {},
    );
    const value = b.scope.serialize(null);
    expect(() =>
      gm.attest(lease.scope, b.handle, {
        codeId,
        recipientActorId,
        operationId,
        value,
      }),
    ).toThrow();
  });
});
