import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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

import {
  MigrationChecksumMismatch,
  applySqlMigrations,
  type SqlMigration,
} from '../src/group-management/infrastructure/postgres/sql-migration.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';

const loadMigration = async (
  version: 1 | 2 | 3 | 4 | 5,
): Promise<SqlMigration> => {
  const names: Record<typeof version, string> = {
    1: '0001_group_management_storage',
    2: '0002_group_locator_v2',
    3: '0003_close_intent_registry',
    4: '0004_group_management_retention',
    5: '0005_authentication_schema',
  };
  const name = names[version];
  const directory = version === 5 ? 'authentication' : 'group-management';
  return {
    version,
    name: version === 5 ? 'authentication-schema' : name.slice(5),
    sql: await readFile(
      resolve(import.meta.dirname, `../migrations/${directory}/${name}.sql`),
      'utf8',
    ),
  };
};

const loadDownMigration = async (): Promise<string> =>
  readFile(
    resolve(
      import.meta.dirname,
      '../migrations/authentication/0005_authentication_schema.down.sql',
    ),
    'utf8',
  );

const insertActor = async (
  client: Client,
  actorId: string,
  state: 'active' | 'disabled' = 'active',
  disabledAt: number | null = null,
): Promise<void> => {
  await client.query(
    `INSERT INTO authentication.actor (
      actor_id, state, version, created_at_ms, disabled_at_ms,
      control_key_version, state_mac
    ) VALUES ($1, $2, 1, 1000, $3, 'state-v1', $4)`,
    [actorId, state, disabledAt, Buffer.alloc(32, 1)],
  );
};

const insertIdentity = async (
  client: Client,
  actorId: string,
  identityId: string,
): Promise<void> => {
  await client.query(
    `INSERT INTO authentication.google_identity (
      identity_id, actor_id, version, envelope_version, algorithm_id,
      schema_version, key_version, ciphertext, nonce, authentication_tag,
      created_at_ms
    ) VALUES (
      $1, $2, 1, 1, 'AES-256-GCM', 1, 'identity-v1',
      $3, $4, $5, 1000
    )`,
    [identityId, actorId, Buffer.from([1]), Buffer.alloc(12), Buffer.alloc(16)],
  );
};

const insertAttempt = async (
  client: Client,
  input: {
    attemptId: string;
    digest: Buffer;
    state?: 'ready' | 'consumed' | 'replaced';
    terminalAt?: number | null;
    nonce?: Buffer;
    createdAt?: number;
    expiresAt?: number;
  },
): Promise<void> => {
  const createdAt = input.createdAt ?? 1000;
  await client.query(
    `INSERT INTO authentication.login_attempt (
      attempt_id, version, epoch, created_at_ms, expires_at_ms, state,
      terminal_at_ms, cookie_digest_key_version, cookie_digest,
      envelope_version, algorithm_id, schema_version, key_version,
      ciphertext, nonce, authentication_tag
    ) VALUES (
      $1, 1, '00000000-0000-4000-8000-000000000214', $2, $3, $4,
      $5, 'attempt-cookie-v1', $6, 1, 'AES-256-GCM', 1, 'attempt-v1',
      $7, $8, $9
    )`,
    [
      input.attemptId,
      createdAt,
      input.expiresAt ?? createdAt + 300_000,
      input.state ?? 'ready',
      input.terminalAt ?? null,
      input.digest,
      Buffer.from([1]),
      input.nonce ?? Buffer.alloc(12),
      Buffer.alloc(16),
    ],
  );
};

