import { describe, expect, it, vi } from 'vitest';
import type { CreateGroupClient } from './graphql/create-group-client';
import type { GroupGraphQLResult, CreatedGroup } from './graphql/group-graphql-response';
import { GroupCreationController, type GroupCreationDependencies, type SessionInspection } from './group-creation-controller';

const session: SessionInspection = { status: 'ok', value: { csrfToken: 'synthetic-csrf', expiresAt: 1 } };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const setup = (results: GroupGraphQLResult<CreatedGroup>[], inspections: SessionInspection[] = [session]) => {
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  const createGroup = vi.fn<CreateGroupClient['createGroup']>(async () => results.shift() ?? { status: 'unavailable' });
  const dependencies: GroupCreationDependencies = {
    inspectSession: vi.fn(async () => inspections.length > 1 ? inspections.shift()! : inspections[0]),
    client: { createGroup },
    newOperationId: vi.fn(() => ids.shift()!),
    onCreated: vi.fn(),
    onAuthenticationRequired: vi.fn(),
  };
  return { controller: new GroupCreationController(dependencies), dependencies, createGroup };
};

describe('Group作成の操作状態', () => {
  it('押下ごとに新しい操作IDを作り、CSRF Tokenと送って成功後に一覧を取り直す', async () => {
    const { controller, dependencies, createGroup } = setup([{ status: 'ok', value: { groupId: 'g1' } }, { status: 'ok', value: { groupId: 'g2' } }]);

    await controller.submit();
    expect(controller.getSnapshot()).toEqual({ phase: 'created', message: 'グループを作成しました。' });
    await controller.submit();

    expect(createGroup.mock.calls).toEqual([
      ['11111111-1111-4111-8111-111111111111', 'synthetic-csrf'],
      ['22222222-2222-4222-8222-222222222222', 'synthetic-csrf'],
    ]);
    expect(dependencies.onCreated).toHaveBeenCalledTimes(2);
  });

  it('送信中は無効化し、二重押下を送らない', async () => {
    const { controller, dependencies, createGroup } = setup([]);
    const pending = deferred<GroupGraphQLResult<CreatedGroup>>();
    createGroup.mockReturnValueOnce(pending.promise);

    const first = controller.submit();
    await vi.waitFor(() => expect(createGroup).toHaveBeenCalledTimes(1));
    expect(controller.getSnapshot().phase).toBe('submitting');
    await controller.submit();
    pending.resolve({ status: 'ok', value: { groupId: 'g1' } });
    await first;

    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(dependencies.newOperationId).toHaveBeenCalledTimes(1);
  });

  it('結果不明では同じ操作IDで再試行でき、成功後は破棄する', async () => {
    const { controller, createGroup, dependencies } = setup([{ status: 'unavailable' }, { status: 'unavailable' }, { status: 'ok', value: { groupId: 'g1' } }, { status: 'ok', value: { groupId: 'g2' } }]);

    await controller.submit();
    expect(controller.getSnapshot()).toEqual({ phase: 'retry', message: expect.stringContaining('同じ作成操作') });
    expect(dependencies.onCreated).not.toHaveBeenCalled();
    await controller.submit();
    await controller.submit();
    await controller.submit();

    expect(createGroup.mock.calls.map(([id]) => id)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
  });

  it('CSRF Tokenを取得できないときは送らず、同じ操作IDで再試行できる', async () => {
    const { controller, createGroup } = setup([{ status: 'ok', value: { groupId: 'g1' } }], [{ status: 'unavailable' }, session]);

    await controller.submit();
    expect(createGroup).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe('retry');
    await controller.submit();

    expect(createGroup.mock.calls).toEqual([['11111111-1111-4111-8111-111111111111', 'synthetic-csrf']]);
  });

  it.each([
    ['Session確認', [], [{ status: 'required' } as const]],
    ['作成', [{ status: 'authentication-required' } as const], [session]],
  ])('%sが未認証ならログイン導線へ移し、操作IDを破棄する', async (_, results, inspections) => {
    const { controller, dependencies, createGroup } = setup([...results], [...inspections]);

    await controller.submit();

    expect(dependencies.onAuthenticationRequired).toHaveBeenCalledTimes(1);
    expect(dependencies.onCreated).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual({ phase: 'redirecting', message: 'ログインが必要です。ログイン画面へ移動します。' });
    await controller.submit();
    expect(createGroup).toHaveBeenCalledTimes(results.length);
  });

  it.each(['rejected', 'invalid-input', 'operation-mismatch'] as const)('%sは確定Errorとして操作IDを破棄し、再読込を案内する', async (status) => {
    const { controller, createGroup } = setup([{ status }, { status: 'ok', value: { groupId: 'g1' } }]);

    await controller.submit();
    expect(controller.getSnapshot()).toEqual({ phase: 'failed', message: 'グループを作成できませんでした。ページを再読み込みしてから、もう一度お試しください。' });
    await controller.submit();

    expect(createGroup.mock.calls.map(([id]) => id)).toEqual(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']);
  });

  it('状態の変化を購読者へ通知し、購読解除後は通知しない', async () => {
    const { controller } = setup([{ status: 'ok', value: { groupId: 'g1' } }]);
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);

    await controller.submit();
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);
    unsubscribe();
    listener.mockClear();
    await controller.submit();

    expect(listener).not.toHaveBeenCalled();
    expect(controller.getServerSnapshot()).toEqual({ phase: 'idle', message: '' });
  });
});
