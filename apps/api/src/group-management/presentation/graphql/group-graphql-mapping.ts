import {
  GroupLifecycle,
  GroupRole,
  type CreateGroupResult,
  type MyGroupList as MyGroupListOutput,
  type MyGroupSummary as MyGroupSummaryOutput,
} from '../../../presentation/graphql/generated/resolvers.js';
import type { GroupCreatedResult } from '../../application/group-repository.js';
import type {
  MyGroupLifecycle,
  MyGroupList,
  MyGroupRole,
  MyGroupSummary,
} from '../../application/use-cases/list-my-groups.js';

const canonicalUuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * `operationId`が小文字canonicalのUUIDv4か（#305 §1）。Clientの`crypto.randomUUID()`の形だけを受ける。
 * @param value GraphQLの`ID`として受けた未検証値。
 * @returns 形式が正しければtrue。
 */
export const isCanonicalOperationId = (value: string): boolean =>
  canonicalUuidV4.test(value);

const lifecycles: Readonly<Record<MyGroupLifecycle, GroupLifecycle>> =
  Object.freeze({
    Active: GroupLifecycle.Active,
    Closing: GroupLifecycle.Closing,
    Canceling: GroupLifecycle.Canceling,
    Archived: GroupLifecycle.Archived,
  });
const roles: Readonly<Record<MyGroupRole, GroupRole>> = Object.freeze({
  Owner: GroupRole.Owner,
  Participant: GroupRole.Participant,
});

/** Use Caseの値を許可した写像だけで変換する。未知の値は一覧全体の失敗にする。 */
const mapped = <K extends string, V>(
  table: Readonly<Record<K, V>>,
  key: K,
): V => {
  if (!Object.hasOwn(table, key))
    throw new Error('Group一覧の値を公開形へ写像できません');
  return table[key];
};

const toSummary = (summary: MyGroupSummary): MyGroupSummaryOutput => ({
  groupId: summary.groupId.value,
  lifecycle: mapped(lifecycles, summary.lifecycle),
  myRole: mapped(roles, summary.myRole),
  activeParticipantCount: summary.activeParticipantCount,
  createdAt: summary.createdAt.value,
  joinedAt: summary.joinedAt.value,
  deleteEligibleAt: summary.deleteEligibleAt?.value ?? null,
});

/**
 * 自分のGroup一覧をSDLの形へ写像する（#305 §2）。並び・件数・`hasMore`はUse Caseの結果を保つ。
 * 時刻は`UtcInstant`のRFC 3339 UTC（ミリ秒）表記をそのまま使う。
 * @param list Use Caseの結果。
 * @returns 表示属性・ParticipantIdを含まない公開形。
 * @throws 写像表にない値（一部だけ返さないため呼出し側でmaskする）。
 */
export const toMyGroupListOutput = (list: MyGroupList): MyGroupListOutput => ({
  items: list.items.map(toSummary),
  hasMore: list.hasMore,
});

/**
 * Group作成の結果を公開形へ写像する（#305 §1）。`participantId`と`version`は返さない。
 * @param result Use Caseの結果。
 * @returns `groupId`だけの公開形。
 */
export const toCreateGroupOutput = (
  result: GroupCreatedResult,
): CreateGroupResult => ({ groupId: result.groupId.value });
