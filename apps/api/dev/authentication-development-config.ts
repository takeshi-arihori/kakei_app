/** 専用開発入口だけが受け取る固定接続設定。Productionへ渡さない。 */
export interface AuthenticationDevelopmentConfig {
  /** loopback専用末尾_auth_devのDB。値を診断へ出さない。 */
  readonly databaseUrl: string;
  /** Serverと開発Browserで一致させるGoogle公開Client ID。 */
  readonly googleClientId: string;
  /** Ownerが承認した唯一のBrowser Origin。 */
  readonly origin: 'http://localhost:3000';
  /** 外部Interfaceで待受けない。 */
  readonly hostname: '127.0.0.1';
  /** Webの開発proxyと一致させる固定Port。 */
  readonly port: 3001;
}

/**
 * 環境値を暗黙変換せず、専用DBとlocalhost限定条件を検査する。
 * @param env Processから明示的に読む公開変数名の値。
 * @returns 値を検査済みの専用開発構成。
 * @throws production、loopback/DB名/固定設定/Client ID不正は値を含めず拒否する。
 */
export const readAuthenticationDevelopmentConfig = (
  env: Readonly<Record<string, string | undefined>>,
): AuthenticationDevelopmentConfig => {
  try {
    const databaseUrl = env.AUTH_DEV_DATABASE_URL;
    const googleClientId = env.GOOGLE_CLIENT_ID;
    if (
      env.NODE_ENV === 'production' ||
      !databaseUrl ||
      !googleClientId ||
      googleClientId !== googleClientId.trim() ||
      !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(googleClientId)
    )
      throw new Error();
    if (
      (env.AUTH_DEV_ORIGIN !== undefined &&
        env.AUTH_DEV_ORIGIN !== 'http://localhost:3000') ||
      (env.AUTH_DEV_HOST !== undefined && env.AUTH_DEV_HOST !== '127.0.0.1') ||
      (env.AUTH_DEV_PORT !== undefined && env.AUTH_DEV_PORT !== '3001')
    )
      throw new Error();
    const url = new URL(databaseUrl);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      !url.username ||
      !/\/[a-z][a-z0-9_]*_auth_dev$/.test(url.pathname) ||
      url.search ||
      url.hash ||
      databaseUrl !== databaseUrl.trim()
    )
      throw new Error();
    return {
      databaseUrl,
      googleClientId,
      origin: 'http://localhost:3000',
      hostname: '127.0.0.1',
      port: 3001,
    };
  } catch {
    throw new Error('開発認証の設定を確認してください');
  }
};
