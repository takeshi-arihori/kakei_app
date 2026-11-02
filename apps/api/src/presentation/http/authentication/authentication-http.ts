import type {
  AuthenticationHttpRate,
  AuthenticationHttpSecurity,
  AuthenticationHttpOperation,
} from '../../../shared/application/authentication/authentication-http-ports.js';
import type { AuthenticationClock } from '../../../shared/application/authentication/authentication-ports.js';
import type { GoogleAuthenticationService } from '../../../shared/application/authentication/google-authentication-service.js';
import {
  AuthenticationHttpInputError,
  authenticationCookieSecrets,
  authenticationJsonObject,
  checkAuthenticationRequest,
} from './authentication-http-input.js';

/** Cookie属性とOriginの承認済み環境。設定Flagから自動fallbackしない。 */
export type AuthenticationHttpProfile = 'production' | 'local-development';
/** HTTP Adapterが利用する内部認証の最小能力。DB/SDKを公開しない。 */
export type AuthenticationHttpService = Pick<
  GoogleAuthenticationService,
  | 'beginGoogleLogin'
  | 'completeGoogleLogin'
  | 'withAuthenticatedActor'
  | 'logoutCurrentSession'
>;
/**
 * Transport前提と公開結果を所有する。PeerはNode接続からのみ受け取る。
 * @param request 未検証のBrowser Request。
 * @param peer 接続socketのremoteAddress。不在時は認証を実行しない。
 * @returns Cookie/診断を制限したHTTP Response。
 */
export type AuthenticationHttpHandler = (
  request: Request,
  peer: string | null,
) => Promise<Response>;

const secret = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
const paths: Readonly<Record<string, AuthenticationHttpOperation>> = {
  '/auth/google/attempt': 'attempt',
  '/auth/google/login': 'login',
  '/auth/session': 'session',
  '/auth/logout': 'logout',
};
const codes: Readonly<Record<number, string>> = {
  400: 'INVALID_REQUEST',
  401: 'AUTHENTICATION_REQUIRED',
  403: 'REQUEST_REJECTED',
  405: 'INVALID_REQUEST',
  409: 'LOGIN_RESTART_REQUIRED',
  413: 'INVALID_REQUEST',
  415: 'INVALID_REQUEST',
  429: 'RATE_LIMITED',
  503: 'AUTHENTICATION_UNAVAILABLE',
};

/**
 * 承認済みの4操作をApplicationへ接続し、失敗から内部診断を除去する。
 * @param options Compositionが検証した環境と必須能力。
 * @returns Node接続Peerを別引数で受けるHTTP能力。
 * @throws Origin/Profileの矛盾は起動時に拒否する。
 */
