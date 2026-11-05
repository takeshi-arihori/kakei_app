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
} from 'vitest';

import { createRecipientInvitationRuntime } from '../src/recipient-invitation-runtime.js';
import { createRecipientCodeCleanupService } from '../src/shared/application/authentication/recipient-code-cleanup-service.js';
import { guardRecipientCodeMaintenance } from '../src/shared/application/authentication/recipient-code-maintenance-guard.js';
import { insertAuthenticationRecord } from '../src/shared/infrastructure/authentication/postgres/authentication-record-rows.js';
import { createPostgresRecipientCodeCleanup } from '../src/shared/infrastructure/authentication/postgres/postgres-recipient-code-cleanup.js';
import { ids } from '../src/shared/infrastructure/authentication/test/authentication-crypto-fixtures.js';
import { syntheticRecipientCodeManagedKeys } from '../src/shared/infrastructure/authentication/test/recipient-code-maintenance-fixtures.js';
import {
  actors,
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

describe('招待コード1件の清掃（実PG17＋合成Provider）', () => {
  const f = new RecipientInvitationFixture(url);
  const holder = new Client({ connectionString: url });
  let holderPid = 0;
  let keys: ReturnType<typeof syntheticRecipientCodeManagedKeys>;
  let runtime: ReturnType<typeof createRecipientInvitationRuntime>;
  let database: ReturnType<typeof createPostgresRecipientCodeCleanup>;
  let service: ReturnType<typeof createRecipientCodeCleanupService>;

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
      limits,
    });
    service = createRecipientCodeCleanupService({
      maintenance: guardRecipientCodeMaintenance(keys),
      database,
      clock: f.clock,
      nextOperationId: randomUUID,
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
        status: 'retained',
      });
      expect(await rowCount(row.codeId)).toBe(1);
      f.now = row.expiresAt;
      await expect(service.cleanOne(scope)).resolves.toEqual({
        status: 'completed',
      });
      await expectComplete(row.codeId);
      expect((await keys.maintenance.find(row.codeId))?.window.dueAt).toBe(
        row.expiresAt,
      );
    },
  );

  it('MAC鍵を取得できない行も残さない', async () => {
    const { row, scope } = await issue();
    f.codeMaterials.delete(`auth-recipient-code-state/v1/${row.codeId}/v1`);
    f.now = row.expiresAt;
    await expect(service.cleanOne(scope)).resolves.toEqual({
      status: 'completed',
    });
    await expectComplete(row.codeId);
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
      status: 'retained',
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

    it('コード行の待機中はActorを保持する', async () => {
      const { row, scope } = await issue();
      f.now = row.expiresAt;
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM authentication.recipient_code WHERE code_id=$1 FOR UPDATE',
        [row.codeId],
      );
      f.sqls = [];
      const running = service.cleanOne(scope);
      const waiter = await waitForSql(/recipient_code .*FOR UPDATE/);
      await f.waitBlocked(waiter, holderPid);
      await expect(
        f.admin.query(
          'SELECT 1 FROM authentication.actor WHERE actor_id=$1 FOR UPDATE NOWAIT',
          [scope.recipientActorId],
        ),
      ).rejects.toMatchObject({ code: '55P03' });
      await holder.query('COMMIT');
      await expect(running).resolves.toEqual({ status: 'completed' });
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
});
