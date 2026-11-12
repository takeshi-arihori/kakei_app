import { describe, expect, it, vi } from 'vitest';

import {
  createAuthenticationConsistencyEvidenceRegistry,
  createAuthenticationRestoreEvidenceDigest,
} from '../../infrastructure/authentication/authentication-consistency-evidence.js';
import type {
  AuthenticationConsistencyBinding,
  AuthenticationConsistencyEvidence,
  AuthenticationConsistencyEvidencePort,
} from './authentication-consistency-evidence.js';

import type {
  AuthenticationCleanupDatabase,
  AuthenticationDeletionDatabase,
  AuthenticationRestoreDatabase,
} from './authentication-maintenance-database.js';
import type {
  AuthenticationBackupManifest,
  AuthenticationKeyDestructionPort,
  AuthenticationActorDeletionCursor,
  AuthenticationDeletionRecord,
  AuthenticationDestructionTicket,
  AuthenticationLedgerEvidence,
  AuthenticationRestoreFence,
  AuthenticationVerifiedHead,
  AuthenticationVerifiedIntent,
  AuthenticationVerifiedDestruction,
  AuthenticationRecoveryRecord,
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
    const evidenceDigest = createAuthenticationRestoreEvidenceDigest();
    // 合成の証跡Source。呼出しごとのbindingを記録し、応答はTestが差し替える。
    const evidenceCalls: AuthenticationConsistencyBinding[] = [];
    let evidenceAnswer = (
      _call: number,
      binding: AuthenticationConsistencyBinding,
    ): readonly AuthenticationConsistencyEvidence[] => [
      {
        recoveryPointId: binding.recoveryPointId,
        contexts: ['group-management'],
        consistencyDigest: new Uint8Array(32).fill(7),
      },
    ];
    const consistency = {
      evidence: createAuthenticationConsistencyEvidenceRegistry({
        source: {
          verify: (binding) =>
            Promise.resolve().then(() => {
              evidenceCalls.push(binding);
              events.push('evidence');
              return evidenceAnswer(evidenceCalls.length, binding);
            }),
        },
      }),
      requiredContexts: ['group-management'] as readonly string[],
    };
    const appended: AuthenticationRecoveryRecord[] = [];
    const opened: Uint8Array[] = [];
    const originalAppend = ledger.append.bind(ledger);
    ledger.append = (current, record) => {
      if (record.kind === 'recovery') appended.push(record);
      return originalAppend(current, record);
    };
    const originalOpen = control.open.bind(control);
    control.open = (input, value, expected, digest) => {
      opened.push(Uint8Array.from(digest));
      return originalOpen(input, value, expected, digest);
    };
    const service = (
      now = 2000,
      overrides: Partial<
        Parameters<typeof createAuthenticationRestoreService>[0]
      > = {},
    ) =>
      createAuthenticationRestoreService({
        control,
        database,
        deletion,
        cleanup,
        ledger,
        keys,
        monitor,
        evidenceDigest,
        clock: { now: () => now },
        ...overrides,
      });
    const v11 = (now = 2000) =>
      service(now, { acceptedSchemaVersions: [6, 11], consistency });
    return {
      events,
      evidenceCalls,
      setEvidence: (answer: typeof evidenceAnswer) => {
        evidenceAnswer = answer;
      },
      consistency,
      appended,
      opened,
      v11,
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

  describe('Restoreの全Context整合証跡（受理版11を注入した構成）', () => {
    const recoveryPointId = '44444444-4444-4444-8444-444444444444';
    const otherRecoveryPointId = '66666666-6666-4666-8666-666666666666';
    const v11Manifest: AuthenticationBackupManifest = {
      ...manifest,
      schemaVersion: 11,
      recoveryPointId,
    };
    const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
    const irreversible = ['discard', 'epoch', 'migrate'] as const;

    it('P1〜P3が揃った場合だけ開通し、証跡をevidenceDigestへ束縛する', async () => {
      const f = fixture();
      expect(await f.v11().run(runId, v11Manifest)).toEqual({
        status: 'complete',
      });
      const positions = f.events
        .map((event, index) => (event === 'evidence' ? index : -1))
        .filter((index) => index >= 0);
      expect(positions).toHaveLength(3);
      const [p1, p2, p3] = positions;
      expect(f.events.indexOf('isolate')).toBeLessThan(p1);
      expect(p1).toBeLessThan(f.events.indexOf('discard'));
      expect(f.events.indexOf('migrate')).toBeLessThan(p2);
      expect(p2).toBeLessThan(f.events.indexOf('checkpoint-witness'));
      expect(f.events.indexOf('checkpoint-witness')).toBeLessThan(p3);
      expect(p3).toBeLessThan(f.events.indexOf('active'));
      // P1／P2はappend前のhead、P3はappend後のheadへ束縛する。
      expect(f.evidenceCalls.map((call) => call.head.sequence)).toEqual([
        0, 0, 1,
      ]);
      expect(
        f.evidenceCalls.every(
          (call) =>
            call.runId === runId && call.recoveryPointId === recoveryPointId,
        ),
      ).toBe(true);
      const expected = createAuthenticationRestoreEvidenceDigest().digest({
        fingerprint: new Uint8Array(32).fill(9),
        codeClosure: null,
        consistency: {
          recoveryPointId,
          contexts: ['group-management'],
          consistencyDigest: new Uint8Array(32).fill(7),
        },
      });
      expect(f.appended.map((record) => hex(record.evidenceDigest))).toEqual([
        hex(expected),
      ]);
      expect(f.opened.map(hex)).toEqual([hex(expected)]);
    });

    it('v6は証跡を要求せず、evidenceDigestを新書式のgoldenにする', async () => {
      const f = fixture();
      expect(await f.service().run(runId, manifest)).toEqual({
        status: 'complete',
      });
      expect(f.evidenceCalls).toEqual([]);
      // fingerprint 0x09×32、要素2／3がpresence=0の固定値（Python独立実装）。
      const golden =
        '8ea7b7301c1cd21bc1d744b1bd4f7d597480eaca478f570e3825af31caf6eda6';
      expect(f.appended.map((record) => hex(record.evidenceDigest))).toEqual([
        golden,
      ]);
      expect(f.opened.map(hex)).toEqual([golden]);
    });

    it('受理版11を注入した構成でもv6は証跡なしで開通する', async () => {
      const f = fixture();
      expect((await f.v11().run(runId, manifest)).status).toBe('complete');
      expect(f.evidenceCalls).toEqual([]);
    });

    it.each([
      ['既定構成（受理版6）のv11', 'default', v11Manifest],
      ['受理版外の版', 'v11', { ...v11Manifest, schemaVersion: 12 }],
      ['証跡Port未注入', 'no-port', v11Manifest],
      ['必須Context集合が空', 'empty-contexts', v11Manifest],
      ['v11でrecoveryPointIdが欠落', 'v11', { ...manifest, schemaVersion: 11 }],
      [
        'v11で不正なrecoveryPointId',
        'v11',
        { ...v11Manifest, recoveryPointId: 'x' },
      ],
      ['v6でrecoveryPointIdが存在', 'v11', { ...manifest, recoveryPointId }],
    ] as const)(
      '%sはisolate前に隔離する',
      async (_name, mode, input: AuthenticationBackupManifest) => {
        const f = fixture();
        const service =
          mode === 'default'
            ? f.service()
            : mode === 'no-port'
              ? f.service(2000, { acceptedSchemaVersions: [6, 11] })
              : mode === 'empty-contexts'
                ? f.service(2000, {
                    acceptedSchemaVersions: [6, 11],
                    consistency: { ...f.consistency, requiredContexts: [] },
                  })
                : f.v11();
        expect((await service.run(runId, input)).status).toBe('quarantined');
        expect(f.events).not.toContain('isolate');
        expect(f.events).toContain('quarantine');
        expect(f.evidenceCalls).toEqual([]);
      },
    );

    it.each([
      ['証跡の不足', () => []],
      [
        '複数一致',
        (_call: number, binding: AuthenticationConsistencyBinding) => [
          evidenceFor(binding.recoveryPointId),
          evidenceFor(binding.recoveryPointId),
        ],
      ],
      ['recoveryPointIdの不一致', () => [evidenceFor(otherRecoveryPointId)]],
      [
        'Contextの欠落',
        (_call: number, binding: AuthenticationConsistencyBinding) => [
          { ...evidenceFor(binding.recoveryPointId), contexts: ['settlement'] },
        ],
      ],
      [
        '余分なContext',
        (_call: number, binding: AuthenticationConsistencyBinding) => [
          {
            ...evidenceFor(binding.recoveryPointId),
            contexts: ['group-management', 'settlement'],
          },
        ],
      ],
      [
        'Source障害',
        () => {
          throw new Error('synthetic evidence failure');
        },
      ],
    ] as const)(
      'P1の%sでは削除再適用・破棄・epoch公開の前に隔離する',
      async (_name, answer) => {
        const f = fixture();
        f.setEvidence(answer);
        expect((await f.v11().run(runId, v11Manifest)).status).toBe(
          'quarantined',
        );
        expect(f.evidenceCalls).toHaveLength(1);
        for (const event of irreversible) expect(f.events).not.toContain(event);
        expect(f.events).not.toContain('open');
        expect(f.events).toContain('quarantine');
      },
    );

    it.each([
      [
        'consistencyDigestの変化',
        { consistencyDigest: new Uint8Array(32).fill(8) },
      ],
      ['Context集合の変化', { contexts: ['group-management', 'settlement'] }],
      ['証跡の不足', null],
    ] as const)(
      'P2で%sを検出したらrecovery checkpointをappendせず隔離する',
      async (_name, change) => {
        const f = fixture();
        f.setEvidence((call, binding) =>
          call === 2
            ? change === null
              ? []
              : [{ ...evidenceFor(binding.recoveryPointId), ...change }]
            : [evidenceFor(binding.recoveryPointId)],
        );
        expect((await f.v11().run(runId, v11Manifest)).status).toBe(
          'quarantined',
        );
        expect(f.evidenceCalls).toHaveLength(2);
        expect(f.events).toContain('epoch');
        expect(f.appended).toEqual([]);
        expect(f.events).not.toContain('active');
        expect(f.events).not.toContain('open');
      },
    );

    it.each([
      [
        'consistencyDigestの変化',
        { consistencyDigest: new Uint8Array(32).fill(8) },
      ],
      ['Context集合の変化', { contexts: ['group-management', 'settlement'] }],
      ['証跡の不足', null],
    ] as const)(
      'P3で%sを検出したらappend済みでもactivate／openせず再閉鎖して隔離する',
      async (_name, change) => {
        const f = fixture();
        f.setEvidence((call, binding) =>
          call === 3
            ? change === null
              ? []
              : [{ ...evidenceFor(binding.recoveryPointId), ...change }]
            : [evidenceFor(binding.recoveryPointId)],
        );
        expect((await f.v11().run(runId, v11Manifest)).status).toBe(
          'quarantined',
        );
        expect(f.appended).toHaveLength(1);
        expect(f.events).not.toContain('active');
        expect(f.events).not.toContain('open');
        expect(f.events.filter((event) => event === 'close')).toHaveLength(2);
      },
    );

    it('Ledger headが進んだら再試行でP1とP2を新しいhandleで再実行する', async () => {
      const f = fixture();
      let advanced = false;
      const originalHead = f.ledger.head.bind(f.ledger);
      let latestCalls = 0;
      const originalLatest = f.ledger.latest.bind(f.ledger);
      f.ledger.latest = (input) => {
        latestCalls += 1;
        return originalLatest(input);
      };
      // 2回目のlatest（append直前の再確認）だけ別headを返し、手順3へ戻す。
      f.ledger.head = (head) => {
        const value = originalHead(head);
        if (latestCalls === 2 && !advanced) {
          advanced = true;
          return { sequence: value.sequence, hash: 'b'.repeat(64) };
        }
        return value;
      };
      expect((await f.v11().run(runId, v11Manifest)).status).toBe('complete');
      expect(f.evidenceCalls).toHaveLength(5);
      expect(f.appended).toHaveLength(1);
    });

    it('consumeで消費できないhandle（別binding）は証跡として受理しない', async () => {
      const f = fixture();
      const port = f.consistency.evidence;
      const forged: AuthenticationConsistencyEvidencePort = {
        verify: (binding) =>
          port.verify({ ...binding, runId: otherRecoveryPointId }),
        consume: (handle, binding) => port.consume(handle, binding),
      };
      const service = f.service(2000, {
        acceptedSchemaVersions: [6, 11],
        consistency: { ...f.consistency, evidence: forged },
      });
      expect((await service.run(runId, v11Manifest)).status).toBe(
        'quarantined',
      );
      for (const event of irreversible) expect(f.events).not.toContain(event);
    });

    it('Portが別の復旧点や不正長のdigestを返しても受理しない', async () => {
      for (const evidence of [
        evidenceFor(otherRecoveryPointId),
        {
          ...evidenceFor(recoveryPointId),
          consistencyDigest: new Uint8Array(31),
        },
      ]) {
        const f = fixture();
        const service = f.service(2000, {
          acceptedSchemaVersions: [6, 11],
          consistency: {
            ...f.consistency,
            evidence: {
              verify: () =>
                Promise.resolve(
                  Object.freeze({}) as Awaited<
                    ReturnType<AuthenticationConsistencyEvidencePort['verify']>
                  >,
                ),
              consume: () => evidence,
            },
          },
        });
        expect((await service.run(runId, v11Manifest)).status).toBe(
          'quarantined',
        );
        for (const event of irreversible) expect(f.events).not.toContain(event);
      }
    });
  });
});

function evidenceFor(
  recoveryPointId: string,
): AuthenticationConsistencyEvidence {
  return {
    recoveryPointId,
    contexts: ['group-management'],
    consistencyDigest: new Uint8Array(32).fill(7),
  };
}
