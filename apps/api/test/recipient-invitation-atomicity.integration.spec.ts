import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { randomUUID } from 'node:crypto';
import { OperationId } from '../src/group-management/application/group-repository.js';
import { ActorSubject, GroupId } from '../src/group-management/domain/group.js';
import { RecipientCodeSecret } from '../src/shared/application/authentication/recipient-code-input.js';
import type {
  RecipientCodeCommitEvidence,
  RecipientCodeSessionPort,
} from '../src/shared/application/authentication/recipient-code-ports.js';
import { RegisteredRecipientInvitationService } from '../src/group-management/application/use-cases/registered-recipient-invitation-service.js';
import { createRecipientInvitationRuntime } from '../src/recipient-invitation-runtime.js';
import { readFile } from 'node:fs/promises';
import { applySqlMigrations } from '../src/group-management/infrastructure/postgres/sql-migration.js';
import {
  RecipientInvitationFixture,
  actors,
  barrier,
  sessionSecret,
} from './support/recipient-invitation-fixture.js';

describe('実Session・コード消費・Invitation・両Auditの共通commit #243', () => {
  const f = new RecipientInvitationFixture(
    process.env.TEST_DATABASE_URL ??
      'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test',
  );
  beforeAll(() => f.initialize());
  beforeEach(() => f.reset());
  afterAll(() => f.dispose());
  const command = (
    code: RecipientCodeSecret,
    groupId = f.groupId,
    operationId = `from-code-${randomUUID()}`,
    byte = 10,
    expectedVersion = 1,
  ) => ({
    code,
    groupId,
    operationId: OperationId.from(operationId),
    sessionSecret: sessionSecret(byte),
    expectedVersion,
  });
  const create = async () => {
    const issued = await f.issue();
    const input = command(issued.code);
    f.sqls = [];
    const r = await f.runtime.create(input);
    expect(r.status).toBe('authenticated');
    if (r.status !== 'authenticated') throw new Error('合成: 作成失敗');
    return {
      issued,
      input,
      result: r,
      body: JSON.parse(r.value.body) as Record<string, unknown>,
    };
  };
  const join = async (actor: string) => {
    const version = (await f.standalone.load(f.groupId))!.version;
    const invited = await f.commands.inviteParticipant({
      actorSubject: ActorSubject.from(actors.owner),
      operationId: OperationId.from(`invite-${randomUUID()}`),
      groupId: f.groupId,
      targetSubject: ActorSubject.from(actor),
      expectedVersion: version,
    });
    return f.commands.acceptInvitation({
      actorSubject: ActorSubject.from(actor),
      operationId: OperationId.from(`accept-${randomUUID()}`),
      groupId: f.groupId,
      invitationId: invited.invitationId,
      expectedVersion: invited.version,
    });
  };

  it('実コードConsumedと7日Pending/全履歴/版/operation/索引/両Auditを一回保存し最小本文を返す', async () => {
    const { issued, body } = await create();
    expect(Object.keys(body).sort()).toEqual([
      'groupId',
      'invitationId',
      'kind',
      'version',
    ]);
    expect(body).toMatchObject({
      kind: 'InvitationCreated',
      groupId: f.groupId.value,
      version: 2,
    });
    const rows = await f.codes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      codeId: issued.codeId,
      status: 'consumed',
      recordVersion: 2,
      terminalAt: f.now,
    });
    expect(await f.crypto.verifyRecord(rows[0])).toBe(true);
    const loaded = await f.standalone.load(f.groupId);
    expect(loaded?.version).toBe(2);
    const invitation = loaded!.group.invitations[0];
    expect(invitation.targetSubject.value).toBe(actors.recipient);
    expect(
      Date.parse(invitation.expiryAt.value) -
        Date.parse(invitation.createdAt.value),
    ).toBe(604800000);
    expect(loaded!.group.participants).toHaveLength(1);
    const audits = (
      await f.admin.query(
        "SELECT action::text,decision::text FROM authentication.audit_event WHERE action::text='recipient-code-consume'",
      )
    ).rows;
    expect(audits).toEqual([
      { action: 'recipient-code-consume', decision: 'allow' },
    ]);
    expect(
      (
        await f.admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM group_recipient_invitation_audit_record',
        )
      ).rows[0].n,
    ).toBe(1);
    const pids = new Set(
      f.sqls
        .filter(
          (e) =>
            /UPDATE authentication.recipient_code|INSERT INTO group_|UPDATE group_/.test(
              e.sql,
            ) ||
            (e.sql.includes('INSERT INTO authentication.audit_event') &&
              e.values.includes('recipient-code-consume')),
        )
        .map((e) => e.pid),
    );
    expect(pids.size).toBe(1);
    const transactions = await f.admin.query<{ tx: string }>(
      `
      SELECT xmin::text AS tx FROM group_aggregate_record WHERE group_id=$1
      UNION ALL SELECT xmin::text FROM group_invitation_record WHERE group_id=$1
      UNION ALL SELECT xmin::text FROM group_invitation_history_record WHERE group_id=$1
      UNION ALL SELECT xmin::text FROM group_operation_result_record WHERE group_id=$1 AND aggregate_version=2
      UNION ALL SELECT l.xmin::text FROM group_operation_locator_v2 l JOIN group_operation_result_record r ON r.group_id=l.group_id AND r.logical_record_id=l.operation_result_record_id WHERE r.group_id=$1 AND r.aggregate_version=2
      UNION ALL SELECT xmin::text FROM group_recipient_invitation_audit_record
      UNION ALL SELECT xmin::text FROM authentication.recipient_code WHERE code_id=$2
      UNION ALL SELECT xmin::text FROM authentication.session_record WHERE session_id='20000000-0000-4000-8000-000000000010'
      UNION ALL SELECT xmin::text FROM authentication.audit_event WHERE action::text='recipient-code-consume'
    `,
      [f.groupId.value, issued.codeId],
    );
    expect(transactions.rows).toHaveLength(9);
    expect(new Set(transactions.rows.map((row) => row.tx)).size).toBe(1);
    const raw = Buffer.from(issued.code.copyBytes()).toString('base64url');
    expect(JSON.stringify(body)).not.toContain(raw);
    expect(
      f.sqls
        .filter((e) => /INSERT|UPDATE/.test(e.sql))
        .some((e) => JSON.stringify(e.values).includes(raw)),
    ).toBe(false);
  });

  const rotateCodeMac = async () => {
    await f.admin.query('BEGIN');
    try {
      await f.admin.query(
        'SELECT state_id FROM authentication.key_state FOR UPDATE',
      );
      await f.admin.query(
        "UPDATE authentication.key_generation SET write_required=false WHERE purpose='recipient-code-state-mac'",
      );
      await f.admin.query(
        "INSERT INTO authentication.key_generation(generation_id,purpose,key_version,epoch,searchable,write_required) VALUES($1,'recipient-code-state-mac','v2',NULL,true,true)",
        [randomUUID()],
      );
      await f.admin.query('COMMIT');
    } finally {
      await f.admin.query('ROLLBACK');
    }
  };
  const callerSession = async () =>
    (
      await f.admin.query<{ row: unknown }>(
        "SELECT to_jsonb(s) AS row FROM authentication.session_record s WHERE session_id='20000000-0000-4000-8000-000000000010'",
      )
    ).rows;

  it.each([false, true])(
    'v1コードを現行MAC v2で消費し既存割当=%sでも鍵を再生成せず両Auditを共通確定する',
    async (existing) => {
      const issued = await f.issue();
      expect((await f.codes())[0].macKeyVersion).toBe('v1');
      await rotateCodeMac();
      const descriptor = {
        codeId: issued.codeId,
        keyVersion: 'v2',
        expiresAt: issued.expiresAt,
      };
      const keys = f.runtimeOptions.authentication.stateKeys;
      if (existing)
        expect(await keys.allocate(descriptor)).toEqual({
          status: 'allocated',
          ...descriptor,
          created: true,
        });
      const material = f.codeMaterials.get(
        `auth-recipient-code-state/v1/${issued.codeId}/v2`,
      );
      const allocate = vi.spyOn(keys, 'allocate');
      try {
        const result = await f.runtime.create(command(issued.code));
        expect(result.status).toBe('authenticated');
        expect(allocate).toHaveBeenCalledExactlyOnceWith(descriptor);
        expect(await allocate.mock.results[0].value).toEqual({
          status: 'allocated',
          ...descriptor,
          created: !existing,
        });
        const row = (await f.codes())[0];
        expect(row).toMatchObject({
          codeId: issued.codeId,
          macKeyVersion: 'v2',
          status: 'consumed',
          recordVersion: 2,
          expiresAt: issued.expiresAt,
        });
        expect(await f.crypto.verifyRecord(row)).toBe(true);
        if (existing)
          expect(
            f.codeMaterials.get(
              `auth-recipient-code-state/v1/${issued.codeId}/v2`,
            ),
          ).toBe(material);
        expect([...f.allocations.keys()].sort()).toEqual([
          `${issued.codeId}/v1`,
          `${issued.codeId}/v2`,
        ]);
        const transactions = await f.admin.query<{ tx: string }>(
          `
        SELECT xmin::text AS tx FROM authentication.recipient_code WHERE code_id=$1
        UNION ALL SELECT xmin::text FROM group_invitation_record WHERE group_id=$2
        UNION ALL SELECT xmin::text FROM group_recipient_invitation_audit_record
        UNION ALL SELECT xmin::text FROM authentication.audit_event WHERE action::text='recipient-code-consume'
        UNION ALL SELECT xmin::text FROM authentication.session_record WHERE session_id='20000000-0000-4000-8000-000000000010'
      `,
          [issued.codeId, f.groupId.value],
        );
        expect(transactions.rows).toHaveLength(5);
        expect(new Set(transactions.rows.map((r) => r.tx)).size).toBe(1);
      } finally {
        allocate.mockRestore();
      }
    },
  );

  it.each([
    'unavailable',
    'throw',
    'codeId',
    'keyVersion',
    'expiresAt',
    'created',
    'new-key-missing',
    'old-key-missing',
  ] as const)(
    '実Consumerの世代切替で%sなら全業務・成功Audit・caller Sessionをrollbackし作成を再実行しない',
    async (fault) => {
      const issued = await f.issue();
      await rotateCodeMac();
      const before = await f.snapshot(),
        sessionBefore = await callerSession();
      const keys = f.runtimeOptions.authentication.stateKeys;
      const original = keys.allocate.bind(keys);
      const allocate = vi
        .spyOn(keys, 'allocate')
        .mockImplementation(async (input) => {
          if (fault === 'throw')
            throw new Error('synthetic allocation unavailable');
          if (fault === 'unavailable') return { status: 'unavailable' };
          const answer = await original(input);
          if (fault === 'codeId') return { ...answer, codeId: randomUUID() };
          if (fault === 'keyVersion') return { ...answer, keyVersion: 'v3' };
          if (fault === 'expiresAt')
            return { ...answer, expiresAt: input.expiresAt + 1 };
          if (fault === 'created')
            return { ...answer, created: undefined as unknown as boolean };
          f.codeMaterials.delete(
            `auth-recipient-code-state/v1/${input.codeId}/${input.keyVersion}`,
          );
          return answer;
        });
      if (fault === 'old-key-missing')
        f.codeMaterials.delete(
          `auth-recipient-code-state/v1/${issued.codeId}/v1`,
        );
      const nextInvitationId = vi.fn(f.runtimeOptions.nextInvitationId);
      const runtime = createRecipientInvitationRuntime({
        ...f.runtimeOptions,
        nextInvitationId,
      });
      f.sqls = [];
      try {
        expect(await runtime.create(command(issued.code))).toEqual({
          status: 'unavailable',
        });
        expect(await f.snapshot()).toEqual(before);
        expect(await callerSession()).toEqual(sessionBefore);
        expect(allocate).toHaveBeenCalledTimes(
          fault === 'old-key-missing' ? 0 : 1,
        );
        expect(nextInvitationId).toHaveBeenCalledTimes(
          fault === 'old-key-missing' ? 0 : 1,
        );
        expect(
          f.sqls.filter((e) =>
            e.sql.startsWith('UPDATE authentication.recipient_code'),
          ),
        ).toHaveLength(0);
        if (fault === 'new-key-missing')
          expect(f.allocations.has(`${issued.codeId}/v2`)).toBe(true);
      } finally {
        allocate.mockRestore();
      }
    },
  );

  it('成功preflightはコード行/宛先Actor/MAC鍵なしでも保存proof世代の最小結果を返す', async () => {
    const { issued, input, result } = await create();
    await f.admin.query(
      'DELETE FROM authentication.recipient_code WHERE code_id=$1',
      [issued.codeId],
    );
    await f.setActor(actors.recipient, 'disabled');
    f.codeMaterials.clear();
    f.now += 700000;
    f.sqls = [];
    const before = await f.snapshot();
    const replay = await f.runtime.create(input);
    expect(replay).toEqual(result);
    expect(await f.snapshot()).toEqual(before);
    expect(
      f.sqls.some((e) => e.sql.includes('authentication.recipient_code')),
    ).toBe(false);
    expect(
      f.sqls
        .filter((e) => e.sql.includes('authentication.actor'))
        .some((e) => e.values.includes(actors.recipient)),
    ).toBe(false);
  });

  it.each(['code', 'groupId', 'expectedVersion', 'actor'] as const)(
    '同operationの%s変更は保存成功を漏らさず業務不変',
    async (field) => {
      const { input } = await create();
      const before = await f.snapshot();
      const changed = { ...input };
      if (field === 'code')
        changed.code = RecipientCodeSecret.parse(
          Buffer.alloc(32, 99).toString('base64url'),
        )!;
      if (field === 'groupId') changed.groupId = f.otherGroupId;
      if (field === 'expectedVersion') changed.expectedVersion = 2;
      if (field === 'actor') changed.sessionSecret = sessionSecret(30);
      expect((await f.runtime.create(changed)).status).not.toBe(
        'authenticated',
      );
      expect(await f.snapshot()).toEqual(before);
    },
  );

  it.each([
    'UPDATE authentication.recipient_code',
    'INSERT INTO group_invitation_record',
    'INSERT INTO group_invitation_history_record',
    'INSERT INTO group_operation_result_record',
    'INSERT INTO group_operation_locator_v2',
    'INSERT INTO group_recipient_invitation_audit_record',
    'INSERT INTO authentication.audit_event',
    'UPDATE authentication.session_record',
  ])(
    '%s故障はコード/Invitation/履歴/版/operation/両Auditを全rollback',
    async (fragment) => {
      const issued = await f.issue();
      const before = await f.snapshot();
      let failed = false;
      f.intercept = async (e, run) => {
        if (
          !failed &&
          e.sql.includes(fragment) &&
          (fragment !== 'INSERT INTO authentication.audit_event' ||
            e.values.includes('recipient-code-consume'))
        ) {
          failed = true;
          throw new Error('synthetic-write-failure');
        }
        return run();
      };
      expect((await f.runtime.create(command(issued.code))).status).not.toBe(
        'authenticated',
      );
      expect(failed).toBe(true);
      expect(await f.snapshot()).toEqual(before);
    },
  );

  it('COMMIT応答喪失は接続を破棄してcaller-only照合へ収束し再作成しない', async () => {
    const issued = await f.issue();
    const input = command(issued.code);
    let lost = false;
    f.intercept = async (e, run) => {
      const answer = await run();
      if (
        !lost &&
        e.sql === 'COMMIT' &&
        f.sqls.some(
          (x) =>
            x.pid === e.pid &&
            x.sql.includes('UPDATE authentication.recipient_code'),
        )
      ) {
        lost = true;
        throw new Error('synthetic-response-lost');
      }
      return answer;
    };
    const result = await f.runtime.create(input);
    expect(result.status).toBe('authenticated');
    expect(lost).toBe(true);
    expect(f.released.some((x) => x.destroy)).toBe(true);
    expect(
      f.sqls.filter((e) =>
        e.sql.includes('UPDATE authentication.recipient_code'),
      ),
    ).toHaveLength(1);
    expect(await f.runtime.create(input)).toEqual(result);
  });

  it('COMMIT送信前の障害は確実rollback、回復照会で新規処理を再実行しない', async () => {
    const issued = await f.issue();
    const before = await f.snapshot();
    let failed = false;
    f.intercept = async (e, run) => {
      if (!failed && e.sql.includes('UPDATE authentication.session_record')) {
        failed = true;
        throw new Error('synthetic-before-commit');
      }
      return run();
    };
    expect((await f.runtime.create(command(issued.code))).status).toBe(
      'unavailable',
    );
    expect(await f.snapshot()).toEqual(before);
    expect(
      f.sqls.filter((e) =>
        e.sql.includes('UPDATE authentication.recipient_code'),
      ),
    ).toHaveLength(1);
  });

  it('Group Lock待機中にコード期限へ到達すればコードもGMも保存しない', async () => {
    const issued = await f.issue();
    const before = await f.snapshot();
    const holder = await f.pool.connect();
    await holder.query('BEGIN');
    await holder.query(
      'SELECT 1 FROM group_aggregate_record WHERE group_id=$1 FOR UPDATE',
      [f.groupId.value],
    );
    const blocker = (
      await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    ).rows[0].pid;
    const waiting = barrier();
    let pid = 0;
    f.intercept = async (e, run) => {
      if (
        e.sql.includes('FROM group_aggregate_record') &&
        e.sql.includes('FOR UPDATE')
      ) {
        pid = e.pid;
        waiting.release();
      }
      return run();
    };
    const outcome = f.runtime.create(command(issued.code));
    try {
      await waiting.entered;
      await f.waitBlocked(pid, blocker);
      f.now = issued.expiresAt;
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await outcome).status).not.toBe('authenticated');
    expect(await f.snapshot()).toEqual(before);
  });

  it('最終serialize後の認証保存中に期限へ到達しても全commitを拒否する', async () => {
    const issued = await f.issue();
    const before = await f.snapshot();
    f.intercept = async (e, run) => {
      const r = await run();
      if (e.sql.includes('UPDATE authentication.session_record'))
        f.now = issued.expiresAt;
      return r;
    };
    expect((await f.runtime.create(command(issued.code))).status).not.toBe(
      'authenticated',
    );
    expect(await f.snapshot()).toEqual(before);
  });

  it.each(['different-owner', 'same-operation'] as const)(
    '同コードの2接続競合 %s は一回だけ消費/作成し同operationは再送へ収束',
    async (mode) => {
      const issued = await f.issue();
      const input = command(issued.code);
      const locked = barrier(),
        release = barrier(),
        secondWaiting = barrier();
      let firstPid = 0,
        secondPid = 0;
      f.intercept = async (e, run) => {
        if (
          e.sql.includes('FROM authentication.recipient_code') &&
          e.sql.includes('FOR UPDATE')
        ) {
          if (!firstPid) {
            firstPid = e.pid;
            const r = await run();
            locked.release();
            await release.entered;
            return r;
          }
          if (e.pid !== firstPid) {
            secondPid = e.pid;
            secondWaiting.release();
          }
        }
        return run();
      };
      const first = f.runtime.create(input);
      await locked.entered;
      const secondInput =
        mode === 'same-operation'
          ? { ...input, sessionSecret: sessionSecret(50) }
          : command(issued.code, f.otherGroupId, `other-${randomUUID()}`, 30);
      const second = f.runtime.create(secondInput);
      try {
        await secondWaiting.entered;
        await f.waitBlocked(secondPid, firstPid);
      } finally {
        release.release();
      }
      const [winner, loser] = await Promise.all([first, second]);
      expect(winner.status).toBe('authenticated');
      if (mode === 'same-operation') expect(loser).toEqual(winner);
      else expect(loser.status).not.toBe('authenticated');
      expect(
        f.sqls.filter((e) =>
          e.sql.includes('UPDATE authentication.recipient_code'),
        ),
      ).toHaveLength(1);
      expect(
        (
          await f.admin.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM group_invitation_record',
          )
        ).rows[0].n,
      ).toBe(1);
      expect((await f.standalone.load(f.otherGroupId))?.version).toBe(1);
    },
  );

  it.each(['revoke', 'reissue'] as const)(
    '消費が先なら後続%sはActor Lockを待ち、確定済みInvitationを取り消さない',
    async (mode) => {
      const issued = await f.issue(),
        locked = barrier(),
        release = barrier(),
        secondWaiting = barrier();
      let firstPid = 0,
        secondPid = 0;
      f.intercept = async (e, run) => {
        if (
          !firstPid &&
          e.sql.includes('FROM authentication.recipient_code') &&
          e.sql.includes('FOR UPDATE')
        ) {
          firstPid = e.pid;
          const r = await run();
          locked.release();
          await release.entered;
          return r;
        }
        if (
          firstPid &&
          e.pid !== firstPid &&
          e.sql.includes('FROM authentication.actor') &&
          e.sql.includes('FOR UPDATE')
        ) {
          secondPid = e.pid;
          secondWaiting.release();
        }
        return run();
      };
      const consuming = f.runtime.create(command(issued.code));
      await locked.entered;
      const management =
        mode === 'revoke'
          ? f.runtime.revoke(sessionSecret(20), issued.codeId, f.clock)
          : f.runtime.issue(sessionSecret(20), f.clock);
      try {
        await secondWaiting.entered;
        await f.waitBlocked(secondPid, firstPid);
      } finally {
        release.release();
      }
      expect((await consuming).status).toBe('authenticated');
      expect((await management).status).toBe(
        mode === 'revoke' ? 'already-inactive' : 'issued',
      );
      expect(
        (
          await f.admin.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM group_invitation_record',
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (await f.codes()).find((c) => c.codeId === issued.codeId)?.status,
      ).toBe('consumed');
    },
  );

  it.each(['revoke', 'reissue'] as const)(
    '%sが先なら消費は宛先Actor Lockを待ち、旧コード/GMを部分更新しない',
    async (mode) => {
      const issued = await f.issue(),
        locked = barrier(),
        release = barrier(),
        secondWaiting = barrier();
      let firstPid = 0,
        secondPid = 0;
      f.intercept = async (e, run) => {
        if (
          !firstPid &&
          e.sql.includes('UPDATE authentication.recipient_code')
        ) {
          firstPid = e.pid;
          const r = await run();
          locked.release();
          await release.entered;
          return r;
        }
        if (
          firstPid &&
          e.pid !== firstPid &&
          e.sql.includes('FROM authentication.actor') &&
          e.sql.includes('FOR SHARE') &&
          e.values.includes(actors.recipient)
        ) {
          secondPid = e.pid;
          secondWaiting.release();
        }
        return run();
      };
      const management =
        mode === 'revoke'
          ? f.runtime.revoke(sessionSecret(20), issued.codeId, f.clock)
          : f.runtime.issue(sessionSecret(20), f.clock);
      await locked.entered;
      const consuming = f.runtime.create(command(issued.code));
      try {
        await secondWaiting.entered;
        await f.waitBlocked(secondPid, firstPid);
      } finally {
        release.release();
      }
      expect((await management).status).toBe(
        mode === 'revoke' ? 'revoked' : 'issued',
      );
      expect((await consuming).status).not.toBe('authenticated');
      expect(
        (
          await f.admin.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM group_invitation_record',
          )
        ).rows[0].n,
      ).toBe(0);
      expect((await f.standalone.load(f.groupId))?.version).toBe(1);
    },
  );

  it('caller-only missの終了後にSessionが失効すると新規leaseで拒否する', async () => {
    const issued = await f.issue();
    const before = await f.snapshot();
    let changed = false;
    f.intercept = async (e, run) => {
      const r = await run();
      if (!changed && e.sql === 'COMMIT') {
        changed = true;
        await f.revokeSession();
      }
      return r;
    };
    expect((await f.runtime.create(command(issued.code))).status).toBe(
      'unauthenticated',
    );
    expect(await f.snapshot()).toEqual(before);
  });

  it.each(['owner', 'recipient'] as const)(
    '新規処理は無効化済み%sを信頼せず業務不変',
    async (role) => {
      const issued = await f.issue();
      await f.setActor(actors[role], 'disabled');
      const before = await f.snapshot();
      expect((await f.runtime.create(command(issued.code))).status).not.toBe(
        'authenticated',
      );
      expect(await f.snapshot()).toEqual(before);
    },
  );

  it.each([
    'Record MAC',
    'proof',
    'GM Envelope',
    'コードAudit',
    'serialize',
  ] as const)('%s障害は成功/部分保存を返さず業務不変', async (mode) => {
    const issued = await f.issue();
    const before = await f.snapshot();
    const failure = () => Promise.reject(new Error('synthetic-port-failure'));
    let restore = () => {};
    if (mode === 'Record MAC') {
      const spy = vi.spyOn(f.crypto, 'recordMac').mockImplementation(failure);
      restore = () => spy.mockRestore();
    }
    if (mode === 'proof') {
      const spy = vi.spyOn(f.proof, 'create').mockImplementation(failure);
      restore = () => spy.mockRestore();
    }
    if (mode === 'GM Envelope') {
      const spy = vi.spyOn(f.groupCodec, 'seal').mockImplementation(failure);
      restore = () => spy.mockRestore();
    }
    if (mode === 'コードAudit') {
      const spy = vi.spyOn(f.crypto, 'audit').mockImplementation(failure);
      restore = () => spy.mockRestore();
    }
    if (mode === 'serialize') {
      const original = JSON.stringify;
      const spy = vi
        .spyOn(JSON, 'stringify')
        .mockImplementation((value: unknown) => {
          if (
            value &&
            typeof value === 'object' &&
            'kind' in value &&
            value.kind === 'InvitationCreated'
          )
            throw new Error('synthetic-serialize-failure');
          return original(value);
        });
      restore = () => spy.mockRestore();
    }
    try {
      expect((await f.runtime.create(command(issued.code))).status).not.toBe(
        'authenticated',
      );
    } finally {
      restore();
    }
    expect(await f.snapshot()).toEqual(before);
  });

  it('中断要求を内部Use Caseから専用leaseへ伝え、GM保存中でも全rollbackする', async () => {
    const issued = await f.issue();
    const before = await f.snapshot();
    const abort = new AbortController();
    let stopped = false;
    f.intercept = async (e, run) => {
      const r = await run();
      if (e.sql.includes('INSERT INTO group_invitation_record')) {
        stopped = true;
        abort.abort();
      }
      return r;
    };
    expect(
      (await f.runtime.create(command(issued.code), abort.signal)).status,
    ).toBe('unavailable');
    expect(stopped).toBe(true);
    expect(await f.snapshot()).toEqual(before);
  });

  it.each(['Closing', 'Owner譲渡', '受諾/4人'] as const)(
    '%sがGroup Lockを先に確定した競合は古い版でコードを消費しない',
    async (mode) => {
      const member = mode === 'Owner譲渡' ? await join(actors.member) : null;
      let pending:
        Awaited<ReturnType<typeof f.commands.inviteParticipant>> | undefined;
      if (mode === '受諾/4人') {
        await join(actors.otherOwner);
        await join(actors.member);
        const version = (await f.standalone.load(f.groupId))!.version;
        pending = await f.commands.inviteParticipant({
          actorSubject: ActorSubject.from(actors.owner),
          operationId: OperationId.from(`pending-${randomUUID()}`),
          groupId: f.groupId,
          targetSubject: ActorSubject.from(actors.recipient),
          expectedVersion: version,
        });
      }
      const version = (await f.standalone.load(f.groupId))!.version;
      const issued = await f.issue();
      const held = await f.pool.connect();
      await held.query('BEGIN');
      await held.query(
        'SELECT 1 FROM group_aggregate_record WHERE group_id=$1 FOR UPDATE',
        [f.groupId.value],
      );
      const holder = (
        await held.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0].pid;
      const firstWaiting = barrier(),
        secondWaiting = barrier();
      let firstPid = 0,
        secondPid = 0;
      f.intercept = async (e, run) => {
        if (
          !firstPid &&
          e.sql.includes('FROM group_aggregate_record') &&
          e.sql.includes('FOR UPDATE')
        ) {
          firstPid = e.pid;
          firstWaiting.release();
        }
        if (
          e.pid !== firstPid &&
          e.sql.includes('FROM group_aggregate_record') &&
          e.sql.includes('FOR UPDATE')
        ) {
          secondPid = e.pid;
          secondWaiting.release();
        }
        return run();
      };
      const base = {
        actorSubject: ActorSubject.from(actors.owner),
        operationId: OperationId.from(`compete-${randomUUID()}`),
        groupId: f.groupId,
        expectedVersion: version,
      };
      const changing =
        mode === 'Closing'
          ? f.commands.startGroupClosing(base)
          : mode === 'Owner譲渡'
            ? f.commands.transferGroupOwnership({
                ...base,
                targetParticipantId: member!.participantId,
              })
            : f.commands.acceptInvitation({
                ...base,
                actorSubject: ActorSubject.from(actors.recipient),
                invitationId: pending!.invitationId,
              });
      let consuming: ReturnType<typeof f.runtime.create> | undefined;
      try {
        await firstWaiting.entered;
        await f.waitBlocked(firstPid, holder);
        consuming = f.runtime.create(
          command(issued.code, f.groupId, `code-${randomUUID()}`, 10, version),
        );
        await secondWaiting.entered;
        await f.waitBlocked(secondPid, firstPid);
      } finally {
        await held.query('ROLLBACK');
        held.release();
      }
      const changed = await changing;
      expect((await consuming).status).not.toBe('authenticated');
      expect((await f.codes())[0].status).toBe('issued');
      expect((await f.standalone.load(f.groupId))?.version).toBe(
        changed.version,
      );
      expect(
        (
          await f.admin.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM group_recipient_invitation_audit_record',
          )
        ).rows[0].n,
      ).toBe(0);
    },
  );

  it('消費がGroup Lockを先に確定すれば並行Closingの古いCASだけが拒否される', async () => {
    const issued = await f.issue(),
      locked = barrier(),
      release = barrier(),
      secondWaiting = barrier();
    let firstPid = 0,
      secondPid = 0;
    f.intercept = async (e, run) => {
      if (
        !firstPid &&
        e.sql.includes('FROM group_aggregate_record') &&
        e.sql.includes('FOR UPDATE')
      ) {
        firstPid = e.pid;
        const r = await run();
        locked.release();
        await release.entered;
        return r;
      }
      if (
        firstPid &&
        e.pid !== firstPid &&
        e.sql.includes('FROM group_aggregate_record') &&
        e.sql.includes('FOR UPDATE')
      ) {
        secondPid = e.pid;
        secondWaiting.release();
      }
      return run();
    };
    const consuming = f.runtime.create(command(issued.code));
    await locked.entered;
    const closing = f.commands
      .startGroupClosing({
        actorSubject: ActorSubject.from(actors.owner),
        operationId: OperationId.from(`closing-${randomUUID()}`),
        groupId: f.groupId,
        expectedVersion: 1,
      })
      .then(
        (r) => ({ r }),
        (error) => ({ error: error as Error }),
      );
    try {
      await secondWaiting.entered;
      await f.waitBlocked(secondPid, firstPid);
    } finally {
      release.release();
    }
    expect((await consuming).status).toBe('authenticated');
    expect(await closing).toMatchObject({ error: { code: 'CONFLICT' } });
    expect((await f.codes())[0].status).toBe('consumed');
    expect((await f.standalone.load(f.groupId))?.version).toBe(2);
  });

  it.each(['MAC', 'epoch', 'lookup'] as const)(
    'コード%s改変は汎用拒否と全業務不変',
    async (mode) => {
      const issued = await f.issue();
      if (mode === 'MAC')
        await f.admin.query(
          'UPDATE authentication.recipient_code SET state_mac=$1 WHERE code_id=$2',
          [Buffer.alloc(32, 99), issued.codeId],
        );
      if (mode === 'epoch')
        await f.admin.query(
          'UPDATE authentication.recipient_code SET epoch=$1 WHERE code_id=$2',
          ['90000000-0000-4000-8000-000000000001', issued.codeId],
        );
      if (mode === 'lookup')
        await f.admin.query(
          'UPDATE authentication.recipient_code SET lookup_digest=$1 WHERE code_id=$2',
          [Buffer.alloc(32, 99), issued.codeId],
        );
      const before = await f.snapshot();
      expect((await f.runtime.create(command(issued.code))).status).not.toBe(
        'authenticated',
      );
      expect(await f.snapshot()).toEqual(before);
    },
  );

  it('非在籍callerは存在非開示でGroup復号0、コードも消費しない', async () => {
    const issued = await f.issue(),
      before = await f.snapshot();
    const opens = vi.spyOn(f.groupCodec, 'open');
    expect(
      (
        await f.runtime.create(
          command(issued.code, f.groupId, `forbidden-${randomUUID()}`, 30),
        )
      ).status,
    ).not.toBe('authenticated');
    expect(opens).not.toHaveBeenCalled();
    expect(await f.snapshot()).toEqual(before);
  });

  it('現在Ownerを失っても、現在Group版とcurrent proof鍵を要求せず保存世代で成功再送する', async () => {
    const { input, result } = await create();
    const member = await join(actors.member);
    await f.commands.transferGroupOwnership({
      actorSubject: ActorSubject.from(actors.owner),
      operationId: OperationId.from(`transfer-${randomUUID()}`),
      groupId: f.groupId,
      expectedVersion: member.version,
      targetParticipantId: member.participantId,
    });
    await f.admin.query(
      'UPDATE group_recipient_code_proof_key_state SET current_key_version=NULL WHERE id=1',
    );
    f.now += 700000;
    const before = await f.snapshot();
    expect(await f.runtime.create(input)).toEqual(result);
    expect(await f.snapshot()).toEqual(before);
  });

  it.each([-1, 0, 1])(
    '初回コード期限から%imsの判断点を厳密に検証する',
    async (offset) => {
      const issued = await f.issue(),
        before = await f.snapshot();
      f.now = issued.expiresAt + offset;
      const result = await f.runtime.create(command(issued.code));
      expect(result.status === 'authenticated').toBe(offset < 0);
      if (offset >= 0) expect(await f.snapshot()).toEqual(before);
    },
  );

  it('発行元本人のlogoutはコードを失効させずOwnerの有効Sessionで消費できる', async () => {
    const issued = await f.issue();
    await f.revokeSession(20);
    expect((await f.runtime.create(command(issued.code))).status).toBe(
      'authenticated',
    );
  });

  it('別コード/別Groupでも同Actor同operationのlocator Unique敗者を全rollbackする', async () => {
    const a = await f.issue();
    const b = await f.runtime.issue(sessionSecret(40), f.clock);
    if (b.status !== 'issued') throw new Error('合成: 第二コード発行失敗');
    const third = GroupId.from(randomUUID());
    await f.seed(third, actors.owner);
    const op = `same-op-${randomUUID()}`,
      locked = barrier(),
      release = barrier(),
      secondWaiting = barrier();
    let firstPid = 0,
      secondPid = 0;
    f.intercept = async (e, run) => {
      if (e.sql.includes('INSERT INTO group_operation_locator_v2')) {
        if (!firstPid) {
          firstPid = e.pid;
          const r = await run();
          locked.release();
          await release.entered;
          return r;
        }
        if (e.pid !== firstPid) {
          secondPid = e.pid;
          secondWaiting.release();
        }
      }
      return run();
    };
    const first = f.runtime.create(command(a.code, f.groupId, op));
    await locked.entered;
    const second = f.runtime.create(command(b.code, third, op, 50));
    try {
      await secondWaiting.entered;
      await f.waitBlocked(secondPid, firstPid);
    } finally {
      release.release();
    }
    expect((await first).status).toBe('authenticated');
    expect((await second).status).not.toBe('authenticated');
    expect((await f.standalone.load(third))?.version).toBe(1);
    expect((await f.codes()).find((c) => c.codeId === b.codeId)?.status).toBe(
      'issued',
    );
    expect(
      (
        await f.admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM group_invitation_record',
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it.each(['owner', 'recipient'] as const)(
    '先行%s無効化のActor排他Lockを待ち、Lock後状態を再検証する',
    async (role) => {
      const issued = await f.issue(),
        before = await f.snapshot(),
        held = await f.pool.connect();
      await held.query('BEGIN');
      await held.query(
        'SELECT 1 FROM authentication.actor WHERE actor_id=$1 FOR UPDATE',
        [actors[role]],
      );
      const blocker = (
        await held.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0].pid;
      const waiting = barrier();
      let pid = 0;
      f.intercept = async (e, run) => {
        if (
          e.sql.includes('FROM authentication.actor') &&
          e.values.includes(actors[role])
        ) {
          pid = e.pid;
          waiting.release();
        }
        return run();
      };
      const result = f.runtime.create(command(issued.code));
      try {
        await waiting.entered;
        await f.waitBlocked(pid, blocker);
        await f.setActor(actors[role], 'disabled', held);
      } finally {
        await held.query('COMMIT');
        held.release();
      }
      expect((await result).status).not.toBe('authenticated');
      expect(await f.snapshot()).toEqual(before);
    },
  );

  it('preflight miss後の専用leaseでも並行成功を先に再照合する', async () => {
    const issued = await f.issue(),
      input = command(issued.code),
      miss = barrier(),
      resume = barrier();
    let paused = false;
    f.intercept = async (e, run) => {
      const r = await run();
      if (!paused && e.sql === 'COMMIT') {
        paused = true;
        miss.release();
        await resume.entered;
      }
      return r;
    };
    const first = f.runtime.create(input);
    await miss.entered;
    let second: Awaited<ReturnType<typeof f.runtime.create>>;
    try {
      second = await f.runtime.create({
        ...input,
        sessionSecret: sessionSecret(50),
      });
    } finally {
      resume.release();
    }
    expect(second!.status).toBe('authenticated');
    expect(await first).toEqual(second!);
    expect(
      f.sqls.filter((e) =>
        e.sql.includes('UPDATE authentication.recipient_code'),
      ),
    ).toHaveLength(1);
  });

  it('COMMIT送信位置で送信前に切断しても結果を推測せず、照会missの後に新規処理を再実行しない', async () => {
    const issued = await f.issue(),
      before = await f.snapshot();
    let lost = false;
    f.intercept = async (e, run) => {
      if (
        !lost &&
        e.sql === 'COMMIT' &&
        f.sqls.some(
          (x) =>
            x.pid === e.pid &&
            x.sql.includes('UPDATE authentication.recipient_code'),
        )
      ) {
        lost = true;
        throw new Error('synthetic-before-send');
      }
      return run();
    };
    expect((await f.runtime.create(command(issued.code))).status).toBe(
      'unavailable',
    );
    expect(lost).toBe(true);
    expect(f.released.some((x) => x.destroy)).toBe(true);
    expect(await f.snapshot()).toEqual(before);
    expect(
      f.sqls.filter((e) =>
        e.sql.includes('UPDATE authentication.recipient_code'),
      ),
    ).toHaveLength(1);
  });

  it('commit不明後の回復照会でSessionが失効してもunauthenticatedへ読み替えず不明を維持する', async () => {
    const issued = await f.issue(),
      input = command(issued.code);
    let lost = false;
    f.intercept = async (e, run) => {
      const r = await run();
      if (
        !lost &&
        e.sql === 'COMMIT' &&
        f.sqls.some(
          (x) =>
            x.pid === e.pid &&
            x.sql.includes('UPDATE authentication.recipient_code'),
        )
      ) {
        lost = true;
        await f.revokeSession();
        throw new Error('synthetic-lost-after-revocation');
      }
      return r;
    };
    expect((await f.runtime.create(input)).status).toBe('unavailable');
    expect(lost).toBe(true);
    expect((await f.codes())[0].status).toBe('consumed');
    expect(
      (await f.runtime.create({ ...input, sessionSecret: sessionSecret(50) }))
        .status,
    ).toBe('authenticated');
    expect(
      f.sqls.filter((e) =>
        e.sql.includes('UPDATE authentication.recipient_code'),
      ),
    ).toHaveLength(1);
  });

  it('Group Lock timeoutは全rollbackし、Callbackを自動再実行しない', async () => {
    const issued = await f.issue(),
      before = await f.snapshot(),
      held = await f.pool.connect();
    await held.query('BEGIN');
    await held.query(
      'SELECT 1 FROM group_aggregate_record WHERE group_id=$1 FOR UPDATE',
      [f.groupId.value],
    );
    try {
      expect((await f.runtime.create(command(issued.code))).status).toBe(
        'unavailable',
      );
    } finally {
      await held.query('ROLLBACK');
      held.release();
    }
    expect(await f.snapshot()).toEqual(before);
    expect(
      f.sqls.filter(
        (e) =>
          e.sql.includes('FROM group_aggregate_record') &&
          e.sql.includes('FOR UPDATE'),
      ),
    ).toHaveLength(1);
  });

  it('Provider待機中のTransaction timeoutでも接続を破棄し、遅延SQLを実行しない', async () => {
    const issued = await f.issue(),
      before = await f.snapshot(),
      entered = barrier(),
      release = barrier();
    let started = false;
    const original = f.groupCodec.seal.bind(f.groupCodec);
    const spy = vi
      .spyOn(f.groupCodec, 'seal')
      .mockImplementation(async (input) => {
        started = true;
        entered.release();
        await release.entered;
        return original(input);
      });
    const drained = barrier();
    const persist = f.runtimeOptions.group.stateWriter.persist.bind(
      f.runtimeOptions.group.stateWriter,
    );
    const stateSpy = vi
      .spyOn(f.runtimeOptions.group.stateWriter, 'persist')
      .mockImplementation(async (...args) => {
        try {
          return await persist(...args);
        } finally {
          drained.release();
        }
      });
    const runtime = createRecipientInvitationRuntime({
      ...f.runtimeOptions,
      limits: { ...f.runtimeOptions.limits, transactionTimeoutMs: 150 },
    });
    const result = runtime.create(command(issued.code));
    await entered.entered;
    try {
      expect((await result).status).toBe('unavailable');
      expect(started).toBe(true);
      expect(f.released.some((x) => x.destroy)).toBe(true);
    } finally {
      release.release();
      spy.mockRestore();
    }
    await drained.entered;
    stateSpy.mockRestore();
    expect(await f.snapshot()).toEqual(before);
  });

  it.each(['偽証跡', '別Scope', '二重消費', '完了済み未await'] as const)(
    '実lease/実GM/実消費の%sは握り潰しても全commitを拒否する',
    async (mode) => {
      const issued = await f.issue(),
        before = await f.snapshot(),
        input = command(issued.code);
      const { repository, leases } = f.components();
      let witness: RecipientCodeCommitEvidence | undefined,
        completed = false,
        readFailed = false;
      const sessions: Pick<RecipientCodeSessionPort, 'use'> = {
        use: (secret, code, clock, callbacks, signal) =>
          leases.use(
            secret,
            code,
            clock,
            {
              replay: callbacks.replay.bind(callbacks),
              create: async (facts, handle, scope) => {
                const value = await callbacks.create(
                  facts,
                  handle,
                  mode === '別Scope' ? Object.freeze({ ...scope }) : scope,
                );
                if (mode === '二重消費')
                  await scope.consume(handle, witness!).catch(() => {});
                if (mode === '完了済み未await') {
                  const done = barrier();
                  void repository
                    .findOperation(
                      scope,
                      ActorSubject.from(facts.caller.actorSubject),
                      input.operationId,
                    )
                    .catch(() => {
                      readFailed = true;
                    })
                    .finally(() => {
                      completed = true;
                      done.release();
                    });
                  await done.entered;
                }
                return value;
              },
            },
            signal,
          ),
      };
      const service = new RegisteredRecipientInvitationService({
        sessions,
        repository: {
          ...repository,
          stage: async (scope, handle, plan) => {
            witness = await repository.stage(scope, handle, plan);
            return mode === '偽証跡'
              ? (Object.freeze({}) as RecipientCodeCommitEvidence)
              : witness;
          },
        },
        proof: f.proof,
        nextInvitationId: f.runtimeOptions.nextInvitationId,
        clock: f.clock,
      });
      expect((await service.create(input)).status).not.toBe('authenticated');
      expect(await f.snapshot()).toEqual(before);
      if (mode === '完了済み未await') {
        expect(completed).toBe(true);
        expect(readFailed).toBe(false);
      }
    },
  );

  it('Migration11は既存Audit/Checksumを保持し、消費成功のコード仮名を必須にしてDownを拒否する', async () => {
    await create();
    const rows = (
      await f.admin.query(
        'SELECT * FROM authentication.audit_event ORDER BY event_id',
      )
    ).rows;
    const sql = await readFile(
      new URL(
        '../migrations/authentication/0011_recipient_code_consumption_audit.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await applySqlMigrations(f.admin, [
      { version: 11, name: '0011_recipient_code_consumption_audit', sql },
    ]);
    expect(
      (
        await f.admin.query(
          'SELECT * FROM authentication.audit_event ORDER BY event_id',
        )
      ).rows,
    ).toEqual(rows);
    await expect(
      f.admin.query(
        "INSERT INTO authentication.audit_event(event_id,request_id,occurred_at_ms,action,decision,reason,audit_key_version) VALUES($1,$2,$3,'recipient-code-consume','allow','success','v1')",
        [randomUUID(), randomUUID(), f.now],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const down = await readFile(
      new URL(
        '../migrations/authentication/0011_recipient_code_consumption_audit.down.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await expect(f.admin.query(down)).rejects.toThrow('forward-only');
    expect(
      (
        await f.admin.query(
          'SELECT * FROM authentication.audit_event ORDER BY event_id',
        )
      ).rows,
    ).toEqual(rows);
  });
});