const insertSession = async (
  client: Client,
  input: {
    sessionId: string;
    actorId: string;
    digest: Buffer;
    idleExpiresAt?: number;
    absoluteExpiresAt?: number;
    state?: 'active' | 'revoked';
    terminalAt?: number | null;
  },
): Promise<void> => {
  await client.query(
    `INSERT INTO authentication.session_record (
      session_id, actor_id, version, epoch, created_at_ms,
      absolute_expires_at_ms, idle_expires_at_ms, state, terminal_at_ms,
      cookie_digest_key_version, cookie_digest, envelope_version,
      algorithm_id, schema_version, key_version, ciphertext, nonce,
      authentication_tag
    ) VALUES (
      $1, $2, 1, '00000000-0000-4000-8000-000000000214', 1000,
      $3, $4, $5, $6, 'session-cookie-v1', $7, 1, 'AES-256-GCM', 1,
      'session-v1', $8, $9, $10
    )`,
    [
      input.sessionId,
      input.actorId,
      input.absoluteExpiresAt ?? 604_801_000,
      input.idleExpiresAt ?? 86_401_000,
      input.state ?? 'active',
      input.terminalAt ?? null,
      input.digest,
      Buffer.from([1]),
      Buffer.alloc(12),
      Buffer.alloc(16),
    ],
  );
};

