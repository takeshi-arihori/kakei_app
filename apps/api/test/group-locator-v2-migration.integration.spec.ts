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
  applySqlMigrations,
  type SqlMigration,
} from '../src/group-management/infrastructure/postgres/sql-migration.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';

const loadMigration = async (version: 1 | 2 | 3): Promise<SqlMigration> => ({
  version,
  name:
    version === 1
      ? 'group-management-storage'
      : version === 2
        ? 'group-locator-v2'
        : 'close-intent-registry',
  sql: await readFile(
    resolve(
      import.meta.dirname,
      `../migrations/group-management/000${version}_${version === 1 ? 'group_management_storage' : version === 2 ? 'group_locator_v2' : 'close_intent_registry'}.sql`,
    ),
    'utf8',
  ),
});

const insertProtectedGroup = async (
  client: Client,
  groupId: string,
  recordId = '00000000-0000-4000-8000-000000000142',
): Promise<void> => {
  await client.query(
    `INSERT INTO group_aggregate_record (
      group_id, logical_record_id, aggregate_version, access_policy_version,
      envelope_version, algorithm_id, schema_version, key_version,
      ciphertext, nonce, authentication_tag, created_at, updated_at
    ) VALUES (
      $1, $2,
      0, 0, 1, 'AES-256-GCM', 1, 'test-key-v1', decode('01', 'hex'),
      decode('000102030405060708090a0b', 'hex'),
      decode('000102030405060708090a0b0c0d0e0f', 'hex'), now(), now()
    )`,
    [groupId, recordId],
  );
};

const insertProtectedResult = async (
  client: Client,
  groupId: string,
  recordId = '00000000-0000-4000-8000-000000000242',
): Promise<void> => {
  await client.query(
    `INSERT INTO group_operation_result_record (
      logical_record_id, group_id, aggregate_version, envelope_version,
      algorithm_id, schema_version, key_version, ciphertext, nonce,
      authentication_tag, created_at
    ) VALUES (
      $2, $1, 0, 1, 'AES-256-GCM', 1, 'test-key-v1', decode('01', 'hex'),
      decode('000102030405060708090a0b', 'hex'),
      decode('000102030405060708090a0b0c0d0e0f', 'hex'), now()
    )`,
    [groupId, recordId],
  );
};

