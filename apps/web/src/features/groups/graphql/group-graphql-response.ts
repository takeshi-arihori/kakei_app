import type { CreateGroupMutation, GroupLifecycle, GroupRole, MyGroupsQuery } from '../../../shared/graphql/generated';

/** 自分のGroup一覧の検査済みの値。 */
export type MyGroupList = MyGroupsQuery['myGroups'];
/** 一覧の1行。Group名等の表示属性は持たない（#305）。 */
export type MyGroupSummary = MyGroupList['items'][number];
/** 作成結果。`groupId`だけを返す（#305 §1）。 */
export type CreatedGroup = CreateGroupMutation['createGroup'];

/**
 * 画面が扱い方を変える失敗の分類。
 * - `authentication-required`: ログイン導線へ移す。
 * - `rejected`: Origin・CSRF・Request形式で実行されなかった確定Error。
 * - `invalid-input`／`operation-mismatch`: 入力または操作IDの確定Error。
 * - `unavailable`: 結果不明・障害・想定外の応答。Mutationは同じ操作IDで再送できる。
 */
export type GroupGraphQLFailure = 'authentication-required' | 'rejected' | 'invalid-input' | 'operation-mismatch' | 'unavailable';

/** 診断・生本文を含まないGroup GraphQLの結果。 */
export type GroupGraphQLResult<T> =
  | Readonly<{ /** 契約どおりの応答。 */ status: 'ok'; /** 検査済みの値。 */ value: T }>
  | Readonly<{ /** 失敗の分類。 */ status: GroupGraphQLFailure }>;

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value);
// APIはRFC 3339 UTC（ミリ秒）で返す（#305 §2）。存在しない日付はDateの往復で除く。
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
// 生成型のunionを網羅するRecordにし、Schemaの値の追加・削除をtypecheckで検出する。
const lifecycles: Readonly<Record<GroupLifecycle, true>> = { ACTIVE: true, CLOSING: true, CANCELING: true, ARCHIVED: true };
const roles: Readonly<Record<GroupRole, true>> = { OWNER: true, PARTICIPANT: true };
const isLifecycle = (value: unknown): value is GroupLifecycle => typeof value === 'string' && Object.hasOwn(lifecycles, value);
const isRole = (value: unknown): value is GroupRole => typeof value === 'string' && Object.hasOwn(roles, value);
const codes: Readonly<Record<string, GroupGraphQLFailure>> = {
  AUTHENTICATION_REQUIRED: 'authentication-required',
  REQUEST_REJECTED: 'rejected',
  INVALID_REQUEST: 'rejected',
  INVALID_INPUT: 'invalid-input',
  OPERATION_MISMATCH: 'operation-mismatch',
};

const summary = (value: unknown): MyGroupSummary | undefined => {
  if (!record(value)) return undefined;
  const { groupId, lifecycle, myRole, activeParticipantCount, createdAt, joinedAt, deleteEligibleAt } = value;
  if (!identifier(groupId) || !isLifecycle(lifecycle) || !isRole(myRole)) return undefined;
  if (typeof activeParticipantCount !== 'number' || !Number.isSafeInteger(activeParticipantCount) || activeParticipantCount < 0) return undefined;
  if (!timestamp(createdAt) || !timestamp(joinedAt) || !(deleteEligibleAt === null || timestamp(deleteEligibleAt))) return undefined;
  return { groupId, lifecycle, myRole, activeParticipantCount, createdAt, joinedAt, deleteEligibleAt };
};

/**
 * `myGroups`の`data`を契約どおりの値へ検査する。
 * @param data GraphQL応答の`data`。未検証。
 * @returns 最大50件の検査済み一覧。形・件数・enum・時刻のどれかが契約外ならundefined。
 */
export const parseMyGroups = (data: unknown): MyGroupList | undefined => {
  if (!record(data) || !record(data.myGroups)) return undefined;
  const { items, hasMore } = data.myGroups;
  if (!Array.isArray(items) || items.length > 50 || typeof hasMore !== 'boolean') return undefined;
  const parsed = items.map(summary);
  return parsed.every((item): item is MyGroupSummary => item !== undefined) ? { items: parsed, hasMore } : undefined;
};

/**
 * `createGroup`の`data`を検査する。
 * @param data GraphQL応答の`data`。未検証。
 * @returns 作成されたGroupの`groupId`。契約外ならundefined。
 */
export const parseCreateGroup = (data: unknown): CreatedGroup | undefined =>
  record(data) && record(data.createGroup) && identifier(data.createGroup.groupId) ? { groupId: data.createGroup.groupId } : undefined;

/**
 * 業務GraphQLの応答を、公開Error code（#304 §5）だけに基づいて分類する。
 * @param response APIまたは同一Origin転送の応答。Bodyを1回だけ読む。
 * @param parse 成功時の`data`を検査する関数。
 * @returns 検査済みの値、または失敗の分類。JSON以外・形式不正・HTTP失敗でErrorなしは`unavailable`。
 */
export const readGroupGraphQLResponse = async <T>(response: Response, parse: (data: unknown) => T | undefined): Promise<GroupGraphQLResult<T>> => {
  const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json' && mediaType !== 'application/graphql-response+json') return { status: 'unavailable' };
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: 'unavailable' };
  }
  if (!record(payload)) return { status: 'unavailable' };
  if ('errors' in payload) {
    const { errors } = payload;
    if (!Array.isArray(errors) || errors.length === 0) return { status: 'unavailable' };
    const first: unknown = errors[0];
    const code = record(first) && record(first.extensions) ? first.extensions.code : undefined;
    // Prototype名（`constructor`・`__proto__`等）を分類へ混ぜないよう、自身のKeyだけを引く。
    return { status: typeof code === 'string' && Object.hasOwn(codes, code) ? codes[code] : 'unavailable' };
  }
  if (response.status !== 200) return { status: 'unavailable' };
  const value = parse(payload.data);
  return value === undefined ? { status: 'unavailable' } : { status: 'ok', value };
};
