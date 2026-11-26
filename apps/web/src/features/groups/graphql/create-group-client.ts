import { CREATE_GROUP_DOCUMENT } from './operations';
import { parseCreateGroup, readGroupGraphQLResponse, type CreatedGroup, type GroupGraphQLResult } from './group-graphql-response';

/** BrowserからGroup作成Mutationを送る能力。Cookieには触れない。 */
export interface CreateGroupClient {
  /**
   * 同一Originの`/graphql`へ`createGroup`を1回送る。
   * @param operationId 作成の1回の意図ごとの小文字UUIDv4。結果不明の再送では同じ値を使う。
   * @param csrfToken `/auth/session`が返したSession束縛のCSRF Token。表示・保存しない。
   * @returns 作成された`groupId`、または失敗の分類。通信断・想定外応答は`unavailable`。
   */
  createGroup(operationId: string, csrfToken: string): Promise<GroupGraphQLResult<CreatedGroup>>;
}

/**
 * Browserが付けるOrigin・Cookieをそのまま使う、同一Origin`/graphql`のClientを作る（#304 §4）。
 * @param fetcher 通信境界。既定はBrowserの`fetch`、Testだけが差し替える。
 * @returns 例外の診断を外へ出さないGroup作成Client。
 */
export const createGroupClient = (fetcher: typeof fetch = fetch): CreateGroupClient => ({
  createGroup: async (operationId, csrfToken) => {
    try {
      const response = await fetcher('/graphql', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json', 'X-Kakei-Request': '1', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ query: CREATE_GROUP_DOCUMENT, operationName: 'CreateGroup', variables: { input: { operationId } } }),
      });
      return await readGroupGraphQLResponse(response, parseCreateGroup);
    } catch {
      return { status: 'unavailable' };
    }
  },
});