describe('Group locator v2 migration', () => {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  let sequence = 0;
  let schemaName = '';

  beforeAll(async () => {
    await client.connect();
  });

  beforeEach(async () => {
    schemaName = `test_issue_42_${process.pid}_${sequence++}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}`);
    await applySqlMigrations(client, [await loadMigration(1)]);
  });

  afterEach(async () => {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  });

  afterAll(async () => {
    await client.end();
  });

  it('legacy 0件ならv2を追加し、再実行をskipする', async () => {
    const v2 = await loadMigration(2);
    expect(await applySqlMigrations(client, [v2])).toEqual({
      appliedVersions: [2],
      skippedVersions: [],
    });
    expect(await applySqlMigrations(client, [v2])).toEqual({
      appliedVersions: [],
      skippedVersions: [2],
    });

    const tables = await client.query<{ name: string }>(`
      SELECT tablename AS name FROM pg_tables
      WHERE schemaname = current_schema()
      ORDER BY tablename
    `);
    expect(tables.rows.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'group_operation_locator',
        'group_operation_locator_v2',
        'group_operation_locator_key_state',
        'group_close_history_record',
      ]),
    );

    const keyState = await client.query<{
      id: number;
      current_key_version: string | null;
    }>('SELECT id, current_key_version FROM group_operation_locator_key_state');
    expect(keyState.rows).toEqual([{ id: 1, current_key_version: null }]);
  });

  it('close履歴が空ならregistryを追加し、保持中の重複とGroup削除を拒否する', async () => {
    await applySqlMigrations(client, [await loadMigration(2)]);
    const migration = await loadMigration(3);
    expect(await applySqlMigrations(client, [migration])).toEqual({
      appliedVersions: [3],
      skippedVersions: [],
    });
    expect(await applySqlMigrations(client, [migration])).toEqual({
      appliedVersions: [],
      skippedVersions: [3],
    });

    const groupId = '00000000-0000-4000-8000-000000000042';
    const closeIntentId = '00000000-0000-4000-8000-000000000142';
    await insertProtectedGroup(client, groupId);
    await client.query(
      'INSERT INTO group_close_intent_registry (close_intent_id, group_id) VALUES ($1, $2)',
      [closeIntentId, groupId],
    );
    await expect(
      client.query(
        'INSERT INTO group_close_intent_registry (close_intent_id, group_id) VALUES ($1, $2)',
        [closeIntentId, groupId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    let deleteError: unknown;
    try {
      await client.query(
        'DELETE FROM group_aggregate_record WHERE group_id = $1',
        [groupId],
      );
    } catch (error: unknown) {
      deleteError = error;
    }
    expect(deleteError).toBeDefined();
    if (
      typeof deleteError !== 'object' ||
      deleteError === null ||
      !('code' in deleteError)
    ) {
      throw new Error('Group deletion must fail with a database constraint');
    }
    expect(['23001', '23503']).toContain(deleteError.code);

    await client.query(
      "UPDATE group_close_intent_registry SET group_id = NULL, retain_until = now() + interval '1 year' WHERE close_intent_id = $1",
      [closeIntentId],
    );
    await client.query(
      'DELETE FROM group_aggregate_record WHERE group_id = $1',
      [groupId],
    );
    const retired = await client.query<{ group_id: string | null }>(
      'SELECT group_id FROM group_close_intent_registry WHERE close_intent_id = $1',
      [closeIntentId],
    );
    expect(retired.rows).toEqual([{ group_id: null }]);
  });

  it('protected close履歴があればregistry migrationをfail-closedでrollbackする', async () => {
    await applySqlMigrations(client, [await loadMigration(2)]);
    const groupId = '00000000-0000-4000-8000-000000000042';
    await insertProtectedGroup(client, groupId);
    await client.query(
      `INSERT INTO group_close_history_record (
        logical_record_id, group_id, aggregate_version, envelope_version,
        algorithm_id, schema_version, key_version, ciphertext, nonce,
        authentication_tag, created_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000342', $1, 1, 1,
        'AES-256-GCM', 1, 'test-key-v1', decode('01', 'hex'),
        decode('000102030405060708090a0b', 'hex'),
        decode('000102030405060708090a0b0c0d0e0f', 'hex'), now()
      )`,
      [groupId],
    );

    await expect(
      applySqlMigrations(client, [await loadMigration(3)]),
    ).rejects.toThrow(
      'protected close history requires an approved CloseIntent registry backfill',
    );
    const registry = await client.query<{ name: string | null }>(
      "SELECT to_regclass('group_close_intent_registry')::text AS name",
    );
    expect(registry.rows).toEqual([{ name: null }]);
    const migration = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM app_schema_migrations WHERE version = 3',
    );
    expect(migration.rows).toEqual([{ count: '0' }]);
  });

  it('legacy行があればv1行とSchemaを変更せず拒否する', async () => {
    await insertProtectedGroup(client, '00000000-0000-4000-8000-000000000042');
    await insertProtectedResult(client, '00000000-0000-4000-8000-000000000042');
    await client.query(`
      INSERT INTO group_operation_locator (
        actor_digest, operation_digest, command_fingerprint,
        digest_key_version, group_id, operation_result_record_id, created_at
      ) VALUES (
        decode('01', 'hex'), decode('02', 'hex'), decode('03', 'hex'),
        'test-digest-v1', '00000000-0000-4000-8000-000000000042',
        '00000000-0000-4000-8000-000000000242', now()
      )
    `);

    await expect(
      applySqlMigrations(client, [await loadMigration(2)]),
    ).rejects.toThrow(
      'legacy group operation locator rows require an owner decision',
    );
    const legacy = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM group_operation_locator',
    );
    expect(legacy.rows).toEqual([{ count: '1' }]);
    const v2 = await client.query<{ name: string | null }>(
      "SELECT to_regclass('group_operation_locator_v2')::text AS name",
    );
    expect(v2.rows).toEqual([{ name: null }]);
    const applied = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM app_schema_migrations WHERE version = 2',
    );
    expect(applied.rows).toEqual([{ count: '0' }]);
  });

  it('v2 locatorのversion付き一意性、結果FK、Group削除cascadeを守る', async () => {
    await applySqlMigrations(client, [await loadMigration(2)]);
    const groupId = '00000000-0000-4000-8000-000000000042';
    await insertProtectedGroup(client, groupId);
    await insertProtectedResult(client, groupId);

    const insertLocator = (
      version: string,
      resultId: string,
    ): Promise<unknown> =>
      client.query(
        `INSERT INTO group_operation_locator_v2 (
          locator_digest, digest_key_version, command_fingerprint,
          group_id, operation_result_record_id, created_at
        ) VALUES (decode('01', 'hex'), $1, decode('02', 'hex'), $2, $3, now())`,
        [version, groupId, resultId],
      );
    await insertLocator(
      'test-digest-v1',
      '00000000-0000-4000-8000-000000000242',
    );
    await expect(
      insertLocator('test-digest-v1', '00000000-0000-4000-8000-000000000242'),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      insertLocator('test-digest-v2', '00000000-0000-4000-8000-000000000342'),
    ).rejects.toMatchObject({ code: '23503' });

    const otherGroupId = '00000000-0000-4000-8000-000000000043';
    await insertProtectedGroup(
      client,
      otherGroupId,
      '00000000-0000-4000-8000-000000000143',
    );
    await insertProtectedResult(
      client,
      otherGroupId,
      '00000000-0000-4000-8000-000000000243',
    );
    await expect(
      insertLocator('test-digest-v2', '00000000-0000-4000-8000-000000000243'),
    ).rejects.toMatchObject({ code: '23503' });
    await client.query(
      'DELETE FROM group_aggregate_record WHERE group_id = $1',
      [otherGroupId],
    );

    await client.query(
      `INSERT INTO group_close_history_record (
        logical_record_id, group_id, aggregate_version, envelope_version,
        algorithm_id, schema_version, key_version, ciphertext, nonce,
        authentication_tag, created_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000342', $1, 0, 1,
        'AES-256-GCM', 1, 'test-key-v1', decode('01', 'hex'),
        decode('000102030405060708090a0b', 'hex'),
        decode('000102030405060708090a0b0c0d0e0f', 'hex'), now()
      )`,
      [groupId],
    );
    await client.query(
      'DELETE FROM group_aggregate_record WHERE group_id = $1',
      [groupId],
    );
    for (const table of [
      'group_operation_result_record',
      'group_operation_locator_v2',
      'group_close_history_record',
    ]) {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(rows).toEqual([{ count: '0' }]);
    }
  });

  it('Group close履歴のFK、version、保護Envelope制約を拒否する', async () => {
    await applySqlMigrations(client, [await loadMigration(2)]);
    const groupId = '00000000-0000-4000-8000-000000000042';
    await insertProtectedGroup(client, groupId);
    const insertClose = (input: {
      groupId: string;
      aggregateVersion: number;
      envelopeVersion: number;
      nonceHex: string;
      tagHex: string;
    }): Promise<unknown> =>
      client.query(
        `INSERT INTO group_close_history_record (
          logical_record_id, group_id, aggregate_version, envelope_version,
          algorithm_id, schema_version, key_version, ciphertext, nonce,
          authentication_tag, created_at
        ) VALUES (
          '00000000-0000-4000-8000-000000000342', $1, $2, $3,
          'AES-256-GCM', 1, 'test-key-v1', decode('01', 'hex'),
          decode($4, 'hex'), decode($5, 'hex'), now()
        )`,
        [
          input.groupId,
          input.aggregateVersion,
          input.envelopeVersion,
          input.nonceHex,
          input.tagHex,
        ],
      );
    const valid = {
      groupId,
      aggregateVersion: 0,
      envelopeVersion: 1,
      nonceHex: '000102030405060708090a0b',
      tagHex: '000102030405060708090a0b0c0d0e0f',
    };
    await expect(
      insertClose({
        ...valid,
        groupId: '00000000-0000-4000-8000-000000000099',
      }),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      insertClose({ ...valid, aggregateVersion: -1 }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertClose({ ...valid, envelopeVersion: 0 }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertClose({ ...valid, nonceHex: '00' }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(insertClose({ ...valid, tagHex: '00' })).rejects.toMatchObject(
      { code: '23514' },
    );
    const count = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM group_close_history_record',
    );
    expect(count.rows).toEqual([{ count: '0' }]);
  });

  it('commandのFOR SHARE中はrotationのFOR UPDATE NOWAITを拒否する', async () => {
    await applySqlMigrations(client, [await loadMigration(2)]);
    const rotation = new Client({ connectionString: TEST_DATABASE_URL });
    await rotation.connect();
    try {
      await rotation.query(`SET search_path TO ${schemaName}`);
      await client.query('BEGIN');
      await client.query(
        'SELECT id FROM group_operation_locator_key_state FOR SHARE',
      );
      await expect(
        rotation.query(
          'SELECT id FROM group_operation_locator_key_state FOR UPDATE NOWAIT',
        ),
      ).rejects.toMatchObject({ code: '55P03' });
      await client.query('COMMIT');
      await expect(
        rotation.query(
          'SELECT id FROM group_operation_locator_key_state FOR UPDATE NOWAIT',
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await client.query('ROLLBACK');
      await rotation.end();
    }
  });

  it('並行するv1 insertの確定を待ってからlegacy件数を判定する', async () => {
    const writer = new Client({ connectionString: TEST_DATABASE_URL });
    await writer.connect();
    try {
      await writer.query(`SET search_path TO ${schemaName}`);
      await writer.query('BEGIN');
      const writerPid = (
        await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]?.pid;
      const migrationPid = (
        await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]?.pid;
      expect(writerPid).toBeDefined();
      expect(migrationPid).toBeDefined();

      const groupId = '00000000-0000-4000-8000-000000000042';
      await insertProtectedGroup(writer, groupId);
      await insertProtectedResult(writer, groupId);
      await writer.query(
        `INSERT INTO group_operation_locator (
          actor_digest, operation_digest, command_fingerprint,
          digest_key_version, group_id, operation_result_record_id, created_at
        ) VALUES (
          decode('01', 'hex'), decode('02', 'hex'), decode('03', 'hex'),
          'test-digest-v1', $1,
          '00000000-0000-4000-8000-000000000242', now()
        )`,
        [groupId],
      );

      const migrationOutcome = applySqlMigrations(client, [
        await loadMigration(2),
      ]).then(
        () => 'applied' as const,
        (error: unknown) => error,
      );
      let blockedByWriter = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const blockers = await writer.query<{ blockers: number[] }>(
          'SELECT pg_blocking_pids($1::integer) AS blockers',
          [migrationPid],
        );
        if (
          writerPid !== undefined &&
          blockers.rows[0]?.blockers.includes(writerPid)
        ) {
          blockedByWriter = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await writer.query('COMMIT');
      expect(blockedByWriter).toBe(true);
      const outcome = await migrationOutcome;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain(
        'legacy group operation locator rows require an owner decision',
      );
      const v2 = await client.query<{ name: string | null }>(
        "SELECT to_regclass('group_operation_locator_v2')::text AS name",
      );
      expect(v2.rows).toEqual([{ name: null }]);
    } finally {
      await writer.query('ROLLBACK');
      await writer.end();
    }
  });
});
