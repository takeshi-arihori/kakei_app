import { existsSync, readFileSync } from 'node:fs';

// シェル未指定時だけリポジトリ .env の TEST_DATABASE_URL を使う。
// 既存の環境変数は維持し、CI が渡した接続先を上書きしない。
export function repositoryTestDatabaseUrl(envFile: string): string | undefined {
  const current = process.env.TEST_DATABASE_URL;
  if (current) return current;
  if (!existsSync(envFile)) return undefined;

  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('TEST_DATABASE_URL=')) continue;
    const value = trimmed.slice('TEST_DATABASE_URL='.length).trim();
    return value.length > 0 ? value : undefined;
  }

  return undefined;
}