export const createAuthenticationHttp = (
  options: Readonly<{
    /** 公開操作を内部認証へ写像する能力。 */ service: AuthenticationHttpService;
    /** 全instanceで共有する独立予約能力。 */ rate: AuthenticationHttpRate;
    /** Server requestIdと定数時間秘密照合。 */ security: AuthenticationHttpSecurity;
    /** Host/Forwardedから作らない固定canonical Origin。 */ origin: string;
    /** localhost例外の適用範囲。 */ profile: AuthenticationHttpProfile;
    /** 保存期限を延ばさない返却時刻判断。 */ clock: AuthenticationClock;
  }>,
): AuthenticationHttpHandler => {
  const configured = new URL(options.origin);
  if (
    configured.origin !== options.origin ||
    configured.username ||
    configured.password ||
    (options.profile === 'local-development'
      ? options.origin !== 'http://localhost:3000'
      : options.profile !== 'production' || configured.protocol !== 'https:')
  )
    throw new Error('認証HTTPの設定が不正です');
  const secure = options.profile === 'production';
  const names = {
    attempt: secure ? '__Host-kakei-auth-attempt' : 'kakei_dev_auth_attempt',
    session: secure ? '__Host-kakei-auth-session' : 'kakei_dev_auth_session',
  };
  const attributes = `; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const erase = (name: string) =>
    `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${attributes}`;
  const issue = (
    name: string,
    value: string,
    expiresAt: number,
    maximum: number,
  ) => {
    const now = options.clock.now();
    if (
      !secret(value) ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(expiresAt) ||
      // 秒へ切り捨てた後も正の寿命が必要。0秒Cookieを成功として発行しない。
      expiresAt - now < 1000 ||
      expiresAt - now > maximum
    )
      throw new Error('認証Cookieを発行できません');
    return `${name}=${value}; Max-Age=${Math.floor((expiresAt - now) / 1000)}${attributes}`;
  };
  return async (request, peer) => {
    const requestId = options.security.createRequestId();
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const json = (body: string, status: number) => {
      headers.set('Content-Type', 'application/json');
      return new Response(body, { status, headers });
    };
    const fail = (status: number) =>
      json(
        JSON.stringify({ error: { code: codes[status], requestId } }),
        status,
      );
    const empty = () => new Response(null, { status: 204, headers });
    try {
      const operation = paths[new URL(request.url).pathname];
      if (!operation) return fail(400);
      const method = operation === 'session' ? 'GET' : 'POST';
      if (request.method !== method) {
        headers.set('Allow', method);
        return fail(405);
      }
      checkAuthenticationRequest(request, options.origin, method);
      const cookies = authenticationCookieSecrets(
        request.headers.get('cookie'),
        names,
      );
      const body =
        method === 'POST'
          ? await authenticationJsonObject(
              request,
              operation === 'login' ? ['credential'] : [],
            )
          : undefined;
      const csrf = request.headers.get('x-csrf-token');
      if (operation === 'login' && !secret(csrf)) return fail(403);
      if (
        operation === 'login' &&
        (!body ||
          body.credential.length < 1 ||
          body.credential.length > 16384 ||
          Array.from(body.credential).some((char) => char.charCodeAt(0) > 127))
      )
        return fail(400);
      if (!peer) return fail(503);
      const reservation = await options.rate.reserve(operation, peer);
      if (reservation.status === 'limited') {
        if (
          !Number.isSafeInteger(reservation.retryAfterSeconds) ||
          reservation.retryAfterSeconds < 1
        )
          return fail(503);
        headers.set('Retry-After', String(reservation.retryAfterSeconds));
        return fail(429);
      }
      if (reservation.status !== 'allowed') return fail(503);
      if (operation === 'attempt') {
        const result = await options.service.beginGoogleLogin({
          previousAttemptSecret: cookies.attemptSecret,
          currentSessionSecret: cookies.sessionSecret,
        });
        if (result.status === 'already-authenticated') return fail(409);
        if (result.status !== 'started') return fail(503);
        if (!secret(result.nonce) || !secret(result.csrf)) return fail(503);
        const cookie = issue(
          names.attempt,
          result.attemptSecret,
          result.expiresAt,
          300_000,
        );
        headers.append('Set-Cookie', cookie);
        return json(
          JSON.stringify({
            nonce: result.nonce,
            csrfToken: result.csrf,
            expiresAt: result.expiresAt,
          }),
          201,
        );
      }
      if (operation === 'login') {
        const result = await options.service.completeGoogleLogin({
          credential: body!.credential,
          attemptSecret: cookies.attemptSecret,
          csrf,
          currentSessionSecret: cookies.sessionSecret,
        });
        if (result.status === 'already-authenticated') return fail(409);
        if (result.status === 'invalid-credential') return fail(401);
        if (result.status === 'restart-required') {
          headers.append('Set-Cookie', erase(names.attempt));
          return fail(409);
        }
        if (result.status !== 'authenticated') return fail(503);
        const cookie = issue(
          names.session,
          result.sessionSecret,
          result.absoluteExpiresAt,
          604_800_000,
        );
        headers.append('Set-Cookie', cookie);
        headers.append('Set-Cookie', erase(names.attempt));
        return empty();
      }
      if (operation === 'session') {
        const result = await options.service.withAuthenticatedActor(
          cookies.sessionSecret,
          'inspect',
          (actor, scope) =>
            Promise.resolve(
              scope.serialize({
                authenticated: true,
                csrfToken: actor.csrf,
                expiresAt: actor.absoluteExpiresAt,
              }),
            ),
        );
        if (result.status === 'unavailable') return fail(503);
        if (result.status === 'unauthenticated') {
          headers.append('Set-Cookie', erase(names.session));
          return fail(401);
        }
        return json(result.value.body, 200);
      }
      const inspected = await options.service.withAuthenticatedActor(
        cookies.sessionSecret,
        'inspect',
        (actor, scope) =>
          Promise.resolve(
            scope.serialize({
              csrfMatches:
                secret(csrf) && options.security.equalSecrets(actor.csrf, csrf),
            }),
          ),
      );
      if (inspected.status === 'unavailable') return fail(503);
      if (inspected.status === 'authenticated') {
        if (inspected.value.body !== '{"csrfMatches":true}') return fail(403);
        const result = await options.service.logoutCurrentSession(
          cookies.sessionSecret,
        );
        if (result.status !== 'logged-out') return fail(503);
      }
      headers.append('Set-Cookie', erase(names.session));
      return empty();
    } catch (error) {
      // Cookie設定前に全成功値を検証する。結果不明/例外では削除も発行も行わない。
      headers.delete('Set-Cookie');
      return fail(
        error instanceof AuthenticationHttpInputError ? error.status : 503,
      );
    }
  };
};
