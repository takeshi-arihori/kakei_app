/** inspectで得た現在Sessionの公開情報。秘密はメモリ内だけに保持する。 */
export interface AuthenticationSession {
  /** 同Sessionのlogoutにだけ使い、表示・永続保存しない。 */ readonly csrfToken: string;
  /** Serverの絶対期限。表示やinspectで延長しない。 */ readonly expiresAt: number;
}
/** beginで得た試行。Browserは期待nonceを独自生成しない。 */
export interface AuthenticationAttempt extends AuthenticationSession {
  /** Googleへの一回の初期化だけに渡すServer発行値。 */ readonly nonce: string;
}
/** 診断や生本文を外へ出さないTransport結果。 */
export type AuthenticationResult<T> =
  | Readonly<{/** 妥当な期待応答。 */ status: 'ok'; /** 検査済みの最小値。 */ value: T}>
  | Readonly<{/** 明示された未認証/再開始/拒否/結果不明。 */ status: 'required' | 'restart' | 'rejected' | 'unavailable'}>
  | Readonly<{/** 明示再試行を待つ。 */ status: 'limited'; /** Retry-Afterから算出した待機期限。 */ retryAt: number}>;
/** 同一OriginのA5操作だけを公開するClient。Cookieには触れない。 */
export interface AuthenticationClient {
  /** @returns 非延長inspectの検査済み応答または失敗。 */ inspect(): Promise<AuthenticationResult<AuthenticationSession>>;
  /** @returns 新しい試行のServer値または失敗。 */ begin(): Promise<AuthenticationResult<AuthenticationAttempt>>;
  /**
   * @param credential Google callbackの一回限りの値。保存しない。
   * @param csrf 当試行のServer発行CSRF。
   * @returns 確認済204または失敗。結果不明でもrollbackと断定しない。
   */
  login(credential: string, csrf: string): Promise<AuthenticationResult<null>>;
  /**
   * @param csrf 現在SessionのServer発行CSRF。
   * @returns 確認済204または失敗。障害でCookieを消さない。
   */
  logout(csrf: string): Promise<AuthenticationResult<null>>;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value: Record<string,unknown>, expected: string[]) => Object.keys(value).sort().join(',') === expected.sort().join(',');
const secret = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const session = (value: unknown): value is AuthenticationSession => record(value) && secret(value.csrfToken) && time(value.expiresAt);
const unavailable = (): AuthenticationResult<never> => ({status:'unavailable'});
const readJson = async (response: Response): Promise<unknown> => {
  if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return null;
  return response.json();
};
const failure = async (response: Response): Promise<AuthenticationResult<never>> => {
  const body = await readJson(response);
  if (!record(body) || !keys(body,['error']) || !record(body.error) || !keys(body.error,['code','requestId']) || typeof body.error.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.error.requestId)) return unavailable();
  const code = body.error.code;
  if (response.status===401 && code==='AUTHENTICATION_REQUIRED') return {status:'required'};
  if (response.status===409 && code==='LOGIN_RESTART_REQUIRED') return {status:'restart'};
  if (response.status===403 && code==='REQUEST_REJECTED') return {status:'rejected'};
  if (response.status===429 && code==='RATE_LIMITED') {
    const retry=response.headers.get('retry-after');
    if (retry && /^[1-9][0-9]{0,3}$/.test(retry) && Number(retry)<=3600) return {status:'limited',retryAt:Date.now()+Number(retry)*1000};
  }
  return unavailable();
};
/**
 * BrowserがOrigin/Cookieを管理する相対4操作へ接続する。
 * @param fetcher 通信境界。既定はBrowser fetch、Testはこの境界だけを差し替える。
 * @returns Header/Body/応答を制限した認証Client。例外の診断は伝播しない。
 */
export const createAuthenticationClient = (fetcher: typeof fetch = fetch): AuthenticationClient => {
  const request = async <T>(path: string, status: number, parse: (body: unknown) => T | undefined, body?: Record<string,string>, csrf?: string): Promise<AuthenticationResult<T>> => {
    try {
      const response = await fetcher(path,{method:body?'POST':'GET', credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(30_000),headers:{'X-Kakei-Request':'1',...(body?{'Content-Type':'application/json'}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});
      if (response.status!==status) return await failure(response);
      const value = parse(status===204?null:await readJson(response));
      return value === undefined ? unavailable() : {status:'ok',value};
    } catch { return unavailable(); }
  };
  return {
    inspect: () => request('/auth/session',200,body => record(body) && keys(body,['authenticated','csrfToken','expiresAt']) && body.authenticated===true && session(body) ? {csrfToken:body.csrfToken,expiresAt:body.expiresAt} : undefined),
    begin: () => request('/auth/google/attempt',201,body => record(body) && keys(body,['nonce','csrfToken','expiresAt']) && session(body) && secret(body.nonce) ? {nonce:body.nonce,csrfToken:body.csrfToken,expiresAt:body.expiresAt} : undefined,{}),
    login: (credential,csrf) => typeof credential==='string' && credential.length>0 && credential.length<=16384 && /^[\x21-\x7e]+$/.test(credential) && secret(csrf) ? request('/auth/google/login',204,() => null,{credential},csrf) : Promise.resolve(unavailable()),
    logout: csrf => secret(csrf) ? request('/auth/logout',204,() => null,{},csrf) : Promise.resolve(unavailable()),
  };
};
