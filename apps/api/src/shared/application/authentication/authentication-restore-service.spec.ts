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
import { RecipientCodeUnavailable } from './recipient-code-record.js';
import type { RecipientCodeRestoreDiscard } from './recipient-code-restore-discard.js';

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
/** 合成のコード破棄が返す全世代closure。 */
const restoreClosures = [
  {
    codeId: '77777777-7777-4777-8777-777777777777',
    operationId: runId,
    inventoryRevision: 'rev-1',
    evidenceReference: 'evidence/a',
  },
];
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
      verifyClosed: () => {
        return Promise.resolve().then(() => {
          events.push('verify-closed');
          return true;
        });
      },
      closedAt: () => {
        return Promise.resolve().then((): number | null => {
          events.push('closed-at');
          return 1500;
        });
      },
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
    // isolateへ渡された構成。Service設定とAdapter設定の一致確認の入力になる。
    const isolations: Parameters<
      AuthenticationRestoreDatabase['isolate']
    >[2][] = [];
    const database: AuthenticationRestoreDatabase = {
      isolate: (_fence, _manifest, configuration) => {
        return Promise.resolve().then(() => {
          events.push('isolate');
          isolations.push(configuration);
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
    // v11はコード参加の構成だけで受理する（ADR #278 論点6）。合成の破棄は固定closureを返す。
    const recipientCodes: RecipientCodeRestoreDiscard = {
      discard: () =>
        Promise.resolve().then(() => {
          events.push('codes');
          return restoreClosures;
        }),
    };
    /** 既定の受理版{6, 11}に、整合証跡とコード参加を足したv11の構成。 */
    const v11 = (
      now = 2000,
      overrides: Partial<
        Parameters<typeof createAuthenticationRestoreService>[0]
      > = {},
    ) => service(now, { consistency, recipientCodes, ...overrides });
    return {
      events,
      isolations,
      recipientCodes,
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
    expect(f.events.indexOf('close')).toBeLessThan(
      f.events.indexOf('verify-closed'),
    );
    expect(f.events.indexOf('verify-closed')).toBeLessThan(
      f.events.indexOf('closed-at'),
    );
    expect(f.events.indexOf('closed-at')).toBeLessThan(
      f.events.indexOf('isolate'),
    );
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
  it.each([
    ['記録なし（喪失）', null],
    ['負値', -1],
    ['非整数', 1500.5],
    ['NaN', Number.NaN],
    ['safe integer超過', Number.MAX_SAFE_INTEGER + 1],
    ['文字列', '1500' as unknown as number],
  ] as const)(
    '閉鎖UTCの記録が%sなら初回扱いせず隔離を維持する',
    async (_name, value) => {
      const f = fixture();
      let closes = 0;
      const originalClose = f.control.close.bind(f.control);
      f.control.close = async (...args) => {
        closes += 1;
        return originalClose(...args);
      };
      f.control.closedAt = () => Promise.resolve(value);
      expect((await f.service().run(runId, manifest)).status).toBe(
        'quarantined',
      );
      expect(closes).toBe(2);
      expect(f.events).toContain('quarantine');
      expect(f.events).not.toContain('isolate');
      expect(f.events).not.toContain('epoch');
      expect(f.events).not.toContain('open');
    },
  );
  it.each([0, Number.MAX_SAFE_INTEGER])(
    '閉鎖UTCの記録が受理境界%iなら既存どおり開通する',
    async (value) => {
      const f = fixture();
      f.control.closedAt = () => Promise.resolve(value);
      expect(await f.service().run(runId, manifest)).toEqual({
        status: 'complete',
      });
      expect(f.events).toContain('isolate');
      expect(f.events).not.toContain('quarantine');
    },
  );
  it('外部閉鎖を確認できなければ閉鎖UTCの記録を読まず隔離する', async () => {
    const f = fixture();
    f.control.verifyClosed = () => Promise.resolve(false);
    let reads = 0;
    f.control.closedAt = () => Promise.resolve(++reads);
    expect((await f.service().run(runId, manifest)).status).toBe('unavailable');
    expect(reads).toBe(0);
    expect(f.events).not.toContain('isolate');
  });
  it('閉鎖UTCの記録を取得できなければ隔離を維持する', async () => {
    const f = fixture();
    f.control.closedAt = () => Promise.reject(new Error('synthetic'));
    expect((await f.service().run(runId, manifest)).status).toBe('quarantined');
    expect(f.events).not.toContain('isolate');
    expect(f.events).not.toContain('open');
  });
  it('閉鎖UTCの記録喪失で外部再閉鎖を確認できなければunavailableを返す', async () => {
    const f = fixture();
    f.control.closedAt = () => Promise.resolve(null);
    let verifications = 0;
    f.control.verifyClosed = () => Promise.resolve(++verifications === 1);
    expect((await f.service().run(runId, manifest)).status).toBe('unavailable');
    expect(f.events).not.toContain('isolate');
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
      expect(p1).toBeLessThan(f.events.indexOf('reconcile'));
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
      const digest = createAuthenticationRestoreEvidenceDigest();
      const expected = digest.digest({
        fingerprint: new Uint8Array(32).fill(9),
        codeClosure: digest.codeClosure(restoreClosures),
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

    it.each([
      ['既定構成（証跡・コード参加なし）のv11', 'default', v11Manifest],
      ['受理版外の版', 'v11', { ...v11Manifest, schemaVersion: 12 }],
      ['証跡Port未注入', 'no-port', v11Manifest],
      ['必須Context集合が空', 'empty-contexts', v11Manifest],
      ['必須Context集合の重複', 'duplicate-contexts', v11Manifest],
      ['v11でrecoveryPointIdが欠落', 'v11', { ...manifest, schemaVersion: 11 }],
      [
        'v11で不正なrecoveryPointId',
        'v11',
        { ...v11Manifest, recoveryPointId: 'x' },
      ],
      [
        'v6でrecoveryPointIdが存在',
        'default',
        { ...manifest, recoveryPointId },
      ],
    ] as const)(
      '%sはisolate前に隔離する',
      async (_name, mode, input: AuthenticationBackupManifest) => {
        const f = fixture();
        const service =
          mode === 'default'
            ? f.service()
            : mode === 'no-port'
              ? f.service(2000, { recipientCodes: f.recipientCodes })
              : mode === 'empty-contexts' || mode === 'duplicate-contexts'
                ? f.v11(2000, {
                    consistency: {
                      ...f.consistency,
                      requiredContexts:
                        mode === 'empty-contexts'
                          ? []
                          : ['group-management', 'group-management'],
                    },
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
        'Contextの置換',
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
        // 削除再適用（Intent照合）にも進まない。
        expect(f.events).not.toContain('reconcile');
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

    it('必須Context集合の一部だけを覆う証跡（純粋な欠落）はP1で隔離する', async () => {
      const f = fixture();
      const service = f.v11(2000, {
        consistency: {
          ...f.consistency,
          requiredContexts: ['group-management', 'settlement'],
        },
      });
      expect((await service.run(runId, v11Manifest)).status).toBe(
        'quarantined',
      );
      expect(f.evidenceCalls).toHaveLength(1);
      expect(f.events).not.toContain('reconcile');
      for (const event of irreversible) expect(f.events).not.toContain(event);
    });

    it('registryが発行していないhandleはP1で隔離する', async () => {
      const f = fixture();
      const port = f.consistency.evidence;
      const forged: AuthenticationConsistencyEvidencePort = {
        verify: async (binding) => {
          await port.verify(binding);
          return Object.freeze({}) as Awaited<
            ReturnType<AuthenticationConsistencyEvidencePort['verify']>
          >;
        },
        consume: (handle, binding) => port.consume(handle, binding),
      };
      const service = f.v11(2000, {
        consistency: { ...f.consistency, evidence: forged },
      });
      expect((await service.run(runId, v11Manifest)).status).toBe(
        'quarantined',
      );
      expect(f.events).not.toContain('reconcile');
      for (const event of irreversible) expect(f.events).not.toContain(event);
    });

    it('P1で消費済みのhandleをP2で再利用させてもappend／開通しない', async () => {
      const f = fixture();
      const port = f.consistency.evidence;
      let first:
        | Awaited<ReturnType<AuthenticationConsistencyEvidencePort['verify']>>
        | undefined;
      const replaying: AuthenticationConsistencyEvidencePort = {
        verify: async (binding) => {
          const handle = await port.verify(binding);
          first ??= handle;
          return first;
        },
        consume: (handle, binding) => port.consume(handle, binding),
      };
      const service = f.v11(2000, {
        consistency: { ...f.consistency, evidence: replaying },
      });
      expect((await service.run(runId, v11Manifest)).status).toBe(
        'quarantined',
      );
      expect(f.evidenceCalls).toHaveLength(2);
      expect(f.events).toContain('epoch');
      expect(f.appended).toEqual([]);
      expect(f.events).not.toContain('open');
    });

    it('このrunの削除Complete appendでheadが進んだら、P1とP2のheadが一致する再試行で開通する', async () => {
      const f = fixture();
      const operationId = '77777777-7777-4777-8777-777777777777';
      const ticket: AuthenticationDestructionTicket = {
        operationId,
        reference: 'opaque-prepared',
        version: 1,
        inventoryDigest: new Uint8Array(32),
        window: { dueAt: 1000, deadline: 86_401_000 },
      };
      const prepared: AuthenticationDeletionRecord = {
        kind: 'actor-deletion',
        operationId,
        actorDigestKeyVersion: 'v1',
        actorDigest: new Uint8Array(32),
        preparedAt: 1000,
        state: 'prepared',
        version: 1,
        targetReference: ticket.reference,
      };
      // headごとのsequenceとIntentを持つ合成Ledger。
      const heads = new WeakMap<
        AuthenticationVerifiedHead,
        Readonly<{
          sequence: number;
          intents: Map<string, AuthenticationVerifiedIntent>;
        }>
      >();
      const records = new WeakMap<
        AuthenticationVerifiedIntent,
        AuthenticationDeletionRecord
      >();
      const issue = (
        sequence: number,
        intents: Map<string, AuthenticationVerifiedIntent>,
      ) => {
        const head = Object.freeze({}) as AuthenticationVerifiedHead;
        heads.set(head, { sequence, intents });
        return head;
      };
      const initialIntent = Object.freeze({}) as AuthenticationVerifiedIntent;
      records.set(initialIntent, prepared);
      let current = issue(0, new Map([[operationId, initialIntent]]));
      f.ledger.latest = () => Promise.resolve(current);
      f.ledger.head = (head) => {
        const sequence = heads.get(head)!.sequence;
        return {
          sequence,
          hash:
            sequence === 0
              ? '0'.repeat(64)
              : sequence.toString(16).padStart(64, '0'),
        };
      };
      f.ledger.intents = (head) => [...heads.get(head)!.intents.values()];
      f.ledger.intent = (head, id) => heads.get(head)!.intents.get(id) ?? null;
      f.ledger.resolve = (intent) => records.get(intent)!;
      f.ledger.append = (head, record) =>
        Promise.resolve().then(() => {
          const base = heads.get(head)!;
          const intents = new Map(base.intents);
          if (record.kind === 'actor-deletion') {
            const intent = Object.freeze({}) as AuthenticationVerifiedIntent;
            records.set(intent, record);
            intents.set(record.operationId, intent);
            f.events.push('deletion-complete');
          } else {
            f.appended.push(record);
            f.events.push('checkpoint-witness');
          }
          current = issue(base.sequence + 1, intents);
          return current;
        });
      f.database.reapplyDeletion = () =>
        Promise.resolve().then(() => {
          f.events.push('apply');
          return ticket;
        });
      f.keys.pendingActorDeletionPage = () =>
        Promise.resolve({ tickets: [ticket], nextCursor: null });
      f.keys.scopes = () =>
        Promise.resolve([
          { recordKind: 'google-identity', keyScopeId: operationId },
        ]);
      const proof = Object.freeze({}) as AuthenticationVerifiedDestruction;
      f.keys.destroy = () => Promise.resolve(proof);
      f.keys.verify = (value) => Promise.resolve(value === proof);
      expect(await f.v11().run(runId, v11Manifest)).toEqual({
        status: 'complete',
      });
      const p1 = f.events.indexOf('evidence');
      expect(p1).toBeLessThan(f.events.indexOf('apply'));
      expect(f.events.indexOf('apply')).toBeLessThan(
        f.events.indexOf('deletion-complete'),
      );
      // 1回目のP1（0）は削除Complete appendでheadが進んだのでP2へ進まない。
      // 2回目はP1とP2が同じhead（1）で一致し、P3はrecovery append後（2）。
      expect(f.evidenceCalls.map((call) => call.head.sequence)).toEqual([
        0, 1, 1, 2,
      ]);
      expect(
        f.events.filter((event) => event === 'deletion-complete'),
      ).toHaveLength(1);
      expect(f.appended).toHaveLength(1);
    });

    it('P1とP2のLedger headが一致しないまま再試行上限に達したら開通せず隔離する', async () => {
      const f = fixture();
      // 呼出しごとに別のhashを返し、P1時点とP2直前のheadを毎回食い違わせる。
      let calls = 0;
      f.ledger.head = () => {
        calls += 1;
        return { sequence: 1, hash: calls.toString(16).padStart(64, '0') };
      };
      expect((await f.v11().run(runId, v11Manifest)).status).toBe(
        'quarantined',
      );
      // 各試行のP1だけでP2へ進まず、既存の最大3回で打ち切る。
      expect(f.evidenceCalls).toHaveLength(3);
      expect(f.appended).toEqual([]);
      expect(f.events).not.toContain('active');
      expect(f.events).not.toContain('open');
      expect(f.events).toContain('quarantine');
    });

    it('consumeで消費できないhandle（別binding）は証跡として受理しない', async () => {
      const f = fixture();
      const port = f.consistency.evidence;
      const forged: AuthenticationConsistencyEvidencePort = {
        verify: (binding) =>
          port.verify({ ...binding, runId: otherRecoveryPointId }),
        consume: (handle, binding) => port.consume(handle, binding),
      };
      const service = f.v11(2000, {
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
        const service = f.v11(2000, {
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

  describe('受理版{6, 11}と構成確認（ADR #278 論点6）', () => {
    const recoveryPointId = '44444444-4444-4444-8444-444444444444';
    const v11Manifest: AuthenticationBackupManifest = {
      ...manifest,
      schemaVersion: 11,
      recoveryPointId,
    };
    const stoppedBeforeIsolate = (f: ReturnType<typeof fixture>) => {
      expect(f.events).not.toContain('isolate');
      expect(f.events).toContain('quarantine');
      for (const event of ['evidence', 'reconcile', 'codes', 'epoch'])
        expect(f.events).not.toContain(event);
    };

    it('既定の受理版で、v6は不参加、v11は参加の構成をisolateへ渡して開通する', async () => {
      const v6 = fixture();
      expect((await v6.service().run(runId, manifest)).status).toBe('complete');
      expect(v6.isolations).toEqual([{ recipientCodes: false }]);
      const v11 = fixture();
      expect((await v11.v11().run(runId, v11Manifest)).status).toBe('complete');
      expect(v11.isolations).toEqual([{ recipientCodes: true }]);
    });

    // 11未満は不参加、11以上は参加の構成で走らせ、版とコード参加の一致確認では止まらない入力にする。
    // 停止の原因を受理版のallowlistに限定する。
    it.each([7, 8, 9, 10, 12])(
      '既定の受理版にない版%iはisolate前に隔離する',
      async (schemaVersion) => {
        const f = fixture();
        const service = schemaVersion >= 11 ? f.v11() : f.service();
        const input =
          schemaVersion >= 11
            ? { ...v11Manifest, schemaVersion }
            : { ...manifest, schemaVersion };
        expect((await service.run(runId, input)).status).toBe('quarantined');
        stoppedBeforeIsolate(f);
        // 同じ構成で受理版へ加えると先へ進むので、止めたのはallowlistである。
        const widened = fixture();
        await (
          schemaVersion >= 11
            ? widened.v11(2000, {
                acceptedSchemaVersions: [6, 11, schemaVersion],
              })
            : widened.service(2000, {
                acceptedSchemaVersions: [6, 11, schemaVersion],
              })
        ).run(runId, input);
        expect(widened.events).toContain('isolate');
      },
    );

    it.each([
      ['証跡必須の最小版を12へ上げても', { consistencyRequiredFrom: 12 }],
      [
        '証跡必須の最小版を上限値にしても',
        { consistencyRequiredFrom: Number.MAX_SAFE_INTEGER },
      ],
    ])('コード参加のv11は、%s証跡なしで受理しない', async (_name, override) => {
      // Port未注入なら、証跡を要求してisolate前に隔離する。
      const missing = fixture();
      expect(
        (
          await missing
            .v11(2000, { ...override, consistency: undefined })
            .run(runId, v11Manifest)
        ).status,
      ).toBe('quarantined');
      stoppedBeforeIsolate(missing);
      // 注入されていれば、P1〜P3の証跡を揃えて開通する。
      const present = fixture();
      expect(
        (await present.v11(2000, override).run(runId, v11Manifest)).status,
      ).toBe('complete');
      expect(present.evidenceCalls).toHaveLength(3);
    });

    it('v6はコード参加（接続済み）の構成では受理せず、isolate前に隔離する', async () => {
      const f = fixture();
      expect((await f.v11().run(runId, manifest)).status).toBe('quarantined');
      stoppedBeforeIsolate(f);
      // 証跡必須の最小版を上げても、接続済みでv6を受理する経路はない（副論点A）。
      const raised = fixture();
      expect(
        (
          await raised
            .v11(2000, { consistencyRequiredFrom: 12 })
            .run(runId, manifest)
        ).status,
      ).toBe('quarantined');
      stoppedBeforeIsolate(raised);
    });

    it('v11はコード不参加の構成では受理せず、isolate前に隔離する', async () => {
      const f = fixture();
      expect(
        (
          await f
            .service(2000, { consistency: f.consistency })
            .run(runId, v11Manifest)
        ).status,
      ).toBe('quarantined');
      stoppedBeforeIsolate(f);
    });

    it('PG Adapterが構成の不一致でisolateを拒否すれば、破棄やepoch公開へ進まない', async () => {
      const f = fixture();
      f.database.isolate = () =>
        Promise.resolve().then(() => {
          f.events.push('isolate');
          throw new Error('synthetic configuration mismatch');
        });
      expect((await f.v11().run(runId, v11Manifest)).status).toBe(
        'quarantined',
      );
      for (const event of ['evidence', 'reconcile', 'codes', 'epoch'])
        expect(f.events).not.toContain(event);
    });
  });

  describe('全招待コードの破棄への参加（コード参加の構成）', () => {
    const closures = restoreClosures;
    const v11Manifest: AuthenticationBackupManifest = {
      ...manifest,
      schemaVersion: 11,
      recoveryPointId: '44444444-4444-4444-8444-444444444444',
    };
    const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
    const participating = () => {
      const f = fixture();
      const calls: Parameters<RecipientCodeRestoreDiscard['discard']>[0][] = [];
      let answer: () => Promise<readonly (typeof closures)[number][]> = () =>
        Promise.resolve(closures);
      const recipientCodes: RecipientCodeRestoreDiscard = {
        discard: (input) => {
          calls.push(input);
          f.events.push('codes');
          return answer();
        },
      };
      return {
        ...f,
        calls,
        fail: () => {
          answer = () => Promise.reject(new RecipientCodeUnavailable());
        },
        // v11はコード参加と整合証跡が揃う構成だけで受理する（ADR #278 論点6）。
        codes: (now = 2000) => f.v11(now, { recipientCodes }),
      };
    };

    it('Credential破棄の後、epoch公開の前に、同runのfenceと初回閉鎖UTCで破棄する', async () => {
      const f = participating();
      expect(await f.codes().run(runId, v11Manifest)).toEqual({
        status: 'complete',
      });
      expect(f.events.indexOf('discard')).toBeLessThan(
        f.events.indexOf('codes'),
      );
      expect(f.events.indexOf('codes')).toBeLessThan(f.events.indexOf('epoch'));
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].runId).toBe(runId);
      expect(f.calls[0].closedAt).toBe(1500);
      expect(f.calls[0].fence).toBeDefined();
    });

    it('closure集合のdigestをevidenceDigestの要素2へ入れて開通する', async () => {
      const f = participating();
      expect((await f.codes().run(runId, v11Manifest)).status).toBe('complete');
      const digest = createAuthenticationRestoreEvidenceDigest();
      const expected = digest.digest({
        fingerprint: new Uint8Array(32).fill(9),
        codeClosure: digest.codeClosure(closures),
        consistency: evidenceFor(v11Manifest.recoveryPointId!),
      });
      expect(f.appended.map((record) => hex(record.evidenceDigest))).toEqual([
        hex(expected),
      ]);
      expect(f.opened.map(hex)).toEqual([hex(expected)]);
      // コード不参加のgolden（要素2がpresence=0）とは異なる値になる。
      expect(hex(expected)).not.toBe(
        '8ea7b7301c1cd21bc1d744b1bd4f7d597480eaca478f570e3825af31caf6eda6',
      );
    });

    it('コードの破棄が成立しなければepochを公開せず隔離する', async () => {
      const f = participating();
      f.fail();
      expect((await f.codes().run(runId, v11Manifest)).status).toBe(
        'quarantined',
      );
      for (const event of ['epoch', 'migrate', 'open'])
        expect(f.events).not.toContain(event);
      expect(f.events).toContain('quarantine');
    });

    it('証跡P1が成立しなければコードの登録・破棄に進まない', async () => {
      const f = participating();
      f.setEvidence(() => []);
      expect((await f.codes().run(runId, v11Manifest)).status).toBe(
        'quarantined',
      );
      expect(f.calls).toEqual([]);
    });

    it('証跡が揃えばP1の後にコードを破棄し、証跡とcode closureの両方をdigestへ入れる', async () => {
      const f = participating();
      expect((await f.codes().run(runId, v11Manifest)).status).toBe('complete');
      expect(f.events.indexOf('evidence')).toBeLessThan(
        f.events.indexOf('codes'),
      );
      const digest = createAuthenticationRestoreEvidenceDigest();
      expect(f.opened.map(hex)).toEqual([
        hex(
          digest.digest({
            fingerprint: new Uint8Array(32).fill(9),
            codeClosure: digest.codeClosure(closures),
            consistency: evidenceFor(v11Manifest.recoveryPointId!),
          }),
        ),
      ]);
    });

    it.each([
      ['Restore ServiceのClockより1ms未来', 2001],
      ['大きく未来', Number.MAX_SAFE_INTEGER],
    ])(
      '初回閉鎖UTCが%sなら、起点に使わずisolate前に隔離する',
      async (_name, value) => {
        const f = participating();
        f.control.closedAt = () => Promise.resolve(value);
        expect((await f.codes(2000).run(runId, v11Manifest)).status).toBe(
          'quarantined',
        );
        expect(f.events).not.toContain('isolate');
        expect(f.calls).toEqual([]);
      },
    );

    it('初回閉鎖UTCが現在時刻と等しければ受理する', async () => {
      const f = participating();
      f.control.closedAt = () => Promise.resolve(2000);
      expect((await f.codes(2000).run(runId, v11Manifest)).status).toBe(
        'complete',
      );
      expect(f.calls[0].closedAt).toBe(2000);
    });

    it('Ledger headが進んだ再試行でも、同じ閉鎖UTCで破棄をやり直してから開通する', async () => {
      const f = participating();
      let refreshes = 0;
      const latest = f.ledger.latest.bind(f.ledger);
      const head = f.ledger.head.bind(f.ledger);
      // 1回目のappend直前の再確認だけheadを進め、手順3からやり直させる。
      // sequence 0のhashは0固定なので、進んだheadはsequence 1で表す（証跡のbinding検査を通す）。
      f.ledger.latest = (input) => {
        refreshes += 1;
        return latest(input);
      };
      f.ledger.head = (verified) => {
        const value = head(verified);
        return refreshes === 2
          ? { sequence: value.sequence + 1, hash: 'f'.repeat(64) }
          : value;
      };
      expect((await f.codes().run(runId, v11Manifest)).status).toBe('complete');
      expect(f.calls.length).toBeGreaterThanOrEqual(2);
      expect(new Set(f.calls.map((call) => call.closedAt))).toEqual(
        new Set([1500]),
      );
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
