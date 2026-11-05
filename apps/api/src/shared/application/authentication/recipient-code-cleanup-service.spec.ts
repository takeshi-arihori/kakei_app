import { describe, expect, it, vi } from 'vitest';

import { syntheticRecipientCodeManagedKeys } from '../../infrastructure/authentication/test/recipient-code-maintenance-fixtures.js';
import {
  createRecipientCodeCleanupService,
  type RecipientCodeCleanupDatabase,
} from './recipient-code-cleanup-service.js';
import type { RecipientCodeMacKeyLifecyclePort } from './recipient-code-key-lifecycle.js';
import { guardRecipientCodeMaintenance } from './recipient-code-maintenance-guard.js';

const codeId = '30000000-0000-4000-8000-000000000001';
const recipientActorId = '30000000-0000-4000-8000-000000000002';
const scope = { codeId, recipientActorId };
const operationId = '30000000-0000-4000-8000-000000000003';
const expiresAt = 1_000_000;

const setup = async (terminalAt: number | null = null) => {
  const keys = syntheticRecipientCodeManagedKeys();
  await keys.allocation.allocate({
    codeId,
    recipientActorId,
    keyVersion: 'v1',
    expiresAt,
  });
  await keys.allocation.allocate({
    codeId,
    recipientActorId,
    keyVersion: 'v2',
    expiresAt,
  });
  const events: string[] = [];
  const state = { row: true, now: expiresAt };
  const remove = vi.fn(() => {
    events.push('remove');
    state.row = false;
    return Promise.resolve();
  });
  const absent = vi.fn(() => {
    events.push('absent');
    return Promise.resolve(!state.row);
  });
  const database: RecipientCodeCleanupDatabase = {
    verifiedTerminalAt: () => Promise.resolve(terminalAt),
    remove,
    absent,
  };
  const nextOperationId = vi.fn(() => operationId);
  const lifecycle: RecipientCodeMacKeyLifecyclePort = {
    ...keys.lifecycle,
    closeAllGenerations: (input) => {
      events.push('close');
      return keys.lifecycle.closeAllGenerations(input);
    },
  };
  const guarded = guardRecipientCodeMaintenance({
    lifecycle,
    maintenance: {
      ...keys.maintenance,
      prepare: (input) => {
        events.push('prepare');
        return keys.maintenance.prepare(input);
      },
      complete: (input) => {
        events.push('complete');
        return keys.maintenance.complete(input);
      },
    },
  });
  const service = (l: RecipientCodeMacKeyLifecyclePort = lifecycle) =>
    createRecipientCodeCleanupService({
      maintenance:
        l === lifecycle
          ? guarded
          : guardRecipientCodeMaintenance({
              lifecycle: l,
              maintenance: keys.maintenance,
            }),
      database,
      clock: { now: () => state.now },
      nextOperationId,
    });
  const destroyed = async () =>
    (await keys.lifecycle.inventory(codeId)).generations.every(
      (generation) => generation.lifecycle === 'destroyed',
    );
  return {
    keys,
    events,
    state,
    remove,
    absent,
    nextOperationId,
    service,
    destroyed,
  };
};

