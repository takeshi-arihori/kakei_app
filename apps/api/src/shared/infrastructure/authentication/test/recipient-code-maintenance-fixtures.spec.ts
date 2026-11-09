import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { AuthenticationKeyScope } from '../../../application/authentication/authentication-crypto-keys.js';
import { recipientCodeRetentionWindow } from '../../../application/authentication/authentication-retention-policy.js';
import type {
  RecipientCodeMacKeyClosure,
  RecipientCodeMacKeyLifecyclePort,
} from '../../../application/authentication/recipient-code-key-lifecycle.js';
import { guardRecipientCodeMaintenance } from '../../../application/authentication/recipient-code-maintenance-guard.js';
import type {
  RecipientCodeDestructionTicket,
  RecipientCodeKeyScope,
  RecipientCodeMaintenancePort,
  RecipientCodeScopeCursor,
  RecipientCodeScopePage,
} from '../../../application/authentication/recipient-code-maintenance-ports.js';
import { RecipientCodeUnavailable } from '../../../application/authentication/recipient-code-record.js';
import { syntheticRecipientCodeManagedKeys } from './recipient-code-maintenance-fixtures.js';

const uuid = (kind: number, index: number) =>
  `${String(kind).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`;
const actorA = uuid(1, 1);
const actorB = uuid(1, 2);
const cleanup = uuid(2, 1);
const deletion = uuid(2, 2);
const code = (index: number) => uuid(3, index);
const scopeOf = (
  index: number,
  recipientActorId = actorA,
): RecipientCodeKeyScope => ({ codeId: code(index), recipientActorId });
const windowAt = (dueAt: number) =>
  recipientCodeRetentionWindow({
    expiresAt: dueAt,
    terminalAt: null,
    actorCutoffAt: null,
  });
const expiresAt = 5000;

