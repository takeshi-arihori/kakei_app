import { randomBytes, randomUUID } from 'node:crypto';
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
import { createRecipientInvitationRuntime } from '../src/recipient-invitation-runtime.js';
import { createRecipientCodeCleanupService } from '../src/shared/application/authentication/recipient-code-cleanup-service.js';
import { guardRecipientCodeMaintenance } from '../src/shared/application/authentication/recipient-code-maintenance-guard.js';
import { insertAuthenticationRecord } from '../src/shared/infrastructure/authentication/postgres/authentication-record-rows.js';
import { createPostgresRecipientCodeCleanup } from '../src/shared/infrastructure/authentication/postgres/postgres-recipient-code-cleanup.js';
import { ids } from '../src/shared/infrastructure/authentication/test/authentication-crypto-fixtures.js';
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
const issuerSession = sessionSecret(20);

describe('招待コードの清掃（実PG17＋合成Provider）', () => {
  const f = new RecipientInvitationFixture(url);
  const holder = new Client({ connectionString: url });
  let holderPid = 0;
  let keys: ReturnType<typeof syntheticRecipientCodeManagedKeys>;
  let runtime: ReturnType<typeof createRecipientInvitationRuntime>;
  let database: ReturnType<typeof createPostgresRecipientCodeCleanup>;
  let service: ReturnType<typeof createRecipientCodeCleanupService>;
  let monitor: {
    record: ReturnType<
      typeof vi.fn<AuthenticationMaintenanceMonitor['record']>
    >;
  };
  let nextOperationId: ReturnType<typeof vi.fn<() => string>>;

  beforeAll(async () => {
    await f.initialize();
    await holder.connect();
    holderPid = (
      await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    ).rows[0].pid;
    await holder.query(`SET search_path TO ${f.schema}`);
  });
  beforeEach(async () => {
    await f.reset();
    keys = syntheticRecipientCodeManagedKeys();
    // 実発行StoreのallocateをDB外の合成Providerへ登録し、行と全世代inventoryを揃える。
    const { stateKeys } = f.runtimeOptions.authentication;
    runtime = createRecipientInvitationRuntime({
      ...f.runtimeOptions,
      authentication: {
        ...f.runtimeOptions.authentication,
        stateKeys: {
          allocate: async (input) => {
            const answer = await keys.allocation.allocate(input);
            if (answer.status === 'allocated') await stateKeys.allocate(input);
            return answer;
          },
        },
      },
    });
    database = createPostgresRecipientCodeCleanup({
      pool: f.connections(),
      crypto: f.crypto,
      digests: f.digests,
      clock: f.clock,
      limits,
    });
    monitor = {
      record: vi.fn<AuthenticationMaintenanceMonitor['record']>(() =>
        Promise.resolve(),
      ),
    };
    nextOperationId = vi.fn(() => randomUUID());
    service = createRecipientCodeCleanupService({
      maintenance: guardRecipientCodeMaintenance(keys),
      database,
      clock: f.clock,
      nextOperationId,
      monitor,
    });
  });
  afterEach(async () => {
    await holder.query('ROLLBACK');
  });
  afterAll(async () => {
    await holder.end();
    await f.dispose();
  });

  const issue = async () => {
    const issued = await runtime.issue(issuerSession, f.clock);
    if (issued.status !== 'issued') throw new Error('合成: 発行失敗');
    const [row] = await f.codes();
    return {
      row,
      scope: { codeId: row.codeId, recipientActorId: row.recipientActorId },
    };
  };
  const rowCount = async (codeId: string) =>
    (
      await f.admin.query(
        'SELECT 1 FROM authentication.recipient_code WHERE code_id=$1',
        [codeId],
      )
    ).rowCount;
  const destroyed = async (codeId: string) =>
    (await keys.lifecycle.inventory(codeId)).generations.map(
      (generation) => generation.lifecycle,
    );
  const expectComplete = async (codeId: string) => {
    expect(await rowCount(codeId)).toBe(0);
    expect(new Set(await destroyed(codeId))).toEqual(new Set(['destroyed']));
    expect((await keys.maintenance.find(codeId))?.state).toBe('complete');
  };
  /** bytea列も失わないよう、DB内のJSON表現で保存した行を戻す。 */
  const saveRow = async (codeId: string) =>
    (
      await f.admin.query<{ row: unknown }>(
        'SELECT to_jsonb(t) AS row FROM authentication.recipient_code t WHERE code_id=$1',
        [codeId],
      )
    ).rows[0].row;
  const restoreRow = async (saved: unknown) => {
    await f.admin.query(
      'INSERT INTO authentication.recipient_code SELECT * FROM jsonb_populate_record(NULL::authentication.recipient_code,$1)',
      [saved],
    );
  };
  const keyStatus = async () =>
    (
      await f.admin.query<{ status: string }>(
        'SELECT status FROM authentication.key_state',
      )
    ).rows[0].status;
  const waitForSql = async (pattern: RegExp) => {
    const limit = Date.now() + 4000;
    while (Date.now() < limit) {
      const found = f.sqls.find((event) => pattern.test(event.sql));
      if (found) return found.pid;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('合成: SQL未到達');
  };

  it('対象の1件だけを除去し、別Actorの有効なコードを巻き込まない', async () => {
    const { row, scope } = await issue();
    // 発行本人とは別のActorが、対象の期限後も有効なコードを持つ状態を作る。
    f.now = row.expiresAt - 1000;
    const other = await runtime.issue(sessionSecret(10), f.clock);
    if (other.status !== 'issued') throw new Error('合成: 発行失敗');
    f.now = row.expiresAt;
    // 別コードをLockしたままでも進むので、対象のcode_idだけをLockしている。
    await holder.query('BEGIN');
    await holder.query(
      'SELECT 1 FROM authentication.recipient_code WHERE code_id=$1 FOR UPDATE',
      [other.codeId],
    );
    await expect(service.cleanOne(scope)).resolves.toEqual({
      status: 'completed',
    });
    await holder.query('COMMIT');
    await expectComplete(row.codeId);
    expect(await rowCount(other.codeId)).toBe(1);
    expect(await keys.maintenance.find(other.codeId)).toBeNull();
    expect(new Set(await destroyed(other.codeId))).toEqual(
      new Set(['current']),
    );
    await expect(database.absent(row.codeId)).resolves.toBe(true);
    await expect(database.absent(other.codeId)).resolves.toBe(false);
  });

  it('期限切れ1件をticket→行除去→全世代closure→0-rowで完了し、他の認証Recordを残す', async () => {
    const { row, scope } = await issue();
    // rotation相当の2世代目。全世代を閉じなければ完了できない状態を作る。
    await keys.allocation.allocate({
      ...scope,
      keyVersion: 'v2',
      expiresAt: row.expiresAt,
    });
    const sessions = await f.admin.query(
      'SELECT session_id FROM authentication.session_record',
    );
    f.now = row.expiresAt;
    f.sqls = [];
    await expect(service.cleanOne(scope)).resolves.toEqual({
      status: 'completed',
    });
    await expectComplete(row.codeId);
    expect(await destroyed(row.codeId)).toHaveLength(2);
    expect(
      (
        await f.admin.query(
          'SELECT session_id FROM authentication.session_record',
        )
      ).rowCount,
    ).toBe(sessions.rowCount);
    // 除去Transactionのkey-state→Actor→コードのLock順（R4）を実SQLで固定する。
    const deletion = f.sqls.find((e) => e.sql.startsWith('DELETE'))!;
    const end = f.sqls.indexOf(deletion);
    const start = f.sqls.findLastIndex(
      (e, index) => index < end && e.sql.startsWith('BEGIN'),
    );
    expect(
      f.sqls
        .slice(start, end + 1)
        .map((e) => e.sql)
        .filter((sql) => /FOR (SHARE|UPDATE)|^DELETE/.test(sql))
        .map(
          (sql) =>
            /FROM authentication\.(\w+)/.exec(sql)?.[1] +
            ':' +
            /FOR \w+|DELETE/.exec(sql)?.[0],
        ),
    ).toEqual([
      'key_state:FOR SHARE',
      'actor:FOR UPDATE',
      'recipient_code:FOR UPDATE',
      'recipient_code:DELETE',
    ]);
  });

  it('コードが期限前なら何も変えない', async () => {
    const { row, scope } = await issue();
    f.now = row.expiresAt - 1;
    await expect(service.cleanOne(scope)).resolves.toEqual({
      status: 'retained',
    });
    expect(await rowCount(row.codeId)).toBe(1);
    expect(await keys.maintenance.find(row.codeId)).toBeNull();
    expect(new Set(await destroyed(row.codeId))).toEqual(new Set(['current']));
  });

  it('MAC検証済みの終端時刻から期限前でも除去する', async () => {
    const { row, scope } = await issue();
    f.now += 1000;
    await expect(
      runtime.revoke(issuerSession, row.codeId, f.clock),
    ).resolves.toEqual({ status: 'revoked' });
    const terminalAt = f.now;
    await expect(service.cleanOne(scope)).resolves.toEqual({
      status: 'completed',
    });
    await expectComplete(row.codeId);
    expect((await keys.maintenance.find(row.codeId))?.window.dueAt).toBe(
      terminalAt,
    );
  });

  it.each([
    ['MACの改竄', 'state_mac=$2', () => randomBytes(32)],
    [
      '偽の終端で期限を前倒しする改竄',
      "state='revoked',terminal_at_ms=$2",
      () => Date.parse('2026-11-01T00:00:00Z'),
    ],
    ['Actorの差替え', 'recipient_actor_id=$2', () => actors.member],
  ])(
    '%sでも行を残さず、Providerが保持する期限で除去する',
    async (_name, set, value) => {
      const { row, scope } = await issue();
      await f.admin.query(
        `UPDATE authentication.recipient_code SET ${set} WHERE code_id=$1`,
        [row.codeId, value()],
      );
      // 検証できない行の値では起算しないので、期限前の不可逆処理へ進まない。
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'quarantined',
      });
      expect(await rowCount(row.codeId)).toBe(1);
      expect(await keyStatus()).toBe('quarantined');
      expect(monitor.record).toHaveBeenCalledWith({
        operation: 'cleanup',
        code: 'QUARANTINED',
        oldest: null,
      });
      f.now = row.expiresAt;
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'quarantined',
      });
      await expectComplete(row.codeId);
      expect((await keys.maintenance.find(row.codeId))?.window.dueAt).toBe(
        row.expiresAt,
      );
    },
  );

  it('MAC鍵を取得できない行は封鎖せず通知し、期限で除去する', async () => {
    const { row, scope } = await issue();
    f.codeMaterials.delete(`auth-recipient-code-state/v1/${row.codeId}/v1`);
    f.now = row.expiresAt;
    await expect(service.cleanOne(scope)).resolves.toEqual({
      status: 'completed',
    });
    await expectComplete(row.codeId);
    expect(await keyStatus()).toBe('active');
    expect(monitor.record).toHaveBeenCalledWith({
      operation: 'cleanup',
      code: 'UNAVAILABLE',
      oldest: null,
    });
  });

  it('公開読取世代にないMAC世代の終端時刻では起算しない', async () => {
    const { row, scope } = await issue();
    await runtime.revoke(issuerSession, row.codeId, f.clock);
    await f.admin.query(
      "UPDATE authentication.key_generation SET searchable=false,write_required=false WHERE purpose='recipient-code-state-mac'",
    );
    await f.admin.query(
      "INSERT INTO authentication.key_generation(generation_id,purpose,key_version,epoch,searchable,write_required) VALUES($1,'recipient-code-state-mac','v2',NULL,true,true)",
      [randomUUID()],
    );
    await expect(service.cleanOne(scope)).resolves.toEqual({
      status: 'quarantined',
    });
    expect(await rowCount(row.codeId)).toBe(1);
  });

  it('行のないscopeも同じ経路で閉じる（列挙は別Task）', async () => {
    const codeId = randomUUID();
    const scope = { codeId, recipientActorId: actors.recipient };
    await keys.allocation.allocate({
      ...scope,
      keyVersion: 'v1',
      expiresAt: f.now,
    });
    await expect(service.cleanOne(scope)).resolves.toEqual({
      status: 'completed',
    });
    await expectComplete(codeId);
  });

  it('束縛Actorの行がなければ止まり、ticketを登録しない', async () => {
    const codeId = randomUUID();
    const scope = { codeId, recipientActorId: randomUUID() };
    await keys.allocation.allocate({
      ...scope,
      keyVersion: 'v1',
      expiresAt: f.now,
    });
    await expect(service.cleanOne(scope)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(await keys.maintenance.find(codeId)).toBeNull();
  });

  describe('Lock順', () => {
    it('Actorを共有Lockされている間は待ち（FOR UPDATE）、コードをまだLockしない', async () => {
      const { row, scope } = await issue();
      f.now = row.expiresAt;
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM authentication.actor WHERE actor_id=$1 FOR SHARE',
        [scope.recipientActorId],
      );
      f.sqls = [];
      const running = service.cleanOne(scope);
      const waiter = await waitForSql(/authentication\.actor .*FOR UPDATE/);
      await f.waitBlocked(waiter, holderPid);
      // 待機中のActorより先にコードをLockしていれば、NOWAITは失敗する。
      await expect(
        f.admin.query(
          'SELECT 1 FROM authentication.recipient_code WHERE code_id=$1 FOR UPDATE NOWAIT',
          [row.codeId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await holder.query('COMMIT');
      await expect(running).resolves.toEqual({ status: 'completed' });
      await expectComplete(row.codeId);
    });

    it('Lock済みのコード行は待たずskipし、ticketを作らない', async () => {
      const { row, scope } = await issue();
      f.now = row.expiresAt;
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM authentication.recipient_code WHERE code_id=$1 FOR UPDATE',
        [row.codeId],
      );
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'skipped',
      });
      expect(await keys.maintenance.find(row.codeId)).toBeNull();
      await holder.query('COMMIT');
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'completed',
      });
    });

    it('key-state→Actor→コードの順にLockし、Actorへ戻らない', async () => {
      const { row, scope } = await issue();
      f.now = row.expiresAt;
      f.sqls = [];
      await service.cleanOne(scope);
      const locks = f.sqls
        .map(
          ({ sql }) =>
            /FROM authentication\.(\w+).*FOR (?:UPDATE|SHARE)/.exec(sql)?.[1],
        )
        .filter((table) => table !== undefined);
      expect(locks.slice(0, 3)).toEqual([
        'key_state',
        'actor',
        'recipient_code',
      ]);
      // Transactionごとに同じ順序で、コードの次にActorを取りに戻らない。
      locks.forEach((table, index) => {
        if (table === 'actor') expect(locks[index - 1]).toBe('key_state');
      });
    });

    it('除去のLock後に期限前と分かれば削除しない', async () => {
      const { row, scope } = await issue();
      await expect(database.remove(scope, row.expiresAt)).resolves.toBe(
        'retained',
      );
      expect(await rowCount(row.codeId)).toBe(1);
      f.now = row.expiresAt;
      await expect(database.remove(scope, row.expiresAt)).resolves.toBe(
        'removed',
      );
      expect(await rowCount(row.codeId)).toBe(0);
    });
  });

  describe('コード専用の0-row照合', () => {
    const attempt = async (attemptId: string) => {
      const digest = await f.digests.attemptCookie({
        secret: sessionSecret(90),
        epoch: ids.epoch,
        keyVersion: 'v1',
      });
      const row = {
        recordKind: 'login-attempt' as const,
        attemptId,
        version: 1,
        epoch: ids.epoch,
        createdAt: f.now,
        expiresAt: f.now + 300_000,
        state: 'ready' as const,
        terminalAt: null,
        cookieDigestKeyVersion: 'v1',
        cookieDigest: digest.bytes,
      };
      await insertAuthenticationRecord(
        f.admin,
        row,
        await f.authCodec.seal({
          row,
          secrets: { csrf: sessionSecret(91), nonce: sessionSecret(92) },
        }),
      );
    };

    it('コード行があればfalse、コード行がなければ他の表に同じIDがあってもtrue', async () => {
      const { row } = await issue();
      await expect(database.absent(row.codeId)).resolves.toBe(false);
      await f.admin.query('DELETE FROM authentication.recipient_code');
      await expect(database.absent(row.codeId)).resolves.toBe(true);
      // 既存absentの暗黙の分岐が参照する表へ同じIDを置いても、結果を変えない。
      await attempt(row.codeId);
      const session = (
        await f.admin.query<{ session_id: string }>(
          'SELECT session_id FROM authentication.session_record LIMIT 1',
        )
      ).rows[0].session_id;
      await expect(database.absent(row.codeId)).resolves.toBe(true);
      await expect(database.absent(session)).resolves.toBe(true);
    });

    it('他の表に同じIDがなくてもコード行があれば完了させない', async () => {
      const { row, scope } = await issue();
      f.now = row.expiresAt;
      // closure後の0-row照合の直前に行が戻った場合を実PGで再現する。
      const saved = await saveRow(row.codeId);
      let restored = false;
      f.intercept = async (event, run) => {
        if (
          !restored &&
          event.sql.startsWith('SELECT 1 FROM authentication.recipient_code')
        ) {
          restored = true;
          await restoreRow(saved);
        }
        return run();
      };
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'unavailable',
      });
      // 0-row照合が行を見つけた結果の停止であり、別の失敗ではないことを確かめる。
      expect(restored).toBe(true);
      expect(await rowCount(row.codeId)).toBe(1);
      expect(new Set(await destroyed(row.codeId))).toEqual(
        new Set(['destroyed']),
      );
      expect((await keys.maintenance.find(row.codeId))?.state).toBe('pending');
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'completed',
      });
      await expectComplete(row.codeId);
    });
  });

  describe('障害と再開', () => {
    it('DELETEのCOMMIT応答喪失では完了せず、同operationで再開する', async () => {
      const { row, scope } = await issue();
      f.now = row.expiresAt;
      let lost = false;
      f.intercept = async (event, run) => {
        const answer = await run();
        if (
          !lost &&
          event.sql === 'COMMIT' &&
          f.sqls.some((x) => x.pid === event.pid && x.sql.startsWith('DELETE'))
        ) {
          lost = true;
          throw new Error('synthetic-response-lost');
        }
        return answer;
      };
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'unavailable',
      });
      expect(lost).toBe(true);
      expect(f.released.some((x) => x.destroy)).toBe(true);
      const ticket = await keys.maintenance.find(row.codeId);
      expect(ticket?.state).toBe('pending');
      expect(new Set(await destroyed(row.codeId))).toEqual(
        new Set(['current']),
      );
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'completed',
      });
      await expectComplete(row.codeId);
      expect((await keys.maintenance.find(row.codeId))?.operationId).toBe(
        ticket?.operationId,
      );
    });

    it('DELETE失敗は全rollbackして行を残し、同operationで再開する', async () => {
      const { row, scope } = await issue();
      f.now = row.expiresAt;
      let failed = false;
      f.intercept = (event, run) => {
        if (!failed && event.sql.startsWith('DELETE')) {
          failed = true;
          return Promise.reject(new Error('synthetic-delete-failure'));
        }
        return run();
      };
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'unavailable',
      });
      expect(await rowCount(row.codeId)).toBe(1);
      expect(new Set(await destroyed(row.codeId))).toEqual(
        new Set(['current']),
      );
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'completed',
      });
      await expectComplete(row.codeId);
    });

    it('部分世代の破棄で止まっても行を戻さず、同operationで全世代を閉じる', async () => {
      const { row, scope } = await issue();
      await keys.allocation.allocate({
        ...scope,
        keyVersion: 'v2',
        expiresAt: row.expiresAt,
      });
      f.now = row.expiresAt;
      keys.faults.add('after-destroy-generation');
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'unavailable',
      });
      expect(new Set(await destroyed(row.codeId))).toEqual(
        new Set(['destroyed', 'current']),
      );
      expect(await rowCount(row.codeId)).toBe(0);
      const ticket = await keys.maintenance.find(row.codeId);
      expect(ticket?.state).toBe('pending');
      keys.faults.clear();
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'completed',
      });
      await expectComplete(row.codeId);
      expect((await keys.maintenance.find(row.codeId))?.operationId).toBe(
        ticket?.operationId,
      );
    });

    it('復元された行は完了済みticketで再除去し、完了件数を増やさない', async () => {
      const { row, scope } = await issue();
      f.now = row.expiresAt;
      const saved = await saveRow(row.codeId);
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'completed',
      });
      await restoreRow(saved);
      expect(await rowCount(row.codeId)).toBe(1);
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'already-complete',
      });
      await expectComplete(row.codeId);
    });
  });

  describe('key-state', () => {
    const setStatus = (status: string) =>
      f.admin.query('UPDATE authentication.key_state SET status=$1', [status]);

    it('quarantinedでも清掃できる', async () => {
      const { row, scope } = await issue();
      f.now = row.expiresAt;
      await setStatus('quarantined');
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'completed',
      });
      await expectComplete(row.codeId);
    });

    it('restoringでは止まり、ticketも行も変えない', async () => {
      const { row, scope } = await issue();
      f.now = row.expiresAt;
      await setStatus('restoring');
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'unavailable',
      });
      expect(await rowCount(row.codeId)).toBe(1);
      expect(await keys.maintenance.find(row.codeId)).toBeNull();
      await expect(database.absent(row.codeId)).rejects.toThrow();
    });
  });
  /** 実コード利用と同じGroupへの作成要求。 */
  const create = (code: Parameters<typeof runtime.create>[0]['code']) =>
    runtime.create({
      code,
      groupId: f.groupId,
      operationId: OperationId.from(`cleanup-${randomUUID()}`),
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
  const disable = (actorId: string) => f.setActor(actorId, 'disabled');
  const orphan = async (expiresAt: number, actorId = actors.member) => {
    const codeId = randomUUID();
    await keys.allocation.allocate({
      codeId,
      recipientActorId: actorId,
      keyVersion: 'v1',
      expiresAt,
    });
    return { codeId, recipientActorId: actorId };
  };
  const reissued = async (times: number) => {
    for (let index = 0; index < times; index += 1) await issue();
    return (await f.codes()).sort((a, b) => a.createdAt - b.createdAt);
  };
  const purges = async () =>
    (
      await f.admin.query<{
        actor_digest: Buffer | null;
        code_digest: Buffer | null;
      }>(
        "SELECT actor_digest,code_digest FROM authentication.audit_event WHERE action='purge'",
      )
    ).rows;

  describe('dueAtの起算と再検証', () => {
    it.each([
      ['直前', -1, 'retained'],
      ['等値', 0, 'completed'],
      ['後', 1, 'completed'],
    ])('期限%sの扱い', async (_name, offset, status) => {
      const { row, scope } = await issue();
      f.now = row.expiresAt + offset;
      await expect(service.cleanOne(scope)).resolves.toEqual({ status });
      expect(await rowCount(row.codeId)).toBe(status === 'retained' ? 1 : 0);
      expect(await keyStatus()).toBe('active');
    });

    it('MAC検証済みのActor disabledAtで起算する', async () => {
      const { row, scope } = await issue();
      f.now += 1000;
      await disable(scope.recipientActorId);
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'completed',
      });
      await expectComplete(row.codeId);
      expect((await keys.maintenance.find(row.codeId))?.window.dueAt).toBe(
        f.now,
      );
    });

    it('改竄されたActorのdisabledAtでは起算せず封鎖する', async () => {
      const { row, scope } = await issue();
      await f.admin.query(
        "UPDATE authentication.actor SET state='disabled',disabled_at_ms=$2 WHERE actor_id=$1",
        [scope.recipientActorId, f.now],
      );
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'quarantined',
      });
      expect(await rowCount(row.codeId)).toBe(1);
      expect(await keys.maintenance.find(row.codeId)).toBeNull();
      expect(await keyStatus()).toBe('quarantined');
      expect(monitor.record).toHaveBeenCalledWith({
        operation: 'cleanup',
        code: 'QUARANTINED',
        oldest: null,
      });
      // 改竄されたdisabledAtは使わず、Providerの期限で除去する。
      f.now = row.expiresAt;
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'quarantined',
      });
      await expectComplete(row.codeId);
      expect((await keys.maintenance.find(row.codeId))?.window.dueAt).toBe(
        row.expiresAt,
      );
    });
  });

  describe('コード利用はBatchを待たず拒否する（#243の回帰）', () => {
    it.each([
      ['期限等値', 0],
      ['期限後', 1],
    ])('%sの利用を拒否し、行は清掃まで残る', async (_name, offset) => {
      const issued = await runtime.issue(issuerSession, f.clock);
      if (issued.status !== 'issued') throw new Error('合成: 発行失敗');
      const [row] = await f.codes();
      f.now = row.expiresAt + offset;
      expect((await create(issued.code)).status).not.toBe('authenticated');
      expect(await rowCount(row.codeId)).toBe(1);
      expect((await f.codes())[0].terminalAt).toBeNull();
    });

    it('disabled Actorのコード利用を拒否する', async () => {
      const issued = await runtime.issue(issuerSession, f.clock);
      if (issued.status !== 'issued') throw new Error('合成: 発行失敗');
      const [row] = await f.codes();
      await disable(row.recipientActorId);
      expect((await create(issued.code)).status).not.toBe('authenticated');
      expect(await rowCount(row.codeId)).toBe(1);
    });
  });

  describe('2接続競合', () => {
    const actorLockWait = async (blocker: number) => {
      const waiter = await waitForSql(/authentication\.actor .*FOR UPDATE/);
      await f.waitBlocked(waiter, blocker);
    };

    it('再発行のcommitを待ち、旧コードだけを除去して新コードを残す', async () => {
      const { row, scope } = await issue();
      f.now = row.expiresAt;
      const paused = pauseAt(/INSERT INTO authentication\.audit_event/);
      const issuing = runtime.issue(issuerSession, f.clock);
      await paused.entered;
      f.sqls = [];
      const cleaning = service.cleanOne(scope);
      await actorLockWait(paused.state.pid);
      paused.resume();
      expect((await issuing).status).toBe('issued');
      await expect(cleaning).resolves.toEqual({ status: 'completed' });
      await expectComplete(row.codeId);
      const remaining = await f.codes();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].codeId).not.toBe(row.codeId);
      expect(remaining[0].status).toBe('issued');
    });

    it('取消のcommitを待ち、確定した終端時刻で除去する', async () => {
      const { row, scope } = await issue();
      f.now += 5000;
      const paused = pauseAt(/INSERT INTO authentication\.audit_event/);
      const revoking = runtime.revoke(issuerSession, row.codeId, f.clock);
      await paused.entered;
      f.sqls = [];
      const cleaning = service.cleanOne(scope);
      await actorLockWait(paused.state.pid);
      paused.resume();
      await revoking;
      await expect(cleaning).resolves.toEqual({ status: 'completed' });
      await expectComplete(row.codeId);
      expect((await keys.maintenance.find(row.codeId))?.window.dueAt).toBe(
        f.now,
      );
    });

    it('消費のcommitを待ち、Invitationを巻き込まずコードを除去する', async () => {
      await f.seed(f.groupId, actors.owner);
      const issued = await runtime.issue(issuerSession, f.clock);
      if (issued.status !== 'issued') throw new Error('合成: 発行失敗');
      const [row] = await f.codes();
      const scope = {
        codeId: row.codeId,
        recipientActorId: row.recipientActorId,
      };
      f.now += 5000;
      const before = await f.snapshot();
      const paused = pauseAt(/UPDATE authentication\.recipient_code/);
      const consuming = create(issued.code);
      await paused.entered;
      f.sqls = [];
      const cleaning = service.cleanOne(scope);
      await actorLockWait(paused.state.pid);
      paused.resume();
      expect((await consuming).status).toBe('authenticated');
      await expect(cleaning).resolves.toEqual({ status: 'completed' });
      await expectComplete(row.codeId);
      // コード清掃はGMのInvitation・成功operation・消費Auditを巻き込まない。
      const after = await f.snapshot();
      const count = (snapshot: Record<string, unknown>, name: string) =>
        (snapshot[name] as unknown[]).length;
      for (const name of [
        'group_invitation_record',
        'group_operation_result_record',
      ])
        expect(count(after, name)).toBe(count(before, name) + 1);
      expect(after.consumeAudit).toHaveLength(1);
      expect(after['authentication.recipient_code']).toEqual([]);
    });

    it('除去のcommit前に始まった消費は待ってから拒否される', async () => {
      await f.seed(f.groupId, actors.owner);
      const issued = await runtime.issue(issuerSession, f.clock);
      if (issued.status !== 'issued') throw new Error('合成: 発行失敗');
      const [row] = await f.codes();
      f.now = row.expiresAt;
      const paused = pauseAt(/DELETE FROM authentication\.recipient_code/);
      const cleaning = service.cleanOne({
        codeId: row.codeId,
        recipientActorId: row.recipientActorId,
      });
      await paused.entered;
      f.sqls = [];
      const consuming = create(issued.code);
      // 清掃が保持するActor Lockを、消費の接続が実際に待っていることを確かめる。
      const consumer = await waitForSql(
        /authentication\.actor .*FOR (?:SHARE|UPDATE)/,
      );
      await f.waitBlocked(consumer, paused.state.pid);
      paused.resume();
      await expect(cleaning).resolves.toEqual({ status: 'completed' });
      expect((await consuming).status).not.toBe('authenticated');
      await expectComplete(row.codeId);
    });
  });

  describe('小Batchと再開', () => {
    it('limit件だけ処理してpendingを返し、次の実行で残りを完了する', async () => {
      const rows = await reissued(3);
      f.now = rows[0].expiresAt + 1;
      const [newest] = rows.slice(-1);
      await expect(service.run(1)).resolves.toEqual({ status: 'pending' });
      expect((await f.codes()).length).toBe(2);
      // 再発行で終端した旧行は発行時刻で終端している。残した最早の対象を監視へ渡す。
      expect(monitor.record).toHaveBeenLastCalledWith({
        operation: 'cleanup',
        code: 'OK',
        oldest: {
          dueAt: rows[0].createdAt,
          deadline: rows[0].createdAt + 86_400_000,
        },
      });
      await expect(service.run(1)).resolves.toEqual({ status: 'pending' });
      expect((await f.codes()).length).toBe(1);
      f.now = newest.expiresAt;
      await expect(service.run(1)).resolves.toEqual({
        status: 'complete',
        removed: 1,
      });
      await expect(service.run(1)).resolves.toEqual({
        status: 'complete',
        removed: 0,
      });
    });

    it('上限で切った行の候補を完了扱いにせず、その期限を監視へ渡す', async () => {
      // 期限前に再発行で終端した行を、時刻をずらして2件作る。
      await issue();
      f.now += 1000;
      await issue();
      f.now += 1000;
      await issue();
      const rows = (await f.codes()).sort((a, b) => a.createdAt - b.createdAt);
      const secondTerminal = rows[2].createdAt;
      await expect(service.run(1)).resolves.toEqual({ status: 'pending' });
      expect(await rowCount(rows[0].codeId)).toBe(0);
      expect(await rowCount(rows[1].codeId)).toBe(1);
      expect(monitor.record).toHaveBeenLastCalledWith({
        operation: 'cleanup',
        code: 'OK',
        oldest: {
          dueAt: secondTerminal,
          deadline: secondTerminal + 86_400_000,
        },
      });
      await expect(service.run(1)).resolves.toEqual({
        status: 'complete',
        removed: 1,
      });
      expect(await rowCount(rows[2].codeId)).toBe(1);
    });

    it('期限前だけなら何も変えない', async () => {
      const { row } = await issue();
      await expect(service.run(10)).resolves.toEqual({
        status: 'complete',
        removed: 0,
      });
      expect(await rowCount(row.codeId)).toBe(1);
      expect(await keys.maintenance.find(row.codeId)).toBeNull();
      expect(monitor.record).toHaveBeenLastCalledWith({
        operation: 'cleanup',
        code: 'OK',
        oldest: null,
      });
    });

    it('Lock済みの行はskipして他を進め、完了扱いにしない', async () => {
      const rows = await reissued(2);
      f.now = rows[1].expiresAt;
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM authentication.recipient_code WHERE code_id=$1 FOR UPDATE',
        [rows[0].codeId],
      );
      await expect(service.run(10)).resolves.toEqual({ status: 'pending' });
      expect(await rowCount(rows[1].codeId)).toBe(0);
      expect(await rowCount(rows[0].codeId)).toBe(1);
      await holder.query('COMMIT');
      await expect(service.run(10)).resolves.toEqual({
        status: 'complete',
        removed: 1,
      });
    });

    it.each([
      ['ticket登録直後', 'after-prepare'],
      ['全世代破棄の途中', 'after-destroy-generation'],
      ['closure応答喪失', 'after-close'],
      ['完了の直前', 'before-complete'],
      ['完了の応答喪失', 'after-complete'],
    ])(
      '%sの中断を同operationで再開し、二重ticketを作らない',
      async (_name, fault) => {
        const { row } = await issue();
        f.now = row.expiresAt;
        keys.faults.add(fault);
        await expect(service.run(10)).resolves.toEqual({
          status: 'unavailable',
        });
        keys.faults.delete(fault);
        const before = await keys.maintenance.find(row.codeId);
        expect(before).not.toBeNull();
        expect(nextOperationId).toHaveBeenCalledTimes(1);
        const result = await service.run(10);
        expect(result).toEqual({
          status: 'complete',
          removed: before?.state === 'complete' ? 0 : 1,
        });
        await expectComplete(row.codeId);
        expect(nextOperationId).toHaveBeenCalledTimes(1);
        expect(
          await keys.maintenance.byOperation(before!.operationId),
        ).toHaveLength(1);
      },
    );
  });

  describe('孤立scope', () => {
    it('期限切れの孤立scopeを閉じる', async () => {
      const scope = await orphan(f.now);
      await expect(service.run(10)).resolves.toEqual({
        status: 'complete',
        removed: 1,
      });
      await expectComplete(scope.codeId);
      expect(await purges()).toEqual([]);
    });

    it('束縛ActorのLock下のdisabledAtで起算し、期限前でも閉じる', async () => {
      const scope = await orphan(f.now + 600_000);
      await disable(scope.recipientActorId);
      await expect(service.run(10)).resolves.toEqual({
        status: 'complete',
        removed: 1,
      });
      await expectComplete(scope.codeId);
      expect((await keys.maintenance.find(scope.codeId))?.window.dueAt).toBe(
        f.now,
      );
    });

    it('有効なActorの期限前の孤立scopeは残す', async () => {
      const scope = await orphan(f.now + 1);
      await expect(service.run(10)).resolves.toEqual({
        status: 'complete',
        removed: 0,
      });
      expect(await keys.maintenance.find(scope.codeId)).toBeNull();
    });

    it('束縛Actorの行がない孤立scopeは完了にしない', async () => {
      const scope = await orphan(f.now, randomUUID());
      await expect(service.run(10)).resolves.toEqual({
        status: 'unavailable',
      });
      expect(await keys.maintenance.find(scope.codeId)).toBeNull();
    });

    it('完了済みの孤立scopeはDBへ行かず、再度数えない', async () => {
      await orphan(f.now);
      await service.run(10);
      f.sqls = [];
      await expect(service.run(10)).resolves.toEqual({
        status: 'complete',
        removed: 0,
      });
      expect(f.sqls.filter(({ sql }) => /FOR UPDATE/.test(sql))).toEqual([]);
    });
  });

  describe('列挙の停止', () => {
    const withMaintenance = (overrides: Partial<typeof keys.maintenance>) =>
      createRecipientCodeCleanupService({
        maintenance: guardRecipientCodeMaintenance({
          lifecycle: keys.lifecycle,
          maintenance: { ...keys.maintenance, ...overrides },
        }),
        database,
        clock: f.clock,
        nextOperationId,
        monitor,
      });

    it('列挙の停止中も、既知の未達は封鎖して通知する', async () => {
      const { row } = await issue();
      f.now = row.expiresAt + 86_400_000;
      keys.faults.add('scope-page-unavailable');
      await expect(service.run(10)).resolves.toEqual({
        status: 'quarantined',
      });
      expect(await keyStatus()).toBe('quarantined');
      expect(await rowCount(row.codeId)).toBe(1);
      expect(monitor.record).toHaveBeenCalledWith({
        operation: 'cleanup',
        code: 'OVERDUE',
        oldest: {
          dueAt: row.expiresAt,
          deadline: row.expiresAt + 86_400_000,
        },
      });
    });

    it('Providerが知らない行で止まっても、行の未達は封鎖する', async () => {
      // Providerへ登録しない発行経路で、列挙にない行を作る。
      const issued = await f.runtime.issue(sessionSecret(20), f.clock);
      if (issued.status !== 'issued') throw new Error('合成: 発行失敗');
      const [row] = await f.codes();
      f.now = row.expiresAt + 86_400_000;
      await expect(service.run(10)).resolves.toEqual({
        status: 'quarantined',
      });
      expect(await keyStatus()).toBe('quarantined');
      expect(await rowCount(row.codeId)).toBe(1);
      expect(monitor.record).toHaveBeenCalledWith({
        operation: 'cleanup',
        code: 'OVERDUE',
        oldest: {
          dueAt: row.expiresAt,
          deadline: row.expiresAt + 86_400_000,
        },
      });
    });

    it('完全性を保証できない列挙を空成功にしない', async () => {
      keys.faults.add('scope-page-unavailable');
      await expect(service.run(10)).resolves.toEqual({
        status: 'unavailable',
      });
      expect(monitor.record).toHaveBeenCalledWith({
        operation: 'cleanup',
        code: 'UNAVAILABLE',
        oldest: null,
      });
    });

    it('Providerが知らない期限切れ行があれば何も変えず止める', async () => {
      const issued = await f.runtime.issue(sessionSecret(20), f.clock);
      if (issued.status !== 'issued') throw new Error('合成: 発行失敗');
      const [row] = await f.codes();
      const known = await orphan(row.expiresAt);
      f.now = row.expiresAt;
      await expect(service.run(10)).resolves.toEqual({
        status: 'unavailable',
      });
      expect(await rowCount(row.codeId)).toBe(1);
      expect(await keys.maintenance.find(known.codeId)).toBeNull();
    });

    it('行の束縛ActorがProviderと違えば止める', async () => {
      const { row } = await issue();
      f.now = row.expiresAt;
      await f.admin.query(
        'UPDATE authentication.recipient_code SET recipient_actor_id=$2 WHERE code_id=$1',
        [row.codeId, actors.member],
      );
      await expect(service.run(10)).resolves.toEqual({
        status: 'unavailable',
      });
      expect(await rowCount(row.codeId)).toBe(1);
    });

    it('ticketと列挙の版が一致しなければ止める', async () => {
      const { row } = await issue();
      f.now = row.expiresAt;
      keys.faults.add('after-prepare');
      await service.run(10);
      keys.faults.delete('after-prepare');
      const stale = withMaintenance({
        scopePage: async (query) => {
          const page = await keys.maintenance.scopePage(query);
          return page.status === 'snapshot'
            ? {
                ...page,
                scopes: page.scopes.map((scope) => ({
                  ...scope,
                  inventoryRevision: 'other-revision',
                })),
              }
            : page;
        },
      });
      await expect(stale.run(10)).resolves.toEqual({ status: 'unavailable' });
      expect(await rowCount(row.codeId)).toBe(1);
    });

    it('未完了ticketのscopeが列挙になければ止める', async () => {
      const { row } = await issue();
      f.now = row.expiresAt;
      keys.faults.add('after-prepare');
      await service.run(10);
      keys.faults.delete('after-prepare');
      const missing = withMaintenance({
        scopePage: async (query) => {
          const page = await keys.maintenance.scopePage(query);
          return page.status === 'snapshot'
            ? { ...page, scopes: [], total: 0, nextCursor: null }
            : page;
        },
      });
      await expect(missing.run(10)).resolves.toEqual({
        status: 'unavailable',
      });
      expect(await rowCount(row.codeId)).toBe(1);
    });

    it('完了済みscopeが列挙から消えても、戻った行を除去できる', async () => {
      const { row, scope } = await issue();
      const saved = await saveRow(row.codeId);
      f.now = row.expiresAt;
      await service.cleanOne(scope);
      await restoreRow(saved);
      const dropped = withMaintenance({
        scopePage: async (query) => {
          const page = await keys.maintenance.scopePage(query);
          return page.status === 'snapshot'
            ? { ...page, scopes: [], total: 0, nextCursor: null }
            : page;
        },
      });
      await expect(dropped.cleanOne(scope)).resolves.toEqual({
        status: 'already-complete',
      });
      expect(await rowCount(row.codeId)).toBe(0);
      await restoreRow(saved);
      await expect(dropped.run(10)).resolves.toEqual({
        status: 'complete',
        removed: 0,
      });
      expect(await rowCount(row.codeId)).toBe(0);
    });

    it('完了済みticketのscopeと違うActorでは行を除去しない', async () => {
      const { row, scope } = await issue();
      const saved = await saveRow(row.codeId);
      f.now = row.expiresAt;
      await service.cleanOne(scope);
      await restoreRow(saved);
      await expect(
        service.cleanOne({ ...scope, recipientActorId: actors.member }),
      ).resolves.toEqual({ status: 'unavailable' });
      expect(await rowCount(row.codeId)).toBe(1);
    });
  });

  describe('24時間未達の封鎖', () => {
    const day = 86_400_000;

    it('deadline直前は封鎖せず、到達で封鎖して完了を数えない', async () => {
      const { row } = await issue();
      f.now = row.expiresAt + day - 1;
      await expect(service.run(10)).resolves.toEqual({
        status: 'complete',
        removed: 1,
      });
      expect(await keyStatus()).toBe('active');

      await f.reset();
      const later = await issue();
      f.now = later.row.expiresAt + day;
      await expect(service.run(10)).resolves.toEqual({
        status: 'quarantined',
      });
      expect(await keyStatus()).toBe('quarantined');
      expect(monitor.record).toHaveBeenCalledWith({
        operation: 'cleanup',
        code: 'OVERDUE',
        oldest: {
          dueAt: later.row.expiresAt,
          deadline: later.row.expiresAt + day,
        },
      });
      await expectComplete(later.row.codeId);
    });

    it('封鎖は清掃の完了後も維持され、発行を拒否する', async () => {
      const { row } = await issue();
      f.now = row.expiresAt + day;
      await service.run(10);
      await expect(service.run(10)).resolves.toEqual({
        status: 'complete',
        removed: 0,
      });
      expect(await keyStatus()).toBe('quarantined');
      await expect(runtime.issue(issuerSession, f.clock)).resolves.toEqual({
        status: 'unavailable',
      });
    });

    it('Provider障害でも既知の未達は封鎖する', async () => {
      const { row } = await issue();
      f.now = row.expiresAt + day;
      keys.faults.add('before-prepare');
      await expect(service.run(10)).resolves.toEqual({
        status: 'quarantined',
      });
      expect(await keyStatus()).toBe('quarantined');
      expect(await rowCount(row.codeId)).toBe(1);
    });

    it('封鎖できなければ成功も封鎖済みも返さない', async () => {
      const { row } = await issue();
      f.now = row.expiresAt + day;
      f.intercept = async (event, run) => {
        if (/UPDATE authentication\.key_state/.test(event.sql))
          throw new Error('synthetic-quarantine-failure');
        return run();
      };
      await expect(service.run(10)).resolves.toEqual({
        status: 'unavailable',
      });
      expect(await keyStatus()).toBe('active');
    });

    it('監視の障害を成功にしない', async () => {
      const { row } = await issue();
      f.now = row.expiresAt + day;
      monitor.record.mockRejectedValue(new Error('synthetic-monitor'));
      await expect(service.run(10)).resolves.toEqual({
        status: 'unavailable',
      });
      expect(await keyStatus()).toBe('quarantined');
    });

    it('未完了ticketの期限内の再開は封鎖しない', async () => {
      const { row } = await issue();
      f.now = row.expiresAt;
      keys.faults.add('before-close');
      await service.run(10);
      keys.faults.delete('before-close');
      f.now = row.expiresAt + day - 1;
      await expect(service.run(10)).resolves.toEqual({
        status: 'complete',
        removed: 1,
      });
      expect(await keyStatus()).toBe('active');
    });

    it('未完了ticketの期限超過を封鎖する', async () => {
      const { row } = await issue();
      f.now = row.expiresAt;
      keys.faults.add('before-close');
      await service.run(10);
      keys.faults.delete('before-close');
      f.now = row.expiresAt + day;
      await expect(service.run(10)).resolves.toEqual({
        status: 'quarantined',
      });
      await expectComplete(row.codeId);
    });
  });

  describe('Audit', () => {
    it('行の除去と同じcommitへActor仮名だけのpurgeを保存する', async () => {
      const { row, scope } = await issue();
      f.now = row.expiresAt;
      await service.cleanOne(scope);
      const rows = await purges();
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_digest).not.toBeNull();
      expect(rows[0].code_digest).toBeNull();
    });

    it('Audit障害では行を残し、完了を数えず同operationで再開する', async () => {
      const { row } = await issue();
      f.now = row.expiresAt;
      let failed = false;
      f.intercept = async (event, run) => {
        if (
          !failed &&
          event.sql.includes('INSERT INTO authentication.audit_event')
        ) {
          failed = true;
          throw new Error('synthetic-audit-failure');
        }
        return run();
      };
      await expect(service.run(10)).resolves.toEqual({
        status: 'unavailable',
      });
      expect(await rowCount(row.codeId)).toBe(1);
      expect(await purges()).toEqual([]);
      const ticket = await keys.maintenance.find(row.codeId);
      expect(ticket?.state).toBe('pending');
      expect(new Set(await destroyed(row.codeId))).toEqual(
        new Set(['current']),
      );
      await expect(service.run(10)).resolves.toEqual({
        status: 'complete',
        removed: 1,
      });
      expect(await purges()).toHaveLength(1);
      expect((await keys.maintenance.find(row.codeId))?.operationId).toBe(
        ticket?.operationId,
      );
    });
  });
});
