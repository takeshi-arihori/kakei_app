import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
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
import { AuthenticationCryptoUnavailable } from '../src/shared/application/authentication/authentication-record-protection.js';
import type { AuthenticationTransactionScope } from '../src/shared/application/authentication/authentication-transaction-scope.js';
import type { RecipientCodeSecret } from '../src/shared/application/authentication/recipient-code-input.js';
import {
  readAuthenticationCleanupKeyState,
  readAuthenticationKeyState,
  readAuthenticationMaintenanceKeyState,
  readRecipientCodeKeyState,
  readRecipientCodeMaintenanceKeyState,
  readRecipientCodeManagementKeyState,
} from '../src/shared/infrastructure/authentication/postgres/authentication-key-state.js';
import { createAuthenticationTransactionScopes } from '../src/shared/infrastructure/authentication/postgres/authentication-transaction-scopes.js';
import { createPostgresAuthenticationCleanup } from '../src/shared/infrastructure/authentication/postgres/postgres-authentication-cleanup.js';
import { createPostgresAuthenticationDeletion } from '../src/shared/infrastructure/authentication/postgres/postgres-authentication-deletion.js';
import { createPostgresAuthenticationStore } from '../src/shared/infrastructure/authentication/postgres/postgres-authentication-store.js';
import { ids } from '../src/shared/infrastructure/authentication/test/authentication-crypto-fixtures.js';
import { syntheticAuthenticationLedger } from '../src/shared/infrastructure/authentication/test/authentication-maintenance-ledger-fixtures.js';
import { syntheticAuthenticationManagedKeys } from '../src/shared/infrastructure/authentication/test/authentication-maintenance-key-fixtures.js';
import {
  actors,
  RecipientInvitationFixture,
  sessionSecret,
} from './support/recipient-invitation-fixture.js';

const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';
const secret = (byte: number) => Buffer.alloc(32, byte).toString('base64url');
const productionRoot = resolve(import.meta.dirname, '../src');
const stoppedStates = ['quarantined', 'restoring', 'uninitialized'] as const;

const productionSources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name === 'test' ? [] : productionSources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
      ? [path]
      : [];
  });

