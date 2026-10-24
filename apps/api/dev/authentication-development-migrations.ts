import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { applySqlMigrations } from '../src/group-management/infrastructure/postgres/sql-migration.js';
import { readAuthenticationDevelopmentConfig } from './authentication-development-config.js';

/**
 * Operatorの明示操作で専用開発DBに認証Migrationだけを追加する。resetは行わない。
 * @param env 専用loopback DB/Client設定。通常DB_URLからfallbackしない。
 * @throws 接続/所有名/PG17/稼働lease/Checksum/DDL障害では固定文言で拒否する。
 */
export const migrateAuthenticationDevelopmentDatabase = async (
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> => {
  const config = readAuthenticationDevelopmentConfig(env);
  const client = new Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
  });
  client.on('error', () => {
    /* 接続例外の詳細を診断へ出さない。 */
  });
  try {
    await client.connect();
    const info = (
      await client.query<{ name: string; version: string }>(
        "SELECT current_database() AS name,current_setting('server_version_num') AS version",
      )
    ).rows[0];
    if (
      !info ||
      info.name !== new URL(config.databaseUrl).pathname.slice(1) ||
      !info.name.endsWith('_auth_dev') ||
      Number(info.version) < 170000 ||
      Number(info.version) >= 180000
    )
      throw new Error();
    if (
      (
        await client.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock(1801546597,218) AS acquired',
        )
      ).rows[0]?.acquired !== true
    )
      throw new Error();
    const names = [
      '0005_authentication_schema',
      '0006_authentication_inventory',
      '0007_authentication_http_rate',
    ];
    const migrations = await Promise.all(
      names.map(async (name, index) => ({
        version: index + 5,
        name: name.slice(5).replaceAll('_', '-'),
        sql: await readFile(
          new URL(
            '../migrations/authentication/' + name + '.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      })),
    );
    await applySqlMigrations(client, migrations);
  } catch {
    throw new Error('開発認証Migrationを適用できません');
  } finally {
    await client.end().catch(() => {
      throw new Error('開発認証Migrationを適用できません');
    });
  }
};
