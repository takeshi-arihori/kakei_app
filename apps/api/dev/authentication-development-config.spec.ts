import { describe, expect, it } from 'vitest';
import { readAuthenticationDevelopmentConfig } from './authentication-development-config.js';
const valid = {
  NODE_ENV: 'development',
  AUTH_DEV_DATABASE_URL:
    'postgresql://synthetic:fixture@127.0.0.1:55432/synthetic_auth_dev',
  GOOGLE_CLIENT_ID: 'synthetic-client.apps.googleusercontent.com',
};
describe('専用開発認証の起動条件', () => {
  it('固定localhost Origin/listenと専用DBだけを返す', () => {
    expect(readAuthenticationDevelopmentConfig(valid)).toEqual({
      databaseUrl: valid.AUTH_DEV_DATABASE_URL,
      googleClientId: valid.GOOGLE_CLIENT_ID,
      origin: 'http://localhost:3000',
      hostname: '127.0.0.1',
      port: 3001,
    });
  });
  it.each([
    { NODE_ENV: 'production' },
    { AUTH_DEV_ORIGIN: 'http://127.0.0.1:3000' },
    { AUTH_DEV_HOST: '0.0.0.0' },
    { AUTH_DEV_PORT: '3002' },
    { GOOGLE_CLIENT_ID: '' },
    {
      AUTH_DEV_DATABASE_URL:
        'postgresql://synthetic:fixture@remote.example.test/synthetic_auth_dev',
    },
    {
      AUTH_DEV_DATABASE_URL:
        'postgresql://synthetic:fixture@127.0.0.1/real_data',
    },
    {
      AUTH_DEV_DATABASE_URL:
        'postgresql://synthetic:fixture@127.0.0.1/synthetic_auth_dev?host=remote.example.test',
    },
    {
      AUTH_DEV_DATABASE_URL:
        'postgresql://synthetic:fixture@127.0.0.1/synthetic_auth_dev#private',
    },
  ])('拒否した設定値を例外へ複製せず起動を止める: %o', (extra) => {
    expect(() =>
      readAuthenticationDevelopmentConfig({ ...valid, ...extra }),
    ).toThrow('開発認証の設定を確認してください');
  });
});
