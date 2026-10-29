import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
  MigrationChecksumMismatch,
  type SqlMigration,
} from '../src/group-management/infrastructure/postgres/sql-migration.js';
import {
  readAuthenticationKeyState,
  readAuthenticationMaintenanceKeyState,
  readAuthenticationRestoreKeyState,
} from '../src/shared/infrastructure/authentication/postgres/authentication-key-state.js';
import { AuthenticationCryptoUnavailable } from '../src/shared/application/authentication/authentication-record-protection.js';

const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';
const names = [
  '0001_group_management_storage',
  '0002_group_locator_v2',
  '0003_close_intent_registry',
  '0004_group_management_retention',
  '0005_authentication_schema',
  '0006_authentication_inventory',
  '0007_authentication_http_rate',
  '0008_recipient_code_schema',
  '0009_recipient_code_audit',
];
const migration = async (version: number): Promise<SqlMigration> => {
  const name = names[version - 1];
  return {
    version,
    name: name.slice(5).replaceAll('_', '-'),
    sql: await readFile(
      new URL(
        `../migrations/${version < 5 ? 'group-management' : 'authentication'}/${name}.sql`,
        import.meta.url,
      ),
      'utf8',
    ),
  };
};

describe('招待コードSchemaの実PostgreSQL17 Migration #237', () => {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
  });
  let owned = false;
  let groupSchema = '';
  const actorId = randomUUID();
  const epoch = randomUUID();

  beforeAll(async () => {
    await client.connect();
    const info = (
      await client.query<{ name: string; version: string }>(
        "SELECT current_database() AS name,current_setting('server_version_num') AS version",
      )
    ).rows[0];
    if (
      !info.name.endsWith('_test') ||
      Number(info.version) < 170000 ||
      Number(info.version) >= 180000
    )
      throw new Error('PG17末尾_testの分離DBだけで検証する');
    await client.query('SELECT pg_advisory_lock(1801546597,1635087464)');
  });
  beforeEach(async () => {
    if (
      (
        await client.query<{ present: boolean }>(
          "SELECT to_regnamespace('authentication') IS NOT NULL OR to_regnamespace('authentication_http') IS NOT NULL AS present",
        )
      ).rows[0].present
    )
      throw new Error('既存の認証/HTTP Schemaを変更しない');
    groupSchema = `test_issue_237_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${groupSchema}`);
    owned = true;
    await client.query(`SET search_path TO ${groupSchema}`);
  });
  afterEach(async () => {
    if (!owned) return;
    await client.query('ROLLBACK');
    await client.query('SET search_path TO public');
    await client.query('DROP SCHEMA IF EXISTS authentication_http CASCADE');
    await client.query('DROP SCHEMA IF EXISTS authentication CASCADE');
    await client.query(`DROP SCHEMA ${groupSchema} CASCADE`);
    owned = false;
  });
  afterAll(async () => {
    await client.end();
  });

  const previous = async () =>
    applySqlMigrations(
      client,
      await Promise.all([1, 2, 3, 4, 5, 6, 7].map(migration)),
    );
  const apply = async () => {
    await previous();
    await applySqlMigrations(client, [await migration(8)]);
  };
  const actor = async (id = actorId) =>
    client.query(
      "INSERT INTO authentication.actor(actor_id,state,version,created_at_ms,disabled_at_ms,control_key_version,state_mac) VALUES($1,'active',1,1000,NULL,'actor-v1',$2)",
      [id, randomBytes(32)],
    );
  const insert = async (patch: Record<string, unknown> = {}) => {
    const row = {
      code_id: randomUUID(),
      recipient_actor_id: actorId,
      record_version: 1,
      epoch,
      created_at_ms: 1000,
      expires_at_ms: 601000,
      state: 'issued',
      terminal_at_ms: null,
      lookup_key_version: 'lookup-v1',
      lookup_digest: randomBytes(32),
      mac_key_version: 'mac-v1',
      state_mac: randomBytes(32),
      ...patch,
    };
    const fields = Object.keys(row);
    return client.query<{ code_id: string }>(
      `INSERT INTO authentication.recipient_code(${fields.join(',')}) VALUES(${fields.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING code_id`,
      Object.values(row),
    );
  };
  const inventory = async () => ({
    actors: (
      await client.query('SELECT * FROM authentication.actor ORDER BY actor_id')
    ).rows,
    state: (await client.query('SELECT * FROM authentication.key_state')).rows,
    generations: (
      await client.query(
        'SELECT * FROM authentication.key_generation ORDER BY purpose,key_version',
      )
    ).rows,
    group: (await client.query('SELECT * FROM group_aggregate_record')).rows,
    ledger: (
      await client.query(
        'SELECT * FROM app_schema_migrations WHERE version<=7 ORDER BY version',
      )
    ).rows,
  });

  const seedLegacyKeys = async () => {
    await client.query(
      "UPDATE authentication.key_state SET status='active',epoch=$1",
      [epoch],
    );
    for (const purpose of [
      'google-identity-search',
      'login-attempt-cookie',
      'session-cookie',
      'actor-state-mac',
      'audit-actor',
      'audit-attempt',
      'audit-session',
      'deleted-actor',
      'deletion-ledger-mac',
    ])
      await client.query(
        "INSERT INTO authentication.key_generation(generation_id,purpose,key_version,epoch,searchable,write_required) VALUES($1,$2,'v1',$3,true,true)",
        [
          randomUUID(),
          purpose,
          ['login-attempt-cookie', 'session-cookie'].includes(purpose)
            ? epoch
            : null,
        ],
      );
  };

  it('空DBへ1〜8を原子的に適用し、新しいコード/鍵世代を初期化しない', async () => {
    expect(
      await applySqlMigrations(
        client,
        await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(migration)),
      ),
    ).toEqual({
      appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8],
      skippedVersions: [],
    });
    expect(
      (await client.query('SELECT * FROM authentication.recipient_code'))
        .rowCount,
    ).toBe(0);
    expect(
      (await client.query('SELECT * FROM authentication.key_generation'))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await client.query(
          'SELECT status,epoch,generation_version FROM authentication.key_state',
        )
      ).rows,
    ).toEqual([
      { status: 'uninitialized', epoch: null, generation_version: '1' },
    ]);
    await expect(readAuthenticationKeyState(client)).rejects.toBeInstanceOf(
      AuthenticationCryptoUnavailable,
    );
  });

  it('既存7までの認証/GM行と台帳を保ち、8の再実行skip/Checksum不一致拒否を行う', async () => {
    await previous();
    await actor();
    await seedLegacyKeys();
    await client.query(
      `INSERT INTO group_aggregate_record(group_id,logical_record_id,aggregate_version,access_policy_version,envelope_version,algorithm_id,schema_version,key_version,ciphertext,nonce,authentication_tag,created_at,updated_at) VALUES($1,$2,0,0,1,'AES-256-GCM',1,'synthetic-v1',$3,$4,$5,to_timestamp(1),to_timestamp(1))`,
      [
        randomUUID(),
        randomUUID(),
        Buffer.from([1]),
        Buffer.alloc(12),
        Buffer.alloc(16),
      ],
    );
    const before = await inventory();
    const next = await migration(8);
    expect(await applySqlMigrations(client, [next])).toEqual({
      appliedVersions: [8],
      skippedVersions: [],
    });
    expect(await inventory()).toEqual(before);
    await expect(readAuthenticationKeyState(client)).resolves.toMatchObject({
      epoch,
    });
    expect(await applySqlMigrations(client, [next])).toEqual({
      appliedVersions: [],
      skippedVersions: [8],
    });
    await expect(
      applySqlMigrations(client, [{ ...next, sql: next.sql + '\nSELECT 1;' }]),
    ).rejects.toBeInstanceOf(MigrationChecksumMismatch);
    expect(await inventory()).toEqual(before);
  });

  it('途中故障ではTable/Enum追加と台帳をrollbackし、正規8の再適用を許可する', async () => {
    await previous();
    const before = await inventory();
    const oldPurposes = (
      await client.query(
        "SELECT enumlabel FROM pg_enum WHERE enumtypid='authentication.key_purpose'::regtype ORDER BY enumsortorder",
      )
    ).rows;
    const next = await migration(8);
    await expect(
      applySqlMigrations(client, [
        { ...next, sql: next.sql + '\nSELECT 1/0;' },
      ]),
    ).rejects.toMatchObject({ code: '22012' });
    expect(
      (
        await client.query(
          "SELECT to_regclass('authentication.recipient_code') AS relation, to_regtype('authentication.recipient_code_state') AS state_type",
        )
      ).rows,
    ).toEqual([{ relation: null, state_type: null }]);
    expect(
      (
        await client.query(
          "SELECT enumlabel FROM pg_enum WHERE enumtypid='authentication.key_purpose'::regtype ORDER BY enumsortorder",
        )
      ).rows,
    ).toEqual(oldPurposes);
    expect(await inventory()).toEqual(before);
    expect(
      (
        await client.query(
          'SELECT 1 FROM app_schema_migrations WHERE version=8',
        )
      ).rowCount,
    ).toBe(0);
    await applySqlMigrations(client, [next]);
  });

  it('R4の最小12列だけを持ち、FKはActorだけ/削除RESTRICTでGMへ跨がない', async () => {
    await apply();
    const columns = (
      await client.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='authentication' AND table_name='recipient_code' ORDER BY ordinal_position",
      )
    ).rows.map((r) => r.column_name);
    expect(columns).toEqual([
      'code_id',
      'recipient_actor_id',
      'record_version',
      'epoch',
      'created_at_ms',
      'expires_at_ms',
      'state',
      'terminal_at_ms',
      'lookup_key_version',
      'lookup_digest',
      'mac_key_version',
      'state_mac',
    ]);
    const nullable = (
      await client.query<{
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        "SELECT column_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='authentication' AND table_name='recipient_code'",
      )
    ).rows;
    expect(
      nullable.filter((r) => r.is_nullable === 'YES').map((r) => r.column_name),
    ).toEqual(['terminal_at_ms']);
    expect(nullable.every((r) => r.column_default === null)).toBe(true);
    const fk = (
      await client.query(
        "SELECT confrelid::regclass::text AS target,confdeltype FROM pg_constraint WHERE conrelid='authentication.recipient_code'::regclass AND contype='f'",
      )
    ).rows;
    expect(fk).toEqual([{ target: 'authentication.actor', confdeltype: 'r' }]);
    await actor();
    await insert();
    await expect(
      client.query('DELETE FROM authentication.actor WHERE actor_id=$1', [
        actorId,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      insert({ recipient_actor_id: randomUUID() }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('期限超過のIssuedも最大1件で、置換後だけ同Actorの新Issuedを挿入できる', async () => {
    await apply();
    await actor();
    const first = await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
    await client.query(
      "UPDATE authentication.recipient_code SET state='replaced',terminal_at_ms=700000,record_version=2 WHERE code_id=$1",
      [first.rows[0].code_id],
    );
    await insert();
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM authentication.recipient_code WHERE recipient_actor_id=$1 AND state='issued'",
          [actorId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    const predicate = (
      await client.query<{ predicate: string }>(
        "SELECT pg_get_expr(indpred,indrelid) AS predicate FROM pg_index WHERE indexrelid='authentication.authentication_recipient_code_issued_actor_idx'::regclass",
      )
    ).rows[0].predicate;
    expect(predicate).toContain('issued');
    expect(predicate).not.toContain('now');
  });

  it('codeIdと世代別Digestを一意にし、別検索世代は同じDigestを保持できる', async () => {
    await apply();
    await actor();
    const other = randomUUID();
    await actor(other);
    const digest = randomBytes(32);
    const first = await insert({ lookup_digest: digest });
    await expect(
      insert({ code_id: first.rows[0].code_id, recipient_actor_id: other }),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      insert({ recipient_actor_id: other, lookup_digest: digest }),
    ).rejects.toMatchObject({ code: '23505' });
    await insert({
      recipient_actor_id: other,
      lookup_digest: digest,
      lookup_key_version: 'lookup-v2',
    });
  });

  it.each(['consumed', 'replaced', 'revoked'])(
    '終端%sは同Actorで複数保持でき、期限後のterminalも許可する',
    async (state) => {
      await apply();
      await actor();
      await insert({ state, terminal_at_ms: 700000 });
      await insert({ state, terminal_at_ms: 700001 });
      await insert();
    },
  );

  it.each([
    [{ record_version: 0 }, '23514'],
    [{ record_version: 9007199254740992 }, '23514'],
    [{ created_at_ms: -1 }, '23514'],
    [{ expires_at_ms: 601001 }, '23514'],
    [
      { created_at_ms: 9007199254740991, expires_at_ms: '9007199255340991' },
      '23514',
    ],
    [{ state: 'issued', terminal_at_ms: 1000 }, '23514'],
    [{ state: 'consumed' }, '23514'],
    [{ state: 'revoked', terminal_at_ms: 999 }, '23514'],
    [{ state: 'expired' }, '22P02'],
    [{ state: null }, '23502'],
    [{ epoch: null }, '23502'],
    [{ code_id: null }, '23502'],
    [{ lookup_digest: Buffer.alloc(31) }, '23514'],
    [{ lookup_digest: Buffer.alloc(33) }, '23514'],
    [{ state_mac: Buffer.alloc(31) }, '23514'],
    [{ state_mac: Buffer.alloc(33) }, '23514'],
    [{ lookup_key_version: '' }, '23514'],
    [{ mac_key_version: 'bad key' }, '23514'],
    [{ code_id: '00000000-0000-1000-8000-000000000000' }, '23514'],
    [{ epoch: '00000000-0000-1000-8000-000000000000' }, '23514'],
    [{ lookup_key_version: 'a'.repeat(256) }, '23514'],
  ] as const)(
    '不正状態/時刻/版/長さ/鍵世代を拒否する: %j',
    async (patch, code) => {
      await apply();
      await actor();
      await expect(insert(patch)).rejects.toMatchObject({ code });
      expect(
        (await client.query('SELECT * FROM authentication.recipient_code'))
          .rowCount,
      ).toBe(0);
    },
  );

  it('safe integer最終期限を保存し、期限/終端の最早時点とActor清掃に索引を持つ', async () => {
    await apply();
    await actor();
    await insert({
      created_at_ms: 9007199254140991,
      expires_at_ms: 9007199254740991,
    });
    const indexes = (
      await client.query<{ indexname: string; indexdef: string }>(
        "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='authentication' AND tablename='recipient_code'",
      )
    ).rows;
    expect(
      indexes.find(
        (r) => r.indexname === 'authentication_recipient_code_cleanup_due_idx',
      )?.indexdef,
    ).toContain(
      'LEAST(expires_at_ms, COALESCE(terminal_at_ms, expires_at_ms))',
    );
    expect(
      indexes.find(
        (r) => r.indexname === 'authentication_recipient_code_actor_idx',
      )?.indexdef,
    ).toContain('(recipient_actor_id)');
  });

  it.each(['recipient-code-lookup', 'recipient-code-state-mac'])(
    '新用途%sはMetadataだけで、旧通常/清掃/Restore readerがskipせず拒否する',
    async (purpose) => {
      await apply();
      await seedLegacyKeys();
      await expect(readAuthenticationKeyState(client)).resolves.toMatchObject({
        epoch,
      });
      await client.query(
        "INSERT INTO authentication.key_generation(generation_id,purpose,key_version,epoch,searchable,write_required) VALUES($1,$2,'code-v1',NULL,false,false)",
        [randomUUID(), purpose],
      );
      await expect(
        client.query(
          "INSERT INTO authentication.key_generation(generation_id,purpose,key_version,epoch,searchable,write_required) VALUES($1,$2,'code-v1',NULL,false,false)",
          [randomUUID(), purpose],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        client.query(
          "INSERT INTO authentication.key_generation(generation_id,purpose,key_version,epoch,searchable,write_required) VALUES($1,$2,'code-v2',$3,false,false)",
          [randomUUID(), purpose, epoch],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(readAuthenticationKeyState(client)).rejects.toBeInstanceOf(
        AuthenticationCryptoUnavailable,
      );
      await expect(
        readAuthenticationMaintenanceKeyState(client),
      ).rejects.toBeInstanceOf(AuthenticationCryptoUnavailable);
      await client.query(
        "UPDATE authentication.key_state SET status='restoring'",
      );
      await expect(
        readAuthenticationRestoreKeyState(client),
      ).rejects.toBeInstanceOf(AuthenticationCryptoUnavailable);
    },
  );

  it('Downは空DBでも拒否し、適用済みcode行/Enum/台帳を保持する', async () => {
    await apply();
    const down = await readFile(
      new URL(
        '../migrations/authentication/0008_recipient_code_schema.down.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await expect(client.query(down)).rejects.toThrow('forward-only');
    await actor();
    await insert();
    const before = await inventory();
    await expect(
      client.query(
        await readFile(
          new URL(
            '../migrations/authentication/0008_recipient_code_schema.down.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    ).rejects.toThrow('forward-only');
    expect(await inventory()).toEqual(before);
    expect(
      (await client.query('SELECT * FROM authentication.recipient_code'))
        .rowCount,
    ).toBe(1);
  });

  it('#240: 監査列追加は既存行を保ち、再適用とchecksumを検証する', async () => {
    await apply();
    await client.query(
      "INSERT INTO authentication.audit_event(event_id,request_id,occurred_at_ms,action,decision,reason,audit_key_version) VALUES($1,$2,1000,'inspect','allow','success','v1')",
      [randomUUID(), randomUUID()],
    );
    const before = await inventory();
    const next = await migration(9);
    expect(await applySqlMigrations(client, [next])).toEqual({
      appliedVersions: [9],
      skippedVersions: [],
    });
    expect(await inventory()).toEqual(before);
    expect(
      (
        await client.query(
          'SELECT code_digest_key_version,code_digest FROM authentication.audit_event',
        )
      ).rows,
    ).toEqual([{ code_digest_key_version: null, code_digest: null }]);
    expect(await applySqlMigrations(client, [next])).toEqual({
      appliedVersions: [],
      skippedVersions: [9],
    });
    await expect(
      applySqlMigrations(client, [{ ...next, sql: next.sql + '\n-- changed' }]),
    ).rejects.toBeInstanceOf(MigrationChecksumMismatch);
  });

  it('#240: 新しいコード監査用途と仮名の一対/32byte/操作制約を強制する', async () => {
    await apply();
    await applySqlMigrations(client, [await migration(9)]);
    const audit = (
      action: string,
      version: string | null,
      digest: Buffer | null,
    ) =>
      client.query(
        "INSERT INTO authentication.audit_event(event_id,request_id,occurred_at_ms,action,decision,reason,audit_key_version,code_digest_key_version,code_digest) VALUES($1,$2,1000,$3,'allow','success','v1',$4,$5)",
        [randomUUID(), randomUUID(), action, version, digest],
      );
    for (const action of [
      'recipient-code-issue',
      'recipient-code-revoke',
      'recipient-code-inspect',
    ])
      await audit(action, 'v1', randomBytes(32));
    for (const [action, version, digest] of [
      ['inspect', 'v1', randomBytes(32)],
      ['recipient-code-issue', null, randomBytes(32)],
      ['recipient-code-issue', 'v1', null],
      ['recipient-code-issue', 'v1', randomBytes(31)],
      ['recipient-code-issue', 'bad space', randomBytes(32)],
    ] as const)
      await expect(audit(action, version, digest)).rejects.toThrow();
  });

  it('#240: DDL/台帳失敗を全rollbackし、9のDownを拒否する', async () => {
    await apply();
    const next = await migration(9);
    await expect(
      applySqlMigrations(client, [
        { ...next, sql: next.sql + '\nSELECT synthetic_missing_column;' },
      ]),
    ).rejects.toThrow();
    expect(
      (
        await client.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema='authentication' AND table_name='audit_event' AND column_name='code_digest'",
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await client.query(
          'SELECT version FROM app_schema_migrations WHERE version=9',
        )
      ).rowCount,
    ).toBe(0);
    await applySqlMigrations(client, [next]);
    await expect(
      client.query(
        await readFile(
          new URL(
            '../migrations/authentication/0009_recipient_code_audit.down.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    ).rejects.toThrow('forward-only');
    expect(
      (
        await client.query(
          'SELECT version FROM app_schema_migrations WHERE version=9',
        )
      ).rowCount,
    ).toBe(1);
  });

  it('#240: 空DBへ1〜9を同時適用でき、code Auditの鍵や行を初期化しない', async () => {
    expect(
      (
        await applySqlMigrations(
          client,
          await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9].map(migration)),
        )
      ).appliedVersions,
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(
      (await client.query('SELECT * FROM authentication.audit_event')).rowCount,
    ).toBe(0);
    expect(
      (await client.query('SELECT * FROM authentication.key_generation'))
        .rowCount,
    ).toBe(0);
    const columns = (
      await client.query(
        "SELECT column_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='authentication' AND table_name='audit_event' AND column_name LIKE 'code_%' ORDER BY column_name",
      )
    ).rows;
    expect(columns).toEqual([
      { column_name: 'code_digest', is_nullable: 'YES', column_default: null },
      {
        column_name: 'code_digest_key_version',
        is_nullable: 'YES',
        column_default: null,
      },
    ]);
  });

  it('#240: 台帳追記故障も新Enum/列ごとrollbackする', async () => {
    await apply();
    await client.query(
      "CREATE FUNCTION reject_code_audit_migration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version=9 THEN RAISE EXCEPTION 'synthetic ledger failure'; END IF; RETURN NEW; END $$",
    );
    await client.query(
      'CREATE TRIGGER synthetic_reject9 BEFORE INSERT ON app_schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_code_audit_migration()',
    );
    await expect(
      applySqlMigrations(client, [await migration(9)]),
    ).rejects.toThrow('synthetic ledger failure');
    expect(
      (
        await client.query(
          "SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='authentication' AND t.typname='audit_action' AND e.enumlabel LIKE 'recipient-code-%'",
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await client.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema='authentication' AND table_name='audit_event' AND column_name='code_digest'",
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await client.query(
          'SELECT version FROM app_schema_migrations WHERE version=9',
        )
      ).rowCount,
    ).toBe(0);
  });
});
