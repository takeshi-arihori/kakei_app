import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Client, Pool } from 'pg';
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
  GroupManagementDeletionReceiptRecord,
  RetentionIntentVersion,
} from '../src/group-management/application/group-management-deletion-receipt-port.js';
import { OperationId } from '../src/group-management/application/group-repository.js';
import {
  CloseIntentId,
  GroupId,
} from '../src/group-management/domain/group.js';
import { PostgresGroupManagementRetentionAdapter } from '../src/group-management/infrastructure/postgres/group-management-retention-adapter.js';
import {
  applySqlMigrations,
  type SqlMigration,
} from '../src/group-management/infrastructure/postgres/sql-migration.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';
const groupId = GroupId.from('00000000-0000-4000-8000-000000000103');
const closeIntentId = CloseIntentId.from(
  '00000000-0000-4000-8000-000000000103',
);
const operationId = OperationId.from('retention-operation-103');
const intentVersion = RetentionIntentVersion.from(2);
const receipt = GroupManagementDeletionReceiptRecord.create({
  operationId,
  intentVersion,
  canonicalReceipt: 'canonical-gm-receipt-103',
});

const migrationFiles = [
  '0001_group_management_storage',
  '0002_group_locator_v2',
  '0003_close_intent_registry',
  '0004_group_management_retention',
] as const;

const loadMigrations = async (): Promise<readonly SqlMigration[]> =>
  Promise.all(
    migrationFiles.map(async (file, index) => ({
      version: index + 1,
      name: file.slice(5).replaceAll('_', '-'),
      sql: await readFile(
        resolve(
          import.meta.dirname,
          `../migrations/group-management/${file}.sql`,
        ),
        'utf8',
      ),
    })),
  );

const deleteRequest = () => ({
  groupId,
  closeIntentId,
  operationId,
  intentVersion,
  receipt,
});

