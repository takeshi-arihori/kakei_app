import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySqlMigrations } from '../src/group-management/infrastructure/postgres/sql-migration.js';

const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';
describe('GM招待コード参加Metadataの追加Migration', () => {
  const client = new Client({ connectionString: url });
  const schema = `gm_enlist_schema_${randomUUID().replaceAll('-', '')}`;
  let owned = false;
  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    owned = true;
    await client.query(`SET search_path TO ${schema}`);
  });
  afterAll(async () => {
    if (owned) await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  });
  it('追加Migrationを再実行でき、初期proof世代は未設定で、Auditへ直接IDを保存しない', async () => {
    const names = [
      [1, '0001_group_management_storage'],
      [2, '0002_group_locator_v2'],
      [3, '0003_close_intent_registry'],
      [4, '0004_group_management_retention'],
      [10, '0010_recipient_invitation_enlistment'],
    ] as const;
    const migrations = await Promise.all(
      names.map(async ([version, name]) => ({
        version,
        name,
        sql: await readFile(
          new URL(
            `../migrations/group-management/${name}.sql`,
            import.meta.url,
          ),
          'utf8',
        ),
      })),
    );
    await expect(applySqlMigrations(client, migrations)).resolves.toMatchObject(
      { appliedVersions: [1, 2, 3, 4, 10] },
    );
    await expect(applySqlMigrations(client, migrations)).resolves.toMatchObject(
      { skippedVersions: [1, 2, 3, 4, 10] },
    );
    expect(
      (
        await client.query(
          'SELECT id, current_key_version FROM group_recipient_code_proof_key_state',
        )
      ).rows,
    ).toEqual([{ id: 1, current_key_version: null }]);
    await expect(
      client.query(
        "UPDATE group_recipient_code_proof_key_state SET current_key_version = 'invalid generation' WHERE id = 1",
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const columns = await client.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      [schema, 'group_recipient_invitation_audit_record'],
    );
    expect(columns.rows.map((r) => r.column_name).sort()).toEqual(
      [
        'request_id',
        'occurred_at',
        'action',
        'decision',
        'reason_code',
        'policy_version',
        'actor_pseudonym',
        'group_pseudonym',
        'resource_pseudonym',
        'request_fingerprint',
        'audit_key_version',
      ].sort(),
    );

    const down = await readFile(
      new URL(
        '../migrations/group-management/0010_recipient_invitation_enlistment.down.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await client.query(down);
    expect(
      (
        await client.query<{ present: string | null }>(
          "SELECT to_regclass('group_recipient_invitation_audit_record')::text AS present",
        )
      ).rows[0]?.present,
    ).toBeNull();
    await client.query(migrations.find((m) => m.version === 10)!.sql);
    await client.query(
      "UPDATE group_recipient_code_proof_key_state SET current_key_version = 'proof-v1' WHERE id = 1",
    );
    await expect(client.query(down)).rejects.toThrow('requires forward-fix');
    await client.query(
      'UPDATE group_recipient_code_proof_key_state SET current_key_version = NULL WHERE id = 1',
    );
    const auditSql = `INSERT INTO group_recipient_invitation_audit_record (request_id,occurred_at,action,decision,reason_code,policy_version,actor_pseudonym,group_pseudonym,resource_pseudonym,request_fingerprint,audit_key_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;
    const values = [
      randomUUID(),
      new Date('2026-10-30T00:00:00.000Z'),
      'CreateInvitationFromRecipientCode',
      'allow',
      'InvitationCreated',
      1,
      Buffer.alloc(32, 1),
      Buffer.alloc(32, 2),
      Buffer.alloc(32, 3),
      Buffer.alloc(32, 4),
      'synthetic-audit-v1',
    ];
    await expect(
      client.query(auditSql, [
        ...values.slice(0, 6),
        Buffer.alloc(31),
        ...values.slice(7),
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query(auditSql, values);
    await expect(
      client.query(auditSql, [randomUUID(), ...values.slice(1)]),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(client.query(down)).rejects.toThrow('requires forward-fix');
    expect(
      (
        await client.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM group_recipient_invitation_audit_record',
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
});
