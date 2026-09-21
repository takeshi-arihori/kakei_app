import { createHash } from 'node:crypto';

import { Client } from 'pg';

export type SqlMigration = Readonly<{
  version: number;
  name: string;
  sql: string;
}>;

export type MigrationPlanViolationCode =
  'VERSION_INVALID' | 'VERSION_DUPLICATED' | 'NAME_EMPTY' | 'SQL_EMPTY';

export class MigrationPlanViolation extends Error {
  constructor(
    readonly code: MigrationPlanViolationCode,
    message: string,
  ) {
    super(message);
    this.name = 'MigrationPlanViolation';
  }
}

export class MigrationChecksumMismatch extends Error {
  constructor(readonly version: number) {
    super(`Applied migration ${version} differs from the repository source`);
    this.name = 'MigrationChecksumMismatch';
  }
}

export const validateMigrationPlan = (
  migrations: readonly SqlMigration[],
): readonly SqlMigration[] => {
  const versions = new Set<number>();

  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new MigrationPlanViolation(
        'VERSION_INVALID',
        'Migration versions must be positive safe integers',
      );
    }
    if (versions.has(migration.version)) {
      throw new MigrationPlanViolation(
        'VERSION_DUPLICATED',
        `Migration version ${migration.version} is duplicated`,
      );
    }
    if (migration.name.trim().length === 0) {
      throw new MigrationPlanViolation(
        'NAME_EMPTY',
        'Migration names must not be empty',
      );
    }
    if (migration.sql.trim().length === 0) {
      throw new MigrationPlanViolation(
        'SQL_EMPTY',
        'Migration SQL must not be empty',
      );
    }
    versions.add(migration.version);
  }

  return Object.freeze(
    [...migrations].sort((left, right) => left.version - right.version),
  );
};

export const checksumSqlMigration = (migration: SqlMigration): string =>
  createHash('sha256').update(migration.sql, 'utf8').digest('hex');

export type ApplyMigrationsResult = Readonly<{
  appliedVersions: readonly number[];
  skippedVersions: readonly number[];
}>;

export const applySqlMigrations = async (
  client: Client,
  migrations: readonly SqlMigration[],
): Promise<ApplyMigrationsResult> => {
  const plan = validateMigrationPlan(migrations);
  const appliedVersions: number[] = [];
  const skippedVersions: number[] = [];

  await client.query('BEGIN');
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_schema_migrations (
        version bigint PRIMARY KEY CHECK (version > 0),
        name text NOT NULL CHECK (length(btrim(name)) > 0),
        checksum character(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // A single writer makes the checksum decision and its DDL commit atomic.
    await client.query('LOCK TABLE app_schema_migrations IN EXCLUSIVE MODE');

    for (const migration of plan) {
      const checksum = checksumSqlMigration(migration);
      const applied = await client.query<{ checksum: string }>(
        'SELECT checksum FROM app_schema_migrations WHERE version = $1',
        [migration.version],
      );

      if (applied.rowCount !== 0) {
        if (applied.rows[0]?.checksum !== checksum) {
          throw new MigrationChecksumMismatch(migration.version);
        }
        skippedVersions.push(migration.version);
        continue;
      }

      await client.query(migration.sql);
      await client.query(
        `INSERT INTO app_schema_migrations (version, name, checksum)
         VALUES ($1, $2, $3)`,
        [migration.version, migration.name, checksum],
      );
      appliedVersions.push(migration.version);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  return Object.freeze({
    appliedVersions: Object.freeze(appliedVersions),
    skippedVersions: Object.freeze(skippedVersions),
  });
};

export const migrateWithPgClient = async (
  connectionString: string,
  migrations: readonly SqlMigration[],
): Promise<ApplyMigrationsResult> => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await applySqlMigrations(client, migrations);
  } finally {
    await client.end();
  }
};
