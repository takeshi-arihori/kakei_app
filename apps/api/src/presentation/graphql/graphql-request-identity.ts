import type { AuthenticationHttpSecurity } from '../../shared/application/authentication/authentication-http-ports.js';
import type { GraphQLAuthenticationService } from './authenticated-operation.js';

/** Cookie属性とOriginの承認済み環境。認証HTTPと同じ組合せだけを許す。 */
export type GraphQLAuthenticationProfile = 'production' | 'local-development';

/** 検証済みCompositionだけが注入する、業務GraphQLの本人性能力。 */
export interface GraphQLAuthenticationCapability {
  /** Host/Forwardedから作らない固定canonical Origin。 */
  readonly origin: string;
  /** Session Cookie名とOriginの許可範囲を決める環境。 */
  readonly profile: GraphQLAuthenticationProfile;
  /** Session leaseだけを公開する認証Service。 */
  readonly service: GraphQLAuthenticationService;
  /** requestId発行とCSRFの定数時間照合。 */
  readonly security: AuthenticationHttpSecurity;
}

/** 入力値を保持しない、本人性の前提違反。 */
export class GraphQLRequestRejection extends Error {
  /**
   * @param code 公開code。
   * @param status 実行前拒否のHTTP status。
   */
  constructor(
    readonly code: 'INVALID_REQUEST' | 'REQUEST_REJECTED',
    readonly status: 400 | 403,
  ) {
    super('GraphQL Requestを拒否しました');
  }
}

/**
 * 能力のOrigin・Profileの組合せを起動時に検証する。
 * @param capability Compositionが注入する能力。
 * @returns Profileに対応する固定のSession Cookie名。
 * @throws 認証HTTPと異なる組合せ、canonicalでないOrigin。
 */
export const verifyGraphQLCapability = (
  capability: GraphQLAuthenticationCapability,
): string => {
  const configured = new URL(capability.origin);
  if (
    configured.origin !== capability.origin ||
    configured.username ||
    configured.password ||
    (capability.profile === 'local-development'
      ? capability.origin !== 'http://localhost:3000'
      : capability.profile !== 'production' || configured.protocol !== 'https:')
  )
    throw new Error('業務GraphQLの認証設定が不正です');
  return capability.profile === 'production'
    ? '__Host-kakei-auth-session'
    : 'kakei_dev_auth_session';
};

/**
 * 全RequestにTransport前提を課す。Mutation固有の条件は実行Operationの確定後に見る。
 * @param request 未検証のRequest。
 * @param origin 照合先のcanonical Origin。能力未注入ならnull。
 * @returns Originを照合済みか（欠落ならfalse）。
 * @throws Header・Originの前提違反はREQUEST_REJECTED（403）。
 */
export const checkGraphQLRequestHeaders = (
  request: Request,
  origin: string | null,
): boolean => {
  const headers = request.headers;
  const rejected = () => new GraphQLRequestRejection('REQUEST_REJECTED', 403);
  if (headers.get('x-kakei-request') !== '1') throw rejected();
  const site = headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') throw rejected();
  const from = headers.get('origin');
  if (from === null) return false;
  if (origin === null || from !== origin) throw rejected();
  return true;
};

const cookieName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const cookieValue =
  /^(?:[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*|"[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*")$/;
/**
 * 認証HTTP（authentication-http-input.ts）と同じ規則でSession Cookieを1つだけ選ぶ。
 * 依存表上、共通GraphQLは認証HTTP Presentationを参照できないため同じ規則をここに置く。
 * URL decodeしない。
 * @param header Cookie Headerまたは不在。
 * @param name Compositionが固定したSession Cookie名。
 * @returns 未検証の秘密値。不在ならundefined。
 * @throws Header上限・制御文字・構文・選択Cookieの重複はINVALID_REQUEST（400）。
 */
export const selectGraphQLSessionCookie = (
  header: string | null,
  name: string,
): string | undefined => {
  const invalid = () => new GraphQLRequestRejection('INVALID_REQUEST', 400);
  if (header === null) return undefined;
  if (header.length > 8192 || /[^\x20-\x7e]/.test(header)) throw invalid();
  let selected: string | undefined;
  for (const segment of header.split(';')) {
    const pair = segment.trimStart();
    const separator = pair.indexOf('=');
    if (separator <= 0 || !cookieName.test(pair.slice(0, separator)))
      throw invalid();
    if (pair.slice(0, separator) !== name) continue;
    const value = pair.slice(separator + 1);
    if (!cookieValue.test(value) || selected !== undefined) throw invalid();
    selected = value;
  }
  return selected;
};
