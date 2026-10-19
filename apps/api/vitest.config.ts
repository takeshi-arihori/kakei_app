import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 大きな境界Fixture追加後もCPUを過剰共有せず、既存の全組合せTestを飢餓させない。
    maxWorkers: 2,
    // 実DB Suiteは共有advisory lockで直列化するため、先行Suite終了を待てる上限にする。
    hookTimeout: 60_000,
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
});
