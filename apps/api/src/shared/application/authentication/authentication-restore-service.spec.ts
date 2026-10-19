import { describe, expect, it, vi } from 'vitest';

import type {
  AuthenticationCleanupDatabase,
  AuthenticationDeletionDatabase,
  AuthenticationRestoreDatabase,
} from './authentication-maintenance-database.js';
import type {
  AuthenticationKeyDestructionPort,
  AuthenticationActorDeletionCursor,
  AuthenticationDeletionRecord,
  AuthenticationDestructionTicket,
  AuthenticationLedgerEvidence,
  AuthenticationRestoreFence,
  AuthenticationVerifiedHead,
  AuthenticationVerifiedIntent,
  AuthenticationVerifiedDestruction,
} from './authentication-maintenance-ports.js';
import type {
  AuthenticationRestoreControl,
  AuthenticationRestorePublication,
} from './authentication-restore-control.js';
import { createAuthenticationRestoreService } from './authentication-restore-service.js';

const runId = '11111111-1111-4111-8111-111111111111';
const oldEpoch = '22222222-2222-4222-8222-222222222222';
const newEpoch = '33333333-3333-4333-8333-333333333333';
const manifest = {
  createdAt: 1000,
  schemaVersion: 6,
  keyStateVersion: 1,
  epoch: oldEpoch,
  checkpoint: { sequence: 0, hash: '0'.repeat(64) },
};
describe('認証Restoreの隔離と開通', () => {
  const fixture = () => {
    const events: string[] = [];
    const fence = {} as AuthenticationRestoreFence;
    const head = {} as AuthenticationVerifiedHead;
    let sequence = 0;
    const purposes = [
      'google-identity-search',
      'login-attempt-cookie',
      'session-cookie',
      'actor-state-mac',
      'audit-actor',
      'audit-attempt',
      'audit-session',
      'deleted-actor',
      'deletion-ledger-mac',
    ] as const;
    const publication: AuthenticationRestorePublication = {
      runId,
      revision: 2,
      epoch: newEpoch,
      generations: purposes.map((purpose) => ({
        purpose,
        keyVersion: 'v1',
        epoch: purpose.includes('cookie') ? newEpoch : null,
        searchable: true,
        writeRequired: true,
        retiredAt: null,
      })),
    };
    const control: AuthenticationRestoreControl = {
      authorizeIsolation: (_fence, _manifest, current) =>
        Promise.resolve(
          current.status === 'restoring'
            ? current.version
            : current.version + 1,
        ),
      currentPublication: () => Promise.resolve(null),
      close: () => {
        return Promise.resolve().then(() => {
          events.push('close');
          return fence;
        });
      },
      verifyClosed: () => Promise.resolve(true),
      publishEpoch: () => {
        return Promise.resolve().then(() => {
          events.push('epoch');
          return publication;
        });
      },
      verifyPublication: () => Promise.resolve(true),
      rotateIdentity: () => Promise.resolve(undefined),
      open: () => {
        return Promise.resolve().then(() => {
          events.push('open');
          return true;
        });
      },
    };
    const database: AuthenticationRestoreDatabase = {
      isolate: () => {
        return Promise.resolve().then(() => {
          events.push('isolate');
          return 2;
        });
      },
      reapplyDeletion: () => {
        return Promise.resolve().then(() => {
          throw new Error('unexpected intent');
        });
      },
      discardCredentials: () => {
        return Promise.resolve().then(() => {
          events.push('discard');
          return [];
        });
      },
      migrateIdentity: () => {
        return Promise.resolve().then(() => {
          events.push('migrate');
          return new Uint8Array(32).fill(9);
        });
      },
      activate: () => {
        return Promise.resolve().then(() => {
          events.push('active');
          return true;
        });
      },
    };
    const deletion: AuthenticationDeletionDatabase = {
      plan: () => {
        return Promise.resolve().then(() => {
          throw new Error('unused');
        });
      },
      disable: () => {
        return Promise.resolve().then(() => {
          throw new Error('unused');
        });
      },
      remove: () => Promise.resolve(false),
      complete: () => Promise.resolve(false),
      reconcileIntents: () => {
        return Promise.resolve().then(() => {
          events.push('reconcile');
          return true;
        });
      },
    };
    const cleanup: AuthenticationCleanupDatabase = {
      deleteExpired: () => Promise.resolve({ status: 'unavailable' }),
      absent: () => Promise.resolve(true),
      quarantine: () => {
        return Promise.resolve().then(() => {
          events.push('quarantine');
          return true;
        });
      },
    };
    const ledger: AuthenticationLedgerEvidence = {
      writeKeyVersion: 'v1',
      latest: () => {
        return Promise.resolve().then(() => {
          events.push('latest');
          return head;
        });
      },
      head: () => ({ sequence, hash: '0'.repeat(64) }),
      intents: () => [],
      intent: () => null,
      resolve: () => {
        throw new Error('unused');
      },
      append: () => {
        return Promise.resolve().then(() => {
          sequence += 1;
          events.push('checkpoint-witness');
          return head;
        });
      },
    };
    const keys: AuthenticationKeyDestructionPort = {
      pendingActorDeletionPage: () =>
        Promise.resolve({ tickets: [], nextCursor: null }),
      find: () => Promise.resolve(null),
      prepare: () => {
        return Promise.resolve().then(() => {
          throw new Error('unused');
        });
      },
      pendingCredentials: () => Promise.resolve([]),
      scopes: () => Promise.resolve([]),
      pendingActorDeletions: () => Promise.resolve([]),
      destroy: () => {
        return Promise.resolve().then(() => {
          throw new Error('unused');
        });
      },
      verify: () => Promise.resolve(false),
    };
    const monitor = { record: vi.fn(() => Promise.resolve(undefined)) };
    const service = (now = 2000) =>
      createAuthenticationRestoreService({
        control,
        database,
        deletion,
        cleanup,
        ledger,
        keys,
        monitor,
        clock: { now: () => now },
      });
    return {
      events,
      control,
      database,
      deletion,
      cleanup,
      ledger,
      keys,
      monitor,
      service,
    };
  };
  it('隔離・削除適用・全Credential破棄・新epoch/鍵・Checkpointの後だけ開通する', async () => {
    const f = fixture();
    expect(await f.service().run(runId, manifest)).toEqual({
      status: 'complete',
    });
    expect(f.events.indexOf('close')).toBeLessThan(f.events.indexOf('isolate'));
    expect(f.events.indexOf('discard')).toBeLessThan(f.events.indexOf('epoch'));
    expect(f.events.indexOf('epoch')).toBeLessThan(f.events.indexOf('migrate'));
    expect(f.events.indexOf('checkpoint-witness')).toBeLessThan(
      f.events.indexOf('active'),
    );
    expect(f.events.indexOf('active')).toBeLessThan(f.events.indexOf('open'));
  });
  it.each([
    'witness',
    'discard',
    'epoch',
    'migrate',
    'activate',
    'open',
  ] as const)('%s故障では隔離を維持する', async (fault) => {
    const f = fixture();
    if (fault === 'witness')
      f.ledger.latest = () => {
        return Promise.resolve().then(() => {
          throw new Error('synthetic');
        });
      };
    if (fault === 'discard')
      f.database.discardCredentials = () => {
        return Promise.resolve().then(() => {
          throw new Error('synthetic');
        });
      };
    if (fault === 'epoch')
      f.control.verifyPublication = () => Promise.resolve(false);
    if (fault === 'migrate')
      f.database.migrateIdentity = () => {
        return Promise.resolve().then(() => {
          throw new Error('synthetic');
        });
      };
    if (fault === 'activate')
      f.database.activate = () => Promise.resolve(false);
    if (fault === 'open') f.control.open = () => Promise.resolve(false);
    expect((await f.service().run(runId, manifest)).status).toBe('quarantined');
    expect(f.events).toContain('quarantine');
  });
  it('35日超Backupを処理せず開通しない', async () => {
    const f = fixture();
    expect(
      (await f.service(1000 + 35 * 86_400_000 + 1).run(runId, manifest)).status,
    ).toBe('quarantined');
    expect(f.events).not.toContain('migrate');
    expect(f.events).not.toContain('open');
  });
  it.each(['open-response', 'monitor'] as const)(
    '%sの開通後障害は外部Trafficも再閉鎖する',
    async (fault) => {
      const f = fixture();
      let closed = false;
      const originalClose = f.control.close.bind(f.control);
      f.control.close = async (...args) => {
        closed = true;
        return originalClose(...args);
      };
      f.control.verifyClosed = () => Promise.resolve(closed);
      f.control.open = () => {
        closed = false;
        return fault === 'open-response'
          ? Promise.reject(new Error('synthetic open response loss'))
          : Promise.resolve(true);
      };
      if (fault === 'monitor')
        f.monitor.record.mockRejectedValue(
          new Error('synthetic monitor failure'),
        );
      expect((await f.service().run(runId, manifest)).status).toBe(
        'quarantined',
      );
      expect(closed).toBe(true);
    },
  );
  it('DBだけの削除Intentはskipせず隔離する', async () => {
    const f = fixture();
    f.deletion.reconcileIntents = () => Promise.resolve(false);
    expect((await f.service().run(runId, manifest)).status).toBe('quarantined');
    expect(f.events).not.toContain('open');
  });
  it('Actor票だけが残り外部Preparedがない場合も受付状態を推測せず隔離する', async () => {
    const f = fixture();
    f.keys.pendingActorDeletionPage = () =>
      Promise.resolve({
        tickets: [
          {
            operationId: runId,
            reference: 'orphan-ref',
            version: 1,
            inventoryDigest: new Uint8Array(32),
            window: { dueAt: 1000, deadline: 86_401_000 },
          },
        ],
        nextCursor: null,
      });
    expect((await f.service().run(runId, manifest)).status).toBe('quarantined');
    expect(f.events).not.toContain('open');
  });
  it('外部公開のLedger MAC世代と現行Signerが違えば開通しない', async () => {
    const f = fixture();
    const original = f.control.publishEpoch.bind(f.control);
    f.control.publishEpoch = async (...args) => {
      const publication = await original(...args);
      return {
        ...publication,
        generations: publication.generations.map((generation) =>
          generation.purpose === 'deletion-ledger-mac'
            ? { ...generation, keyVersion: 'v2' }
            : generation,
        ),
      };
    };
    expect((await f.service().run(runId, manifest)).status).toBe('quarantined');
    expect(f.events).not.toContain('migrate');
    expect(f.events).not.toContain('open');
  });
  it('1001件目の孤児票も先行照合し、既知票のDB削除前に隔離する', async () => {
    const f = fixture();
    const tickets = new Map<string, AuthenticationDestructionTicket>();
    const pending = new Set<string>();
    const records = new WeakMap<
      AuthenticationVerifiedIntent,
      AuthenticationDeletionRecord
    >();
    const snapshots = new WeakMap<
      AuthenticationVerifiedHead,
      Map<string, AuthenticationVerifiedIntent>
    >();
    let currentHead = Object.freeze({}) as AuthenticationVerifiedHead;
    const initial = new Map<string, AuthenticationVerifiedIntent>();
    for (let index = 1; index <= 1001; index += 1) {
      const operationId =
        '00000000-0000-4000-8000-' + index.toString(16).padStart(12, '0');
      const ticket = {
        operationId,
        reference: 'opaque-' + String(index),
        version: 1,
        inventoryDigest: new Uint8Array(32),
        window: { dueAt: 1000, deadline: 86_401_000 },
      };
      tickets.set(operationId, ticket);
      pending.add(operationId);
      if (index <= 1000) {
        const intent = Object.freeze({}) as AuthenticationVerifiedIntent;
        initial.set(operationId, intent);
        records.set(intent, {
          kind: 'actor-deletion',
          operationId,
          actorDigestKeyVersion: 'v1',
          actorDigest: new Uint8Array(32),
          preparedAt: 1000,
          state: 'prepared',
          version: 1,
          targetReference: ticket.reference,
        });
      }
    }
    snapshots.set(currentHead, initial);
    f.ledger.latest = () => Promise.resolve(currentHead);
    f.ledger.intents = (head) => [...snapshots.get(head)!.values()];
    f.ledger.intent = (head, id) => snapshots.get(head)!.get(id) ?? null;
    f.ledger.resolve = (intent) => records.get(intent)!;
    f.ledger.append = (head, record) =>
      Promise.resolve().then(() => {
        if (record.kind !== 'actor-deletion') throw new Error('synthetic kind');
        const next = new Map(snapshots.get(head));
        const intent = Object.freeze({}) as AuthenticationVerifiedIntent;
        records.set(intent, record);
        next.set(record.operationId, intent);
        currentHead = Object.freeze({}) as AuthenticationVerifiedHead;
        snapshots.set(currentHead, next);
        return currentHead;
      });
    f.database.reapplyDeletion = (_fence, intent) =>
      Promise.resolve().then(() => {
        f.events.push('apply-known');
        return tickets.get(records.get(intent)!.operationId)!;
      });
    f.keys.pendingActorDeletions = (limit) =>
      Promise.resolve(
        [...pending].slice(0, limit).map((id) => tickets.get(id)!),
      );
    const cursors = new WeakMap<AuthenticationActorDeletionCursor, number>();
    f.keys.pendingActorDeletionPage = (cursor, limit) => {
      const start = cursor === null ? 0 : cursors.get(cursor)!;
      const all = [...pending].map((id) => tickets.get(id)!);
      const next =
        start + limit < all.length
          ? (Object.freeze({}) as AuthenticationActorDeletionCursor)
          : null;
      if (next !== null) cursors.set(next, start + limit);
      return Promise.resolve({
        tickets: all.slice(start, start + limit),
        nextCursor: next,
      });
    };
    f.keys.scopes = (ticket) =>
      Promise.resolve([
        { recordKind: 'google-identity', keyScopeId: ticket.operationId },
      ]);
    const proofs = new WeakMap<AuthenticationVerifiedDestruction, string>();
    f.keys.destroy = (ticket) => {
      const proof = Object.freeze({}) as AuthenticationVerifiedDestruction;
      proofs.set(proof, ticket.operationId);
      return Promise.resolve(proof);
    };
    f.keys.verify = (proof) => {
      const id = proofs.get(proof);
      if (id !== undefined) pending.delete(id);
      return Promise.resolve(id !== undefined);
    };
    expect((await f.service().run(runId, manifest)).status).toBe('quarantined');
    expect(f.events).not.toContain('apply-known');
    expect(f.events).not.toContain('migrate');
    expect(f.events).not.toContain('open');
  });
});
