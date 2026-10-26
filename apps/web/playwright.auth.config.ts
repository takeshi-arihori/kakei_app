import { defineConfig, devices } from '@playwright/test';
/** 認証だけを固定localhost開発OriginとTest所有API/PGで検証する。 */
export default defineConfig({testDir:'./e2e-auth',testMatch:'**/*.e2e.ts',retries:0,workers:1,timeout:45_000,reporter:'list',use:{baseURL:'http://localhost:3000',trace:'off'},projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],webServer:{command:'pnpm dev --port 3000',url:'http://localhost:3000/login',reuseExistingServer:false,timeout:60_000,env:{NEXT_PUBLIC_GOOGLE_CLIENT_ID:'synthetic-browser.apps.googleusercontent.com'}}});
