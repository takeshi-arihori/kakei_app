import { describe, expect, it, vi } from 'vitest';

import type { AuthenticationCleanupDatabase } from './authentication-maintenance-database.js';
import type {
  AuthenticationKeyDestructionPort,
  AuthenticationVerifiedDestruction,
} from './authentication-maintenance-ports.js';
import { createAuthenticationCleanupService } from './authentication-cleanup-service.js';

describe('認証清掃のDB/全鍵完了境界', () => {
  const fixture = () => {
    const ticket = {
      operationId: '11111111-1111-4111-8111-111111111111',
      reference: 'opaque-ref',
      version: 1,
      inventoryDigest: new Uint8Array(32),
      window: { dueAt: 1000, deadline: 86_401_000 },
    };
    const events: string[] = [];
    const db: AuthenticationCleanupDatabase = {
      deleteExpired: () => {
        return Promise.resolve().then(() => {
          events.push('delete');
          return {
            status: 'committed',
            tickets: [ticket],
            auditCount: 0,
            oldest: null,
          };
        });
      },
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
      prepare: () => Promise.resolve(ticket),
      pendingCredentials: () => Promise.resolve([]),
      pendingActorDeletions: () => Promise.resolve([]),
      scopes: () =>
        Promise.resolve([
          { recordKind: 'session', keyScopeId: ticket.operationId },
        ]),
      destroy: () => {
        return Promise.resolve().then(() => {
          events.push('destroy');
          return {} as AuthenticationVerifiedDestruction;
        });
      },
      verify: () => {
        return Promise.resolve().then(() => {
          events.push('proof');
          return true;
        });
      },
    };
    const monitor = { record: vi.fn(() => Promise.resolve(undefined)) };
    return {
      ticket,
      events,
      db,
      keys,
      monitor,
      service: () =>
        createAuthenticationCleanupService({
          database: db,
          keys,
          monitor,
          clock: { now: () => 2000 },
        }),
    };
  };
  it('DBの0-rowと全世代証明を確認した後だけ完了する', async () => {
    const f = fixture();
    expect(await f.service().run(10)).toEqual({
      status: 'complete',
      credentials: 1,
      audits: 0,
    });
    expect(f.events).toEqual([
      'delete',
      'zero-row',
      'destroy',
      'proof',
      'zero-row',
    ]);
  });
  it('DB応答喪失後でもpending ticketから全鍵破棄を再開する', async () => {
    const f = fixture();
    f.db.deleteExpired = () =>
      Promise.resolve({
        status: 'committed',
        tickets: [],
        auditCount: 0,
        oldest: null,
      });
    f.keys.pendingCredentials = () => Promise.resolve([f.ticket]);
    expect((await f.service().run(10)).status).toBe('complete');
    expect(f.events).toEqual(['zero-row', 'destroy', 'proof', 'zero-row']);
  });
  it('行が残っていれば鍵を破棄しない', async () => {
    const f = fixture();
    f.db.absent = () => Promise.resolve(false);
    expect((await f.service().run(10)).status).toBe('pending');
    expect(f.events).not.toContain('destroy');
  });
  it('Actor Identityのticketは外部削除意思を検証する別Workflowへ残す', async () => {
    const f = fixture();
    f.keys.scopes = () =>
      Promise.resolve([
        { recordKind: 'google-identity', keyScopeId: f.ticket.operationId },
      ]);
    expect((await f.service().run(10)).status).toBe('pending');
    expect(f.events).not.toContain('destroy');
  });
  it('AlreadyDestroyedや部分証明だけを完了にしない', async () => {
    const f = fixture();
    f.keys.verify = () => Promise.resolve(false);
    expect((await f.service().run(10)).status).toBe('unavailable');
  });
  it('24時間未達では成功を返さず隔離する', async () => {
    const f = fixture();
    f.ticket.window = { dueAt: 0, deadline: 1 };
    f.db.deleteExpired = () =>
      Promise.resolve({
        status: 'committed',
        tickets: [],
        auditCount: 0,
        oldest: { dueAt: 0, deadline: 86_400_000 },
      });
    const service = createAuthenticationCleanupService({
      database: f.db,
      keys: f.keys,
      monitor: f.monitor,
      clock: { now: () => 86_400_000 },
    });
    expect((await service.run(10)).status).toBe('quarantined');
    expect(f.events).toContain('quarantine');
  });
  it('期限未達の監視配信が失敗してもDB封鎖を省略しない', async () => {
    const f = fixture();
    f.db.deleteExpired = () =>
      Promise.resolve({
        status: 'committed',
        tickets: [],
        auditCount: 0,
        oldest: { dueAt: 0, deadline: 86_400_000 },
      });
    f.monitor.record.mockRejectedValue(new Error('synthetic monitor failure'));
    const service = createAuthenticationCleanupService({
      database: f.db,
      keys: f.keys,
      monitor: f.monitor,
      clock: { now: () => 86_400_000 },
    });
    expect((await service.run(10)).status).toBe('unavailable');
    expect(f.events).toContain('quarantine');
  });
  it.each(['pending', 'scopes', 'destroy'] as const)(
    '既知overdueの%s障害より前に受付を封鎖する',
    async (fault) => {
      const f = fixture();
      const reject = () => {
        f.events.push('fault');
        return Promise.reject(new Error('synthetic key failure'));
      };
      if (fault === 'pending') f.keys.pendingCredentials = reject;
      if (fault === 'scopes') f.keys.scopes = reject;
      if (fault === 'destroy') f.keys.destroy = reject;
      const service = createAuthenticationCleanupService({
        database: f.db,
        keys: f.keys,
        monitor: f.monitor,
        clock: { now: () => 86_401_000 },
      });
      expect((await service.run(10)).status).toBe('unavailable');
      expect(f.events).toContain('quarantine');
      expect(f.events.indexOf('quarantine')).toBeLessThan(
        f.events.indexOf('fault'),
      );
    },
  );
});
