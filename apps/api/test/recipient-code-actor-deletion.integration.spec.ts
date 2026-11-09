import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { OperationId } from '../src/group-management/application/group-repository.js';
import type { AuthenticationMaintenanceMonitor } from '../src/shared/application/authentication/authentication-maintenance-ports.js';
import { createAuthenticationDeletionService } from '../src/shared/application/authentication/authentication-deletion-service.js';
import { createRecipientInvitationRuntime } from '../src/recipient-invitation-runtime.js';
import { createRecipientCodeActorDeletion } from '../src/shared/application/authentication/recipient-code-actor-deletion.js';
import { createRecipientCodeCleanupService } from '../src/shared/application/authentication/recipient-code-cleanup-service.js';
import { guardRecipientCodeMaintenance } from '../src/shared/application/authentication/recipient-code-maintenance-guard.js';
import { createPostgresAuthenticationCleanup } from '../src/shared/infrastructure/authentication/postgres/postgres-authentication-cleanup.js';
import { createPostgresAuthenticationDeletion } from '../src/shared/infrastructure/authentication/postgres/postgres-authentication-deletion.js';
import { createPostgresRecipientCodeCleanup } from '../src/shared/infrastructure/authentication/postgres/postgres-recipient-code-cleanup.js';
import { syntheticAuthenticationLedger } from '../src/shared/infrastructure/authentication/test/authentication-maintenance-ledger-fixtures.js';
import { syntheticAuthenticationManagedKeys } from '../src/shared/infrastructure/authentication/test/authentication-maintenance-key-fixtures.js';
import { syntheticRecipientCodeManagedKeys } from '../src/shared/infrastructure/authentication/test/recipient-code-maintenance-fixtures.js';
import {
  actors,
  barrier,
  RecipientInvitationFixture,
  sessionSecret,
} from './support/recipient-invitation-fixture.js';

const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';
const limits = {
  lockTimeoutMs: 1500,
  statementTimeoutMs: 3000,
  transactionTimeoutMs: 10000,
};
const day = 86_400_000;
const issuer = sessionSecret(20);

