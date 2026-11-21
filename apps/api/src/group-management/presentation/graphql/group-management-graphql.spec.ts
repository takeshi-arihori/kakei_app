import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PUBLIC_ROOT_FIELDS,
  createGraphQLEntry,
} from '../../../presentation/graphql/graphql-entry.js';
import type { GraphQLAuthenticationService } from '../../../presentation/graphql/authenticated-operation.js';
import { PublicGraphQLError } from '../../../presentation/graphql/public-graphql-error.js';
import { createGraphQLSchema } from '../../../presentation/graphql/schema.js';
import type { AuthenticatedActor } from '../../../shared/application/authentication/authentication-ports.js';
import { createAuthenticationTransactionScopes } from '../../../shared/infrastructure/authentication/postgres/authentication-transaction-scopes.js';
import {
  ActorSubject,
  GroupId,
  ParticipantId,
  UtcInstant,
} from '../../domain/group.js';
import {
  GroupCommandApplicationError,
  type CreateGroupCommand,
  type GroupCommandApplicationErrorCode,
} from '../../application/group-command-service.js';
import type { GroupCreatedResult } from '../../application/group-repository.js';
import {
  MyGroupListApplicationError,
  type ListMyGroupsQuery,
  type MyGroupList,
  type MyGroupSummary,
} from '../../application/use-cases/list-my-groups.js';
import type { GroupManagementGraphQLUseCases } from './group-management-resolvers.js';

const origin = 'http://localhost:3000';
const cookieName = 'kakei_dev_auth_session';
const secret = (n: number) => Buffer.alloc(32, n).toString('base64url');
const actor: AuthenticatedActor = {
  actorSubject: '00000000-0000-4000-8000-000000000312',
  absoluteExpiresAt: 604_801_000,
  csrf: secret(5),
};
const uuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const operationId = '7d3f6c2a-1b4e-4f8a-9c0d-2e5f6a7b8c9d';
const createdGroupId = '3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

type PublicCode = ConstructorParameters<typeof PublicGraphQLError>[0];

const createGroup =
  vi.fn<(command: CreateGroupCommand) => Promise<GroupCreatedResult>>();
const listMyGroups =
  vi.fn<(query: ListMyGroupsQuery) => Promise<MyGroupList>>();
const useCases: GroupManagementGraphQLUseCases = {
  commands: { createGroup },
  queries: { listMyGroups },
};

const setup = (
  options: {
    useCases?: GroupManagementGraphQLUseCases | null;
    authCommit?: 'ok' | 'fail';
  } = {},
) => {
  const lease = vi.fn<(sessionSecret: unknown, usage: string) => void>();
  const withAuthenticatedActor: GraphQLAuthenticationService['withAuthenticatedActor'] =
    async (sessionSecret, usage, callback) => {
      lease(sessionSecret, usage);
      if (sessionSecret === undefined) return { status: 'unauthenticated' };
      const scopes = createAuthenticationTransactionScopes().open({
        query: () =>
          Promise.resolve({
            rows: [],
            rowCount: 0,
            command: 'SELECT',
            oid: 0,
            fields: [],
          }),
      });
      try {
        const value = await callback(actor, scopes.scope);
        scopes.seal();
        scopes.assertResult(value);
        scopes.assertCommittable();
        if (options.authCommit === 'fail') return { status: 'unavailable' };
        return { status: 'authenticated', value };
      } catch {
        return { status: 'unavailable' };
      } finally {
        scopes.close();
      }
    };
  const handler = createGraphQLEntry({
    schema: createGraphQLSchema(
      options.useCases === null
        ? {}
        : { groupManagement: options.useCases ?? useCases },
    ),
    publicRootFields: PUBLIC_ROOT_FIELDS,
    capability: {
      origin,
      profile: 'local-development',
      service: { withAuthenticatedActor },
      security: {
        createRequestId: () => '6f1c2f8e-3b1a-4c5d-9e7f-0a1b2c3d4e5f',
        equalSecrets: (left, right) => left === right,
      },
    },
  });
  return { handler, lease };
};

