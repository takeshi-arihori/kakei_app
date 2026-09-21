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

const loadMigration = async (): Promise<SqlMigration> => ({
  version: 1,
  name: 'group-management-storage',
  sql: await readFile(
    resolve(
      import.meta.dirname,
      '../migrations/group-management/0001_group_management_storage.sql',
    ),
    'utf8',
  ),
});

const loadDownMigration = async (): Promise<string> =>
  readFile(
    resolve(
      import.meta.dirname,
      '../migrations/group-management/0001_group_management_storage.down.sql',
    ),
    'utf8',
  );

describe('Group Management schema migration', () => {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  let schemaSequence = 0;
  let schemaName = '';

  beforeAll(async () => {
    await client.connect();
  });

  beforeEach(async () => {
    schemaName = `test_issue_74_${process.pid}_${schemaSequence++}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}`);
  });

  afterEach(async () => {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  });

  afterAll(async () => {
    await client.end();
  });

  it('空Schemaへ適用し、同じMigrationの再実行をskipする', async () => {
    const migration = await loadMigration();

    expect(await applySqlMigrations(client, [migration])).toEqual({
      appliedVersions: [1],
      skippedVersions: [],
    });
    expect(await applySqlMigrations(client, [migration])).toEqual({
      appliedVersions: [],
      skippedVersions: [1],
    });

    const tables = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
      ORDER BY table_name
    `);

    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      'app_schema_migrations',
      'group_actor_access_index',
      'group_aggregate_record',
      'group_invitation_history_record',
      'group_invitation_record',
      'group_membership_history_record',
      'group_operation_locator',
      'group_operation_result_record',
      'group_participant_record',
    ]);
  });

  it('業務平文列をADR #55のallowlistへ限定する', async () => {
    await applySqlMigrations(client, [await loadMigration()]);

    const columns = await client.query<{
      table_name: string;
      column_name: string;
    }>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name LIKE 'group_%'
      ORDER BY table_name, ordinal_position
    `);

    const actual: Record<string, string[]> = {};
    for (const { table_name, column_name } of columns.rows) {
      actual[table_name] = [...(actual[table_name] ?? []), column_name];
    }

    expect(actual).toEqual({
      group_actor_access_index: [
        'group_id',
        'actor_digest',
        'digest_key_version',
        'created_at',
        'updated_at',
      ],
      group_aggregate_record: [
        'group_id',
        'logical_record_id',
        'aggregate_version',
        'access_policy_version',
        'envelope_version',
        'algorithm_id',
        'schema_version',
        'key_version',
        'ciphertext',
        'nonce',
        'authentication_tag',
        'created_at',
        'updated_at',
        'deleted_partition_at',
      ],
      group_invitation_history_record: [
        'logical_record_id',
        'group_id',
        'aggregate_version',
        'envelope_version',
        'algorithm_id',
        'schema_version',
        'key_version',
        'ciphertext',
        'nonce',
        'authentication_tag',
        'created_at',
      ],
      group_invitation_record: [
        'logical_record_id',
        'group_id',
        'aggregate_version',
        'envelope_version',
        'algorithm_id',
        'schema_version',
        'key_version',
        'ciphertext',
        'nonce',
        'authentication_tag',
        'created_at',
        'updated_at',
        'deleted_partition_at',
      ],
      group_membership_history_record: [
        'logical_record_id',
        'group_id',
        'aggregate_version',
        'envelope_version',
        'algorithm_id',
        'schema_version',
        'key_version',
        'ciphertext',
        'nonce',
        'authentication_tag',
        'created_at',
      ],
      group_operation_locator: [
        'actor_digest',
        'operation_digest',
        'command_fingerprint',
        'digest_key_version',
        'group_id',
        'operation_result_record_id',
        'created_at',
      ],
      group_operation_result_record: [
        'logical_record_id',
        'group_id',
        'aggregate_version',
        'envelope_version',
        'algorithm_id',
        'schema_version',
        'key_version',
        'ciphertext',
        'nonce',
        'authentication_tag',
        'created_at',
      ],
      group_participant_record: [
        'logical_record_id',
        'group_id',
        'aggregate_version',
        'envelope_version',
        'algorithm_id',
        'schema_version',
        'key_version',
        'ciphertext',
        'nonce',
        'authentication_tag',
        'created_at',
        'updated_at',
        'deleted_partition_at',
      ],
    });
  });

  it('nonce／tag長、version、locatorのGroup境界とcascadeをDB制約で守る', async () => {
    await applySqlMigrations(client, [await loadMigration()]);

    await client.query(
      `INSERT INTO group_aggregate_record (
        group_id, logical_record_id, aggregate_version, access_policy_version,
        envelope_version, algorithm_id, schema_version, key_version,
        ciphertext, nonce, authentication_tag, created_at, updated_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000074',
        '00000000-0000-4000-8000-000000000174',
        0, 0, 1, 'AES-256-GCM', 1, 'test-key-v1',
        decode('01', 'hex'), decode('000102030405060708090a0b', 'hex'),
        decode('000102030405060708090a0b0c0d0e0f', 'hex'), now(), now()
      )`,
    );
    await client.query(
      `INSERT INTO group_aggregate_record (
        group_id, logical_record_id, aggregate_version, access_policy_version,
        envelope_version, algorithm_id, schema_version, key_version,
        ciphertext, nonce, authentication_tag, created_at, updated_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000075',
        '00000000-0000-4000-8000-000000000175',
        0, 0, 1, 'AES-256-GCM', 1, 'test-key-v1',
        decode('01', 'hex'), decode('000102030405060708090a0b', 'hex'),
        decode('000102030405060708090a0b0c0d0e0f', 'hex'), now(), now()
      )`,
    );
    await client.query(
      `INSERT INTO group_operation_result_record (
        logical_record_id, group_id, aggregate_version, envelope_version,
        algorithm_id, schema_version, key_version, ciphertext, nonce,
        authentication_tag, created_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000274',
        '00000000-0000-4000-8000-000000000074', 0, 1,
        'AES-256-GCM', 1, 'test-key-v1', decode('01', 'hex'),
        decode('000102030405060708090a0b', 'hex'),
        decode('000102030405060708090a0b0c0d0e0f', 'hex'), now()
      )`,
    );

    await expect(
      client.query(
        `INSERT INTO group_operation_locator (
          actor_digest, operation_digest, command_fingerprint,
          digest_key_version, group_id, operation_result_record_id, created_at
        ) VALUES (
          decode('09', 'hex'), decode('08', 'hex'), decode('07', 'hex'),
          'test-digest-v1', '00000000-0000-4000-8000-000000000075',
          '00000000-0000-4000-8000-000000000274', now()
        )`,
      ),
    ).rejects.toMatchObject({ code: '23503' });

    await client.query(
      `INSERT INTO group_operation_locator (
        actor_digest, operation_digest, command_fingerprint,
        digest_key_version, group_id, operation_result_record_id, created_at
      ) VALUES (
        decode('01', 'hex'), decode('02', 'hex'), decode('03', 'hex'),
        'test-digest-v1', '00000000-0000-4000-8000-000000000074',
        '00000000-0000-4000-8000-000000000274', now()
      )`,
    );

    await expect(
      client.query(
        `UPDATE group_aggregate_record
         SET nonce = decode('00', 'hex')
         WHERE group_id = '00000000-0000-4000-8000-000000000074'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      client.query(
        `UPDATE group_aggregate_record
         SET authentication_tag = decode('00', 'hex')
         WHERE group_id = '00000000-0000-4000-8000-000000000074'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      client.query(
        `UPDATE group_aggregate_record
         SET aggregate_version = -1
         WHERE group_id = '00000000-0000-4000-8000-000000000074'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await client.query(
      `DELETE FROM group_aggregate_record
       WHERE group_id = '00000000-0000-4000-8000-000000000074'`,
    );
    const locatorCount = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM group_operation_locator',
    );
    expect(locatorCount.rows).toEqual([{ count: '0' }]);
  });

  it('同じversionのSQL driftを拒否する', async () => {
    const migration = await loadMigration();
    await applySqlMigrations(client, [migration]);

    await expect(
      applySqlMigrations(client, [
        { ...migration, sql: `${migration.sql}\nSELECT 1;` },
      ]),
    ).rejects.toBeInstanceOf(MigrationChecksumMismatch);
  });

  it('Data存在時のDownを無変更で拒否し、空Schemaなら再適用できる', async () => {
    await applySqlMigrations(client, [await loadMigration()]);
    await client.query(
      `INSERT INTO group_aggregate_record (
        group_id, logical_record_id, aggregate_version, access_policy_version,
        envelope_version, algorithm_id, schema_version, key_version,
        ciphertext, nonce, authentication_tag, created_at, updated_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000076',
        '00000000-0000-4000-8000-000000000176',
        0, 0, 1, 'AES-256-GCM', 1, 'test-key-v1',
        decode('01', 'hex'), decode('000102030405060708090a0b', 'hex'),
        decode('000102030405060708090a0b0c0d0e0f', 'hex'), now(), now()
      )`,
    );

    await expect(client.query(await loadDownMigration())).rejects.toThrow(
      'group storage down migration requires an empty schema',
    );
    expect(
      (
        await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM group_aggregate_record',
        )
      ).rows,
    ).toEqual([{ count: '1' }]);
    expect(
      (
        await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM app_schema_migrations WHERE version = 1',
        )
      ).rows,
    ).toEqual([{ count: '1' }]);

    await client.query('DELETE FROM group_aggregate_record');
    await client.query(await loadDownMigration());

    const removed = await client.query<{ relation: string | null }>(
      "SELECT to_regclass('group_aggregate_record')::text AS relation",
    );
    expect(removed.rows).toEqual([{ relation: null }]);

    expect(await applySqlMigrations(client, [await loadMigration()])).toEqual({
      appliedVersions: [1],
      skippedVersions: [],
    });
  });
});