describe('createRecipientCodeCleanupService', () => {
  it('ticket登録→行除去→全世代closure→0-row→完了の順で1件を完了する', async () => {
    const t = await setup();
    await expect(t.service().cleanOne(scope)).resolves.toEqual({
      status: 'completed',
    });
    expect(t.events).toEqual([
      'prepare',
      'remove',
      'close',
      'absent',
      'complete',
    ]);
    expect(await t.destroyed()).toBe(true);
    await expect(t.keys.maintenance.find(codeId)).resolves.toMatchObject({
      operationId,
      state: 'complete',
      window: { dueAt: expiresAt, deadline: expiresAt + 86_400_000 },
    });
  });

  it.each([
    ['期限直前', null, expiresAt - 1, 'retained'],
    ['期限等値', null, expiresAt, 'completed'],
    ['期限後', null, expiresAt + 1, 'completed'],
    ['終端直前', 900_000, 899_999, 'retained'],
    ['終端等値', 900_000, 900_000, 'completed'],
  ] as const)(
    '%sの判定は%s/%sから%sとする',
    async (_n, terminal, now, status) => {
      const t = await setup(terminal);
      t.state.now = now;
      await expect(t.service().cleanOne(scope)).resolves.toEqual({ status });
      if (status === 'retained') {
        // 期限前は不可逆な処理へ一切進まない。
        expect(t.events).toEqual([]);
        await expect(t.keys.maintenance.find(codeId)).resolves.toBeNull();
      }
    },
  );

  it('終端時刻を窓の起算に使う', async () => {
    const t = await setup(900_000);
    t.state.now = 900_000;
    await t.service().cleanOne(scope);
    await expect(t.keys.maintenance.find(codeId)).resolves.toMatchObject({
      window: { dueAt: 900_000, deadline: 900_000 + 86_400_000 },
    });
  });

  it('既存ticketのdueAt未到達なら行も鍵も触らない（guardはClockを持たない）', async () => {
    const t = await setup();
    t.keys.faults.add('before-close');
    await expect(t.service().cleanOne(scope)).resolves.toEqual({
      status: 'unavailable',
    });
    t.keys.faults.clear();
    t.events.length = 0;
    t.state.row = true;
    t.state.now = expiresAt - 1;
    await expect(t.service().cleanOne(scope)).resolves.toEqual({
      status: 'retained',
    });
    expect(t.events).toEqual([]);
    expect(await t.destroyed()).toBe(false);
  });

  it('closure後も行が残れば完了せず、除去後に同operationで完了する', async () => {
    const t = await setup();
    t.remove.mockImplementationOnce(() => Promise.resolve());
    await expect(t.service().cleanOne(scope)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(await t.destroyed()).toBe(true);
    await expect(t.keys.maintenance.find(codeId)).resolves.toMatchObject({
      state: 'pending',
    });
    await expect(t.service().cleanOne(scope)).resolves.toEqual({
      status: 'completed',
    });
    expect(t.nextOperationId).toHaveBeenCalledTimes(1);
  });

  it('0-rowでも全世代closureがなければ完了しない', async () => {
    const t = await setup();
    t.state.row = false;
    t.keys.faults.add('before-close');
    await expect(t.service().cleanOne(scope)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(t.absent).not.toHaveBeenCalled();
    await expect(t.keys.maintenance.find(codeId)).resolves.toMatchObject({
      state: 'pending',
    });
  });

  it.each([
    ['before-prepare', 'completed', 2],
    ['after-prepare', 'completed', 1],
    ['find', 'completed', 1],
    ['scope-page', 'completed', 1],
    ['inventory', 'completed', 1],
    ['before-close', 'completed', 1],
    ['after-destroy-generation', 'completed', 1],
    ['after-close', 'completed', 1],
    ['verify-closure', 'completed', 1],
    ['before-complete', 'completed', 1],
    ['after-complete', 'already-complete', 1],
  ] as const)(
    'Provider障害%sでは完了件数を増やさず、同operationで再開して%sとなる',
    async (fault, resumed, operations) => {
      const t = await setup();
      t.keys.faults.add(fault);
      await expect(t.service().cleanOne(scope)).resolves.toEqual({
        status: 'unavailable',
      });
      t.keys.faults.clear();
      await expect(t.service().cleanOne(scope)).resolves.toEqual({
        status: resumed,
      });
      expect(t.nextOperationId).toHaveBeenCalledTimes(operations);
      expect(await t.destroyed()).toBe(true);
      await expect(t.keys.maintenance.find(codeId)).resolves.toMatchObject({
        operationId,
        adoptingOperationIds: [],
        state: 'complete',
      });
      await expect(t.service().cleanOne(scope)).resolves.toEqual({
        status: 'already-complete',
      });
    },
  );

  it.each<
    [
      string,
      (
        l: RecipientCodeMacKeyLifecyclePort,
      ) => Partial<RecipientCodeMacKeyLifecyclePort>,
    ]
  >([
    [
      '検証されないclosure',
      () => ({ verifyClosure: () => Promise.resolve(false) }),
    ],
    [
      '別operationのclosure',
      (l) => ({
        closeAllGenerations: async (input) => ({
          ...(await l.closeAllGenerations(input)),
          operationId: recipientActorId,
        }),
      }),
    ],
    [
      '一世代だけ破棄したのに検証済みと主張するclosure',
      (l) => ({
        closeAllGenerations: (input) =>
          Promise.resolve({
            codeId: input.codeId,
            operationId: input.operationId,
            inventoryRevision: input.inventoryRevision,
            evidenceReference: 'forged',
          }),
        verifyClosure: () => Promise.resolve(true),
        inventory: async (id) => {
          const inventory = await l.inventory(id);
          return {
            ...inventory,
            generations: inventory.generations.map((generation, index) => ({
              ...generation,
              lifecycle: index === 0 ? ('destroyed' as const) : 'current',
            })),
          };
        },
      }),
    ],
  ])('%sでは完了せず、再実行で完了できる', async (_name, forge) => {
    const t = await setup();
    await expect(
      t
        .service({ ...t.keys.lifecycle, ...forge(t.keys.lifecycle) })
        .cleanOne(scope),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(t.absent).not.toHaveBeenCalled();
    await expect(t.keys.maintenance.find(codeId)).resolves.toMatchObject({
      state: 'pending',
    });
    await expect(t.service().cleanOne(scope)).resolves.toEqual({
      status: 'completed',
    });
  });

  it('DB障害では完了せず、原因を外へ出さない', async () => {
    const t = await setup();
    t.remove.mockRejectedValueOnce(new Error(codeId));
    await expect(t.service().cleanOne(scope)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(await t.destroyed()).toBe(false);
    t.absent.mockRejectedValueOnce(new Error(codeId));
    await expect(t.service().cleanOne(scope)).resolves.toEqual({
      status: 'unavailable',
    });
    await expect(t.service().cleanOne(scope)).resolves.toEqual({
      status: 'completed',
    });
  });

  it.each([
    ['Providerが知らないcode', { codeId: operationId, recipientActorId }],
    ['束縛Actorと異なるActor', { codeId, recipientActorId: operationId }],
  ])('%sは空の成功にせず止める', async (_name, target) => {
    const t = await setup();
    await expect(t.service().cleanOne(target)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(t.events).toEqual([]);
  });

  it('列挙の完全性を保証できないProviderでは止める', async () => {
    const t = await setup();
    t.keys.faults.add('scope-page-unavailable');
    await expect(t.service().cleanOne(scope)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(t.events).toEqual([]);
  });

  it('多数のscopeがあるActorでも全Pageから対象を見つける', async () => {
    const t = await setup();
    for (let i = 0; i < 1001; i += 1)
      await t.keys.allocation.allocate({
        codeId: `30000000-0000-4000-8000-1${String(i).padStart(11, '0')}`,
        recipientActorId,
        keyVersion: 'v1',
        expiresAt,
      });
    // 辞書順で全コードより後になり、2Page目にだけ現れる対象。
    const last = '40000000-0000-4000-8000-000000000001';
    await t.keys.allocation.allocate({
      codeId: last,
      recipientActorId,
      keyVersion: 'v1',
      expiresAt,
    });
    await expect(
      t.service().cleanOne({ codeId: last, recipientActorId }),
    ).resolves.toEqual({ status: 'completed' });
  });

  it('完了済みticketに行が戻っていたら除去し、完了件数を増やさない', async () => {
    const t = await setup();
    await t.service().cleanOne(scope);
    t.state.row = true;
    t.events.length = 0;
    await expect(t.service().cleanOne(scope)).resolves.toEqual({
      status: 'already-complete',
    });
    expect(t.events).toEqual(['remove', 'absent']);
    expect(t.state.row).toBe(false);
  });

  it('完了済みticketで行を除去できなければ完了扱いにしない', async () => {
    const t = await setup();
    await t.service().cleanOne(scope);
    t.state.row = true;
    t.remove.mockImplementationOnce(() => Promise.resolve());
    await expect(t.service().cleanOne(scope)).resolves.toEqual({
      status: 'unavailable',
    });
  });
});