const session = { cookie: `${cookieName}=${secret(9)}` };
const mutationHeaders = { ...session, origin, 'x-csrf-token': secret(5) };
const post = (
  query: string,
  headers: Record<string, string>,
  variables?: Record<string, unknown>,
): Request =>
  new Request('http://127.0.0.1:3001/graphql', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kakei-request': '1',
      ...headers,
    },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });

const createMutation = /* GraphQL */ `
  mutation Create($input: CreateGroupInput!) {
    createGroup(input: $input) {
      groupId
    }
  }
`;
const myGroupsQuery = /* GraphQL */ `
  query {
    myGroups {
      items {
        groupId
        lifecycle
        myRole
        activeParticipantCount
        createdAt
        joinedAt
        deleteEligibleAt
      }
      hasMore
    }
  }
`;

const readBody = async (response: Response) => {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  return (await response.json()) as Record<string, unknown>;
};
/** 公開Errorの形（固定文・code・requestIdだけ、locations／pathなし）を確かめる。 */
const expectPublicError = async (
  response: Response,
  code: PublicCode,
  status = 200,
) => {
  expect(response.status).toBe(status);
  const body = await readBody(response);
  expect(body).toEqual({
    errors: [
      {
        message: new PublicGraphQLError(code).message,
        extensions: {
          code,
          requestId: expect.stringMatching(uuidV4) as unknown,
        },
      },
    ],
    ...(status === 200 ? { data: null } : {}),
  });
  return JSON.stringify(body);
};

const created = (groupId = createdGroupId): GroupCreatedResult =>
  Object.freeze({
    kind: 'GroupCreated',
    groupId: GroupId.from(groupId),
    participantId: ParticipantId.from('participant-secret-1'),
    version: 1,
  });

const at = (iso: string) => UtcInstant.from(new Date(iso));
const summary = (
  overrides: Partial<MyGroupSummary> & { groupId: GroupId },
): MyGroupSummary =>
  Object.freeze({
    lifecycle: 'Active',
    myRole: 'Owner',
    activeParticipantCount: 1,
    createdAt: at('2026-11-20T01:02:03.004Z'),
    joinedAt: at('2026-11-20T01:02:03.004Z'),
    deleteEligibleAt: null,
    ...overrides,
  });
const groupIdOf = (n: number) =>
  GroupId.from(`00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`);

afterEach(() => {
  createGroup.mockReset();
  listMyGroups.mockReset();
});

