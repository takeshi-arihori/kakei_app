import { describe, expect, it, vi } from 'vitest';

import { createAuthenticationTransactionScopes } from './authentication-transaction-scopes.js';
import { createRecipientCodeTransactionScopes } from './recipient-code-transaction-scopes.js';
import type { RecipientCodeCommitEvidence } from '../../../application/authentication/recipient-code-ports.js';

const codeId = '10000000-0000-4000-8000-000000000001';
const recipientActorId = '10000000-0000-4000-8000-000000000002';
const operationId = '10000000-0000-4000-8000-000000000003';
const empty = { command: 'SELECT', rowCount: 0, oid: 0, fields: [], rows: [] };

const fixture = async (plannedOperationId = operationId) => {
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
  const value = bound.scope.serialize({ invitation: 'synthetic' });
  gm.beginPlan(lease.scope, bound.handle, {
    codeId,
    recipientActorId,
    operationId: plannedOperationId,
    value,
  });
  await gm.query(lease.scope, 'INSERT INTO synthetic_gm VALUES (1)');
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
        operationId: plannedOperationId,
        value,
      }));
    },
  };
};

describe('招待コードleaseの登録参加者と消費証跡', () => {
  it.each(['before-consume', 'after-consume'] as const)(
    '%sの登録GMの検証失敗はScopeを不可逆にcommit不可にする',
    async (when) => {
      const f = await fixture();
      const evidence = f.evidence;
      if (when === 'after-consume') {
        await f.bound.scope.consume(f.bound.handle, evidence);
      }
      await expect(
        f.gm.run(f.lease.scope, () =>
          Promise.reject(new Error('synthetic GM validation failure')),
        ),
      ).rejects.toThrow();
      if (when === 'before-consume') {
        await expect(
          f.bound.scope.consume(f.bound.handle, evidence),
        ).rejects.toThrow();
        expect(f.consume).not.toHaveBeenCalled();
      }
      f.lease.seal();
      expect(() => f.lease.assertCommittable()).toThrow();
    },
  );

  it('SQL前の未完了GM操作をsealで拒否し、Providerを待たずにdrainできる', async () => {
    const f = await fixture();
    await f.bound.scope.consume(f.bound.handle, f.evidence);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = f.connection.query.mock.calls.length;
    const pending = f.gm.run(f.lease.scope, async () => {
      await gate;
      await f.gm.query(f.lease.scope, 'SELECT 1');
    });
    void pending.catch(() => {});
    f.lease.seal();
    expect(() => f.lease.assertCommittable()).toThrow();
    await f.lease.drain();
    f.lease.close();
    release();
    await expect(pending).rejects.toThrow();
    expect(f.connection.query).toHaveBeenCalledTimes(calls);
  });

  it('完了済みでも未awaitのGM操作をcommit済みと扱わない', async () => {
    const f = await fixture();
    const evidence = f.evidence;
    void f.gm.run(f.lease.scope, () => Promise.resolve('synthetic result'));
    await Promise.resolve();
    await Promise.resolve();
    await f.bound.scope.consume(f.bound.handle, evidence);
    f.lease.seal();
    expect(() => f.lease.assertCommittable()).toThrow();
  });

  it('GM操作の入力固定を最初のawaitより後へ遅延させない', async () => {
    const f = await fixture();
    const input = { value: 'original' };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = f.gm.run(f.lease.scope, async () => {
      const fixed = input.value;
      await gate;
      return fixed;
    });
    input.value = 'changed';
    release();
    expect(await running).toBe('original');
    await f.bound.scope.consume(f.bound.handle, f.evidence);
    f.lease.seal();
    expect(() => f.lease.assertCommittable()).not.toThrow();
  });

  it('未完了GM操作に重ねた操作受付はScopeを失敗済みにする', async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = f.gm.run(f.lease.scope, () => gate);
    await expect(
      f.gm.run(f.lease.scope, () => Promise.resolve()),
    ).rejects.toThrow();
    release();
    await first;
    f.lease.seal();
    expect(() => f.lease.assertCommittable()).toThrow();
  });

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
    const value = other.scope.serialize(null);
    f.gm.beginPlan(other.scope, b.handle, {
      codeId,
      recipientActorId,
      operationId,
      value,
    });
    await f.gm.query(other.scope, 'INSERT INTO synthetic_gm VALUES (1)');
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
    const f = await fixture('synthetic-operation');
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
    const value = bound.scope.serialize({ invitation: 'synthetic' });
    gm.beginPlan(lease.scope, bound.handle, {
      codeId,
      recipientActorId,
      operationId,
      value,
    });
    await gm.query(lease.scope, 'INSERT INTO synthetic_gm VALUES (1)');
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
    gm.beginPlan(lease.scope, b.handle, {
      codeId,
      recipientActorId,
      operationId,
      value,
    });
    expect(() =>
      gm.attest(lease.scope, b.handle, {
        codeId,
        recipientActorId,
        operationId,
        value,
      }),
    ).toThrow();
  });
  it.each(['operationId', 'value'] as const)(
    '新規受付時の%sを保存証跡で差し替えられない',
    async (field) => {
      const f = await fixture();
      const replacement =
        field === 'operationId'
          ? 'changed-operation'
          : f.bound.scope.serialize({ invitation: 'synthetic' });
      expect(() =>
        f.gm.attest(f.lease.scope, f.bound.handle, {
          codeId,
          recipientActorId,
          operationId,
          value: f.value,
          [field]: replacement,
        }),
      ).toThrow();
      f.lease.seal();
      expect(() => f.lease.assertCommittable()).toThrow();
    },
  );
  it('登録GMの新規DMLはbeginPlan済み計画だけに限定し、caller-only Scopeでcommitさせない', async () => {
    const registry = createRecipientCodeTransactionScopes(
      createAuthenticationTransactionScopes(),
    );
    const gm = registry.registerGroupParticipant({
      prepare: () => Promise.resolve(),
    });
    const connection = { query: vi.fn(() => Promise.resolve(empty)) };
    const lease = registry.scopes.open(connection);
    await registry.prepare(lease.scope);
    await expect(
      gm.query(lease.scope, 'INSERT INTO synthetic_gm VALUES (1)'),
    ).rejects.toThrow();
    expect(connection.query).not.toHaveBeenCalled();
    lease.scope.serialize({ status: 'no-replay' });
    lease.seal();
    expect(() => lease.assertCommittable()).toThrow();
  });
  it('二度目の新規計画受付は先行証跡も消費不可にして全rollbackを要求する', async () => {
    const f = await fixture();
    const evidence = f.evidence;
    expect(() =>
      f.gm.beginPlan(f.lease.scope, f.bound.handle, {
        codeId,
        recipientActorId,
        operationId,
        value: f.value,
      }),
    ).toThrow();
    await expect(
      f.bound.scope.consume(f.bound.handle, evidence),
    ).rejects.toThrow();
    f.lease.seal();
    expect(() => f.lease.assertCommittable()).toThrow();
  });
  it('未受付DMLを未awaitで捨ててもSQLを送らず未処理rejectionを残さない', async () => {
    const registry = createRecipientCodeTransactionScopes(
      createAuthenticationTransactionScopes(),
    );
    const gm = registry.registerGroupParticipant({
      prepare: () => Promise.resolve(),
    });
    const connection = { query: vi.fn(() => Promise.resolve(empty)) };
    const lease = registry.scopes.open(connection);
    await registry.prepare(lease.scope);
    void gm.query(lease.scope, 'INSERT INTO synthetic_gm VALUES (1)');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    lease.seal();
    await lease.drain();
    expect(() => lease.assertCommittable()).toThrow();
    expect(connection.query).not.toHaveBeenCalled();
    lease.close();
  });
});
