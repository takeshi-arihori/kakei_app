import { describe, expect, it } from 'vitest';

import {
  MigrationPlanViolation,
  checksumSqlMigration,
  validateMigrationPlan,
  type SqlMigration,
} from './sql-migration.js';

const migration = (
  version: number,
  sql = `CREATE TABLE example_${version} (id uuid PRIMARY KEY)`,
): SqlMigration => ({
  version,
  name: `example-${version}`,
  sql,
});

describe('SQL migration plan', () => {
  it('version順へ正規化し、同じSQLのchecksumを安定して返す', () => {
    expect(validateMigrationPlan([migration(2), migration(1)])).toEqual([
      migration(1),
      migration(2),
    ]);

    expect(checksumSqlMigration(migration(1))).toBe(
      checksumSqlMigration(migration(1)),
    );
    expect(checksumSqlMigration(migration(1))).not.toBe(
      checksumSqlMigration(migration(1, 'SELECT 1')),
    );
  });

  it.each([
    {
      migrations: [migration(0)],
      code: 'VERSION_INVALID',
    },
    {
      migrations: [migration(1), migration(1, 'SELECT 1')],
      code: 'VERSION_DUPLICATED',
    },
    {
      migrations: [{ ...migration(1), name: '   ' }],
      code: 'NAME_EMPTY',
    },
    {
      migrations: [{ ...migration(1), sql: '   ' }],
      code: 'SQL_EMPTY',
    },
  ] as const)(
    '不正なMigration planを拒否する: $code',
    ({ migrations, code }) => {
      expect(() => validateMigrationPlan(migrations)).toThrow(
        expect.objectContaining<Partial<MigrationPlanViolation>>({ code }),
      );
    },
  );
});