describe('Mutation.createGroup（#305 §1）', () => {
  it('CG-PRE-1／CG-POST-1: lease内でActorとoperationIdだけをCommandにし、groupIdだけを返す', async () => {
    createGroup.mockResolvedValue(created());
    const { handler, lease } = setup();

    const response = await handler(
      post(createMutation, mutationHeaders, { input: { operationId } }),
    );

    expect(response.status).toBe(200);
    expect(await readBody(response)).toEqual({
      data: { createGroup: { groupId: createdGroupId } },
    });
    expect(lease).toHaveBeenCalledExactlyOnceWith(secret(9), 'activity');
    expect(createGroup).toHaveBeenCalledOnce();
    const [command] = createGroup.mock.calls[0];
    expect(Object.keys(command).sort()).toEqual([
      'actorSubject',
      'operationId',
    ]);
    expect(
      command.actorSubject.equals(ActorSubject.from(actor.actorSubject)),
    ).toBe(true);
    expect(command.operationId.value).toBe(operationId);
  });

  it('CG-POST-1: participantId・versionはSDLに無く、選択するとINVALID_REQUEST', async () => {
    const { handler } = setup();
    for (const field of ['participantId', 'version']) {
      await expectPublicError(
        await handler(
          post(
            `mutation { createGroup(input: { operationId: "${operationId}" }) { groupId ${field} } }`,
            mutationHeaders,
          ),
        ),
        'INVALID_REQUEST',
        400,
      );
    }
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('CG-PRE-1: InputにActor等を持たせられない（未知fieldはINVALID_REQUEST）', async () => {
    const { handler, lease } = setup();
    await expectPublicError(
      await handler(
        post(createMutation, mutationHeaders, {
          input: { operationId, actorSubject: 'someone-else' },
        }),
      ),
      'INVALID_REQUEST',
      400,
    );
    expect(lease).not.toHaveBeenCalled();
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('CG-POST-2: 同じoperationIdの再送はUse Caseが返した同じgroupIdをそのまま返す', async () => {
    createGroup.mockResolvedValue(created());
    const { handler } = setup();

    const bodies = [];
    for (let i = 0; i < 2; i += 1)
      bodies.push(
        await readBody(
          await handler(
            post(createMutation, mutationHeaders, { input: { operationId } }),
          ),
        ),
      );

    expect(bodies[0]).toEqual(bodies[1]);
    expect(createGroup.mock.calls.map(([c]) => c.operationId.value)).toEqual([
      operationId,
      operationId,
    ]);
  });

  it.each([
    ['大文字', operationId.toUpperCase()],
    ['UUIDv1', '7d3f6c2a-1b4e-1f8a-9c0d-2e5f6a7b8c9d'],
    ['variant不正', '7d3f6c2a-1b4e-4f8a-7c0d-2e5f6a7b8c9d'],
    ['括弧付き', `{${operationId}}`],
    ['前後空白', ` ${operationId}`],
    ['空', ''],
    ['UUIDでない', 'operation-1'],
  ])(
    'CG-PRE-2: operationIdが%sならUse Caseを呼ばずINVALID_INPUT',
    async (_label, value) => {
      const { handler, lease } = setup();

      await expectPublicError(
        await handler(
          post(createMutation, mutationHeaders, {
            input: { operationId: value },
          }),
        ),
        'INVALID_INPUT',
      );
      // 本人性とCSRFを確かめた後に入力を検査する。
      expect(lease).toHaveBeenCalledOnce();
      expect(createGroup).not.toHaveBeenCalled();
    },
  );

  it('CG-PRE-2: 整数のID literalも形式違反としてINVALID_INPUT', async () => {
    const { handler } = setup();
    await expectPublicError(
      await handler(
        post(
          'mutation { createGroup(input: { operationId: 123 }) { groupId } }',
          mutationHeaders,
        ),
      ),
      'INVALID_INPUT',
    );
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('CG-PRE-1: Session CookieがなければAUTHENTICATION_REQUIREDでUse Caseを呼ばない', async () => {
    const { handler } = setup();
    const withoutCookie = { origin, 'x-csrf-token': secret(5) };

    await expectPublicError(
      await handler(
        post(createMutation, withoutCookie, { input: { operationId } }),
      ),
      'AUTHENTICATION_REQUIRED',
    );
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('CG-PRE-1: CSRFがSessionと一致しなければREQUEST_REJECTEDでUse Caseを呼ばない', async () => {
    const { handler } = setup();

    await expectPublicError(
      await handler(
        post(
          createMutation,
          { ...mutationHeaders, 'x-csrf-token': secret(6) },
          { input: { operationId } },
        ),
      ),
      'REQUEST_REJECTED',
    );
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('CG-FAIL-1: OPERATION_MISMATCHはOPERATION_MISMATCHへ写像する', async () => {
    createGroup.mockRejectedValue(
      new GroupCommandApplicationError(
        'OPERATION_MISMATCH',
        'operation detail for actor',
      ),
    );
    const { handler } = setup();

    const body = await expectPublicError(
      await handler(
        post(createMutation, mutationHeaders, { input: { operationId } }),
      ),
      'OPERATION_MISMATCH',
    );
    expect(body).not.toContain('operation detail');
  });

  it.each<GroupCommandApplicationErrorCode>([
    'UNAVAILABLE',
    'GROUP_ALREADY_EXISTS',
    'CONFLICT',
    'GROUP_NOT_FOUND',
    'INVALID_EXPECTED_VERSION',
    'CLOSE_INTENT_ALREADY_EXISTS',
  ])('CG-FAIL-2: %sはSERVICE_UNAVAILABLEへmaskする', async (code) => {
    createGroup.mockRejectedValue(
      new GroupCommandApplicationError(code, `cause ${createdGroupId}`),
    );
    const { handler } = setup();

    const body = await expectPublicError(
      await handler(
        post(createMutation, mutationHeaders, { input: { operationId } }),
      ),
      'SERVICE_UNAVAILABLE',
    );
    expect(body).not.toContain(createdGroupId);
    expect(body).not.toContain(code === 'UNAVAILABLE' ? 'cause' : code);
  });

  it('CG-FAIL-2: 想定外例外もSERVICE_UNAVAILABLEへmaskし原因を出さない', async () => {
    createGroup.mockRejectedValue(new Error('database password=hunter2'));
    const { handler } = setup();

    const body = await expectPublicError(
      await handler(
        post(createMutation, mutationHeaders, { input: { operationId } }),
      ),
      'SERVICE_UNAVAILABLE',
    );
    expect(body).not.toContain('hunter2');
  });

  it('業務成功後に認証commitが失敗したら結果不明としてSERVICE_UNAVAILABLE', async () => {
    createGroup.mockResolvedValue(created());
    const { handler } = setup({ authCommit: 'fail' });

    const body = await expectPublicError(
      await handler(
        post(createMutation, mutationHeaders, { input: { operationId } }),
      ),
      'SERVICE_UNAVAILABLE',
    );
    expect(body).not.toContain(createdGroupId);
  });
});

describe('Query.myGroups（#305 §2）', () => {
  it('LG-POST-1: lease内でActorだけをQueryにし、要約をSDLの形へ写像する', async () => {
    listMyGroups.mockResolvedValue(
      Object.freeze({
        items: [
          summary({
            groupId: groupIdOf(1),
            lifecycle: 'Active',
            myRole: 'Owner',
            activeParticipantCount: 3,
            createdAt: at('2026-11-20T03:00:00.000Z'),
            joinedAt: at('2026-11-20T03:00:00.000Z'),
          }),
          summary({
            groupId: groupIdOf(2),
            lifecycle: 'Closing',
            myRole: 'Participant',
            activeParticipantCount: 2,
            createdAt: at('2026-11-20T02:00:00.000Z'),
            joinedAt: at('2026-11-20T02:30:00.500Z'),
          }),
          summary({
            groupId: groupIdOf(3),
            lifecycle: 'Canceling',
            myRole: 'Participant',
          }),
          summary({
            groupId: groupIdOf(4),
            lifecycle: 'Archived',
            myRole: 'Owner',
            activeParticipantCount: 0,
            deleteEligibleAt: at('2027-11-20T00:00:00.000Z'),
          }),
        ],
        hasMore: true,
      }),
    );
    const { handler, lease } = setup();

    // Server Component経路を想定し、Originを付けないQuery。
    const response = await handler(post(myGroupsQuery, session));

    expect(response.status).toBe(200);
    expect(await readBody(response)).toEqual({
      data: {
        myGroups: {
          items: [
            {
              groupId: groupIdOf(1).value,
              lifecycle: 'ACTIVE',
              myRole: 'OWNER',
              activeParticipantCount: 3,
              createdAt: '2026-11-20T03:00:00.000Z',
              joinedAt: '2026-11-20T03:00:00.000Z',
              deleteEligibleAt: null,
            },
            {
              groupId: groupIdOf(2).value,
              lifecycle: 'CLOSING',
              myRole: 'PARTICIPANT',
              activeParticipantCount: 2,
              createdAt: '2026-11-20T02:00:00.000Z',
              joinedAt: '2026-11-20T02:30:00.500Z',
              deleteEligibleAt: null,
            },
            {
              groupId: groupIdOf(3).value,
              lifecycle: 'CANCELING',
              myRole: 'PARTICIPANT',
              activeParticipantCount: 1,
              createdAt: '2026-11-20T01:02:03.004Z',
              joinedAt: '2026-11-20T01:02:03.004Z',
              deleteEligibleAt: null,
            },
            {
              groupId: groupIdOf(4).value,
              lifecycle: 'ARCHIVED',
              myRole: 'OWNER',
              activeParticipantCount: 0,
              createdAt: '2026-11-20T01:02:03.004Z',
              joinedAt: '2026-11-20T01:02:03.004Z',
              deleteEligibleAt: '2027-11-20T00:00:00.000Z',
            },
          ],
          hasMore: true,
        },
      },
    });
    expect(lease).toHaveBeenCalledExactlyOnceWith(secret(9), 'activity');
    expect(listMyGroups).toHaveBeenCalledOnce();
    const [query] = listMyGroups.mock.calls[0];
    expect(Object.keys(query)).toEqual(['actorSubject']);
    expect(
      query.actorSubject.equals(ActorSubject.from(actor.actorSubject)),
    ).toBe(true);
  });

  it('LG-POST-1: 空の一覧はErrorにしない', async () => {
    listMyGroups.mockResolvedValue({ items: [], hasMore: false });
    const { handler } = setup();

    expect(await readBody(await handler(post(myGroupsQuery, session)))).toEqual(
      { data: { myGroups: { items: [], hasMore: false } } },
    );
  });

  it('LG-PRE: Session CookieがなければAUTHENTICATION_REQUIREDでUse Caseを呼ばない', async () => {
    const { handler } = setup();

    await expectPublicError(
      await handler(post(myGroupsQuery, {})),
      'AUTHENTICATION_REQUIRED',
    );
    expect(listMyGroups).not.toHaveBeenCalled();
  });

  it('LG-FAIL-1: 一覧のApplication ErrorはSERVICE_UNAVAILABLE（NOT_FOUNDを使わない）', async () => {
    listMyGroups.mockRejectedValue(
      new MyGroupListApplicationError(
        'UNAVAILABLE',
        `index ${groupIdOf(9).value}`,
      ),
    );
    const { handler } = setup();

    const body = await expectPublicError(
      await handler(post(myGroupsQuery, session)),
      'SERVICE_UNAVAILABLE',
    );
    expect(body).not.toContain(groupIdOf(9).value);
  });

  it('LG-FAIL-1: 想定外例外はSERVICE_UNAVAILABLE', async () => {
    listMyGroups.mockRejectedValue(new TypeError('decrypt failed'));
    const { handler } = setup();

    const body = await expectPublicError(
      await handler(post(myGroupsQuery, session)),
      'SERVICE_UNAVAILABLE',
    );
    expect(body).not.toContain('decrypt');
  });

  it('LG-FAIL-1: 写像できない値を含む一覧は一部だけ返さずSERVICE_UNAVAILABLE', async () => {
    listMyGroups.mockResolvedValue({
      items: [
        summary({ groupId: groupIdOf(1) }),
        summary({
          groupId: groupIdOf(2),
          lifecycle: 'Deleted' as unknown as MyGroupSummary['lifecycle'],
        }),
      ],
      hasMore: false,
    });
    const { handler } = setup();

    const body = await expectPublicError(
      await handler(post(myGroupsQuery, session)),
      'SERVICE_UNAVAILABLE',
    );
    expect(body).not.toContain(groupIdOf(1).value);
  });
});

describe('Group Managementの能力が未注入の構成', () => {
  it('両fieldは認証leaseを開かずSERVICE_UNAVAILABLE', async () => {
    const { handler, lease } = setup({ useCases: null });

    await expectPublicError(
      await handler(post(myGroupsQuery, session)),
      'SERVICE_UNAVAILABLE',
    );
    await expectPublicError(
      await handler(
        post(createMutation, mutationHeaders, { input: { operationId } }),
      ),
      'SERVICE_UNAVAILABLE',
    );
    expect(lease).not.toHaveBeenCalled();
  });

  it('apiStatusは従来どおり未認証で返す', async () => {
    const { handler, lease } = setup({ useCases: null });

    expect(
      await readBody(await handler(post('{ apiStatus { status } }', {}))),
    ).toEqual({ data: { apiStatus: { status: 'ok' } } });
    expect(lease).not.toHaveBeenCalled();
  });

  it('新しいfieldは未認証公開の許可Listに入れない', () => {
    expect([...PUBLIC_ROOT_FIELDS]).toEqual(['Query.apiStatus']);
  });
});
