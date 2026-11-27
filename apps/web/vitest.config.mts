import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Next.jsはServer Component Buildで`server-only`を空Moduleへ、Client Buildでは例外Moduleへ解決する。
 * VitestはServer側の単体検証なので、Next.jsのServer側と同じ空Moduleへ解決する。
 */
export default defineConfig({
  resolve: {
    alias: {
      'server-only': fileURLToPath(import.meta.resolve('next/dist/compiled/server-only/empty.js')),
    },
  },
});
