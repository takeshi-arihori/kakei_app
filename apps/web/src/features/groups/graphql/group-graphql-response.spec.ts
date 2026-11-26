import { describe, expect, it } from 'vitest';
import { parseCreateGroup, parseMyGroups, readGroupGraphQLResponse } from './group-graphql-response';

const summary = {
  groupId: 'synthetic-group-1',
  lifecycle: 'ACTIVE',
  myRole: 'OWNER',
  activeParticipantCount: 1,
  createdAt: '2026-11-20T01:02:03.004Z',
  joinedAt: '2026-11-20T01:02:03.004Z',
  deleteEligibleAt: null,
};
const myGroups = (value: unknown) => ({ myGroups: value });
const publicError = (code: string, status = 200) =>
  Response.json(
    { errors: [{ message: '固定文', extensions: { code, requestId: '00000000-0000-4000-8000-000000000001' } }] },
    { status },
  );

describe('Group GraphQL応答の検査', () => {
  it('契約どおりのmyGroupsを生成型の値として受け入れる', async () => {
    const archived = { ...summary, groupId: 'synthetic-group-2', lifecycle: 'ARCHIVED', myRole: 'OWNER', activeParticipantCount: 0, deleteEligibleAt: '2027-11-20T00:00:00.000Z' };
    const result = await readGroupGraphQLResponse(Response.json({ data: myGroups({ items: [summary, archived], hasMore: true }) }), parseMyGroups);
    expect(result).toEqual({ status: 'ok', value: { items: [summary, archived], hasMore: true } });
  });

  it('空の一覧をErrorにしない', async () => {
    expect(await readGroupGraphQLResponse(Response.json({ data: myGroups({ items: [], hasMore: false }) }), parseMyGroups)).toEqual({ status: 'ok', value: { items: [], hasMore: false } });
  });

  it('GraphQL応答のmedia typeも受け入れる', async () => {
    const response = new Response(JSON.stringify({ data: { createGroup: { groupId: 'synthetic-group' } } }), { headers: { 'Content-Type': 'application/graphql-response+json; charset=utf-8' } });
    expect(await readGroupGraphQLResponse(response, parseCreateGroup)).toEqual({ status: 'ok', value: { groupId: 'synthetic-group' } });
  });

  it.each([
    ['AUTHENTICATION_REQUIRED', 200, 'authentication-required'],
    ['REQUEST_REJECTED', 403, 'rejected'],
    ['REQUEST_REJECTED', 200, 'rejected'],
    ['INVALID_REQUEST', 400, 'rejected'],
    ['INVALID_INPUT', 200, 'invalid-input'],
    ['OPERATION_MISMATCH', 200, 'operation-mismatch'],
    ['SERVICE_UNAVAILABLE', 200, 'unavailable'],
    ['SERVICE_UNAVAILABLE', 503, 'unavailable'],
    ['NOT_FOUND', 200, 'unavailable'],
    ['UNKNOWN_CODE', 200, 'unavailable'],
    ['constructor', 200, 'unavailable'],
    ['__proto__', 200, 'unavailable'],
    ['toString', 200, 'unavailable'],
  ] as const)('公開Error %s（HTTP %i）を%sへ分類する', async (code, status, expected) => {
    expect(await readGroupGraphQLResponse(publicError(code, status), parseCreateGroup)).toEqual({ status: expected });
  });

  it('dataとErrorが併存するときErrorを優先する', async () => {
    const response = Response.json({ data: { createGroup: { groupId: 'synthetic-group' } }, errors: [{ message: 'x', extensions: { code: 'AUTHENTICATION_REQUIRED' } }] });
    expect(await readGroupGraphQLResponse(response, parseCreateGroup)).toEqual({ status: 'authentication-required' });
  });

  it.each([
    ['JSON以外', new Response('<html>bad gateway</html>', { headers: { 'Content-Type': 'text/html' } })],
    ['壊れたJSON', new Response('{', { headers: { 'Content-Type': 'application/json' } })],
    ['HTTP失敗でErrorなし', Response.json({ data: { createGroup: { groupId: 'synthetic-group' } } }, { status: 502 })],
    ['errorsが配列でない', Response.json({ errors: {} })],
    ['extensionsがない', Response.json({ errors: [{ message: 'x' }] })],
    ['dataがない', Response.json({})],
  ])('%sは結果不明として扱う', async (_, response) => {
    expect(await readGroupGraphQLResponse(response, parseCreateGroup)).toEqual({ status: 'unavailable' });
  });

  it.each([
    ['itemsがない', { hasMore: false }],
    ['hasMoreが文字列', { items: [], hasMore: 'false' }],
    ['51件', { items: Array.from({ length: 51 }, (_, index) => ({ ...summary, groupId: 'g' + index })), hasMore: true }],
    ['lifecycleが許可外', { items: [{ ...summary, lifecycle: 'DELETED' }], hasMore: false }],
    ['myRoleが許可外', { items: [{ ...summary, myRole: 'ADMIN' }], hasMore: false }],
    ['参加人数が負', { items: [{ ...summary, activeParticipantCount: -1 }], hasMore: false }],
    ['参加人数が小数', { items: [{ ...summary, activeParticipantCount: 1.5 }], hasMore: false }],
    ['groupIdが空', { items: [{ ...summary, groupId: '' }], hasMore: false }],
    ['createdAtがUTCでない', { items: [{ ...summary, createdAt: '2026-11-20T10:02:03.004+09:00' }], hasMore: false }],
    ['joinedAtが存在しない日付', { items: [{ ...summary, joinedAt: '2026-02-30T00:00:00.000Z' }], hasMore: false }],
    ['deleteEligibleAtが不正', { items: [{ ...summary, deleteEligibleAt: 'tomorrow' }], hasMore: false }],
    ['deleteEligibleAtがない', { items: [{ groupId: 'g', lifecycle: 'ACTIVE', myRole: 'OWNER', activeParticipantCount: 1, createdAt: summary.createdAt, joinedAt: summary.joinedAt }], hasMore: false }],
    ['要素がnull', { items: [null], hasMore: false }],
  ])('myGroupsの%sを拒否する', async (_, value) => {
    expect(await readGroupGraphQLResponse(Response.json({ data: myGroups(value) }), parseMyGroups)).toEqual({ status: 'unavailable' });
  });

  it.each([
    ['createGroupがnull', { createGroup: null }],
    ['groupIdが数値', { createGroup: { groupId: 1 } }],
    ['groupIdが空', { createGroup: { groupId: '' } }],
  ])('createGroupの%sを拒否する', async (_, data) => {
    expect(await readGroupGraphQLResponse(Response.json({ data }), parseCreateGroup)).toEqual({ status: 'unavailable' });
  });
});
