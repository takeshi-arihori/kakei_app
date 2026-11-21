import { configDefaults, defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { repositoryTestDatabaseUrl } from './test/support/repository-test-database-url.js';

const testDatabaseUrl = repositoryTestDatabaseUrl(
  fileURLToPath(new URL('../../.env', import.meta.url)),
);

export default defineConfig({
  resolve: {
    // Nodeの実行時と同じくgraphqlをCJS版1つへ解決し、Yogaと別realmのSchema/ASTを作らない。
    alias: [
      {
        find: /^graphql$/,
        replacement: createRequire(import.meta.url).resolve('graphql'),
      },
    ],
  },
  test: {
    env: testDatabaseUrl ? { TEST_DATABASE_URL: testDatabaseUrl } : {},
    // 大きな境界Fixture追加後もCPUを過剰共有せず、既存の全組合せTestを飢餓させない。
    maxWorkers: 2,
    // 実DB Suiteは共有advisory lockで直列化するため、先行Suite終了を待てる上限にする。
    hookTimeout: 60_000,
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
});