describe('招待コード保守の停止契約（実PG17）', () => {
  const f = new RecipientInvitationFixture(url);
  const holder = new Client({ connectionString: url });

  beforeAll(async () => {
    await f.initialize();
    await holder.connect();
  });
  beforeEach(() => f.reset());
  afterEach(async () => {
    await holder.query('ROLLBACK');
  });
  afterAll(async () => {
    await holder.end();
    await f.dispose();
  });

  const setStatus = (status: string) =>
    f.admin.query('UPDATE authentication.key_state SET status=$1,epoch=$2', [
      status,
      status === 'uninitialized' ? null : ids.epoch,
    ]);
  const keyState = async () =>
    (
      await f.admin.query<{ status: string; generation_version: string }>(
        'SELECT status,generation_version FROM authentication.key_state',
      )
    ).rows[0];
  const create = (code: RecipientCodeSecret) =>
    f.runtime.create({
      code,
      groupId: f.groupId,
      operationId: OperationId.from(`stop-${randomUUID()}`),
      sessionSecret: sessionSecret(10),
      expectedVersion: 1,
    });
  const store = () =>
    createPostgresAuthenticationStore({
      pool: f.runtimeOptions.pool,
      scopes: createAuthenticationTransactionScopes(),
      digests: f.digests,
      codec: f.authCodec,
    });
  const removeCodePurposes = async () => {
    const removed = await f.admin.query<{
      generation_id: string;
      purpose: string;
    }>(
      "DELETE FROM authentication.key_generation WHERE purpose::text LIKE 'recipient-code-%' RETURNING generation_id,purpose",
    );
    expect(removed.rowCount).toBe(2);
    return removed.rows;
  };
  const addUnknownPurpose = async () => {
    await f.admin.query(
      "ALTER TYPE authentication.key_purpose ADD VALUE IF NOT EXISTS 'future-purpose'",
    );
    await f.admin.query(
      "INSERT INTO authentication.key_generation(generation_id,purpose,key_version,epoch,searchable,write_required) VALUES($1,'future-purpose','v1',NULL,true,true)",
      [randomUUID()],
    );
  };

  describe('利用受付', () => {
    it.each(stoppedStates)('%sではコードを発行しない', async (status) => {
      await setStatus(status);
      const before = await f.snapshot();
      await expect(
        f.runtime.issue(sessionSecret(20), f.clock),
      ).resolves.toEqual({ status: 'unavailable' });
      expect(await f.snapshot()).toEqual(before);
    });

    it.each(stoppedStates)('%sではコードを消費しない', async (status) => {
      const issued = await f.issue();
      await setStatus(status);
      const before = await f.snapshot();
      await expect(create(issued.code)).resolves.toEqual({
        status: 'unavailable',
      });
      expect(await f.snapshot()).toEqual(before);
      expect((await f.codes())[0].status).toBe('issued');
    });
  });

  describe('quarantinedからの復帰', () => {
    it('通常入口と保守readerを動かしても状態も版も戻らない', async () => {
      const issued = await f.issue();
      await setStatus('quarantined');
      const before = await keyState();
      const auth = store();
      await f.runtime.issue(sessionSecret(20), f.clock);
      await create(issued.code);
      await auth.begin(
        { attemptSecret: secret(1), csrf: secret(2), nonce: secret(3) },
        f.clock,
      );
      await auth.revoke(sessionSecret(10), f.clock);
      await readRecipientCodeMaintenanceKeyState(f.admin);
      expect(await keyState()).toEqual(before);
    });

    it('activeへ戻す更新はRestoreのrestoring限定CASだけが持つ', () => {
      const writers = productionSources(productionRoot).flatMap((path) =>
        [
          ...readFileSync(path, 'utf8').matchAll(
            /(["'`])\s*(UPDATE\s+authentication\.key_state\b[\s\S]*?)\1/gi,
          ),
        ]
          .map((match) => match[2])
          .filter((sql) =>
            /\bSET\b[\s\S]*?\bstatus\s*=/i.test(sql.split(/\bWHERE\b/i)[0]),
          )
          .map((sql) => {
            const [assignment, condition = ''] = sql.split(/\bWHERE\b/i);
            return {
              path: basename(path),
              target: /status\s*=\s*'?([^',\s]+)/i.exec(assignment)?.[1],
              fromRestoring: /status\s*=\s*'restoring'/i.test(condition),
            };
          }),
      );
      expect(writers).toHaveLength(3);
      expect(writers).toEqual(
        expect.arrayContaining([
          {
            path: 'postgres-authentication-restore.ts',
            target: 'active',
            fromRestoring: true,
          },
          {
            path: 'postgres-authentication-restore.ts',
            target: 'restoring',
            fromRestoring: false,
          },
          {
            // 既存清掃とコード清掃が共有する封鎖関数（#259で移動）。
            path: 'authentication-key-state.ts',
            target: 'quarantined',
            fromRestoring: false,
          },
        ]),
      );
    });
  });

  describe('未知purpose', () => {
    afterEach(() =>
      f.admin.query(
        "DELETE FROM authentication.key_generation WHERE purpose='future-purpose'",
      ),
    );

    it.each([
      ['通常認証', readAuthenticationKeyState, false],
      ['既存保守', readAuthenticationMaintenanceKeyState, false],
      ['既存清掃', readAuthenticationCleanupKeyState, true],
      ['コード専用lease', readRecipientCodeKeyState, true],
      ['コード管理', readRecipientCodeManagementKeyState, true],
      ['コード保守', readRecipientCodeMaintenanceKeyState, true],
    ])('%sのreaderが拒否する', async (_name, read, acceptsCode) => {
      // 既存readerはコードpurposeでも拒否するので、除去して原因を未知purposeに限定する。
      if (!acceptsCode) await removeCodePurposes();
      await expect(read(f.admin)).resolves.toBeDefined();
      await addUnknownPurpose();
      await expect(read(f.admin)).rejects.toBeInstanceOf(
        AuthenticationCryptoUnavailable,
      );
    });

    it('コードの発行と消費を止める', async () => {
      const issued = await f.issue();
      await addUnknownPurpose();
      await expect(
        f.runtime.issue(sessionSecret(20), f.clock),
      ).resolves.toEqual({ status: 'unavailable' });
      await expect(create(issued.code)).resolves.toEqual({
        status: 'unavailable',
      });
    });
  });

  describe('既存の清掃・削除Adapter（ADR D6）', () => {
    const adapterKeys = () => syntheticAuthenticationManagedKeys();
    const cleanup = () =>
      createPostgresAuthenticationCleanup({
        pool: f.runtimeOptions.pool,
        codec: f.authCodec,
        digests: f.digests,
        keys: adapterKeys().keys,
        clock: f.clock,
      });
    const deletion = () =>
      createPostgresAuthenticationDeletion({
        pool: f.runtimeOptions.pool,
        codec: f.authCodec,
        digests: f.digests,
        keys: adapterKeys().keys,
        clock: f.clock,
        ledger: syntheticAuthenticationLedger().evidence,
      });
    const revokedSession = async () => {
      const before = await f.admin.query<{ session_id: string }>(
        'SELECT session_id FROM authentication.session_record',
      );
      await f.addSession(actors.member, 77);
      const after = await f.admin.query<{ session_id: string }>(
        'SELECT session_id FROM authentication.session_record',
      );
      const known = new Set(before.rows.map((row) => row.session_id));
      return after.rows.find((row) => !known.has(row.session_id))!.session_id;
    };

    it('コードpurposeがあっても既存清掃は期限切れSessionを除去する', async () => {
      const sessionId = await revokedSession();
      f.now += 8 * 86_400_000;
      await expect(cleanup().deleteExpired(100)).resolves.toMatchObject({
        status: 'committed',
      });
      expect(
        (
          await f.admin.query(
            'SELECT 1 FROM authentication.session_record WHERE session_id=$1',
            [sessionId],
          )
        ).rowCount,
      ).toBe(0);
    });

    it('コードpurposeがなくても既存清掃は動く', async () => {
      const generations = await removeCodePurposes();
      expect(generations).toHaveLength(2);
      const sessionId = await revokedSession();
      f.now += 8 * 86_400_000;
      await expect(cleanup().deleteExpired(100)).resolves.toMatchObject({
        status: 'committed',
      });
      expect(
        (
          await f.admin.query(
            'SELECT 1 FROM authentication.session_record WHERE session_id=$1',
            [sessionId],
          )
        ).rowCount,
      ).toBe(0);
    });

    it('既存清掃も未知purposeでは止まる', async () => {
      await addUnknownPurpose();
      try {
        await expect(cleanup().deleteExpired(100)).resolves.toEqual({
          status: 'unavailable',
        });
      } finally {
        await f.admin.query(
          "DELETE FROM authentication.key_generation WHERE purpose='future-purpose'",
        );
      }
    });

    it('既存の削除Adapterはコードpurposeがあると止まり、Actorを変えない（拡張は#260）', async () => {
      const before = await f.admin.query(
        'SELECT * FROM authentication.actor WHERE actor_id=$1',
        [actors.member],
      );
      await expect(deletion().plan(actors.member)).rejects.toBeDefined();
      expect(
        (
          await f.admin.query(
            'SELECT * FROM authentication.actor WHERE actor_id=$1',
            [actors.member],
          )
        ).rows,
      ).toEqual(before.rows);
    });
  });

  describe('通常認証Store', () => {
    it('コードpurposeがあると4つの認証操作をすべて止める', async () => {
      const auth = store();
      // コードpurposeが無ければ動くことを確認し、停止の原因をコードpurposeに限定する。
      const generations = await removeCodePurposes();
      const attempt = {
        attemptSecret: secret(1),
        csrf: secret(2),
        nonce: secret(3),
      };
      await expect(auth.begin(attempt, f.clock)).resolves.toMatchObject({
        status: 'started',
      });
      const ready = await auth.readAttempt(attempt, f.clock);
      if (ready.status !== 'ready') throw new Error('合成試行が必要');
      await expect(
        auth.withSession(
          sessionSecret(10),
          'inspect',
          f.clock,
          (_actor, scope) =>
            Promise.resolve(scope.serialize({ allowed: true })),
        ),
      ).resolves.toMatchObject({ status: 'authenticated' });
      for (const row of generations)
        await f.admin.query(
          "INSERT INTO authentication.key_generation(generation_id,purpose,key_version,epoch,searchable,write_required) VALUES($1,$2,'v1',NULL,true,true)",
          [row.generation_id, row.purpose],
        );
      await expect(
        auth.complete(
          {
            ...attempt,
            snapshot: ready.snapshot,
            identity: {
              issuer: 'https://accounts.google.com',
              subject: 'synthetic-subject',
            },
            sessionSecret: secret(4),
            sessionCsrf: secret(5),
          },
          f.clock,
        ),
      ).resolves.toEqual({ status: 'unavailable' });
      await expect(
        auth.begin(
          { attemptSecret: secret(1), csrf: secret(2), nonce: secret(3) },
          f.clock,
        ),
      ).resolves.toEqual({ status: 'unavailable' });
      await expect(
        auth.readAttempt(
          { attemptSecret: secret(1), csrf: secret(2) },
          f.clock,
        ),
      ).resolves.toEqual({ status: 'unavailable' });
      const callback = vi.fn(
        (_actor: unknown, scope: AuthenticationTransactionScope) =>
          Promise.resolve(scope.serialize({ allowed: true })),
      );
      await expect(
        auth.withSession(sessionSecret(10), 'inspect', f.clock, callback),
      ).resolves.toEqual({ status: 'unavailable' });
      expect(callback).not.toHaveBeenCalled();
      await expect(auth.revoke(sessionSecret(10), f.clock)).resolves.toEqual({
        status: 'unavailable',
      });
    });
  });

  describe('コード保守reader', () => {
    it.each(['active', 'rotating', 'quarantined'])(
      '%sを受理してコード世代を返す',
      async (status) => {
        await setStatus(status);
        await expect(
          readRecipientCodeMaintenanceKeyState(f.admin),
        ).resolves.toMatchObject({
          epoch: ids.epoch,
          codeLookup: ['v1'],
          codeMac: ['v1'],
        });
      },
    );

    it.each(['restoring', 'uninitialized'])('%sを拒否する', async (status) => {
      await setStatus(status);
      await expect(
        readRecipientCodeMaintenanceKeyState(f.admin),
      ).rejects.toBeInstanceOf(AuthenticationCryptoUnavailable);
    });

    it.each(['recipient-code-lookup', 'recipient-code-state-mac'])(
      '%sの世代が欠けたら拒否する',
      async (purpose) => {
        await f.admin.query(
          'DELETE FROM authentication.key_generation WHERE purpose=$1',
          [purpose],
        );
        await expect(
          readRecipientCodeMaintenanceKeyState(f.admin),
        ).rejects.toBeInstanceOf(AuthenticationCryptoUnavailable);
      },
    );

    it.each([
      ['通常認証', readAuthenticationKeyState, false, ['active', 'rotating']],
      [
        '既存保守',
        readAuthenticationMaintenanceKeyState,
        false,
        ['active', 'rotating', 'quarantined'],
      ],
      [
        'コード専用lease',
        readRecipientCodeKeyState,
        true,
        ['active', 'rotating'],
      ],
      [
        'コード管理',
        readRecipientCodeManagementKeyState,
        true,
        ['active', 'rotating'],
      ],
      [
        'コード保守',
        readRecipientCodeMaintenanceKeyState,
        true,
        ['active', 'rotating', 'quarantined'],
      ],
    ] as const)(
      '%sのreaderが受理する状態を固定する',
      async (_name, read, acceptsCode, accepted) => {
        if (!acceptsCode) {
          await expect(read(f.admin)).rejects.toBeInstanceOf(
            AuthenticationCryptoUnavailable,
          );
          await removeCodePurposes();
        }
        for (const status of [
          'active',
          'rotating',
          'quarantined',
          'restoring',
          'uninitialized',
        ]) {
          await setStatus(status);
          if ((accepted as readonly string[]).includes(status))
            await expect(read(f.admin)).resolves.toBeDefined();
          else
            await expect(read(f.admin)).rejects.toBeInstanceOf(
              AuthenticationCryptoUnavailable,
            );
        }
      },
    );

    it('Transactionの間はkey_stateを共有Lockする', async () => {
      await holder.query('BEGIN');
      await readRecipientCodeMaintenanceKeyState(holder);
      await f.admin.query("SET lock_timeout='100ms'");
      await expect(
        f.admin.query("UPDATE authentication.key_state SET status='restoring'"),
      ).rejects.toMatchObject({ code: '55P03' });
      await f.admin.query('SET lock_timeout=0');
      await holder.query('ROLLBACK');
      expect((await keyState()).status).toBe('active');
    });
  });
});
