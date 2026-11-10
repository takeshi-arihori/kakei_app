import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { syntheticRecipientCodeManagedKeys } from '../../infrastructure/authentication/test/recipient-code-maintenance-fixtures.js';
import {
  createRecipientCodeActorDeletion,
  type RecipientCodeDeletionDatabase,
  type RecipientCodeDeletionObserver,
} from './recipient-code-actor-deletion.js';
import { guardRecipientCodeMaintenance } from './recipient-code-maintenance-guard.js';
import { RecipientCodeUnavailable } from './recipient-code-record.js';

const day = 86_400_000;
const preparedAt = 1_000_000;
const expiresAt = preparedAt + 600_000;
const operationId = randomUUID();
const actorId = randomUUID();
const window = (dueAt: number) => ({ dueAt, deadline: dueAt + day });

describe('Actor削除へのコードticket参加', () => {
  let keys: ReturnType<typeof syntheticRecipientCodeManagedKeys>;
  let database: {
    [K in keyof RecipientCodeDeletionDatabase]: Mock<
      RecipientCodeDeletionDatabase[K]
    >;
  };
  let observer: {
    [K in keyof RecipientCodeDeletionObserver]: Mock<
      RecipientCodeDeletionObserver[K]
    >;
  };
  const input = { operationId, actorId, preparedAt };
  const service = () =>
    createRecipientCodeActorDeletion({
      maintenance: guardRecipientCodeMaintenance(keys),
      database,
    });
  const allocate = async (
    codeId = randomUUID(),
    recipientActorId = actorId,
    keyVersion = 'v1',
    expires = expiresAt,
  ) => {
    await keys.allocation.allocate({
      codeId,
      recipientActorId,
      keyVersion,
      expiresAt: expires,
    });
    return codeId;
  };
  const lifecycles = async (codeId: string) =>
    (await keys.lifecycle.inventory(codeId)).generations.map(
      (generation) => generation.lifecycle,
    );
  const register = () => service().register(input, observer);
  const finish = () => service().finish(input, observer);
  const unavailable = (work: Promise<unknown>) =>
    expect(work).rejects.toBeInstanceOf(RecipientCodeUnavailable);

  beforeEach(() => {
    keys = syntheticRecipientCodeManagedKeys();
    database = {
      inspect: vi.fn(() =>
        Promise.resolve({
          status: 'read' as const,
          disabledAt: null,
          terminalAt: null,
          integrity: 'valid' as const,
        }),
      ),
      remove: vi.fn(() => Promise.resolve('removed' as const)),
      absent: vi.fn(() => Promise.resolve(true)),
      actorAbsent: vi.fn(() => Promise.resolve(true)),
    };
    observer = {
      window: vi.fn(() => Promise.resolve()),
      integrity: vi.fn(() => Promise.resolve()),
    };
  });

  describe('register', () => {
    it('対象Actorの新規allocateを列挙より先に封鎖する', async () => {
      const order: string[] = [];
      const blockActor = keys.maintenance.blockActor.bind(keys.maintenance);
      const scopePage = keys.maintenance.scopePage.bind(keys.maintenance);
      keys.maintenance.blockActor = (id) => {
        order.push('block');
        return blockActor(id);
      };
      keys.maintenance.scopePage = (query) => {
        order.push('snapshot');
        return scopePage(query);
      };
      await register();
      expect(order).toEqual(['block', 'snapshot']);
      await expect(
        keys.allocation.allocate({
          codeId: randomUUID(),
          recipientActorId: actorId,
          keyVersion: 'v1',
          expiresAt,
        }),
      ).resolves.toEqual({ status: 'unavailable' });
    });

    it('対象Actorのscopeだけにticketを登録し、別Actorのコードに触れない', async () => {
      const code = await allocate();
      const other = await allocate(randomUUID(), randomUUID());
      await register();
      expect(await keys.maintenance.find(code)).toMatchObject({
        operationId,
        state: 'pending',
        window: window(preparedAt),
      });
      expect(await keys.maintenance.find(other)).toBeNull();
    });

    it('1000件を超えるPageも全件にticketを登録する', async () => {
      const codes = await Promise.all(
        Array.from({ length: 1001 }, () => allocate()),
      );
      await register();
      const tickets = await keys.maintenance.byOperation(operationId);
      expect(tickets.map((t) => t.codeId).sort()).toEqual([...codes].sort());
    });

    it('dueAtはコード期限・終端・preparedAtの最早で、Actor無効化時刻を使わない', async () => {
      const expired = await allocate(
        randomUUID(),
        actorId,
        'v1',
        preparedAt - 2000,
      );
      const terminal = await allocate();
      const later = await allocate();
      database.inspect.mockImplementation(({ codeId }: { codeId: string }) =>
        Promise.resolve({
          status: 'read' as const,
          disabledAt: preparedAt - 9000,
          terminalAt: codeId === terminal ? preparedAt - 1000 : null,
          integrity: 'valid' as const,
        }),
      );
      await register();
      const dueOf = async (id: string) =>
        (await keys.maintenance.find(id))?.window;
      expect(await dueOf(expired)).toEqual(window(preparedAt - 2000));
      expect(await dueOf(terminal)).toEqual(window(preparedAt - 1000));
      expect(await dueOf(later)).toEqual(window(preparedAt));
    });

    it('Lock確認の前に渡す窓もpreparedAtを上限にする', async () => {
      await allocate();
      database.inspect.mockRejectedValue(new RecipientCodeUnavailable());
      await unavailable(register());
      expect(observer.window.mock.calls).toEqual([[window(preparedAt)]]);
    });

    it('照合できなかった値を起算へ使わず、observerへ渡す', async () => {
      const code = await allocate();
      database.inspect.mockResolvedValue({
        status: 'read',
        disabledAt: null,
        terminalAt: null,
        integrity: 'mismatch',
      });
      await register();
      expect(observer.integrity).toHaveBeenCalledWith('mismatch');
      expect((await keys.maintenance.find(code))?.window).toEqual(
        window(preparedAt),
      );
    });

    it('照合結果がvalidならobserverのintegrityを呼ばない', async () => {
      await allocate();
      await register();
      expect(observer.integrity).not.toHaveBeenCalled();
    });

    it('Providerが保持する期限の未達を、Lock確認より先にobserverへ渡す', async () => {
      await allocate(randomUUID(), actorId, 'v1', preparedAt - 2000);
      database.inspect.mockRejectedValue(new RecipientCodeUnavailable());
      await unavailable(register());
      expect(observer.window).toHaveBeenCalledWith(window(preparedAt - 2000));
    });

    it('コード行がLock中ならticketを登録せず止まる', async () => {
      const code = await allocate();
      database.inspect.mockResolvedValue({ status: 'locked' });
      await unavailable(register());
      expect(await keys.maintenance.find(code)).toBeNull();
    });

    it('別operationの未完了ticketを採用し、窓を前倒しのみする', async () => {
      const code = await allocate();
      const cleanup = randomUUID();
      await keys.maintenance.prepare({
        scope: { codeId: code, recipientActorId: actorId },
        operationId: cleanup,
        window: window(expiresAt),
        expected: null,
      });
      await register();
      const adopted = await keys.maintenance.find(code);
      expect(adopted).toMatchObject({
        operationId: cleanup,
        adoptingOperationIds: [operationId],
        version: 2,
        window: window(preparedAt),
      });
      expect(
        (await keys.maintenance.byOperation(operationId)).map((t) => t.codeId),
      ).toEqual([code]);
      expect(observer.window).toHaveBeenCalledWith(window(preparedAt));
    });

    it('別operationの窓が早ければ延長せず、その窓をobserverへ渡す', async () => {
      const code = await allocate();
      await keys.maintenance.prepare({
        scope: { codeId: code, recipientActorId: actorId },
        operationId: randomUUID(),
        window: window(preparedAt - 5000),
        expected: null,
      });
      await register();
      expect((await keys.maintenance.find(code))?.window).toEqual(
        window(preparedAt - 5000),
      );
      expect(observer.window).toHaveBeenCalledWith(window(preparedAt - 5000));
    });

    it('1件の登録に失敗しても残りを登録してから止まる', async () => {
      const codes = [await allocate(), await allocate()].sort();
      database.inspect.mockImplementationOnce(() =>
        Promise.reject(new RecipientCodeUnavailable()),
      );
      await unavailable(register());
      expect(await keys.maintenance.find(codes[0])).toBeNull();
      expect((await keys.maintenance.find(codes[1]))?.state).toBe('pending');
    });

    it('再実行しても二重ticketや追加の版上げを作らない', async () => {
      const code = await allocate();
      await register();
      const first = await keys.maintenance.find(code);
      await register();
      expect(await keys.maintenance.find(code)).toEqual(first);
      expect(await keys.maintenance.byOperation(operationId)).toHaveLength(1);
    });

    it('途中で落ちても再実行が不足分だけを登録する', async () => {
      const codes = [await allocate(), await allocate()].sort();
      const prepare = keys.maintenance.prepare.bind(keys.maintenance);
      let calls = 0;
      keys.maintenance.prepare = (request) => {
        calls += 1;
        return calls === 2
          ? Promise.reject(new Error('synthetic'))
          : prepare(request);
      };
      await unavailable(register());
      keys.maintenance.prepare = prepare;
      await register();
      expect(
        (await keys.maintenance.byOperation(operationId))
          .map((t) => t.codeId)
          .sort(),
      ).toEqual(codes);
    });

    it('完了済みticketの窓は未達としてobserverへ渡さない', async () => {
      const code = await allocate();
      await register();
      await finish();
      expect(await keys.maintenance.find(code)).toMatchObject({
        state: 'complete',
      });
      observer.window.mockClear();
      await register();
      expect(observer.window).not.toHaveBeenCalled();
    });

    it('findの障害ではProviderの期限を渡してから止まる', async () => {
      await allocate(randomUUID(), actorId, 'v1', preparedAt - 2000);
      keys.faults.add('find');
      await unavailable(register());
      expect(observer.window).toHaveBeenCalledWith(window(preparedAt - 2000));
    });

    it('完了済みticketは充足済みとして採用し、再作成しない', async () => {
      const code = await allocate();
      const owner = randomUUID();
      const { ticket } = await keys.maintenance.prepare({
        scope: { codeId: code, recipientActorId: actorId },
        operationId: owner,
        window: window(preparedAt - 1),
        expected: null,
      });
      const closure = await keys.lifecycle.closeAllGenerations({
        codeId: code,
        operationId: owner,
        inventoryRevision: ticket.inventoryRevision,
        deadlineAt: ticket.window.deadline,
      });
      await keys.maintenance.complete({ ticket, closure });
      await register();
      expect(await keys.maintenance.find(code)).toMatchObject({
        operationId: owner,
        state: 'complete',
        adoptingOperationIds: [operationId],
      });
      expect(database.inspect).not.toHaveBeenCalled();
    });

    it('列挙の版とticketの全世代版が違えば採用しない', async () => {
      const code = await allocate();
      await keys.maintenance.prepare({
        scope: { codeId: code, recipientActorId: actorId },
        operationId: randomUUID(),
        window: window(preparedAt),
        expected: null,
      });
      const scopePage = keys.maintenance.scopePage.bind(keys.maintenance);
      keys.maintenance.scopePage = async (query) => {
        const page = await scopePage(query);
        return page.status === 'snapshot'
          ? {
              ...page,
              scopes: page.scopes.map((scope) => ({
                ...scope,
                inventoryRevision: 'stale-revision',
              })),
            }
          : page;
      };
      await unavailable(register());
      expect((await keys.maintenance.find(code))?.adoptingOperationIds).toEqual(
        [],
      );
    });

    it.each(['block-actor', 'scope-page', 'scope-page-unavailable'])(
      '%sの障害では空のsnapshotとして進まない',
      async (fault) => {
        const code = await allocate();
        keys.faults.add(fault);
        await unavailable(register());
        expect(await keys.maintenance.find(code)).toBeNull();
      },
    );
  });

  describe('finish', () => {
    it('行除去→全世代closure→0-row→完了の順で全世代を閉じる', async () => {
      const code = await allocate();
      await keys.allocation.allocate({
        codeId: code,
        recipientActorId: actorId,
        keyVersion: 'v2',
        expiresAt,
      });
      await register();
      const order: string[] = [];
      database.remove.mockImplementation(() => {
        order.push('remove');
        return Promise.resolve('removed' as const);
      });
      database.absent.mockImplementation(() => {
        order.push('absent');
        return Promise.resolve(true);
      });
      const closeAllGenerations = keys.lifecycle.closeAllGenerations.bind(
        keys.lifecycle,
      );
      keys.lifecycle.closeAllGenerations = (request) => {
        order.push('close');
        return closeAllGenerations(request);
      };
      const complete = keys.maintenance.complete.bind(keys.maintenance);
      keys.maintenance.complete = (request) => {
        order.push('complete');
        return complete(request);
      };
      await finish();
      expect(order).toEqual(['remove', 'close', 'absent', 'complete']);
      expect(database.remove).toHaveBeenCalledWith(
        { codeId: code, recipientActorId: actorId },
        preparedAt,
      );
      expect(new Set(await lifecycles(code))).toEqual(new Set(['destroyed']));
      expect((await keys.maintenance.find(code))?.state).toBe('complete');
    });

    it('採用ticketは所有operationのclosureで完了する', async () => {
      const code = await allocate();
      const owner = randomUUID();
      await keys.maintenance.prepare({
        scope: { codeId: code, recipientActorId: actorId },
        operationId: owner,
        window: window(expiresAt),
        expected: null,
      });
      await register();
      const closeAllGenerations = keys.lifecycle.closeAllGenerations.bind(
        keys.lifecycle,
      );
      const spy = vi.fn(closeAllGenerations);
      keys.lifecycle.closeAllGenerations = spy;
      await finish();
      expect(spy.mock.calls[0][0].operationId).toBe(owner);
      expect((await keys.maintenance.find(code))?.state).toBe('complete');
    });

    it('完了済みticketは所有operationのclosureを再検証し、不正なら止まる', async () => {
      const code = await allocate();
      await register();
      await finish();
      const verifyClosure = keys.lifecycle.verifyClosure.bind(keys.lifecycle);
      const closeAllGenerations = keys.lifecycle.closeAllGenerations.bind(
        keys.lifecycle,
      );
      const close = vi.fn(closeAllGenerations);
      keys.lifecycle.closeAllGenerations = close;
      await finish();
      expect(close.mock.calls[0][0].operationId).toBe(operationId);
      keys.lifecycle.verifyClosure = () => Promise.resolve(false);
      await unavailable(finish());
      keys.lifecycle.verifyClosure = verifyClosure;
      expect((await keys.maintenance.find(code))?.state).toBe('complete');
    });

    it('1件の除去に失敗しても残りを閉じてから止まり、Complete前提を満たさない', async () => {
      const codes = [await allocate(), await allocate()].sort();
      await register();
      database.remove.mockImplementationOnce(() =>
        Promise.resolve('locked' as const),
      );
      await unavailable(finish());
      expect((await keys.maintenance.find(codes[0]))?.state).toBe('pending');
      expect((await keys.maintenance.find(codes[1]))?.state).toBe('complete');
    });

    it('完了済みticketの窓は再検証でもobserverへ渡さない', async () => {
      await allocate();
      await register();
      await finish();
      observer.window.mockClear();
      await finish();
      expect(observer.window).not.toHaveBeenCalled();
    });

    it('完了済みticketでも0-rowを確認できなければ止まる', async () => {
      await allocate();
      await register();
      await finish();
      database.absent.mockResolvedValue(false);
      await unavailable(finish());
    });

    it('全世代破棄の途中失敗では完了せず、再実行で完了する', async () => {
      const code = await allocate();
      await keys.allocation.allocate({
        codeId: code,
        recipientActorId: actorId,
        keyVersion: 'v2',
        expiresAt,
      });
      await register();
      keys.faults.add('after-destroy-generation');
      await unavailable(finish());
      expect((await keys.maintenance.find(code))?.state).toBe('pending');
      keys.faults.clear();
      await finish();
      expect((await keys.maintenance.find(code))?.state).toBe('complete');
    });

    it.each([
      ['retained', 'retained'],
      ['locked', 'locked'],
    ] as const)('行除去が%sならclosureへ進まない', async (_name, removed) => {
      const code = await allocate();
      await register();
      database.remove.mockResolvedValue(removed);
      await unavailable(finish());
      expect(new Set(await lifecycles(code))).toEqual(new Set(['current']));
    });

    it('0-rowを確認できなければ完了しない', async () => {
      const code = await allocate();
      await register();
      database.absent.mockResolvedValue(false);
      await unavailable(finish());
      expect((await keys.maintenance.find(code))?.state).toBe('pending');
    });

    it('封鎖後の再snapshotにticketのないscopeがあれば止まる', async () => {
      await allocate();
      await register();
      const scopePage = keys.maintenance.scopePage.bind(keys.maintenance);
      keys.maintenance.scopePage = async (query) => {
        const page = await scopePage(query);
        if (page.status !== 'snapshot') return page;
        return {
          ...page,
          total: page.total + 1,
          scopes: [
            ...page.scopes,
            {
              codeId: randomUUID(),
              recipientActorId: actorId,
              expiresAt,
              inventoryRevision: 'late',
            },
          ],
        };
      };
      await unavailable(finish());
    });

    it('再snapshotの全世代版がticketと違えば止まる', async () => {
      await allocate();
      await register();
      const scopePage = keys.maintenance.scopePage.bind(keys.maintenance);
      keys.maintenance.scopePage = async (query) => {
        const page = await scopePage(query);
        return page.status === 'snapshot'
          ? {
              ...page,
              scopes: page.scopes.map((scope) => ({
                ...scope,
                inventoryRevision: 'moved',
              })),
            }
          : page;
      };
      await unavailable(finish());
    });

    it('再snapshotの障害ではCompleteの前提を満たさない', async () => {
      await allocate();
      await register();
      const scopePage = keys.maintenance.scopePage.bind(keys.maintenance);
      let calls = 0;
      keys.maintenance.scopePage = (query) => {
        calls += 1;
        return calls === 1
          ? Promise.resolve({ status: 'unavailable' as const })
          : scopePage(query);
      };
      await unavailable(finish());
    });

    it('byOperationが別Actorのticketを返せば止まり、そのコードを除去しない', async () => {
      const otherActor = randomUUID();
      const code = await allocate(randomUUID(), otherActor);
      await keys.maintenance.prepare({
        scope: { codeId: code, recipientActorId: otherActor },
        operationId,
        window: window(preparedAt),
        expected: null,
      });
      await unavailable(finish());
      expect(database.remove).not.toHaveBeenCalled();
    });

    it('未完了のまま残るticketがあればCompleteの前提を満たさない', async () => {
      await allocate();
      await register();
      const byOperation = keys.maintenance.byOperation.bind(keys.maintenance);
      const pending = await byOperation(operationId);
      await finish();
      let calls = 0;
      keys.maintenance.byOperation = (id) => {
        calls += 1;
        return calls === 2 ? Promise.resolve(pending) : byOperation(id);
      };
      await unavailable(finish());
    });

    it('検証の後に現れた完了済みticketは検証済みとして扱わない', async () => {
      await allocate();
      await register();
      await finish();
      const byOperation = keys.maintenance.byOperation.bind(keys.maintenance);
      const [ticket] = await byOperation(operationId);
      let calls = 0;
      keys.maintenance.byOperation = () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve([])
          : Promise.resolve([{ ...ticket }]);
      };
      await unavailable(finish());
    });

    it('Providerの知らない行がActorに残れば止まる', async () => {
      await allocate();
      await register();
      database.actorAbsent.mockResolvedValue(false);
      await unavailable(finish());
    });

    it('コードのないActorはそのまま前提を満たす', async () => {
      await register();
      await expect(finish()).resolves.toBeUndefined();
      expect(database.actorAbsent).toHaveBeenCalledWith(actorId);
    });

    it('採用ticketの窓をobserverへ渡し、期限未達の判断を呼出し側に残す', async () => {
      const code = await allocate();
      await keys.maintenance.prepare({
        scope: { codeId: code, recipientActorId: actorId },
        operationId: randomUUID(),
        window: window(preparedAt - 7000),
        expected: null,
      });
      await register();
      observer.window.mockClear();
      await finish();
      expect(observer.window).toHaveBeenCalledWith(window(preparedAt - 7000));
    });
  });
});
