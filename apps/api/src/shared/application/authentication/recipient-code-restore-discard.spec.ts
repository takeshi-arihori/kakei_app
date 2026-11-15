import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { syntheticRecipientCodeManagedKeys } from '../../infrastructure/authentication/test/recipient-code-maintenance-fixtures.js';
import type {
  AuthenticationMaintenanceMonitor,
  AuthenticationRestoreFence,
} from './authentication-maintenance-ports.js';
import { guardRecipientCodeMaintenance } from './recipient-code-maintenance-guard.js';
import { RecipientCodeUnavailable } from './recipient-code-record.js';
import {
  createRecipientCodeRestoreDiscard,
  type RecipientCodeRestoreDatabase,
} from './recipient-code-restore-discard.js';

const day = 86_400_000;
const created = 1_000_000;
// 発行の10分後に失効する。Restoreの閉鎖はそれより後なので、行の期限は過ぎている。
const expiresAt = created + 600_000;
const closedAt = created + 30 * day;
const window = (dueAt: number) => ({ dueAt, deadline: dueAt + day });
const fence = Object.freeze({}) as AuthenticationRestoreFence;

describe('Restoreへのコード参加（ticket・closure・0-row）', () => {
  let keys: ReturnType<typeof syntheticRecipientCodeManagedKeys>;
  let rows: Map<string, string>;
  let now: number;
  let runId: string;
  let database: {
    [K in keyof RecipientCodeRestoreDatabase]: Mock<
      RecipientCodeRestoreDatabase[K]
    >;
  };
  let monitor: { record: Mock<AuthenticationMaintenanceMonitor['record']> };
  const service = () =>
    createRecipientCodeRestoreDiscard({
      maintenance: guardRecipientCodeMaintenance(keys),
      database,
      clock: { now: () => now },
      monitor,
    });
  const discard = (id = runId) =>
    service().discard({ runId: id, fence, closedAt });
  /** 復旧したDBにも行がある発行済みコード。 */
  const issue = async (
    recipientActorId = randomUUID(),
    codeId = randomUUID(),
  ) => {
    await keys.allocation.allocate({
      codeId,
      recipientActorId,
      keyVersion: 'v1',
      expiresAt,
    });
    rows.set(codeId, recipientActorId);
    return codeId;
  };
  const lifecycles = async (codeId: string) =>
    (await keys.lifecycle.inventory(codeId)).generations.map(
      (generation) => generation.lifecycle,
    );
  const unavailable = (work: Promise<unknown>) =>
    expect(work).rejects.toBeInstanceOf(RecipientCodeUnavailable);

  beforeEach(() => {
    keys = syntheticRecipientCodeManagedKeys();
    rows = new Map();
    now = closedAt + 1000;
    runId = randomUUID();
    const sorted = () => [...rows].sort(([a], [b]) => (a < b ? -1 : 1));
    database = {
      rows: vi.fn((_fence, after, limit) =>
        Promise.resolve(
          sorted()
            .filter(([codeId]) => after === null || codeId > after)
            .slice(0, limit)
            .map(([codeId, recipientActorId]) => ({
              codeId,
              recipientActorId,
            })),
        ),
      ),
      remove: vi.fn((_fence, scope) => {
        const actor = rows.get(scope.codeId);
        if (actor !== undefined && actor !== scope.recipientActorId)
          return Promise.reject(new Error('actor mismatch'));
        rows.delete(scope.codeId);
        return Promise.resolve();
      }),
      absent: vi.fn((_fence, codeId) => Promise.resolve(!rows.has(codeId))),
      empty: vi.fn(() => Promise.resolve(rows.size === 0)),
    };
    monitor = { record: vi.fn(() => Promise.resolve()) };
  });

  it('期限切れの行と孤立scopeを含む全コードを、初回閉鎖UTC起算のrun所有ticketで破棄する', async () => {
    const first = await issue();
    const second = await issue();
    // allocate後にrollbackされ、DBに行のない孤立scope。
    const orphan = randomUUID();
    await keys.allocation.allocate({
      codeId: orphan,
      recipientActorId: randomUUID(),
      keyVersion: 'v1',
      expiresAt,
    });
    const closures = await discard();
    expect(closures.map((closure) => closure.codeId)).toEqual(
      [first, second, orphan].sort(),
    );
    for (const codeId of [first, second, orphan]) {
      expect(await keys.maintenance.find(codeId)).toMatchObject({
        operationId: runId,
        adoptingOperationIds: [],
        state: 'complete',
        window: window(closedAt),
      });
      expect(await lifecycles(codeId)).toEqual(['destroyed']);
    }
    expect(closures.every((closure) => closure.operationId === runId)).toBe(
      true,
    );
    expect(rows.size).toBe(0);
    expect(monitor.record).not.toHaveBeenCalled();
  });

  it('コードがなければticketを作らず、空のclosure集合を返す', async () => {
    await expect(discard()).resolves.toEqual([]);
    expect(database.empty).toHaveBeenCalled();
  });

  it('同runの再実行は窓とticketを変えず、同じclosureを返す', async () => {
    const codeId = await issue();
    const first = await discard();
    const ticket = await keys.maintenance.find(codeId);
    now += 3 * day;
    const again = await discard();
    expect(again).toEqual(first);
    expect(await keys.maintenance.find(codeId)).toEqual(ticket);
  });

  it('途中で止まった同runの再開は、登録済みticketの窓を延ばさずに完了する', async () => {
    const codeId = await issue();
    keys.faults.add('before-close');
    await unavailable(discard());
    const pending = await keys.maintenance.find(codeId);
    expect(pending).toMatchObject({
      state: 'pending',
      window: window(closedAt),
    });
    keys.faults.clear();
    now += 2 * day;
    await discard();
    expect(await keys.maintenance.find(codeId)).toMatchObject({
      operationId: runId,
      state: 'complete',
      version: pending!.version + 1,
      window: window(closedAt),
    });
  });

  it('別runや清掃の未完了ticketは採用し、窓は前倒しだけで延長しない', async () => {
    const earlier = await issue();
    const later = await issue();
    const owner = randomUUID();
    const previousRun = randomUUID();
    await keys.maintenance.prepare({
      scope: { codeId: earlier, recipientActorId: rows.get(earlier)! },
      operationId: owner,
      window: window(expiresAt),
      expected: null,
    });
    await keys.maintenance.prepare({
      scope: { codeId: later, recipientActorId: rows.get(later)! },
      operationId: previousRun,
      window: window(closedAt + day),
      expected: null,
      basis: 'restore-fence',
    });
    const closures = await discard();
    expect(await keys.maintenance.find(earlier)).toMatchObject({
      operationId: owner,
      adoptingOperationIds: [runId],
      state: 'complete',
      window: window(expiresAt),
    });
    expect(await keys.maintenance.find(later)).toMatchObject({
      operationId: previousRun,
      adoptingOperationIds: [runId],
      state: 'complete',
      window: window(closedAt),
    });
    // closureは採用経由でも所有operationへ束縛する。
    expect(
      Object.fromEntries(closures.map((c) => [c.codeId, c.operationId])),
    ).toEqual({ [earlier]: owner, [later]: previousRun });
  });

  it('完了済みticketは充足として採用し、Backupから戻った行を除去してclosureを再検証する', async () => {
    const codeId = await issue();
    const owner = randomUUID();
    const guard = guardRecipientCodeMaintenance(keys);
    const { ticket } = await guard.prepare({
      scope: { codeId, recipientActorId: rows.get(codeId)! },
      operationId: owner,
      window: window(expiresAt),
      expected: null,
    });
    await guard.complete(ticket, await guard.close(ticket));
    const closures = await discard();
    expect(rows.has(codeId)).toBe(false);
    expect(closures).toEqual([
      expect.objectContaining({ codeId, operationId: owner }),
    ]);
    expect(await keys.maintenance.find(codeId)).toMatchObject({
      state: 'complete',
      adoptingOperationIds: [runId],
      window: window(expiresAt),
    });
  });

  it('Providerが知らない行があれば、ticketを作らず止める', async () => {
    const codeId = await issue();
    rows.set(randomUUID(), randomUUID());
    await unavailable(discard());
    expect(await keys.maintenance.find(codeId)).toBeNull();
    expect(database.remove).not.toHaveBeenCalled();
  });

  it('行のActorがProviderの束縛と異なれば、ticketを作らず止める', async () => {
    const codeId = await issue();
    rows.set(codeId, randomUUID());
    await unavailable(discard());
    expect(await keys.maintenance.find(codeId)).toBeNull();
  });

  it('1000件を超える行も全Pageを照合し、2Page目の未知の行で止める', async () => {
    const actor = randomUUID();
    for (let index = 0; index < 1000; index += 1) await issue(actor);
    // codeIdの昇順で最後に来る、Providerが知らない行。
    rows.set('ffffffff-ffff-4fff-bfff-ffffffffffff', actor);
    await unavailable(discard());
    expect(database.rows).toHaveBeenCalledTimes(2);
    expect(await keys.maintenance.pending(1000)).toEqual([]);
  });

  it('列挙の完全性を保証できないProviderでは止める', async () => {
    await issue();
    keys.faults.add('scope-page-unavailable');
    await unavailable(discard());
  });

  it('登録済みticketと全世代版が食い違えば止める', async () => {
    const codeId = await issue();
    await keys.maintenance.prepare({
      scope: { codeId, recipientActorId: rows.get(codeId)! },
      operationId: randomUUID(),
      window: window(expiresAt),
      expected: null,
    });
    const find = keys.maintenance.find.bind(keys.maintenance);
    keys.maintenance.find = async (id) => {
      const ticket = await find(id);
      return ticket && { ...ticket, inventoryRevision: 'other' };
    };
    await unavailable(discard());
    expect(rows.has(codeId)).toBe(true);
  });

  it('破棄の間に増えたscopeを再snapshotで検出して止める', async () => {
    await issue();
    const remove = database.remove.getMockImplementation()!;
    database.remove.mockImplementation(async (f, scope) => {
      await remove(f, scope);
      await keys.allocation.allocate({
        codeId: randomUUID(),
        recipientActorId: randomUUID(),
        keyVersion: 'v1',
        expiresAt,
      });
    });
    await unavailable(discard());
  });

  it.each([
    ['codeIdの入替え', 'replace'],
    ['全世代版の変化', 'revision'],
    ['束縛Actorの変化', 'actor'],
  ] as const)(
    '件数が同じでも再snapshotの%sを検出して止める',
    async (_name, change) => {
      await issue();
      const scopePage = keys.maintenance.scopePage.bind(keys.maintenance);
      let snapshots = 0;
      keys.maintenance.scopePage = async (query) => {
        const page = await scopePage(query);
        if (query.cursor === null) snapshots += 1;
        if (snapshots < 2 || page.status !== 'snapshot') return page;
        return {
          ...page,
          scopes: page.scopes.map((scope) => ({
            ...scope,
            codeId: change === 'replace' ? randomUUID() : scope.codeId,
            inventoryRevision:
              change === 'revision' ? 'other' : scope.inventoryRevision,
            recipientActorId:
              change === 'actor' ? randomUUID() : scope.recipientActorId,
          })),
        };
      };
      await unavailable(discard());
      expect(snapshots).toBe(2);
    },
  );

  describe('完了済みscopeをsnapshotから落とすProvider（Port契約上は許される）', () => {
    beforeEach(() => {
      const scopePage = keys.maintenance.scopePage.bind(keys.maintenance);
      const find = keys.maintenance.find.bind(keys.maintenance);
      keys.maintenance.scopePage = async (query) => {
        const page = await scopePage({ ...query, limit: 1000 });
        if (page.status !== 'snapshot') return page;
        const scopes = [];
        for (const scope of page.scopes)
          if ((await find(scope.codeId))?.state !== 'complete')
            scopes.push(scope);
        return {
          status: 'snapshot',
          scopes,
          total: scopes.length,
          nextCursor: null,
        };
      };
    });

    it('清掃が完了済みのコードの行がBackupから戻っても、scopesで束縛して除去しclosureを再検証する', async () => {
      const codeId = await issue();
      const owner = randomUUID();
      const guard = guardRecipientCodeMaintenance(keys);
      const { ticket } = await guard.prepare({
        scope: { codeId, recipientActorId: rows.get(codeId)! },
        operationId: owner,
        window: window(expiresAt),
        expected: null,
      });
      await guard.complete(ticket, await guard.close(ticket));
      const pending = await issue();
      const closures = await discard();
      expect(rows.size).toBe(0);
      expect(closures.map((c) => [c.codeId, c.operationId])).toEqual(
        [
          [codeId, owner],
          [pending, runId],
        ].sort(([a], [b]) => (a < b ? -1 : 1)),
      );
      expect(
        (await keys.maintenance.find(codeId))?.adoptingOperationIds,
      ).toEqual([runId]);
    });

    it('完了して列挙から落ちた後の同runの再実行でも、同じclosureを返す', async () => {
      await issue();
      await issue();
      const first = await discard();
      expect(first).toHaveLength(2);
      await expect(discard()).resolves.toEqual(first);
    });

    it('snapshotにない行の票が未完了なら、所在を証明できないので止める', async () => {
      const codeId = await issue();
      // 列挙に出ない未完了ticket（Providerの列挙漏れ）を作る。
      await keys.maintenance.prepare({
        scope: { codeId, recipientActorId: rows.get(codeId)! },
        operationId: randomUUID(),
        window: window(expiresAt),
        expected: null,
      });
      const scopePage = keys.maintenance.scopePage.bind(keys.maintenance);
      keys.maintenance.scopePage = async (query) => {
        const page = await scopePage(query);
        return page.status === 'snapshot'
          ? { ...page, scopes: [], total: 0, nextCursor: null }
          : page;
      };
      await unavailable(discard());
      expect(rows.has(codeId)).toBe(true);
    });

    it('このrunの未完了ticketが列挙にも行にもなければ、所在を証明できないので破棄せず止める', async () => {
      const codeId = randomUUID();
      const recipientActorId = randomUUID();
      await keys.allocation.allocate({
        codeId,
        recipientActorId,
        keyVersion: 'v1',
        expiresAt,
      });
      await keys.maintenance.prepare({
        scope: { codeId, recipientActorId },
        operationId: runId,
        window: window(closedAt),
        expected: null,
        basis: 'restore-fence',
      });
      const scopePage = keys.maintenance.scopePage.bind(keys.maintenance);
      keys.maintenance.scopePage = async (query) => {
        const page = await scopePage(query);
        return page.status === 'snapshot'
          ? { ...page, scopes: [], total: 0, nextCursor: null }
          : page;
      };
      await unavailable(discard());
      expect((await keys.maintenance.find(codeId))?.state).toBe('pending');
      expect(await lifecycles(codeId)).toEqual(['current']);
    });

    it('snapshotにない行の完了済み票が別Actorへ束縛されていれば止める', async () => {
      const codeId = await issue();
      const guard = guardRecipientCodeMaintenance(keys);
      const { ticket } = await guard.prepare({
        scope: { codeId, recipientActorId: rows.get(codeId)! },
        operationId: randomUUID(),
        window: window(expiresAt),
        expected: null,
      });
      await guard.complete(ticket, await guard.close(ticket));
      rows.set(codeId, randomUUID());
      await unavailable(discard());
      expect(rows.has(codeId)).toBe(true);
    });
  });

  it('1件の除去に失敗しても他のコードを破棄してから止め、そのticketは未完了に残す', async () => {
    const failing = await issue();
    const other = await issue();
    const remove = database.remove.getMockImplementation()!;
    database.remove.mockImplementation((f, scope) =>
      scope.codeId === failing
        ? Promise.reject(new Error('fault'))
        : remove(f, scope),
    );
    await unavailable(discard());
    expect((await keys.maintenance.find(failing))?.state).toBe('pending');
    expect((await keys.maintenance.find(other))?.state).toBe('complete');
  });

  it('closure後に行が残れば、ticketを完了しない', async () => {
    const codeId = await issue();
    database.absent.mockResolvedValue(false);
    await unavailable(discard());
    expect((await keys.maintenance.find(codeId))?.state).toBe('pending');
  });

  it('コード表に行が残れば止める', async () => {
    await issue();
    database.empty.mockResolvedValue(false);
    await unavailable(discard());
  });

  it('閉鎖UTCへ未達のClockでは、鍵を破棄しない', async () => {
    const codeId = await issue();
    now = closedAt - 1;
    await unavailable(discard());
    expect(await lifecycles(codeId)).toEqual(['current']);
  });

  it('deadline到達の未完了ticketはOVERDUEを最古の窓で通知し、それだけでは止めない', async () => {
    const restoreOwned = await issue();
    const adopted = await issue();
    await keys.maintenance.prepare({
      scope: { codeId: adopted, recipientActorId: rows.get(adopted)! },
      operationId: randomUUID(),
      window: window(expiresAt),
      expected: null,
    });
    now = closedAt + day;
    await expect(discard()).resolves.toHaveLength(2);
    expect(monitor.record).toHaveBeenCalledTimes(1);
    expect(monitor.record).toHaveBeenCalledWith({
      operation: 'restore',
      code: 'OVERDUE',
      oldest: window(expiresAt),
    });
    expect((await keys.maintenance.find(restoreOwned))?.state).toBe('complete');
  });

  it('OVERDUEを通知できなければ、成功にしない', async () => {
    await issue();
    now = closedAt + day;
    monitor.record.mockRejectedValue(new Error('monitor down'));
    await expect(discard()).rejects.toThrow();
  });
});