const setup = (
  overrides: {
    maintenance?: Partial<RecipientCodeMaintenancePort>;
    lifecycle?: Partial<RecipientCodeMacKeyLifecyclePort>;
  } = {},
) => {
  const f = syntheticRecipientCodeManagedKeys();
  const allocate = (
    index: number,
    recipientActorId = actorA,
    keyVersion = 'v1',
  ) =>
    f.allocation.allocate({
      codeId: code(index),
      recipientActorId,
      keyVersion,
      expiresAt,
    });
  const guard = guardRecipientCodeMaintenance({
    maintenance: { ...f.maintenance, ...overrides.maintenance },
    lifecycle: { ...f.lifecycle, ...overrides.lifecycle },
  });
  const prepare = (
    index: number,
    operationId: string,
    dueAt: number,
    expected: RecipientCodeDestructionTicket | null = null,
    recipientActorId = actorA,
  ) =>
    guard.prepare({
      scope: scopeOf(index, recipientActorId),
      operationId,
      window: windowAt(dueAt),
      expected,
    });
  return { f, guard, allocate, prepare };
};
const readAll = async (
  guard: ReturnType<typeof setup>['guard'],
  limit: number,
  recipientActorId: string | null = null,
) => {
  const seen: string[] = [];
  let cursor: RecipientCodeScopeCursor | null = null;
  do {
    const page: Awaited<ReturnType<typeof guard.scopePage>> =
      await guard.scopePage({ cursor, limit, recipientActorId });
    seen.push(...page.scopes.map((scope) => scope.codeId));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return seen;
};
// 未知fieldではなく検証したい条件で拒否されるよう、正しい形のclosureを作る。
const closureFor = (input: {
  readonly codeId: string;
  readonly operationId: string;
  readonly inventoryRevision: string;
}): RecipientCodeMacKeyClosure => ({
  codeId: input.codeId,
  operationId: input.operationId,
  inventoryRevision: input.inventoryRevision,
  evidenceReference: 'evidence',
});
const unavailable = (run: () => Promise<unknown>) =>
  expect(run()).rejects.toBeInstanceOf(RecipientCodeUnavailable);

describe('招待コード保守のscope型', () => {
  it('コードscopeを認証のAuthenticationKeyScopeへ渡せない', () => {
    expectTypeOf<RecipientCodeKeyScope>().not.toExtend<AuthenticationKeyScope>();
    expectTypeOf<AuthenticationKeyScope>().not.toExtend<RecipientCodeKeyScope>();
  });
});

describe('allocateのActor束縛と封鎖（ADR D5）', () => {
  it('束縛Actorまで完全一致するAckを返し、既存世代はcreated=falseで再確認する', async () => {
    const { allocate } = setup();
    const descriptor = {
      codeId: code(1),
      recipientActorId: actorA,
      keyVersion: 'v1',
      expiresAt,
    };
    expect(await allocate(1)).toEqual({
      status: 'allocated',
      created: true,
      ...descriptor,
    });
    expect(await allocate(1)).toEqual({
      status: 'allocated',
      created: false,
      ...descriptor,
    });
  });

  it('同じcodeIdへの別Actorと期限の変更をunavailableにする', async () => {
    const { f, allocate } = setup();
    await allocate(1);
    expect((await allocate(1, actorB)).status).toBe('unavailable');
    expect(
      (
        await f.allocation.allocate({
          codeId: code(1),
          recipientActorId: actorA,
          keyVersion: 'v2',
          expiresAt: expiresAt + 1,
        })
      ).status,
    ).toBe('unavailable');
  });

  it('封鎖後は同一Descriptorの再確認も含めて封鎖Actorだけをunavailableにする', async () => {
    const { guard, allocate } = setup();
    await allocate(1);
    expect(await guard.blockActor(actorA)).toEqual({
      status: 'blocked',
      recipientActorId: actorA,
    });
    expect(await guard.blockActor(actorA)).toEqual({
      status: 'blocked',
      recipientActorId: actorA,
    });
    expect((await allocate(1)).status).toBe('unavailable');
    expect((await allocate(1, actorA, 'v2')).status).toBe('unavailable');
    expect((await allocate(2)).status).toBe('unavailable');
    expect((await allocate(3, actorB)).status).toBe('allocated');
  });

  it('ticket登録済みcodeIdへの追加allocateは再MACを含めてunavailableにし、版を陳腐化させない', async () => {
    const { guard, allocate, prepare } = setup();
    await allocate(1);
    const { ticket } = await prepare(1, cleanup, 1000);
    expect((await allocate(1)).status).toBe('unavailable');
    expect((await allocate(1, actorA, 'v2')).status).toBe('unavailable');
    expect((await guard.find(code(1)))?.inventoryRevision).toBe(
      ticket.inventoryRevision,
    );
    expect((await allocate(2)).status).toBe('allocated');
  });

  it('封鎖と競合したallocateは、受理されたものだけが封鎖後のsnapshotへ必ず入る', async () => {
    const { guard, allocate } = setup();
    const answers = await Promise.all([
      allocate(1),
      allocate(2),
      guard.blockActor(actorA),
      allocate(3),
      allocate(4),
    ]);
    const accepted = [answers[0], answers[1], answers[3], answers[4]].flatMap(
      (answer) => (answer.status === 'allocated' ? [answer.codeId] : []),
    );
    // 封鎖より先に受理された分と、封鎖で拒否された分の両方が実際に生じている。
    expect(accepted).toEqual([code(1), code(2)]);
    expect(await readAll(guard, 10, actorA)).toEqual(accepted);
  });
});

describe('ticketの所有・採用・window（ADR D3）', () => {
  it('作成したticketをfind/pending/byOperation/scopesから同じ内容で読める', async () => {
    const { guard, allocate, prepare } = setup();
    await allocate(1);
    const answer = await prepare(1, cleanup, 1000);
    expect(answer.status).toBe('created');
    expect(answer.ticket).toMatchObject({
      codeId: code(1),
      operationId: cleanup,
      adoptingOperationIds: [],
      version: 1,
      state: 'pending',
      window: { dueAt: 1000, deadline: 86_401_000 },
    });
    expect(await guard.find(code(1))).toEqual(answer.ticket);
    expect(await guard.find(code(9))).toBeNull();
    expect(await guard.pending(10)).toEqual([answer.ticket]);
    expect(await guard.byOperation(cleanup)).toEqual([answer.ticket]);
    expect(await guard.byOperation(deletion)).toEqual([]);
    expect(await guard.scopes(answer.ticket)).toEqual([scopeOf(1)]);
  });

  it('別operationは重複作成せず採用し、byOperationは所有と採用の両方を返す', async () => {
    const { guard, allocate, prepare } = setup();
    await allocate(1);
    const owned = await prepare(1, cleanup, 1000);
    const adopted = await prepare(1, deletion, 2000, owned.ticket);
    expect(adopted.status).toBe('adopted');
    expect(adopted.ticket.operationId).toBe(cleanup);
    expect(adopted.ticket.adoptingOperationIds).toEqual([deletion]);
    expect(await guard.pending(10)).toHaveLength(1);
    expect(await guard.byOperation(deletion)).toEqual([adopted.ticket]);
    expect(await guard.byOperation(cleanup)).toEqual([adopted.ticket]);
  });

  it.each([
    { requested: 500, dueAt: 500, version: 2, name: '早い採用は前倒しする' },
    { requested: 1000, dueAt: 1000, version: 2, name: '等値は窓を変えない' },
    { requested: 2000, dueAt: 1000, version: 2, name: '遅い採用は延長しない' },
  ])('$name', async ({ requested, dueAt, version }) => {
    const { allocate, prepare } = setup();
    await allocate(1);
    const owned = await prepare(1, cleanup, 1000);
    const { ticket } = await prepare(1, deletion, requested, owned.ticket);
    expect(ticket.window).toEqual({ dueAt, deadline: dueAt + 86_400_000 });
    expect(ticket.version).toBe(version);
  });

  it('所有operationの再実行は冪等で、同じ採用も二重記録しない', async () => {
    const { allocate, prepare } = setup();
    await allocate(1);
    const owned = await prepare(1, cleanup, 1000);
    const resumed = await prepare(1, cleanup, 1000, owned.ticket);
    expect(resumed.status).toBe('resumed');
    expect(resumed.ticket).toEqual(owned.ticket);
    const earlier = await prepare(1, cleanup, 900, resumed.ticket);
    expect(earlier.status).toBe('resumed');
    expect(earlier.ticket.version).toBe(2);
    const adopted = await prepare(1, deletion, 800, earlier.ticket);
    const again = await prepare(1, deletion, 800, adopted.ticket);
    expect(again.status).toBe('adopted');
    expect(again.ticket).toEqual(adopted.ticket);
  });

  it('版の古いexpectedと未登録の期待を拒否し、ticketを変更しない', async () => {
    const { guard, allocate, prepare } = setup();
    await allocate(1);
    const owned = await prepare(1, cleanup, 1000);
    const moved = await prepare(1, deletion, 500, owned.ticket);
    await unavailable(() => prepare(1, cleanup, 100, owned.ticket));
    await unavailable(() => prepare(1, cleanup, 100, null));
    await unavailable(() => guard.scopes(owned.ticket));
    expect(await guard.find(code(1))).toEqual(moved.ticket);
  });

  it('expiresAtより後のdueAtはticketを作らず、等値は受理する', async () => {
    const { guard, allocate, prepare } = setup();
    await allocate(1);
    await unavailable(() => prepare(1, cleanup, expiresAt + 1));
    expect(await guard.find(code(1))).toBeNull();
    const { ticket } = await prepare(1, cleanup, expiresAt);
    await unavailable(() => prepare(1, deletion, expiresAt + 1, ticket));
    expect(await guard.find(code(1))).toEqual(ticket);
  });

  it('未知scopeと別Actorのscopeにはticketを作らない', async () => {
    const { guard, allocate, prepare } = setup();
    await allocate(1);
    await unavailable(() => prepare(9, cleanup, 1000));
    await unavailable(() => prepare(1, cleanup, 1000, null, actorB));
    expect(await guard.pending(10)).toEqual([]);
  });

  it('完了済みticketは充足済みとして採用を記録し、再作成も窓の変更もしない', async () => {
    const { guard, allocate, prepare } = setup();
    await allocate(1);
    const { ticket } = await prepare(1, cleanup, 1000);
    const closure = await guard.close(ticket);
    const done = await guard.complete(ticket, closure);
    expect(done).toMatchObject({ state: 'complete', version: 2 });
    const satisfied = await prepare(1, deletion, 500, done);
    expect(satisfied.status).toBe('satisfied');
    expect(satisfied.ticket.window).toEqual(done.window);
    expect(satisfied.ticket.adoptingOperationIds).toEqual([deletion]);
    expect(await guard.pending(10)).toEqual([]);
    expect(await guard.byOperation(deletion)).toEqual([satisfied.ticket]);
    const owner = await prepare(1, cleanup, 500, satisfied.ticket);
    expect(owner.status).toBe('satisfied');
    expect(owner.ticket).toEqual(satisfied.ticket);
  });

  it('pendingはdueAtの早い順で、limitを超えない', async () => {
    const { guard, allocate, prepare } = setup();
    for (const [index, dueAt] of [
      [1, 3000],
      [2, 1000],
      [3, 2000],
    ] as const) {
      await allocate(index);
      await prepare(index, cleanup, dueAt);
    }
    expect((await guard.pending(2)).map((t) => t.codeId)).toEqual([
      code(2),
      code(3),
    ]);
    expect((await guard.pending(1000)).map((t) => t.window.dueAt)).toEqual([
      1000, 2000, 3000,
    ]);
  });
});

describe('完了済みticketのclosure再検証', () => {
  const completed = async () => {
    const { f, guard, allocate } = setup();
    await allocate(1);
    const { ticket } = await guard.prepare({
      scope: scopeOf(1),
      operationId: cleanup,
      window: windowAt(1000),
      expected: null,
    });
    return { f, guard, ticket };
  };
  it('未完了ticketは再検証を拒否する', async () => {
    const { guard, ticket } = await completed();
    await expect(guard.verifyComplete(ticket)).rejects.toBeInstanceOf(
      RecipientCodeUnavailable,
    );
  });
  it('所有operationのclosureを冪等に再検証し、偽closureを拒否する', async () => {
    const { f, guard, ticket } = await completed();
    const done = await guard.complete(ticket, await guard.close(ticket));
    await expect(guard.verifyComplete(done)).resolves.toBeUndefined();
    const forged = guardRecipientCodeMaintenance({
      maintenance: f.maintenance,
      lifecycle: {
        ...f.lifecycle,
        verifyClosure: () => Promise.resolve(false),
      },
    });
    await expect(forged.verifyComplete(done)).rejects.toBeInstanceOf(
      RecipientCodeUnavailable,
    );
  });
});

describe('全世代closureと完了（ADR D3）', () => {
  const prepared = async (
    overrides: Parameters<typeof setup>[0] = {},
    generations = 1,
  ) => {
    const context = setup(overrides);
    for (let index = 1; index <= generations; index += 1)
      await context.allocate(1, actorA, `v${String(index)}`);
    const { ticket } = await context.prepare(1, cleanup, 1000);
    return { ...context, ticket };
  };

  it('採用ticketのclosureも所有operationへ束縛し、全世代の破棄後だけ完了できる', async () => {
    const { f, guard, prepare, ticket } = await prepared({}, 3);
    const adopted = await prepare(1, deletion, 500, ticket);
    const closure = await guard.close(adopted.ticket);
    expect(closure.operationId).toBe(cleanup);
    expect((await f.lifecycle.inventory(code(1))).generations).toEqual(
      ['v1', 'v2', 'v3'].map((keyVersion) => ({
        keyVersion,
        lifecycle: 'destroyed',
      })),
    );
    const done = await guard.complete(adopted.ticket, closure);
    expect(done.state).toBe('complete');
    await expect(
      f.lifecycle.closeAllGenerations({
        codeId: code(1),
        operationId: deletion,
        inventoryRevision: done.inventoryRevision,
        deadlineAt: done.window.deadline,
      }),
    ).rejects.toThrow('synthetic closure binding mismatch');
  });

  const modes = async (
    f: ReturnType<typeof syntheticRecipientCodeManagedKeys>,
  ) =>
    (await f.lifecycle.inventory(code(1))).generations.map(
      (generation) => generation.lifecycle,
    );

  it('部分世代の障害は未完了のまま残り、同operationの再実行で閉じる', async () => {
    const { f, guard, ticket } = await prepared({}, 3);
    f.faults.add('after-destroy-generation');
    await unavailable(() => guard.close(ticket));
    f.faults.delete('after-destroy-generation');
    expect(await modes(f)).toEqual(['destroyed', 'read-only', 'current']);
    expect((await guard.find(code(1)))?.state).toBe('pending');
    const closure = await guard.close(ticket);
    expect(await modes(f)).toEqual(['destroyed', 'destroyed', 'destroyed']);
    expect((await guard.complete(ticket, closure)).state).toBe('complete');
  });

  it('部分世代が残るとverifyClosureがtrueでもcloseとcompleteを拒否する', async () => {
    const complete = vi.fn(() => Promise.reject(new Error('unexpected')));
    const { f, guard, ticket } = await prepared(
      {
        maintenance: { complete },
        lifecycle: {
          closeAllGenerations: (input) => Promise.resolve(closureFor(input)),
          verifyClosure: () => Promise.resolve(true),
        },
      },
      3,
    );
    f.faults.add('after-destroy-generation');
    await expect(
      f.lifecycle.closeAllGenerations({
        codeId: ticket.codeId,
        operationId: ticket.operationId,
        inventoryRevision: ticket.inventoryRevision,
        deadlineAt: ticket.window.deadline,
      }),
    ).rejects.toThrow('synthetic provider fault');
    f.faults.delete('after-destroy-generation');
    expect(await modes(f)).toEqual(['destroyed', 'read-only', 'current']);
    await unavailable(() => guard.close(ticket));
    await unavailable(() => guard.complete(ticket, closureFor(ticket)));
    expect(complete).not.toHaveBeenCalled();
    expect((await guard.find(code(1)))?.state).toBe('pending');
  });

  it('completeは直前にclosureと全世代を再検証し、失敗ならProviderを呼ばない', async () => {
    const complete = vi.fn(() => Promise.reject(new Error('unexpected')));
    let verified = true;
    let mode: 'current' | 'read-only' | 'destroyed' = 'destroyed';
    const { guard, ticket } = await prepared({
      maintenance: { complete },
      lifecycle: {
        verifyClosure: () => Promise.resolve(verified),
        inventory: (codeId) =>
          Promise.resolve({
            codeId,
            inventoryRevision: `${codeId}/revision-1`,
            generations: [{ keyVersion: 'v1', lifecycle: mode }],
          }),
      },
    });
    const closure = await guard.close(ticket);
    verified = false;
    await unavailable(() => guard.complete(ticket, closure));
    verified = true;
    mode = 'current';
    await unavailable(() => guard.complete(ticket, closure));
    mode = 'read-only';
    await unavailable(() => guard.complete(ticket, closure));
    expect(complete).not.toHaveBeenCalled();
  });

  it('採用で版が上がった後の古いticketでは完了できず、最新版なら同じclosureで完了する', async () => {
    const { guard, prepare, ticket } = await prepared();
    const closure = await guard.close(ticket);
    const adopted = await prepare(1, deletion, 500, ticket);
    await unavailable(() => guard.complete(ticket, closure));
    expect((await guard.find(code(1)))?.state).toBe('pending');
    expect((await guard.complete(adopted.ticket, closure)).version).toBe(3);
  });

  it.each<[string, Partial<RecipientCodeDestructionTicket>]>([
    ['版の飛越し', { version: 3 }],
    ['版の据置き', { version: 1 }],
    ['窓の変更', { window: windowAt(500) }],
    ['全世代版の差替え', { inventoryRevision: 'other' }],
    ['所有operationの差替え', { operationId: deletion }],
    ['採用の追加', { adoptingOperationIds: [deletion] }],
  ])('completeの応答の%sを拒否する', async (_name, fields) => {
    const { guard, ticket } = await prepared({
      maintenance: {
        complete: ({ ticket: current }) =>
          Promise.resolve({
            ...current,
            version: current.version + 1,
            state: 'complete' as const,
            ...fields,
          }),
      },
    });
    const closure = await guard.close(ticket);
    await unavailable(() => guard.complete(ticket, closure));
  });

  it('prepareとcompleteの応答喪失後はfindから再開し、重複も再完了も生じない', async () => {
    const { f, guard, allocate, prepare } = setup();
    await allocate(1);
    f.faults.add('after-prepare');
    await unavailable(() => prepare(1, cleanup, 1000));
    f.faults.delete('after-prepare');
    await unavailable(() => prepare(1, cleanup, 1000));
    const found = await guard.find(code(1));
    const resumed = await prepare(1, cleanup, 1000, found);
    expect(resumed.status).toBe('resumed');
    expect(resumed.ticket).toEqual(found);
    expect(await guard.pending(10)).toHaveLength(1);

    const closure = await guard.close(resumed.ticket);
    f.faults.add('after-complete');
    await unavailable(() => guard.complete(resumed.ticket, closure));
    f.faults.delete('after-complete');
    const done = await guard.find(code(1));
    expect(done?.state).toBe('complete');
    expect(await guard.pending(10)).toEqual([]);
    await unavailable(() => guard.complete(resumed.ticket, closure));
    expect((await prepare(1, cleanup, 1000, done)).status).toBe('satisfied');
  });

  it('closeの応答喪失後も同operationで同じclosureへ収束する', async () => {
    const { f, guard, ticket } = await prepared();
    f.faults.add('after-close');
    await unavailable(() => guard.close(ticket));
    f.faults.delete('after-close');
    const closure = await guard.close(ticket);
    expect(await f.lifecycle.verifyClosure(closure)).toBe(true);
  });

  it.each<
    [
      string,
      (closure: RecipientCodeMacKeyClosure) => RecipientCodeMacKeyClosure,
    ]
  >([
    ['別code', (closure) => ({ ...closure, codeId: code(2) })],
    ['採用側operation', (closure) => ({ ...closure, operationId: deletion })],
    ['別版', (closure) => ({ ...closure, inventoryRevision: 'other' })],
    ['空の証跡', (closure) => ({ ...closure, evidenceReference: '' })],
    ['偽の証跡', (closure) => ({ ...closure, evidenceReference: 'forged' })],
    [
      '未知field',
      (closure) => ({ ...closure, extra: true }) as RecipientCodeMacKeyClosure,
    ],
  ])('completeは%sのclosureを拒否する', async (_name, forge) => {
    const { guard, ticket } = await prepared();
    const closure = await guard.close(ticket);
    await unavailable(() => guard.complete(ticket, forge(closure)));
    expect((await guard.find(code(1)))?.state).toBe('pending');
  });

  it('未完了を完了と偽る応答、完了済みticketの再完了と再closeを拒否する', async () => {
    const lying = await prepared({
      maintenance: {
        complete: ({ ticket }) => Promise.resolve({ ...ticket }),
      },
    });
    const closure = await lying.guard.close(lying.ticket);
    await unavailable(() => lying.guard.complete(lying.ticket, closure));

    const { guard, ticket } = await prepared();
    const real = await guard.close(ticket);
    const done = await guard.complete(ticket, real);
    await unavailable(() => guard.complete(done, real));
    await unavailable(() => guard.close(done));
  });

  it.each<[string, Partial<RecipientCodeMacKeyLifecyclePort>]>([
    ['verifyClosureがfalse', { verifyClosure: () => Promise.resolve(false) }],
    [
      'verifyClosureが真偽値でない',
      { verifyClosure: () => Promise.resolve('true' as unknown as boolean) },
    ],
    [
      'closureのoperationが採用側',
      {
        closeAllGenerations: (input) =>
          Promise.resolve({ ...closureFor(input), operationId: deletion }),
      },
    ],
    [
      'closureが別code',
      {
        closeAllGenerations: (input) =>
          Promise.resolve({ ...closureFor(input), codeId: code(2) }),
      },
    ],
  ])('closeは%sのときclosureを返さない', async (_name, lifecycle) => {
    const { guard, ticket } = await prepared({ lifecycle });
    await unavailable(() => guard.close(ticket));
  });

  it.each<[string, Partial<RecipientCodeMacKeyLifecyclePort>]>([
    [
      '全世代版がticketと不一致',
      {
        inventory: (codeId) =>
          Promise.resolve({
            codeId,
            inventoryRevision: 'other',
            generations: [{ keyVersion: 'v1', lifecycle: 'current' as const }],
          }),
      },
    ],
    [
      '全世代が空',
      {
        inventory: (codeId) =>
          Promise.resolve({
            codeId,
            inventoryRevision: `${codeId}/revision-1`,
            generations: [],
          }),
      },
    ],
    [
      'inventoryが別code',
      {
        inventory: () =>
          Promise.resolve({
            codeId: code(2),
            inventoryRevision: `${code(1)}/revision-1`,
            generations: [{ keyVersion: 'v1', lifecycle: 'current' as const }],
          }),
      },
    ],
    [
      'lifecycleが未知',
      {
        inventory: (codeId) =>
          Promise.resolve({
            codeId,
            inventoryRevision: `${codeId}/revision-1`,
            generations: [
              { keyVersion: 'v1', lifecycle: 'unknown' as 'current' },
            ],
          }),
      },
    ],
  ])('%sなら破棄の前に停止し、鍵を破棄しない', async (_name, lifecycle) => {
    const { f, guard, ticket } = await prepared({ lifecycle });
    await unavailable(() => guard.close(ticket));
    expect(
      (await f.lifecycle.inventory(code(1))).generations.map(
        (generation) => generation.lifecycle,
      ),
    ).toEqual(['current']);
  });
});

describe('孤立scopeの固定snapshot列挙（ADR D4）', () => {
  it('行のない孤立scopeを含め、固定snapshotを欠落も重複もなく読める', async () => {
    const { f, guard, allocate } = setup();
    f.faults.add('after-allocate');
    await expect(allocate(1)).rejects.toThrow('synthetic provider fault');
    f.faults.delete('after-allocate');
    await allocate(2);
    await allocate(3, actorB);
    const first = await guard.scopePage({
      cursor: null,
      limit: 2,
      recipientActorId: null,
    });
    expect(first.scopes[0]).toEqual({
      ...scopeOf(1),
      expiresAt,
      inventoryRevision: `${code(1)}/revision-1`,
    });
    expect(first.total).toBe(3);
    // 固定snapshotの続きは、読取中のallocateで変わらない。
    await allocate(4);
    const second = await guard.scopePage({
      cursor: first.nextCursor,
      limit: 2,
      recipientActorId: null,
    });
    expect(second.scopes.map((scope) => scope.codeId)).toEqual([code(3)]);
    expect(second.nextCursor).toBeNull();
    expect(await readAll(guard, 1)).toEqual([1, 2, 3, 4].map(code));
    expect(await readAll(guard, 2, actorB)).toEqual([code(3)]);
  });

  it('scopeがない場合だけ、保証付きの空snapshotを返す', async () => {
    const { guard } = setup();
    expect(
      await guard.scopePage({
        cursor: null,
        limit: 10,
        recipientActorId: null,
      }),
    ).toEqual({ scopes: [], total: 0, nextCursor: null });
  });

  it('完全列挙を保証できないProviderの応答を空成功にしない', async () => {
    const { f, guard, allocate } = setup();
    await allocate(1);
    f.faults.add('scope-page-unavailable');
    await unavailable(() =>
      guard.scopePage({ cursor: null, limit: 10, recipientActorId: null }),
    );
  });

  it('破棄済みscopeも列挙し、採用した削除operationのticket集合と一致を確認できる', async () => {
    const { guard, allocate, prepare } = setup();
    await allocate(1);
    await allocate(2);
    const { ticket } = await prepare(1, cleanup, 1000);
    await guard.complete(ticket, await guard.close(ticket));
    await guard.blockActor(actorA);
    const snapshot = await readAll(guard, 10, actorA);
    for (const [index, codeId] of snapshot.entries())
      await prepare(index + 1, deletion, 2000, await guard.find(codeId));
    const tickets = await guard.byOperation(deletion);
    expect(tickets.map((t) => t.codeId).sort()).toEqual(snapshot);
    expect(await readAll(guard, 10, actorA)).toEqual(snapshot);
  });

  const cursor = Object.freeze(Object.create(null)) as RecipientCodeScopeCursor;
  const row = (index: number, recipientActorId: unknown = actorA) => ({
    codeId: code(index),
    recipientActorId: recipientActorId as string,
    expiresAt,
    inventoryRevision: 'r1',
  });
  it.each<
    [string, Awaited<ReturnType<RecipientCodeMaintenancePort['scopePage']>>]
  >([
    [
      '完全性を保証しないstatusの空Page',
      {
        status: 'unavailable',
        scopes: [],
        total: 0,
        nextCursor: null,
      } as unknown as RecipientCodeScopePage,
    ],
    [
      '件数不足で読了と主張',
      { status: 'snapshot', scopes: [row(1)], total: 2, nextCursor: null },
    ],
    [
      '空Pageで続きを主張',
      { status: 'snapshot', scopes: [], total: 1, nextCursor: cursor },
    ],
    [
      '空で件数ありを主張',
      { status: 'snapshot', scopes: [], total: 1, nextCursor: null },
    ],
    [
      '全件読了でも続きを主張',
      { status: 'snapshot', scopes: [row(1)], total: 1, nextCursor: cursor },
    ],
    [
      'Page内の重複',
      {
        status: 'snapshot',
        scopes: [row(1), row(1)],
        total: 1,
        nextCursor: null,
      },
    ],
    [
      'limit超過',
      {
        status: 'snapshot',
        scopes: [row(1), row(2), row(3)],
        total: 3,
        nextCursor: null,
      },
    ],
    [
      '束縛Actorのない未知scope',
      {
        status: 'snapshot',
        scopes: [row(1, null)],
        total: 1,
        nextCursor: null,
      },
    ],
    [
      '形式不正のActor',
      {
        status: 'snapshot',
        scopes: [row(1, 'not-a-uuid')],
        total: 1,
        nextCursor: null,
      },
    ],
    [
      '未知field',
      {
        status: 'snapshot',
        scopes: [{ ...row(1), extra: 1 } as ReturnType<typeof row>],
        total: 1,
        nextCursor: null,
      },
    ],
    [
      '負の期限',
      {
        status: 'snapshot',
        scopes: [{ ...row(1), expiresAt: -1 }],
        total: 1,
        nextCursor: null,
      },
    ],
    [
      '全件数が不正',
      { status: 'snapshot', scopes: [], total: -1, nextCursor: null },
    ],
  ])('列挙の%sを拒否する', async (_name, page) => {
    const { guard } = setup({
      maintenance: { scopePage: () => Promise.resolve(page) },
    });
    await unavailable(() =>
      guard.scopePage({ cursor: null, limit: 2, recipientActorId: null }),
    );
  });

  it('続きPageの件数変化・Page間の重複・Actor条件違反を拒否する', async () => {
    const pages = (
      second: Awaited<ReturnType<RecipientCodeMaintenancePort['scopePage']>>,
    ) => {
      let call = 0;
      return setup({
        maintenance: {
          scopePage: () =>
            Promise.resolve(
              call++ === 0
                ? {
                    status: 'snapshot' as const,
                    scopes: [row(1)],
                    total: 2,
                    nextCursor: cursor,
                  }
                : second,
            ),
        },
      }).guard;
    };
    const walk = async (guard: ReturnType<typeof pages>) => {
      const first = await guard.scopePage({
        cursor: null,
        limit: 2,
        recipientActorId: null,
      });
      return guard.scopePage({
        cursor: first.nextCursor,
        limit: 2,
        recipientActorId: null,
      });
    };
    await unavailable(() =>
      walk(
        pages({
          status: 'snapshot',
          scopes: [row(2), row(3)],
          total: 3,
          nextCursor: null,
        }),
      ),
    );
    await unavailable(() =>
      walk(
        pages({
          status: 'snapshot',
          scopes: [row(1), row(2)],
          total: 2,
          nextCursor: null,
        }),
      ),
    );
    const { guard } = setup({
      maintenance: {
        scopePage: () =>
          Promise.resolve({
            status: 'snapshot' as const,
            scopes: [row(1, actorB)],
            total: 1,
            nextCursor: null,
          }),
      },
    });
    await unavailable(() =>
      guard.scopePage({ cursor: null, limit: 2, recipientActorId: actorA }),
    );
  });

  it('Providerが受理しても、別のActor条件とこのguardが発行していないcursorを拒否する', async () => {
    let call = 0;
    const { guard } = setup({
      maintenance: {
        // Provider側のcursor検証に頼らず、guard自身の検証だけを確かめる。
        scopePage: () =>
          Promise.resolve({
            status: 'snapshot' as const,
            scopes: [row(++call)],
            total: 2,
            nextCursor: call === 1 ? cursor : null,
          }),
      },
    });
    const first = await guard.scopePage({
      cursor: null,
      limit: 1,
      recipientActorId: null,
    });
    await unavailable(() =>
      guard.scopePage({
        cursor: first.nextCursor,
        limit: 1,
        recipientActorId: actorA,
      }),
    );
    await unavailable(() =>
      guard.scopePage({
        cursor: Object.freeze(Object.create(null)) as RecipientCodeScopeCursor,
        limit: 1,
        recipientActorId: null,
      }),
    );
    expect(call).toBe(1);
    await guard.scopePage({
      cursor: first.nextCursor,
      limit: 1,
      recipientActorId: null,
    });
  });
});

describe('応答検証guard', () => {
  const ticket = (
    overrides: Partial<RecipientCodeDestructionTicket> = {},
  ): RecipientCodeDestructionTicket => ({
    codeId: code(1),
    operationId: cleanup,
    adoptingOperationIds: [],
    version: 1,
    inventoryRevision: 'r1',
    window: windowAt(1000),
    state: 'pending',
    ...overrides,
  });

  it.each<[string, RecipientCodeMaintenancePort['prepare']]>([
    [
      'createdが別operation',
      () =>
        Promise.resolve({
          status: 'created',
          ticket: ticket({ operationId: deletion }),
        }),
    ],
    [
      'createdが別code',
      () =>
        Promise.resolve({
          status: 'created',
          ticket: ticket({ codeId: code(2) }),
        }),
    ],
    [
      'createdの版が1でない',
      () =>
        Promise.resolve({ status: 'created', ticket: ticket({ version: 2 }) }),
    ],
    [
      'createdの窓が要求と違う',
      () =>
        Promise.resolve({
          status: 'created',
          ticket: ticket({ window: windowAt(2000) }),
        }),
    ],
    [
      '期待がnullなのにadopted',
      () => Promise.resolve({ status: 'adopted', ticket: ticket() }),
    ],
    [
      'deadlineがdueAt+24hでない',
      () =>
        Promise.resolve({
          status: 'created',
          ticket: ticket({ window: { dueAt: 1000, deadline: 1001 } }),
        }),
    ],
    [
      '未完了以外で作成',
      () =>
        Promise.resolve({
          status: 'created',
          ticket: ticket({ state: 'complete' }),
        }),
    ],
    [
      '未知field',
      () =>
        Promise.resolve({
          status: 'created',
          ticket: {
            ...ticket(),
            extra: 1,
          } as RecipientCodeDestructionTicket,
        }),
    ],
  ])('prepareの%sを拒否する', async (_name, prepare) => {
    const { guard } = setup({ maintenance: { prepare } });
    await unavailable(() =>
      guard.prepare({
        scope: scopeOf(1),
        operationId: cleanup,
        window: windowAt(1000),
        expected: null,
      }),
    );
  });

  it.each<
    [string, Partial<RecipientCodeDestructionTicket> & { status?: string }]
  >([
    ['窓の延長', { window: windowAt(1500) }],
    ['前倒しで版を上げない', { version: 1 }],
    ['版の飛越し', { version: 3 }],
    [
      '所有operationと採用operationの入替え',
      { operationId: deletion, adoptingOperationIds: [cleanup] },
    ],
    ['全世代版の差替え', { inventoryRevision: 'r2' }],
    ['採用の欠落', { adoptingOperationIds: [] }],
    ['結果の種別違い', { status: 'resumed' }],
  ])('採用時の%sを拒否する', async (_name, { status, ...fields }) => {
    const expected = ticket();
    const { guard } = setup({
      maintenance: {
        prepare: () =>
          Promise.resolve({
            status: (status ?? 'adopted') as 'adopted',
            ticket: {
              ...expected,
              adoptingOperationIds: [deletion],
              version: 2,
              window: windowAt(500),
              ...fields,
            },
          }),
      },
    });
    await unavailable(() =>
      guard.prepare({
        scope: scopeOf(1),
        operationId: deletion,
        window: windowAt(500),
        expected,
      }),
    );
  });

  it('完了済みticketの窓を動かすsatisfiedを拒否する', async () => {
    const done = ticket({ state: 'complete', version: 2 });
    const { guard } = setup({
      maintenance: {
        prepare: () =>
          Promise.resolve({
            status: 'satisfied',
            ticket: {
              ...done,
              adoptingOperationIds: [deletion],
              version: 3,
              window: windowAt(500),
            },
          }),
      },
    });
    await unavailable(() =>
      guard.prepare({
        scope: scopeOf(1),
        operationId: deletion,
        window: windowAt(500),
        expected: done,
      }),
    );
  });

  it('別codeのexpectedはProviderを呼ばずに拒否する', async () => {
    const done = ticket({ state: 'complete', version: 2 });
    let called = false;
    const { guard } = setup({
      maintenance: {
        prepare: () => {
          called = true;
          return Promise.reject(new Error('unexpected'));
        },
      },
    });
    await unavailable(() =>
      guard.prepare({
        scope: scopeOf(2),
        operationId: deletion,
        window: windowAt(500),
        expected: done,
      }),
    );
    expect(called).toBe(false);
  });

  it.each<
    [string, () => Parameters<ReturnType<typeof setup>['guard']['prepare']>[0]]
  >([
    [
      'scopeのcodeId形式',
      () => ({
        scope: { codeId: 'x', recipientActorId: actorA },
        operationId: cleanup,
        window: windowAt(1),
        expected: null,
      }),
    ],
    [
      'scopeのActor形式',
      () => ({
        scope: { codeId: code(1), recipientActorId: 'x' },
        operationId: cleanup,
        window: windowAt(1),
        expected: null,
      }),
    ],
    [
      'operation形式',
      () => ({
        scope: scopeOf(1),
        operationId: 'x',
        window: windowAt(1),
        expected: null,
      }),
    ],
    [
      'deadlineがdueAt+24hでない窓',
      () => ({
        scope: scopeOf(1),
        operationId: cleanup,
        window: { dueAt: 1, deadline: 2 },
        expected: null,
      }),
    ],
  ])(
    'prepare前に%sの入力を拒否してProviderを呼ばない',
    async (_name, input) => {
      let called = false;
      const { guard } = setup({
        maintenance: {
          prepare: () => {
            called = true;
            return Promise.reject(new Error('unexpected'));
          },
        },
      });
      await unavailable(() => guard.prepare(input()));
      expect(called).toBe(false);
    },
  );

  it.each<
    [string, Partial<RecipientCodeMaintenancePort>, () => Promise<unknown>]
  >([
    [
      'findの別code',
      { find: () => Promise.resolve(ticket({ codeId: code(2) })) },
      () => Promise.resolve(code(1)),
    ],
    [
      'pendingの完了済み',
      { pending: () => Promise.resolve([ticket({ state: 'complete' })]) },
      () => Promise.resolve(10),
    ],
    [
      'pendingの重複',
      { pending: () => Promise.resolve([ticket(), ticket()]) },
      () => Promise.resolve(10),
    ],
    [
      'pendingの並び順',
      {
        pending: () =>
          Promise.resolve([
            ticket({ window: windowAt(2000) }),
            ticket({ codeId: code(2), window: windowAt(1000) }),
          ]),
      },
      () => Promise.resolve(10),
    ],
    [
      'pendingのlimit超過',
      {
        pending: () => Promise.resolve([ticket(), ticket({ codeId: code(2) })]),
      },
      () => Promise.resolve(1),
    ],
    [
      'byOperationの無関係なticket',
      { byOperation: () => Promise.resolve([ticket()]) },
      () => Promise.resolve(deletion),
    ],
    [
      'byOperationの重複',
      { byOperation: () => Promise.resolve([ticket(), ticket()]) },
      () => Promise.resolve(cleanup),
    ],
    [
      'scopesの空',
      { scopes: () => Promise.resolve([]) },
      () => Promise.resolve(ticket()),
    ],
    [
      'scopesの複数',
      { scopes: () => Promise.resolve([scopeOf(1), scopeOf(2)]) },
      () => Promise.resolve(ticket()),
    ],
    [
      'scopesの別code',
      { scopes: () => Promise.resolve([scopeOf(2)]) },
      () => Promise.resolve(ticket()),
    ],
    [
      'scopesの未知field',
      {
        scopes: () =>
          Promise.resolve([
            { ...scopeOf(1), extra: 1 } as RecipientCodeKeyScope,
          ]),
      },
      () => Promise.resolve(ticket()),
    ],
    [
      'scopesの形式不正のActor',
      {
        scopes: () =>
          Promise.resolve([{ codeId: code(1), recipientActorId: 'x' }]),
      },
      () => Promise.resolve(ticket()),
    ],
    [
      'blockActorのstatus違い',
      {
        blockActor: () =>
          Promise.resolve({
            status: 'other' as 'blocked',
            recipientActorId: actorA,
          }),
      },
      () => Promise.resolve(actorA),
    ],
    [
      'blockActorの別Actor',
      {
        blockActor: () =>
          Promise.resolve({
            status: 'blocked' as const,
            recipientActorId: actorB,
          }),
      },
      () => Promise.resolve(actorA),
    ],
  ])('%sを拒否する', async (name, maintenance, argument) => {
    const { guard } = setup({ maintenance });
    const value = await argument();
    await unavailable(() => {
      if (name.startsWith('find')) return guard.find(value as string);
      if (name.startsWith('pending')) return guard.pending(value as number);
      if (name.startsWith('byOperation'))
        return guard.byOperation(value as string);
      if (name.startsWith('scopes'))
        return guard.scopes(value as RecipientCodeDestructionTicket);
      return guard.blockActor(value as string);
    });
  });

  it.each([0, 1001, 1.5])(
    'limit %sをProviderへ渡さず拒否する',
    async (limit) => {
      const pending = vi.fn(() => Promise.resolve([]));
      const scopePage = vi.fn(() =>
        Promise.resolve({ status: 'unavailable' as const }),
      );
      const { guard } = setup({ maintenance: { pending, scopePage } });
      await unavailable(() => guard.pending(limit));
      await unavailable(() =>
        guard.scopePage({ cursor: null, limit, recipientActorId: null }),
      );
      expect(pending).not.toHaveBeenCalled();
      expect(scopePage).not.toHaveBeenCalled();
    },
  );

  it('形式不正のIDをProviderへ渡さず拒否する', async () => {
    const spy = vi.fn(() => Promise.reject(new Error('unexpected')));
    const { guard } = setup({
      maintenance: {
        blockActor: spy,
        find: spy,
        byOperation: spy,
        scopePage: spy,
      },
    });
    await unavailable(() => guard.blockActor('x'));
    await unavailable(() => guard.find('x'));
    await unavailable(() => guard.byOperation('x'));
    await unavailable(() =>
      guard.scopePage({ cursor: null, limit: 1, recipientActorId: 'x' }),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ['版が0', { version: 0 }],
    ['版が小数', { version: 1.5 }],
    ['未知のstate', { state: 'unknown' }],
    ['採用の重複', { adoptingOperationIds: [deletion, deletion] }],
    ['所有者の採用', { adoptingOperationIds: [cleanup] }],
    ['採用が配列でない', { adoptingOperationIds: deletion }],
    ['形式不正のoperation', { operationId: 'x' }],
    ['空の全世代版', { inventoryRevision: '' }],
    ['前後に空白のある全世代版', { inventoryRevision: ' r1' }],
    ['窓の欠落', { window: null }],
  ])('読取経路で%sのticketを拒否する', async (_name, fields) => {
    const broken = { ...ticket(), ...fields };
    const { guard } = setup({
      maintenance: {
        find: () => Promise.resolve(broken),
        byOperation: () => Promise.resolve([broken]),
      },
    });
    await unavailable(() => guard.find(code(1)));
    await unavailable(() => guard.byOperation(cleanup));
  });

  it.each([
    ['block-actor', 'blockActor'],
    ['scope-page', 'scopePage'],
    ['before-prepare', 'prepare'],
    ['after-prepare', 'prepare'],
    ['find', 'find'],
    ['pending', 'pending'],
    ['by-operation', 'byOperation'],
    ['scopes', 'scopes'],
    ['inventory', 'close'],
    ['before-close', 'close'],
    ['verify-closure', 'close'],
    ['before-complete', 'complete'],
    ['after-complete', 'complete'],
  ])(
    'Provider障害%sを入力や原因を含まない固定失敗にする（%s）',
    async (point, method) => {
      const { f, guard, allocate, prepare } = setup();
      await allocate(1);
      const { ticket: current } = await prepare(1, cleanup, 1000);
      const closure = await guard.close(current);
      f.faults.add(point);
      const calls: Record<string, () => Promise<unknown>> = {
        blockActor: () => guard.blockActor(actorA),
        scopePage: () =>
          guard.scopePage({ cursor: null, limit: 1, recipientActorId: null }),
        prepare: () => prepare(1, deletion, 1000, current),
        find: () => guard.find(code(1)),
        pending: () => guard.pending(1),
        byOperation: () => guard.byOperation(cleanup),
        scopes: () => guard.scopes(current),
        close: () => guard.close(current),
        complete: () => guard.complete(current, closure),
      };
      const failure = await calls[method]().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RecipientCodeUnavailable);
      expect((failure as Error).message).toBe('Recipient code unavailable');
      expect((failure as Error).cause).toBeUndefined();
    },
  );

  it('返すticketとscopeを凍結する', async () => {
    const { guard, allocate, prepare } = setup();
    await allocate(1);
    const { ticket: current } = await prepare(1, cleanup, 1000);
    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.isFrozen(current.window)).toBe(true);
    expect(Object.isFrozen(current.adoptingOperationIds)).toBe(true);
    expect(Object.isFrozen((await guard.scopes(current))[0])).toBe(true);
  });
});
