import 'server-only';
import { MY_GROUPS_DOCUMENT } from './operations';
import { parseMyGroups, readGroupGraphQLResponse, type GroupGraphQLResult, type MyGroupList } from './group-graphql-response';

// 開発用Compositionの固定名（#304 §3）。Productionの`__Host-`名はProduction Gateまで扱わない。
const sessionCookieName = 'kakei_dev_auth_session';
// RFC 6265のcookie-octet。CTL・空白・`"`・`,`・`;`・`\`を含む値は転送しない。
const cookieValue = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/;

type SessionCookie = Readonly<{ status: 'found'; value: string }> | Readonly<{ status: 'absent' }> | Readonly<{ status: 'invalid' }>;

const selectSessionCookie = (header: string | null): SessionCookie => {
  const values: string[] = [];
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== sessionCookieName) continue;
    values.push(part.slice(separator + 1).trim());
  }
  if (values.length === 0) return { status: 'absent' };
  // 重複は本人性を一意に決められないため、APIへ渡して選ばせず取得不能にする。
  if (values.length > 1 || !cookieValue.test(values[0])) return { status: 'invalid' };
  return { status: 'found', value: values[0] };
};

/** 一覧取得の実行条件。Testだけが差し替える。 */
export interface LoadMyGroupsOptions {
  /** 実行Mode。`development`以外はAPIへ接続しない。省略時は`process.env.NODE_ENV`。 */
  readonly mode?: string;
  /** Server間通信の境界。省略時はRuntimeの`fetch`。 */
  readonly fetcher?: typeof fetch;
}

/**
 * Server Componentから`myGroups`だけをAPIへServer間で送る（#304 §4）。
 * 受信Requestの開発Session Cookie 1つだけを転送し、`X-Kakei-Request: 1`とJSONを付け、Originは付けない。
 * @param cookieHeader 受信RequestのCookie Header。値をLog・応答へ出さない。
 * @param options 実行Modeと通信境界。
 * @returns 検査済みの一覧。Cookieなしは送信せず`authentication-required`、Cookie重複・形式不正・development以外・接続障害・契約外応答は`unavailable`。
 */
export const loadMyGroups = async (cookieHeader: string | null, options: LoadMyGroupsOptions = {}): Promise<GroupGraphQLResult<MyGroupList>> => {
  const mode = 'mode' in options ? options.mode : process.env.NODE_ENV;
  if (mode !== 'development') return { status: 'unavailable' };
  const cookie = selectSessionCookie(cookieHeader);
  if (cookie.status === 'absent') return { status: 'authentication-required' };
  if (cookie.status === 'invalid') return { status: 'unavailable' };
  try {
    const response = await (options.fetcher ?? fetch)('http://127.0.0.1:3001/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kakei-Request': '1', Cookie: `${sessionCookieName}=${cookie.value}` },
      body: JSON.stringify({ query: MY_GROUPS_DOCUMENT, operationName: 'MyGroups' }),
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    return await readGroupGraphQLResponse(response, parseMyGroups);
  } catch {
    return { status: 'unavailable' };
  }
};