describe('Authentication schema migration', () => {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  let schemaSequence = 0;
  let schemaName = '';

  beforeAll(async () => {
    await client.connect();
    const result = await client.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    );
    if (!result.rows[0]?.database_name.endsWith('_test')) {
      throw new Error('Authentication migrations require a *_test database');
    }
  });

  beforeEach(async () => {
    schemaName = `test_issue_214_${process.pid}_${schemaSequence++}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}`);
  });

  afterEach(async () => {
    await client.query('SET search_path TO public');
    await client.query('DROP SCHEMA IF EXISTS authentication CASCADE');
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  });

  afterAll(async () => {
    await client.end();
  });

  it('空DBへ追加専用Schemaを作り、番号付きchecksumで再実行をskipする', async () => {
    const migration = await loadMigration(5);
    expect(await applySqlMigrations(client, [migration])).toEqual({
      appliedVersions: [5],
      skippedVersions: [],
    });
    expect(await applySqlMigrations(client, [migration])).toEqual({
      appliedVersions: [],
      skippedVersions: [5],
    });

    const tables = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'authentication' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      'actor',
      'audit_event',
      'deletion_intent',
      'google_identity',
      'identity_alias',
      'key_generation',
      'key_state',
      'login_attempt',
      'session_record',
    ]);

    const keyState = await client.query<{
      status: string;
      epoch: string | null;
      generation_version: string;
    }>(
      'SELECT status, epoch, generation_version FROM authentication.key_state',
    );
    expect(keyState.rows).toEqual([
      { status: 'uninitialized', epoch: null, generation_version: '1' },
    ]);
    expect(
      (await client.query('SELECT 1 FROM authentication.key_generation'))
        .rowCount,
    ).toBe(0);

    await expect(
      applySqlMigrations(client, [
        { ...migration, sql: `${migration.sql}\nSELECT 1;` },
      ]),
    ).rejects.toBeInstanceOf(MigrationChecksumMismatch);
  });

  it('既存Group DBへ適用してGroup行を保ち、GroupへのCascade FKを作らない', async () => {
    const existing = await Promise.all(
      ([1, 2, 3, 4] as const).map(loadMigration),
    );
    await applySqlMigrations(client, existing);
    await client.query(
      `INSERT INTO group_aggregate_record (
        group_id, logical_record_id, aggregate_version, access_policy_version,
        envelope_version, algorithm_id, schema_version, key_version,
        ciphertext, nonce, authentication_tag, created_at, updated_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000214',
        '00000000-0000-4000-8000-000000000414',
        0, 0, 1, 'AES-256-GCM', 1, 'test-key-v1', decode('01', 'hex'),
        decode('000102030405060708090a0b', 'hex'),
        decode('000102030405060708090a0b0c0d0e0f', 'hex'),
        to_timestamp(1), to_timestamp(1)
      )`,
    );

    expect(await applySqlMigrations(client, [await loadMigration(5)])).toEqual({
      appliedVersions: [5],
      skippedVersions: [],
    });
    const groupRow = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM group_aggregate_record',
    );
    expect(groupRow.rows).toEqual([{ count: '1' }]);
    const ledger = await client.query<{ versions: string[] }>(
      'SELECT array_agg(version::text ORDER BY version) AS versions FROM app_schema_migrations',
    );
    expect(ledger.rows[0]?.versions).toEqual(['1', '2', '3', '4', '5']);

    const externalForeignKeys = await client.query<{
      constraint_name: string;
    }>(`
      SELECT constraint_row.conname AS constraint_name
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS source_table ON source_table.oid = constraint_row.conrelid
      JOIN pg_namespace AS source_schema ON source_schema.oid = source_table.relnamespace
      JOIN pg_class AS target_table ON target_table.oid = constraint_row.confrelid
      JOIN pg_namespace AS target_schema ON target_schema.oid = target_table.relnamespace
      WHERE constraint_row.contype = 'f'
        AND source_schema.nspname = 'authentication'
        AND target_schema.nspname <> 'authentication'
    `);
    expect(externalForeignKeys.rows).toEqual([]);
  });

  it('Actor・Identity・Aliasの所有、一意性、EnvelopeとDigest制約を守る', async () => {
    await applySqlMigrations(client, [await loadMigration(5)]);
    const actorId = '00000000-0000-4000-8000-000000000214';
    const otherActorId = '00000000-0000-4000-8000-000000000314';
    const identityId = '00000000-0000-4000-8000-000000000414';
    const otherIdentityId = '00000000-0000-4000-8000-000000000514';
    await insertActor(client, actorId);

    await expect(
      insertActor(client, otherActorId, 'disabled'),
    ).rejects.toMatchObject({
      code: '23514',
    });
    await insertActor(client, otherActorId, 'disabled', 1000);
    await insertIdentity(client, actorId, identityId);
    await expect(
      insertIdentity(client, actorId, otherIdentityId),
    ).rejects.toMatchObject({
      code: '23505',
    });
    await expect(
      insertIdentity(
        client,
        '00000000-0000-4000-8000-000000000999',
        otherIdentityId,
      ),
    ).rejects.toMatchObject({
      code: '23503',
    });
    await insertIdentity(client, otherActorId, otherIdentityId);

    const digest = Buffer.alloc(32, 7);
    const insertAlias = (input: {
      identity: string;
      version: string;
      digest: Buffer;
      purpose?: string;
    }): Promise<unknown> =>
      client.query(
        `INSERT INTO authentication.identity_alias (
          purpose, digest_key_version, digest, identity_id, created_at_ms
        ) VALUES ($1, $2, $3, $4, 1000)`,
        [
          input.purpose ?? 'auth-google-identity/v1',
          input.version,
          input.digest,
          input.identity,
        ],
      );
    await insertAlias({ identity: identityId, version: 'search-v1', digest });
    await expect(
      insertAlias({
        identity: identityId,
        version: 'search-v1',
        digest: Buffer.alloc(32, 8),
      }),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      insertAlias({ identity: otherIdentityId, version: 'search-v1', digest }),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      insertAlias({
        identity: identityId,
        version: 'search-v2',
        digest: Buffer.alloc(31),
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertAlias({
        identity: identityId,
        version: 'search-v2',
        digest: Buffer.alloc(32),
        purpose: 'cookie',
      }),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      client.query(
        `UPDATE authentication.google_identity SET nonce = decode('00', 'hex')
         WHERE identity_id = $1`,
        [identityId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('Attempt／Sessionの状態、TTL、Cookie Digest一意性、Envelope長を守る', async () => {
    await applySqlMigrations(client, [await loadMigration(5)]);
    const actorId = '00000000-0000-4000-8000-000000000214';
    await insertActor(client, actorId);
    await insertAttempt(client, {
      attemptId: '00000000-0000-4000-8000-000000000614',
      digest: Buffer.alloc(32, 1),
    });

    await expect(
      insertAttempt(client, {
        attemptId: '00000000-0000-4000-8000-000000000714',
        digest: Buffer.alloc(32, 1),
      }),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      insertAttempt(client, {
        attemptId: '00000000-0000-4000-8000-000000000814',
        digest: Buffer.alloc(32, 2),
        expiresAt: 301001,
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertAttempt(client, {
        attemptId: '00000000-0000-4000-8000-000000000914',
        digest: Buffer.alloc(32, 3),
        state: 'consumed',
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertAttempt(client, {
        attemptId: '00000000-0000-4000-8000-000000001014',
        digest: Buffer.alloc(32, 4),
        nonce: Buffer.alloc(11),
      }),
    ).rejects.toMatchObject({ code: '23514' });

    await insertSession(client, {
      sessionId: '00000000-0000-4000-8000-000000001114',
      actorId,
      digest: Buffer.alloc(32, 5),
      absoluteExpiresAt: 604801000,
      idleExpiresAt: 604801000,
    });
    await expect(
      insertSession(client, {
        sessionId: '00000000-0000-4000-8000-000000001214',
        actorId,
        digest: Buffer.alloc(32, 6),
        absoluteExpiresAt: 604801001,
        idleExpiresAt: 604801001,
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertSession(client, {
        sessionId: '00000000-0000-4000-8000-000000001314',
        actorId,
        digest: Buffer.alloc(32, 7),
        idleExpiresAt: 604802000,
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertSession(client, {
        sessionId: '00000000-0000-4000-8000-000000001414',
        actorId: '00000000-0000-4000-8000-000000000999',
        digest: Buffer.alloc(32, 8),
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('固定Audit Enumと一Attempt一成功を強制する', async () => {
    await applySqlMigrations(client, [await loadMigration(5)]);
    const insertSuccess = (eventId: string): Promise<unknown> =>
      client.query(
        `INSERT INTO authentication.audit_event (
          event_id, request_id, occurred_at_ms, action, decision, reason,
          attempt_digest_key_version, attempt_digest, audit_key_version
        ) VALUES (
          $1, $2, 1000, 'complete', 'allow', 'success',
          'audit-attempt-v1', $3, 'audit-v1'
        )`,
        [eventId, '00000000-0000-4000-8000-000000002214', Buffer.alloc(32, 9)],
      );
    await insertSuccess('00000000-0000-4000-8000-000000001514');
    await expect(
      insertSuccess('00000000-0000-4000-8000-000000001614'),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      client.query(
        `INSERT INTO authentication.audit_event (
          event_id, request_id, occurred_at_ms, action, decision, reason,
          actor_digest, audit_key_version
        ) VALUES (
          '00000000-0000-4000-8000-000000001714',
          '00000000-0000-4000-8000-000000002314', 1000,
          'complete', 'allow', 'success', decode('01', 'hex'), 'audit-v1'
        )`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.query(
        `INSERT INTO authentication.audit_event (
          event_id, request_id, occurred_at_ms, action, decision, reason,
          audit_key_version
        ) VALUES (
          '00000000-0000-4000-8000-000000001814',
          '00000000-0000-4000-8000-000000002414', 1000,
          'unrecognized', 'allow', 'success', 'audit-v1'
        )`,
      ),
    ).rejects.toMatchObject({ code: '22P02' });
  });

  it('初期Key Stateは鍵なしでdown可能、データがあればdownを拒否する', async () => {
    await applySqlMigrations(client, [await loadMigration(5)]);
    const actorId = '00000000-0000-4000-8000-000000000214';
    await insertActor(client, actorId);

    await expect(client.query(await loadDownMigration())).rejects.toThrow(
      'authentication schema down migration requires an unused schema',
    );
    expect(
      (
        await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM authentication.actor',
        )
      ).rows,
    ).toEqual([{ count: '1' }]);
    expect(
      (
        await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM app_schema_migrations WHERE version = 5',
        )
      ).rows,
    ).toEqual([{ count: '1' }]);

    await client.query('DELETE FROM authentication.actor WHERE actor_id = $1', [
      actorId,
    ]);
    await client.query(await loadDownMigration());
    expect(
      (
        await client.query<{ relation: string | null }>(
          "SELECT to_regclass('authentication.actor')::text AS relation",
        )
      ).rows,
    ).toEqual([{ relation: null }]);
    expect(
      (
        await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM app_schema_migrations WHERE version = 5',
        )
      ).rows,
    ).toEqual([{ count: '0' }]);
    expect(await applySqlMigrations(client, [await loadMigration(5)])).toEqual({
      appliedVersions: [5],
      skippedVersions: [],
    });
  });
});