describe('Postgres Group Management Retention adapter', () => {
  const admin = new Pool({ connectionString: TEST_DATABASE_URL });
  let sequence = 0;
  let schemaName = '';
  let pool: Pool;

  beforeAll(async () => {
    await admin.query('SELECT 1');
  });

  beforeEach(async () => {
    schemaName = `test_issue_103_${process.pid}_${sequence++}`;
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`SET search_path TO ${schemaName}`);
      await applySqlMigrations(client, await loadMigrations());
    } finally {
      await client.end();
    }
    pool = new Pool({
      connectionString: TEST_DATABASE_URL,
      options: `-c search_path=${schemaName}`,
    });
  });

  afterEach(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  });

  afterAll(async () => {
    await admin.end();
  });

  it('live/retired形状、nullable FK、退役後の最小MetadataをDB制約で守る', async () => {
    await seedGroup(pool);

    await expect(
      pool.query(
        `INSERT INTO group_close_intent_registry (
           close_intent_id, group_id, retain_until, created_at
         ) VALUES ($1, NULL, NULL, NULL)`,
        ['00000000-0000-4000-8000-000000000104'],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `INSERT INTO group_close_intent_registry (
           close_intent_id, group_id, retain_until, created_at
         ) VALUES ($1, NULL, $2, $3)`,
        [
          '00000000-0000-4000-8000-000000000105',
          '2027-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `INSERT INTO group_close_intent_registry (
           close_intent_id, group_id
         ) VALUES ($1, $2)`,
        [
          '00000000-0000-4000-8000-000000000106',
          '00000000-0000-4000-8000-000000000999',
        ],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      pool.query('DELETE FROM group_aggregate_record WHERE group_id = $1', [
        groupId.value,
      ]),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it.each([
    {
      deletedAt: '2025-03-15T01:30:00.000Z',
      retainUntil: '2026-03-15T01:30:00.000Z',
    },
    {
      deletedAt: '2024-02-29T03:00:00.000Z',
      retainUntil: '2025-02-28T03:00:00.000Z',
    },
  ])(
    'registry退役、GM業務Data削除、Receipt保存を同時commitする: $deletedAt',
    async ({ deletedAt, retainUntil }) => {
      await seedGroup(pool, true);
      let nowCalls = 0;
      const adapter = new PostgresGroupManagementRetentionAdapter({
        pool,
        now: () => {
          nowCalls += 1;
          return new Date(deletedAt);
        },
      });

      await expect(adapter.deleteGroupData(deleteRequest())).resolves.toEqual({
        kind: 'Deleted',
        record: receipt,
      });
      expect(nowCalls).toBe(1);

      const registry = await pool.query<{
        close_intent_id: string;
        group_id: string | null;
        retain_until: Date;
        created_at: Date | null;
      }>(
        `SELECT close_intent_id, group_id, retain_until, created_at
           FROM group_close_intent_registry
          WHERE close_intent_id = $1`,
        [closeIntentId.value],
      );
      expect(registry.rows).toEqual([
        {
          close_intent_id: closeIntentId.value,
          group_id: null,
          retain_until: new Date(retainUntil),
          created_at: null,
        },
      ]);
      expect(await countGroupOwnedRows(pool)).toBe(0);
      await expect(
        adapter.findReceipt({ operationId, intentVersion }),
      ).resolves.toEqual({ kind: 'Found', record: receipt });
    },
  );

  it.each([
    'afterRegistryRetired',
    'afterGroupDeleted',
    'beforeReceiptStored',
    'afterReceiptStored',
  ] as const)(
    '%sで故障してもtransaction全体をrollbackし、同じoperationで再試行できる',
    async (failurePoint) => {
      await seedGroup(pool, true);
      const adapter = new PostgresGroupManagementRetentionAdapter({
        pool,
        now: () => new Date('2025-03-15T01:30:00.000Z'),
        failureInjector: {
          [failurePoint]: () => {
            throw new Error('injected failure');
          },
        },
      });

      await expect(adapter.deleteGroupData(deleteRequest())).resolves.toEqual({
        kind: 'Unavailable',
      });
      expect(await countGroupOwnedRows(pool)).toBe(10);
      expect(
        await pool.query(
          `SELECT 1 FROM group_close_intent_registry
            WHERE close_intent_id = $1
              AND group_id = $2
              AND retain_until IS NULL
              AND created_at IS NOT NULL`,
          [closeIntentId.value, groupId.value],
        ),
      ).toMatchObject({ rowCount: 1 });
      expect(
        await pool.query(
          'SELECT 1 FROM group_management_deletion_receipt_record',
        ),
      ).toMatchObject({ rowCount: 0 });

      const retry = new PostgresGroupManagementRetentionAdapter({
        pool,
        now: () => new Date('2025-03-15T01:30:00.000Z'),
      });
      await expect(retry.deleteGroupData(deleteRequest())).resolves.toEqual({
        kind: 'Deleted',
        record: receipt,
      });
    },
  );

  it('commit後の応答喪失は保存済みReceiptを返し、削除を繰り返さない', async () => {
    await seedGroup(pool, true);
    const lostResponse = new PostgresGroupManagementRetentionAdapter({
      pool,
      now: () => new Date('2025-03-15T01:30:00.000Z'),
      failureInjector: {
        afterCommit: () => {
          throw new Error('response lost');
        },
      },
    });

    await expect(
      lostResponse.deleteGroupData(deleteRequest()),
    ).resolves.toEqual({ kind: 'Unavailable' });
    expect(await countGroupOwnedRows(pool)).toBe(0);

    const retry = new PostgresGroupManagementRetentionAdapter({ pool });
    await expect(retry.deleteGroupData(deleteRequest())).resolves.toEqual({
      kind: 'AlreadyDeleted',
      record: receipt,
    });
  });

  it('commit済みReceiptに対する古いversionと異なるbindingをfail closedにする', async () => {
    await seedGroup(pool);
    const adapter = new PostgresGroupManagementRetentionAdapter({
      pool,
      now: () => new Date('2025-03-15T01:30:00.000Z'),
    });
    await expect(
      adapter.deleteGroupData(deleteRequest()),
    ).resolves.toMatchObject({ kind: 'Deleted' });

    await expect(
      adapter.findReceipt({
        operationId,
        intentVersion: RetentionIntentVersion.from(1),
      }),
    ).resolves.toEqual({ kind: 'StaleEvidence' });
    await expect(
      adapter.findReceipt({
        operationId,
        intentVersion: RetentionIntentVersion.from(3),
      }),
    ).resolves.toEqual({ kind: 'BindingMismatch' });

    const mismatchedReceipt = GroupManagementDeletionReceiptRecord.create({
      operationId,
      intentVersion,
      canonicalReceipt: 'another-canonical-receipt',
    });
    await expect(
      adapter.deleteGroupData({
        ...deleteRequest(),
        receipt: mismatchedReceipt,
      }),
    ).resolves.toEqual({ kind: 'Rejected', reason: 'BindingMismatch' });
  });

  it('期限前を保持し、期限到達時と経過後だけを単一txNowでpurgeして再実行できる', async () => {
    await seedRetiredRegistryRows(pool);
    let nowCalls = 0;
    const adapter = new PostgresGroupManagementRetentionAdapter({
      pool,
      now: () => {
        nowCalls += 1;
        return new Date('2027-01-01T00:00:00.000Z');
      },
    });

    await expect(adapter.purgeRetiredCloseIntents()).resolves.toEqual({
      kind: 'Purged',
      txNow: new Date('2027-01-01T00:00:00.000Z'),
      purgedCount: 2,
    });
    expect(nowCalls).toBe(1);
    expect(
      await pool.query<{ close_intent_id: string }>(
        `SELECT close_intent_id FROM group_close_intent_registry
          ORDER BY close_intent_id`,
      ),
    ).toMatchObject({
      rows: [{ close_intent_id: '00000000-0000-4000-8000-000000000303' }],
    });

    await expect(adapter.purgeRetiredCloseIntents()).resolves.toEqual({
      kind: 'Purged',
      txNow: new Date('2027-01-01T00:00:00.000Z'),
      purgedCount: 0,
    });
    expect(nowCalls).toBe(2);
  });

  it('purge中の故障はrollbackし、期限経過後もcommitまでは重複IDを拒否する', async () => {
    await pool.query(
      `INSERT INTO group_close_intent_registry (
         close_intent_id, group_id, retain_until, created_at
       ) VALUES ($1, NULL, $2, NULL)`,
      [closeIntentId.value, '2026-12-31T23:59:59.999Z'],
    );
    const adapter = new PostgresGroupManagementRetentionAdapter({
      pool,
      now: () => new Date('2027-01-01T00:00:00.000Z'),
      failureInjector: {
        afterPurgeDeleted: () => {
          throw new Error('purge failed');
        },
      },
    });

    await expect(adapter.purgeRetiredCloseIntents()).resolves.toEqual({
      kind: 'Unavailable',
    });
    expect(
      await pool.query(
        'SELECT 1 FROM group_close_intent_registry WHERE close_intent_id = $1',
        [closeIntentId.value],
      ),
    ).toMatchObject({ rowCount: 1 });
    await seedRoot(pool, groupId.value);
    await expect(
      pool.query(
        `INSERT INTO group_close_intent_registry (close_intent_id, group_id)
         VALUES ($1, $2)`,
        [closeIntentId.value, groupId.value],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    const retry = new PostgresGroupManagementRetentionAdapter({
      pool,
      now: () => new Date('2027-01-01T00:00:00.000Z'),
    });
    await expect(retry.purgeRetiredCloseIntents()).resolves.toMatchObject({
      kind: 'Purged',
      purgedCount: 1,
    });
    await expect(
      pool.query(
        `INSERT INTO group_close_intent_registry (close_intent_id, group_id)
         VALUES ($1, $2)`,
        [closeIntentId.value, groupId.value],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});

async function seedRoot(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO group_aggregate_record (
       group_id, logical_record_id, aggregate_version, access_policy_version,
       envelope_version, algorithm_id, schema_version, key_version,
       ciphertext, nonce, authentication_tag, created_at, updated_at
     ) VALUES (
       $1, $2, 1, 1, 1, 'AES-256-GCM', 1, 'test-data-v1',
       decode('01', 'hex'), decode('000102030405060708090a0b', 'hex'),
       decode('000102030405060708090a0b0c0d0e0f', 'hex'), $3, $3
     )`,
    [id, id.replace(/.$/, '9'), '2025-01-01T00:00:00.000Z'],
  );
}

async function seedGroup(pool: Pool, withChildren = false): Promise<void> {
  await seedRoot(pool, groupId.value);
  await pool.query(
    `INSERT INTO group_close_intent_registry (close_intent_id, group_id)
     VALUES ($1, $2)`,
    [closeIntentId.value, groupId.value],
  );
  if (!withChildren) return;

  const encryptedRecordValues = `
    1, 1, 'AES-256-GCM', 1, 'test-data-v1', decode('01', 'hex'),
    decode('000102030405060708090a0b', 'hex'),
    decode('000102030405060708090a0b0c0d0e0f', 'hex')`;
  await pool.query(
    `INSERT INTO group_participant_record (
       logical_record_id, group_id, aggregate_version, envelope_version,
       algorithm_id, schema_version, key_version, ciphertext, nonce,
       authentication_tag, created_at, updated_at
     ) VALUES ($1, $2, ${encryptedRecordValues}, $3, $3)`,
    ['00000000-0000-4000-8000-000000000401', groupId.value, '2025-01-01Z'],
  );
  await pool.query(
    `INSERT INTO group_invitation_record (
       logical_record_id, group_id, aggregate_version, envelope_version,
       algorithm_id, schema_version, key_version, ciphertext, nonce,
       authentication_tag, created_at, updated_at
     ) VALUES ($1, $2, ${encryptedRecordValues}, $3, $3)`,
    ['00000000-0000-4000-8000-000000000402', groupId.value, '2025-01-01Z'],
  );
  for (const [table, id] of [
    ['group_membership_history_record', '00000000-0000-4000-8000-000000000403'],
    ['group_invitation_history_record', '00000000-0000-4000-8000-000000000404'],
    ['group_close_history_record', '00000000-0000-4000-8000-000000000405'],
  ] as const) {
    await pool.query(
      `INSERT INTO ${table} (
         logical_record_id, group_id, aggregate_version, envelope_version,
         algorithm_id, schema_version, key_version, ciphertext, nonce,
         authentication_tag, created_at
       ) VALUES ($1, $2, ${encryptedRecordValues}, $3)`,
      [id, groupId.value, '2025-01-01Z'],
    );
  }
  await pool.query(
    `INSERT INTO group_operation_result_record (
       logical_record_id, group_id, aggregate_version, envelope_version,
       algorithm_id, schema_version, key_version, ciphertext, nonce,
       authentication_tag, created_at
     ) VALUES ($1, $2, ${encryptedRecordValues}, $3)`,
    ['00000000-0000-4000-8000-000000000406', groupId.value, '2025-01-01Z'],
  );
  await pool.query(
    `INSERT INTO group_actor_access_index (
       group_id, actor_digest, digest_key_version, created_at, updated_at
     ) VALUES ($1, decode('01', 'hex'), 'test-digest-v1', $2, $2)`,
    [groupId.value, '2025-01-01Z'],
  );
  await pool.query(
    `INSERT INTO group_operation_locator (
       actor_digest, operation_digest, command_fingerprint,
       digest_key_version, group_id, operation_result_record_id, created_at
     ) VALUES (
       decode('04', 'hex'), decode('05', 'hex'), decode('06', 'hex'),
       'test-digest-v1', $1, $2, $3
     )`,
    [groupId.value, '00000000-0000-4000-8000-000000000406', '2025-01-01Z'],
  );
  await pool.query(
    `INSERT INTO group_operation_locator_v2 (
       locator_digest, digest_key_version, command_fingerprint, group_id,
       operation_result_record_id, created_at
     ) VALUES (
       decode('02', 'hex'), 'test-digest-v1', decode('03', 'hex'), $1, $2, $3
     )`,
    [groupId.value, '00000000-0000-4000-8000-000000000406', '2025-01-01Z'],
  );
}

async function countGroupOwnedRows(pool: Pool): Promise<number> {
  const tables = [
    'group_aggregate_record',
    'group_participant_record',
    'group_invitation_record',
    'group_membership_history_record',
    'group_invitation_history_record',
    'group_operation_result_record',
    'group_actor_access_index',
    'group_operation_locator',
    'group_operation_locator_v2',
    'group_close_history_record',
  ];
  let total = 0;
  for (const table of tables) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE group_id = $1`,
      [groupId.value],
    );
    total += Number(result.rows[0]?.count ?? 0);
  }
  return total;
}

async function seedRetiredRegistryRows(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO group_close_intent_registry (
       close_intent_id, group_id, retain_until, created_at
     ) VALUES
       ('00000000-0000-4000-8000-000000000301', NULL, $1, NULL),
       ('00000000-0000-4000-8000-000000000302', NULL, $2, NULL),
       ('00000000-0000-4000-8000-000000000303', NULL, $3, NULL)`,
    [
      '2026-12-31T23:59:59.999Z',
      '2027-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.001Z',
    ],
  );
}