describe('Actor削除へのコード参加（実PG17＋合成Provider）', () => {
  const f = new RecipientInvitationFixture(url);
  const holder = new Client({ connectionString: url });
  let codeKeys: ReturnType<typeof syntheticRecipientCodeManagedKeys>;
  let managed: ReturnType<typeof syntheticAuthenticationManagedKeys>;
  let ledger: ReturnType<typeof syntheticAuthenticationLedger>;
  let runtime: ReturnType<typeof createRecipientInvitationRuntime>;
  let monitor: {
    record: ReturnType<
      typeof vi.fn<AuthenticationMaintenanceMonitor['record']>
    >;
  };
  let service: ReturnType<typeof createAuthenticationDeletionService>;
  let cleanup: ReturnType<typeof createRecipientCodeCleanupService>;
  const actorId = actors.recipient;

  beforeAll(async () => {
    await f.initialize();
    await holder.connect();
    await holder.query(`SET search_path TO ${f.schema}`);
  });
  afterEach(async () => {
    await holder.query('ROLLBACK');
  });
  afterAll(async () => {
    await holder.end();
    await f.dispose();
  });
  const compose = (participating: boolean) => {
    const pool = f.connections();
    const codeDatabase = createPostgresRecipientCodeCleanup({
      pool,
      crypto: f.crypto,
      digests: f.digests,
      clock: f.clock,
      limits,
    });
    const maintenance = guardRecipientCodeMaintenance(codeKeys);
    cleanup = createRecipientCodeCleanupService({
      maintenance,
      database: codeDatabase,
      clock: f.clock,
      nextOperationId: randomUUID,
      monitor,
    });
    return createAuthenticationDeletionService({
      database: createPostgresAuthenticationDeletion({
        pool,
        codec: f.authCodec,
        digests: f.digests,
        keys: managed.keys,
        clock: f.clock,
        ledger: ledger.evidence,
      }),
      cleanup: createPostgresAuthenticationCleanup({
        pool,
        codec: f.authCodec,
        digests: f.digests,
        keys: managed.keys,
        clock: f.clock,
      }),
      keys: managed.keys,
      ledger: ledger.evidence,
      clock: f.clock,
      monitor,
      newOperationId: randomUUID,
      deletedActor: async (subjectId, keyVersion) =>
        (await f.digests.deletedActor({ subjectId, keyVersion })).bytes,
      recipientCodes: participating
        ? createRecipientCodeActorDeletion({
            maintenance,
            database: codeDatabase,
          })
        : undefined,
    });
  };
  beforeEach(async () => {
    await f.reset();
    codeKeys = syntheticRecipientCodeManagedKeys();
    managed = syntheticAuthenticationManagedKeys();
    ledger = syntheticAuthenticationLedger();
    monitor = {
      record: vi.fn<AuthenticationMaintenanceMonitor['record']>(() =>
        Promise.resolve(),
      ),
    };
    const { stateKeys } = f.runtimeOptions.authentication;
    runtime = createRecipientInvitationRuntime({
      ...f.runtimeOptions,
      authentication: {
        ...f.runtimeOptions.authentication,
        stateKeys: {
          allocate: async (input) => {
            const answer = await codeKeys.allocation.allocate(input);
            if (answer.status === 'allocated') await stateKeys.allocate(input);
            return answer;
          },
        },
      },
    });
    service = compose(true);
  });

  const issue = async (session = issuer) => {
    const issued = await runtime.issue(session, f.clock);
    if (issued.status !== 'issued') throw new Error('合成: 発行失敗');
    const row = (await f.codes()).find((x) => x.codeId === issued.codeId)!;
    return row;
  };
  const rowCount = async (codeId: string) =>
    (
      await f.admin.query(
        'SELECT 1 FROM authentication.recipient_code WHERE code_id=$1',
        [codeId],
      )
    ).rowCount;
  const destroyed = async (codeId: string) =>
    new Set(
      (await codeKeys.lifecycle.inventory(codeId)).generations.map(
        (generation) => generation.lifecycle,
      ),
    );
  const keyStatus = async () =>
    (
      await f.admin.query<{ status: string }>(
        'SELECT status FROM authentication.key_state',
      )
    ).rows[0].status;
  const intentStates = async () =>
    (
      await f.admin.query<{ state: string }>(
        'SELECT state FROM authentication.deletion_intent',
      )
    ).rows.map((row) => row.state);
  const actorState = async () =>
    (
      await f.admin.query<{ state: string }>(
        'SELECT state FROM authentication.actor WHERE actor_id=$1',
        [actorId],
      )
    ).rows[0].state;
  const expectClosed = async (codeId: string) => {
    expect(await rowCount(codeId)).toBe(0);
    expect(await destroyed(codeId)).toEqual(new Set(['destroyed']));
    expect((await codeKeys.maintenance.find(codeId))?.state).toBe('complete');
  };
  const beganOperation = (result: { operationId: string | null }) => {
    if (result.operationId === null) throw new Error('合成: operationなし');
    return result.operationId;
  };
  const scopeOf = (row: { codeId: string; recipientActorId: string }) => ({
    codeId: row.codeId,
    recipientActorId: row.recipientActorId,
  });

  /** 実コード利用と同じGroupへの作成要求。呼び直すと同じoperationの再送になる。 */
  const createInput = (code: Parameters<typeof runtime.create>[0]['code']) => ({
    code,
    groupId: f.groupId,
    operationId: OperationId.from(`deletion-${randomUUID()}`),
    sessionSecret: sessionSecret(10),
    expectedVersion: 1,
  });
  /** 実操作のSQL直前で止め、Actor Lockを保持した接続を作る。 */
  const pauseAt = (pattern: RegExp) => {
    const entered = barrier();
    const resume = barrier();
    const state = { pid: 0 };
    f.intercept = async (event, run) => {
      if (state.pid === 0 && pattern.test(event.sql)) {
        state.pid = event.pid;
        entered.release();
        await resume.entered;
      }
      return run();
    };
    return { entered: entered.entered, resume: resume.release, state };
  };
  const waitForSql = async (pattern: RegExp) => {
    const limit = Date.now() + 4000;
    while (Date.now() < limit) {
      const found = f.sqls.find((event) => pattern.test(event.sql));
      if (found) return found.pid;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('合成: SQL未到達');
  };

  it('全世代のclosureと0-rowまで確定し、別Actorのコードを巻き込まない', async () => {
    const code = await issue();
    await codeKeys.allocation.allocate({
      ...scopeOf(code),
      keyVersion: 'v2',
      expiresAt: code.expiresAt,
    });
    const other = await issue(sessionSecret(10));
    const result = await service.begin(actorId);
    expect(result.status).toBe('complete');
    await expectClosed(code.codeId);
    expect(
      (await codeKeys.lifecycle.inventory(code.codeId)).generations,
    ).toHaveLength(2);
    const ticket = await codeKeys.maintenance.find(code.codeId);
    expect(ticket).toMatchObject({
      operationId: result.operationId,
      adoptingOperationIds: [],
    });
    expect(ticket?.window.dueAt).toBeLessThanOrEqual(f.now);
    expect(await rowCount(other.codeId)).toBe(1);
    expect(await destroyed(other.codeId)).toEqual(new Set(['current']));
    expect(await codeKeys.maintenance.find(other.codeId)).toBeNull();
    expect(await actorState()).toBe('disabled');
    expect(await intentStates()).toEqual(['complete']);
    expect(monitor.record).toHaveBeenCalledWith({
      operation: 'deletion',
      code: 'OK',
      oldest: null,
    });
  });

  it('コードのないActorの削除はticketを作らず完了する', async () => {
    await expect(service.begin(actors.member)).resolves.toMatchObject({
      status: 'complete',
    });
    expect(await intentStates()).toEqual(['complete']);
  });

  it('実消費で作られたGM Invitation・成功結果・消費Auditとproof鍵を変えず、成功再送できる', async () => {
    await f.seed(f.groupId, actors.owner);
    const issued = await runtime.issue(issuer, f.clock);
    if (issued.status !== 'issued') throw new Error('合成: 発行失敗');
    const input = createInput(issued.code);
    const result = await runtime.create(input);
    expect(result.status).toBe('authenticated');
    const before = await f.snapshot();
    for (const name of [
      'group_invitation_record',
      'group_operation_result_record',
      'consumeAudit',
    ])
      expect(before[name]).not.toEqual([]);
    const proofs = new Map(f.proofMaterials);
    f.sqls = [];
    expect((await service.begin(actorId)).status).toBe('complete');
    expect(f.sqls.filter((e) => /\bgroup_/.test(e.sql))).toEqual([]);
    const after = await f.snapshot();
    for (const name of Object.keys(before))
      if (name !== 'authentication.recipient_code')
        expect(after[name]).toEqual(before[name]);
    expect(after['authentication.recipient_code']).toEqual([]);
    expect(f.proofMaterials).toEqual(proofs);
    // 宛先Actorの削除とコード行の除去の後も、保存世代で同じ最小結果を再送する。
    await expect(runtime.create(input)).resolves.toEqual(result);
  });

  it('Prepared後の遅延allocateと鍵rotationをProviderが拒否する', async () => {
    const code = await issue();
    codeKeys.faults.add('after-close');
    const pending = await service.begin(actorId);
    expect(pending.status).toBe('unavailable');
    await expect(
      codeKeys.allocation.allocate({
        codeId: randomUUID(),
        recipientActorId: actorId,
        keyVersion: 'v1',
        expiresAt: code.expiresAt,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    await expect(
      codeKeys.allocation.allocate({
        ...scopeOf(code),
        keyVersion: 'v2',
        expiresAt: code.expiresAt,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    codeKeys.faults.clear();
    expect((await service.resume(beganOperation(pending))).status).toBe(
      'complete',
    );
    expect(
      (await codeKeys.lifecycle.inventory(code.codeId)).generations,
    ).toHaveLength(1);
  });

  it('封鎖後でActorが有効な区間の発行は失敗し、コード行を増やさない', async () => {
    const code = await issue();
    codeKeys.faults.add('before-prepare');
    const pending = await service.begin(actorId);
    expect(pending.status).toBe('unavailable');
    expect(await actorState()).toBe('active');
    expect((await runtime.issue(issuer, f.clock)).status).not.toBe('issued');
    expect((await f.codes()).map((row) => row.codeId)).toEqual([code.codeId]);
    codeKeys.faults.clear();
    expect((await service.resume(beganOperation(pending))).status).toBe(
      'complete',
    );
    await expectClosed(code.codeId);
  });

  it('Complete済みの再照合はticketの版を変えず、窓の経過後も封鎖しない', async () => {
    const code = await issue();
    const result = await service.begin(actorId);
    expect(result.status).toBe('complete');
    const ticket = await codeKeys.maintenance.find(code.codeId);
    f.now += 3 * day;
    expect((await service.resume(beganOperation(result))).status).toBe(
      'complete',
    );
    expect(await codeKeys.maintenance.find(code.codeId)).toEqual(ticket);
    expect(await keyStatus()).toBe('active');
  });

  describe('2接続の競合', () => {
    const actorLockWait = async (blocker: number) => {
      const waiter = await waitForSql(/authentication\.actor .*FOR UPDATE/);
      await f.waitBlocked(waiter, blocker);
    };

    it('別接続がコード行をLock中なら待たずに止まり、解放後の再開で完了する', async () => {
      const code = await issue();
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM authentication.recipient_code WHERE code_id=$1 FOR UPDATE',
        [code.codeId],
      );
      const pending = await service.begin(actorId);
      expect(pending.status).toBe('unavailable');
      expect(await actorState()).toBe('active');
      expect(await codeKeys.maintenance.find(code.codeId)).toBeNull();
      await holder.query('ROLLBACK');
      expect((await service.resume(beganOperation(pending))).status).toBe(
        'complete',
      );
      await expectClosed(code.codeId);
    });

    it('消費のcommitを待ち、Invitationを残してコードと全世代を閉じる', async () => {
      await f.seed(f.groupId, actors.owner);
      const issued = await runtime.issue(issuer, f.clock);
      if (issued.status !== 'issued') throw new Error('合成: 発行失敗');
      const paused = pauseAt(/UPDATE authentication\.recipient_code/);
      const consuming = runtime.create(createInput(issued.code));
      await paused.entered;
      f.sqls = [];
      const deleting = service.begin(actorId);
      await actorLockWait(paused.state.pid);
      paused.resume();
      expect((await consuming).status).toBe('authenticated');
      expect((await deleting).status).toBe('complete');
      await expectClosed(issued.codeId);
      const after = await f.snapshot();
      expect(after.group_invitation_record).toHaveLength(1);
      expect(after.consumeAudit).toHaveLength(1);
    });
  });

  describe('清掃との競合', () => {
    /** 清掃がticket登録後に止まった、所有者の異なる未完了ticketを作る。 */
    const cleanupOwned = async (row: Awaited<ReturnType<typeof issue>>) => {
      f.now = row.expiresAt;
      codeKeys.faults.add('before-close');
      expect((await cleanup.cleanOne(scopeOf(row))).status).toBe('unavailable');
      codeKeys.faults.clear();
      return (await codeKeys.maintenance.find(row.codeId))!;
    };

    it('清掃の未完了ticketを採用し、所有operationで閉じる', async () => {
      const code = await issue();
      const owned = await cleanupOwned(code);
      const result = await service.begin(actorId);
      expect(result.status).toBe('complete');
      await expectClosed(code.codeId);
      expect(await codeKeys.maintenance.find(code.codeId)).toMatchObject({
        operationId: owned.operationId,
        adoptingOperationIds: [result.operationId],
        window: owned.window,
      });
      expect(
        (await codeKeys.maintenance.byOperation(beganOperation(result))).map(
          (t) => t.codeId,
        ),
      ).toEqual([code.codeId]);
    });

    it('preparedAtより遅い清掃ticketの窓をpreparedAtへ前倒しする', async () => {
      const code = await issue();
      const owner = randomUUID();
      const later = code.expiresAt - 1;
      await codeKeys.maintenance.prepare({
        scope: scopeOf(code),
        operationId: owner,
        window: { dueAt: later, deadline: later + day },
        expected: null,
      });
      codeKeys.faults.add('before-close');
      const preparedAt = f.now;
      const result = await service.begin(actorId);
      expect(result.status).toBe('unavailable');
      expect(await codeKeys.maintenance.find(code.codeId)).toMatchObject({
        operationId: owner,
        window: { dueAt: preparedAt, deadline: preparedAt + day },
        version: 2,
      });
    });

    it('清掃の完了済みticketは充足済みとして再検証し、再作成しない', async () => {
      const code = await issue();
      f.now = code.expiresAt;
      expect((await cleanup.cleanOne(scopeOf(code))).status).toBe('completed');
      const owned = await codeKeys.maintenance.find(code.codeId);
      const result = await service.begin(actorId);
      expect(result.status).toBe('complete');
      const adopted = await codeKeys.maintenance.find(code.codeId);
      expect(adopted).toMatchObject({
        operationId: owned?.operationId,
        state: 'complete',
        adoptingOperationIds: [result.operationId],
        window: owned?.window,
      });
    });

    it('期限内に清掃が閉じたコードは、窓の経過後の削除でも認証を封鎖しない', async () => {
      const code = await issue();
      f.now = code.expiresAt;
      expect((await cleanup.cleanOne(scopeOf(code))).status).toBe('completed');
      f.now += 2 * day;
      expect((await service.begin(actorId)).status).toBe('complete');
      expect(await keyStatus()).toBe('active');
    });

    it('採用の応答喪失でも採用を二重に記録しない', async () => {
      const code = await issue();
      const owned = await cleanupOwned(code);
      codeKeys.faults.add('after-prepare');
      const pending = await service.begin(actorId);
      expect(pending.status).toBe('unavailable');
      codeKeys.faults.clear();
      expect((await service.resume(beganOperation(pending))).status).toBe(
        'complete',
      );
      expect(await codeKeys.maintenance.find(code.codeId)).toMatchObject({
        operationId: owned.operationId,
        adoptingOperationIds: [pending.operationId],
      });
    });

    it('清掃の完了済みclosureが偽ならCompleteしない', async () => {
      const code = await issue();
      f.now = code.expiresAt;
      expect((await cleanup.cleanOne(scopeOf(code))).status).toBe('completed');
      const verifyClosure = codeKeys.lifecycle.verifyClosure.bind(
        codeKeys.lifecycle,
      );
      codeKeys.lifecycle.verifyClosure = () => Promise.resolve(false);
      const result = await service.begin(actorId);
      expect(result.status).toBe('unavailable');
      expect(await intentStates()).toEqual(['prepared']);
      codeKeys.lifecycle.verifyClosure = verifyClosure;
      expect((await service.resume(beganOperation(result))).status).toBe(
        'complete',
      );
    });

    it('削除所有の未完了ticketを清掃が再開しても採用を増やさず、削除が再検証して完了する', async () => {
      const code = await issue();
      codeKeys.faults.add('before-close');
      const pending = await service.begin(actorId);
      expect(pending.status).toBe('unavailable');
      codeKeys.faults.clear();
      expect((await cleanup.cleanOne(scopeOf(code))).status).toBe('completed');
      expect(await codeKeys.maintenance.find(code.codeId)).toMatchObject({
        operationId: pending.operationId,
        adoptingOperationIds: [],
        state: 'complete',
      });
      expect((await service.resume(beganOperation(pending))).status).toBe(
        'complete',
      );
      await expectClosed(code.codeId);
    });
  });

  describe('障害と再開', () => {
    const expectResumable = async (
      pending: { status: string; operationId: string | null },
      codeId: string,
    ) => {
      expect(pending.status).toBe('unavailable');
      expect(await intentStates()).toEqual(['prepared']);
      expect((await codeKeys.maintenance.find(codeId))?.state).toBe('pending');
      expect(monitor.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ code: 'OK' }),
      );
      const resumed = await service.resume(beganOperation(pending));
      expect(resumed).toEqual({
        status: 'complete',
        operationId: pending.operationId,
      });
      await expectClosed(codeId);
      expect(
        await codeKeys.maintenance.byOperation(beganOperation(pending)),
      ).toHaveLength(1);
    };

    it('全世代破棄の途中失敗では完了せず、部分世代を検出して再開する', async () => {
      const code = await issue();
      await codeKeys.allocation.allocate({
        ...scopeOf(code),
        keyVersion: 'v2',
        expiresAt: code.expiresAt,
      });
      codeKeys.faults.add('after-destroy-generation');
      const pending = await service.begin(actorId);
      codeKeys.faults.clear();
      expect(await destroyed(code.codeId)).toEqual(
        new Set(['destroyed', 'current']),
      );
      await expectResumable(pending, code.codeId);
    });

    it.each(['block-actor', 'scope-page', 'before-prepare'])(
      '登録前の%s障害ではActorを無効化せず同operationで再開する',
      async (fault) => {
        const code = await issue();
        codeKeys.faults.add(fault);
        const pending = await service.begin(actorId);
        expect(pending.status).toBe('unavailable');
        expect(await actorState()).toBe('active');
        expect(await rowCount(code.codeId)).toBe(1);
        codeKeys.faults.clear();
        expect((await service.resume(beganOperation(pending))).status).toBe(
          'complete',
        );
        await expectClosed(code.codeId);
      },
    );

    it.each([
      'after-prepare',
      'inventory',
      'before-close',
      'verify-closure',
      'before-complete',
      'after-complete',
    ])(
      '%sの障害では外部Completeせず、同operationで二重ticketなく再開する',
      async (fault) => {
        const code = await issue();
        codeKeys.faults.add(fault);
        const pending = await service.begin(actorId);
        expect(pending.status).toBe('unavailable');
        expect(await intentStates()).toEqual(
          fault === 'after-prepare' ? [] : ['prepared'],
        );
        expect(monitor.record).not.toHaveBeenCalledWith(
          expect.objectContaining({ code: 'OK' }),
        );
        codeKeys.faults.clear();
        expect((await service.resume(beganOperation(pending))).status).toBe(
          'complete',
        );
        await expectClosed(code.codeId);
        expect(
          await codeKeys.maintenance.byOperation(beganOperation(pending)),
        ).toHaveLength(1);
      },
    );

    it('コード行のDELETE失敗は同operationで再開する', async () => {
      const code = await issue();
      let failed = false;
      f.intercept = async (event, run) => {
        if (
          !failed &&
          event.sql.startsWith('DELETE FROM authentication.recipient_code')
        ) {
          failed = true;
          throw new Error('synthetic-sql-failure');
        }
        return run();
      };
      const pending = await service.begin(actorId);
      expect(failed).toBe(true);
      expect(await rowCount(code.codeId)).toBe(1);
      expect(await destroyed(code.codeId)).toEqual(new Set(['current']));
      await expectResumable(pending, code.codeId);
    });

    it('コード行のpurge Audit障害では行を残し、同operationで再開する', async () => {
      const code = await issue();
      let failed = false;
      let deleted = false;
      f.intercept = async (event, run) => {
        if (event.sql.startsWith('DELETE FROM authentication.recipient_code'))
          deleted = true;
        if (
          !failed &&
          deleted &&
          event.sql.includes('INSERT INTO authentication.audit_event')
        ) {
          failed = true;
          throw new Error('synthetic-audit-failure');
        }
        return run();
      };
      const pending = await service.begin(actorId);
      expect(failed).toBe(true);
      expect(await rowCount(code.codeId)).toBe(1);
      expect(await destroyed(code.codeId)).toEqual(new Set(['current']));
      await expectResumable(pending, code.codeId);
    });

    it('コード行DELETEのCOMMIT応答喪失でも同operationで再開する', async () => {
      const code = await issue();
      let lost = false;
      f.intercept = async (event, run) => {
        const answer = await run();
        if (
          !lost &&
          event.sql === 'COMMIT' &&
          f.sqls.some(
            (x) =>
              x.pid === event.pid &&
              x.sql.startsWith('DELETE FROM authentication.recipient_code'),
          )
        ) {
          lost = true;
          throw new Error('synthetic-response-lost');
        }
        return answer;
      };
      const pending = await service.begin(actorId);
      expect(lost).toBe(true);
      expect(await rowCount(code.codeId)).toBe(0);
      await expectResumable(pending, code.codeId);
    });

    it('Providerの知らない行が残るActorはCompleteしない', async () => {
      // Providerへ登録しない実Storeの発行で、列挙に現れないコード行を作る。
      const issued = await f.issue();
      const pending = await service.begin(actorId);
      expect(pending.status).toBe('unavailable');
      expect(await rowCount(issued.codeId)).toBe(1);
      expect(await intentStates()).toEqual(['prepared']);
    });

    it('Actor削除側の期限超過では封鎖を維持し、成功として報告しない', async () => {
      const code = await issue();
      codeKeys.faults.add('before-close');
      const pending = await service.begin(actorId);
      const ticket = await codeKeys.maintenance.find(code.codeId);
      f.now = ticket!.window.deadline;
      monitor.record.mockClear();
      expect((await service.resume(beganOperation(pending))).status).toBe(
        'unavailable',
      );
      expect(await keyStatus()).toBe('quarantined');
      expect(await intentStates()).toEqual(['prepared']);
      expect(monitor.record).toHaveBeenCalledWith({
        operation: 'deletion',
        code: 'OVERDUE',
        oldest: ticket!.window,
      });
      codeKeys.faults.clear();
      // 除去は隔離中でも進むが、期限未達を成功として報告しない。
      monitor.record.mockClear();
      expect((await service.resume(beganOperation(pending))).status).toBe(
        'quarantined',
      );
      await expectClosed(code.codeId);
      expect(await intentStates()).toEqual(['complete']);
      expect(monitor.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ code: 'OK' }),
      );
    });

    it('改竄されたコード行は封鎖しつつ除去し、完了と報告しない', async () => {
      const code = await issue();
      await f.admin.query(
        "UPDATE authentication.recipient_code SET state_mac=decode(repeat('00',32),'hex') WHERE code_id=$1",
        [code.codeId],
      );
      const result = await service.begin(actorId);
      expect(result.status).toBe('quarantined');
      expect(await keyStatus()).toBe('quarantined');
      await expectClosed(code.codeId);
    });
  });

  describe('封鎖の引き継ぎ', () => {
    const tamper = (codeId: string) =>
      f.admin.query(
        "UPDATE authentication.recipient_code SET state_mac=decode(repeat('00',32),'hex') WHERE code_id=$1",
        [codeId],
      );

    it('改竄の検出後に行を除去してから止まっても、再開は成功と報告しない', async () => {
      const code = await issue();
      await tamper(code.codeId);
      codeKeys.faults.add('before-close');
      const pending = await service.begin(actorId);
      expect(pending.status).toBe('unavailable');
      expect(await rowCount(code.codeId)).toBe(0);
      codeKeys.faults.clear();
      monitor.record.mockClear();
      expect((await service.resume(beganOperation(pending))).status).toBe(
        'quarantined',
      );
      await expectClosed(code.codeId);
      expect(monitor.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ code: 'OK' }),
      );
    });

    it('改竄の検出後にDB Completeの応答を失っても、再開は成功と報告しない', async () => {
      const code = await issue();
      await tamper(code.codeId);
      let lost = false;
      f.intercept = async (event, run) => {
        const answer = await run();
        if (
          !lost &&
          event.sql.startsWith('UPDATE authentication.deletion_intent')
        ) {
          lost = true;
          throw new Error('synthetic-response-lost');
        }
        return answer;
      };
      const pending = await service.begin(actorId);
      expect(lost).toBe(true);
      expect(pending.status).toBe('unavailable');
      monitor.record.mockClear();
      expect((await service.resume(beganOperation(pending))).status).toBe(
        'quarantined',
      );
      expect(monitor.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ code: 'OK' }),
      );
    });
  });

  describe('コード用途の有無', () => {
    const removeCodePurposes = () =>
      f.admin.query(
        "DELETE FROM authentication.key_generation WHERE purpose::text LIKE 'recipient-code-%'",
      );

    it('コード用途があるのに参加しない構成は、Prepared前に止まりActorを変えない', async () => {
      await issue();
      const result = await compose(false).begin(actorId);
      expect(result.status).toBe('unavailable');
      expect(await actorState()).toBe('active');
      expect(await intentStates()).toEqual([]);
    });

    it('コード用途の一部だけが初期化された環境でも、参加なしの削除は止まる', async () => {
      await f.admin.query(
        "DELETE FROM authentication.key_generation WHERE purpose='recipient-code-lookup'",
      );
      expect((await compose(false).begin(actors.member)).status).toBe(
        'unavailable',
      );
      expect(await intentStates()).toEqual([]);
    });

    it('コード用途がない環境では参加なしで既存の削除が完了する', async () => {
      await removeCodePurposes();
      const result = await compose(false).begin(actors.member);
      expect(result.status).toBe('complete');
      expect(await intentStates()).toEqual(['complete']);
    });

    it('コード用途がないのに参加する構成はPrepared前に止まる', async () => {
      await removeCodePurposes();
      const result = await compose(true).begin(actors.member);
      expect(result.status).toBe('unavailable');
      expect(await intentStates()).toEqual([]);
    });
  });
});
