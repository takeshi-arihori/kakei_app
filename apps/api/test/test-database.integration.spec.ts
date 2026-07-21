import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';

describe('test-only PostgreSQL connectivity', () => {
  const client = new Client({ connectionString: TEST_DATABASE_URL });

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it('TEMP TABLEで読み書きし、commit後にテスト用Tableを残さない', async () => {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE test_task_92_api_probe (
        id integer PRIMARY KEY,
        marker text NOT NULL
      ) ON COMMIT DROP
    `);
    await client.query(
      'INSERT INTO test_task_92_api_probe (id, marker) VALUES ($1, $2)',
      [92, 'test-only'],
    );

    const inserted = await client.query<{ marker: string }>(
      'SELECT marker FROM test_task_92_api_probe WHERE id = $1',
      [92],
    );
    expect(inserted.rows).toEqual([{ marker: 'test-only' }]);

    await client.query('COMMIT');

    const remaining = await client.query<{ relation: string | null }>(
      "SELECT to_regclass('pg_temp.test_task_92_api_probe')::text AS relation",
    );
    expect(remaining.rows[0]?.relation).toBeNull();
  });
});
