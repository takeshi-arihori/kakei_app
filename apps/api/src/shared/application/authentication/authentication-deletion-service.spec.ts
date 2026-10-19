import { describe, expect, it, vi } from 'vitest';

import type {
  AuthenticationDeletionDatabase,
  AuthenticationCleanupDatabase,
} from './authentication-maintenance-database.js';
import type {
  AuthenticationDeletionRecord,
  AuthenticationKeyDestructionPort,
  AuthenticationLedgerEvidence,
  AuthenticationVerifiedHead,
  AuthenticationVerifiedIntent,
  AuthenticationVerifiedDestruction,
} from './authentication-maintenance-ports.js';
import { createAuthenticationDeletionService } from './authentication-deletion-service.js';

const operationId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
describe('認証Actor削除の不可逆な境界', () => {
  const fixture = () => {
    const events: string[] = [];
    let record: AuthenticationDeletionRecord | null = {
      kind: 'actor-deletion',
      operationId,
      actorDigestKeyVersion: 'v1',
      actorDigest: new Uint8Array(32),
      preparedAt: 1000,
      version: 1,
      state: 'prepared',
      targetReference: 'opaque-ref',
    };
    const head = {} as AuthenticationVerifiedHead;
    const intent = {} as AuthenticationVerifiedIntent;
    const ticket = {
      operationId,
      reference: 'opaque-ref',
      version: 1,
      inventoryDigest: new Uint8Array(32),
      window: { dueAt: 1000, deadline: 86_401_000 },
    };
    const ledger: AuthenticationLedgerEvidence = {
      writeKeyVersion: 'v1',
      latest: () => {
        return Promise.resolve().then(() => {
          events.push('latest');
          return head;
        });
      },
      head: () => ({ sequence: 1, hash: '0'.repeat(64) }),
      intents: () => (record === null ? [] : [intent]),
      intent: () => (record === null ? null : intent),
      resolve: () => record!,
      append: (_head, next) => {
        return Promise.resolve().then(() => {
          if (next.kind !== 'actor-deletion') throw new Error('synthetic kind');
          record = next;
          events.push('external-' + next.state);
          return head;
        });
      },
    };
    const database: AuthenticationDeletionDatabase = {
      plan: () =>
        Promise.resolve({ keyVersion: 'v1', digest: new Uint8Array(32) }),
      disable: () => {
        return Promise.resolve().then(() => {
          events.push('disable-commit');
          return { actorId, ticket };
        });
      },
      remove: () => {
        return Promise.resolve().then(() => {
          events.push('remove-commit');
          return true;
        });
      },
      complete: () => {
        return Promise.resolve().then(() => {
          events.push('db-complete');
          return true;
        });
      },
      reconcileIntents: () => Promise.resolve(true),
    };
    const cleanup: AuthenticationCleanupDatabase = {
      deleteExpired: () => Promise.resolve({ status: 'unavailable' }),
      absent: () => {
        return Promise.resolve().then(() => {
          events.push('zero-row');
          return true;
        });
      },
      quarantine: () => {
        return Promise.resolve().then(() => {
          events.push('quarantine');
          return true;
        });
      },
    };
    const keys: AuthenticationKeyDestructionPort = {
      pendingActorDeletionPage: () =>
        Promise.resolve({ tickets: [], nextCursor: null }),
      find: () => Promise.resolve(ticket),
      prepare: (_operationId, _scopes, window) => {
        return Promise.resolve().then(() => {
          ticket.window = { ...window };
          return ticket;
        });
      },
      pendingCredentials: () => Promise.resolve([]),
      pendingActorDeletions: () => Promise.resolve([]),
      scopes: () =>
        Promise.resolve([
          { recordKind: 'google-identity', keyScopeId: actorId },
        ]),
      destroy: () => {
        return Promise.resolve().then(() => {
          events.push('destroy');
          return {} as AuthenticationVerifiedDestruction;
        });
      },
      verify: () => {
        return Promise.resolve().then(() => {
          events.push('verify-all-versions');
          return true;
        });
      },
    };
    const monitor = { record: vi.fn(() => Promise.resolve(undefined)) };
    const service = (newOperationId = () => operationId, now = 2000) =>
      createAuthenticationDeletionService({
        database,
        cleanup,
        keys,
        ledger,
        monitor,
        clock: { now: () => now },
        newOperationId,
        deletedActor: () => Promise.resolve(new Uint8Array(32)),
      });
    return {
      events,
      database,
      cleanup,
      keys,
      ledger,
      monitor,
      service,
      reset: () => {
        record = null;
      },
    };
  };
  it('全鍵破棄と0-rowまで外部Completeを発行しない', async () => {
    const f = fixture();
    expect(await f.service().resume(operationId)).toEqual({
      status: 'complete',
      operationId,
    });
    expect(f.events).toEqual([
      'latest',
      'disable-commit',
      'remove-commit',
      'zero-row',
      'destroy',
      'verify-all-versions',
      'zero-row',
      'latest',
      'external-complete',
      'db-complete',
    ]);
  });
  it('期限内にComplete済みの操作を翌日再照合しても新しい未達にしない', async () => {
    const f = fixture();
    expect((await f.service().resume(operationId)).status).toBe('complete');
    f.events.length = 0;
    expect(
      (await f.service(undefined, 86_401_001).resume(operationId)).status,
    ).toBe('complete');
    expect(f.events).not.toContain('quarantine');
  });
  it('削除期限未達の通知失敗でもActor/認証受付のDB封鎖を実行する', async () => {
    const f = fixture();
    f.monitor.record.mockRejectedValue(new Error('synthetic monitor failure'));
    expect(
      (await f.service(undefined, 86_401_000).resume(operationId)).status,
    ).toBe('unavailable');
    expect(f.events).toContain('quarantine');
  });
  it('外部Prepared前にDB無効化へ進まない', async () => {
    const f = fixture();
    f.reset();
    expect((await f.service().begin(actorId)).status).toBe('complete');
    expect(f.events.indexOf('external-prepared')).toBeLessThan(
      f.events.indexOf('disable-commit'),
    );
  });
  it('DBだけに残るIntentを受付未完としてskipせず隔離する', async () => {
    const f = fixture();
    f.reset();
    f.database.reconcileIntents = () => Promise.resolve(false);
    expect((await f.service().resume(operationId)).status).toBe('quarantined');
    expect(f.events).toContain('quarantine');
    expect(f.events).not.toContain('disable-commit');
  });
  it('同Actorに別の孤児ticketがあれば既知operationの再開も隔離する', async () => {
    const f = fixture();
    f.keys.pendingActorDeletions = () =>
      Promise.resolve([
        {
          operationId: actorId,
          reference: 'orphan-reference',
          version: 1,
          inventoryDigest: new Uint8Array(32),
          window: { dueAt: 1000, deadline: 86_401_000 },
        },
      ]);
    expect((await f.service().resume(operationId)).status).toBe('quarantined');
    expect(f.events).not.toContain('disable-commit');
  });
  it.each(['ticket', 'disable', 'destroy'] as const)(
    '削除期限未達の%s障害でも先に受付を封鎖する',
    async (fault) => {
      const f = fixture();
      const reject = () => {
        f.events.push('fault');
        return Promise.reject(new Error('synthetic deletion failure'));
      };
      if (fault === 'ticket') f.keys.find = reject;
      if (fault === 'disable') f.database.disable = reject;
      if (fault === 'destroy') f.keys.destroy = reject;
      expect(
        (await f.service(undefined, 86_401_000).resume(operationId)).status,
      ).toBe('unavailable');
      expect(f.events).toContain('quarantine');
      expect(f.events.indexOf('quarantine')).toBeLessThan(
        f.events.indexOf('fault'),
      );
    },
  );
  it.each(['prepared', 'complete'] as const)(
    '外部%sの管理票欠落を同operationの再試行でも隔離する',
    async (state) => {
      const f = fixture();
      if (state === 'complete')
        expect((await f.service().resume(operationId)).status).toBe('complete');
      f.events.length = 0;
      f.keys.find = () => Promise.resolve(null);
      for (let retry = 0; retry < 2; retry += 1)
        expect(await f.service().resume(operationId)).toEqual({
          status: 'quarantined',
          operationId,
        });
      expect(f.events).toContain('quarantine');
      expect(f.events).not.toContain('disable-commit');
      expect(f.events).not.toContain('destroy');
      expect(f.monitor.record).toHaveBeenCalledWith({
        operation: 'deletion',
        code: 'QUARANTINED',
        oldest: null,
      });
    },
  );
  it.each(['operation', 'reference', 'window'] as const)(
    '正常応答の管理票の%s不一致はDB無効化前に隔離する',
    async (field) => {
      const f = fixture();
      const ticket = await f.keys.find(operationId, 'opaque-ref');
      if (ticket === null) throw new Error('合成管理票が必要');
      f.keys.find = () =>
        Promise.resolve({
          ...ticket,
          ...(field === 'operation' ? { operationId: actorId } : {}),
          ...(field === 'reference' ? { reference: 'foreign-ref' } : {}),
          ...(field === 'window'
            ? { window: { ...ticket.window, deadline: 86_402_000 } }
            : {}),
        });
      expect(await f.service().resume(operationId)).toEqual({
        status: 'quarantined',
        operationId,
      });
      expect(f.events).not.toContain('disable-commit');
      expect(f.events).not.toContain('destroy');
    },
  );
  it.each([0, 2])(
    'Identity scopeが%d件なら削除を進めず隔離する',
    async (size) => {
      const f = fixture();
      f.keys.scopes = () =>
        Promise.resolve(
          Array.from({ length: size }, () => ({
            recordKind: 'google-identity' as const,
            keyScopeId: actorId,
          })),
        );
      expect((await f.service().resume(operationId)).status).toBe(
        'quarantined',
      );
      expect(f.events).not.toContain('disable-commit');
      expect(f.events).not.toContain('destroy');
    },
  );
  it.each(['reference', 'window', 'actor'] as const)(
    'DB無効化後の%s不一致を鍵破棄前に隔離する',
    async (field) => {
      const f = fixture();
      const disable = f.database.disable.bind(f.database);
      f.database.disable = async (intent) => {
        const result = await disable(intent);
        return {
          ...result,
          actorId: field === 'actor' ? operationId : result.actorId,
          ticket: {
            ...result.ticket,
            ...(field === 'reference' ? { reference: 'foreign-ref' } : {}),
            ...(field === 'window'
              ? { window: { ...result.ticket.window, dueAt: 1001 } }
              : {}),
          },
        };
      };
      expect((await f.service().resume(operationId)).status).toBe(
        'quarantined',
      );
      expect(f.events).toContain('quarantine');
      expect(f.events).not.toContain('remove-commit');
      expect(f.events).not.toContain('destroy');
    },
  );
  it('Identity scopeがLedgerの仮名と異なるなら無効化前に隔離する', async () => {
    const f = fixture();
    const resolve = f.ledger.resolve.bind(f.ledger);
    f.ledger.resolve = (intent) => ({
      ...resolve(intent),
      actorDigest: new Uint8Array(32).fill(1),
    });
    expect((await f.service().resume(operationId)).status).toBe('quarantined');
    expect(f.events).not.toContain('disable-commit');
    expect(f.events).not.toContain('destroy');
  });
  it('行削除後の管理票がIdentity scopeを失っていれば鍵破棄せず隔離する', async () => {
    const f = fixture();
    let removed = false;
    const remove = f.database.remove.bind(f.database);
    const scopes = f.keys.scopes.bind(f.keys);
    f.database.remove = async (intent, disabled) => {
      const result = await remove(intent, disabled);
      removed = true;
      return result;
    };
    f.keys.scopes = (ticket) =>
      removed ? Promise.resolve([]) : scopes(ticket);
    expect((await f.service().resume(operationId)).status).toBe('quarantined');
    expect(f.events).toContain('remove-commit');
    expect(f.events).toContain('quarantine');
    expect(f.events).not.toContain('destroy');
  });
  it('Provider読取障害は結果不明を保ち、回復後に同operationで再開する', async () => {
    const f = fixture();
    const find = f.keys.find.bind(f.keys);
    f.keys.find = () => Promise.reject(new Error('synthetic read failure'));
    expect(await f.service().resume(operationId)).toEqual({
      status: 'unavailable',
      operationId,
    });
    expect(f.events).not.toContain('quarantine');
    f.keys.find = find;
    expect(await f.service().resume(operationId)).toEqual({
      status: 'complete',
      operationId,
    });
  });
  it('管理票欠落で封鎖が確認できなければ隔離完了を主張しない', async () => {
    const f = fixture();
    f.keys.find = () => Promise.resolve(null);
    f.cleanup.quarantine = () => Promise.resolve(false);
    expect(await f.service().resume(operationId)).toEqual({
      status: 'unavailable',
      operationId,
    });
    expect(f.events).not.toContain('destroy');
  });
  it('管理票欠落の封鎖は監視障害でも取り消さない', async () => {
    const f = fixture();
    f.keys.find = () => Promise.resolve(null);
    f.monitor.record.mockRejectedValue(new Error('synthetic monitor failure'));
    expect(await f.service().resume(operationId)).toEqual({
      status: 'quarantined',
      operationId,
    });
    expect(f.events).toContain('quarantine');
  });
  it('operation未発行のEntropy障害も秘密なしのResultへ写像する', async () => {
    const f = fixture();
    f.reset();
    await expect(
      f
        .service(() => {
          throw new Error('synthetic entropy');
        })
        .begin(actorId),
    ).resolves.toEqual({ status: 'unavailable', operationId: null });
    expect(f.events).not.toContain('external-prepared');
  });
  it('不正な再開IDを失敗結果へ反射しない', async () => {
    const f = fixture();
    expect(
      await f.service().resume('Synthetic-token-not-an-operation-id'),
    ).toEqual({ status: 'unavailable', operationId: null });
    expect(f.events).not.toContain('latest');
  });
  it.each(['disable', 'remove', 'destroy', 'verify'] as const)(
    '%sの障害で外部Completeにせず同operationで再開できる',
    async (fault) => {
      const f = fixture();
      if (fault === 'disable')
        f.database.disable = () => {
          return Promise.resolve().then(() => {
            throw new Error('synthetic');
          });
        };
      if (fault === 'remove') f.database.remove = () => Promise.resolve(false);
      if (fault === 'destroy')
        f.keys.destroy = () => {
          return Promise.resolve().then(() => {
            throw new Error('synthetic');
          });
        };
      if (fault === 'verify') f.keys.verify = () => Promise.resolve(false);
      const result = await f.service().resume(operationId);
      expect(result.operationId).toBe(operationId);
      expect(result.status).not.toBe('complete');
      expect(f.events).not.toContain('external-complete');
    },
  );
});
