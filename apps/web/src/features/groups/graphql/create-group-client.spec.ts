import { describe, expect, it, vi } from 'vitest';
import { createGroupClient } from './create-group-client';

const operationId = '7c1f0a52-3a4c-4f7e-9d1b-2f5e6a7b8c9d';
const csrf = 'synthetic-csrf-token';

describe('Group作成の同一Origin Client', () => {
  it('相対/graphqlへCSRF・X-Kakei-Request付きのJSON POSTでCreateGroupを送る', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { createGroup: { groupId: 'synthetic-group' } } }));

    const result = await createGroupClient(fetcher).createGroup(operationId, csrf);

    expect(result).toEqual({ status: 'ok', value: { groupId: 'synthetic-group' } });
    const [target, init] = fetcher.mock.calls[0];
    expect(target).toBe('/graphql');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    const headers = new Headers(init?.headers);
    expect([...headers.keys()].sort()).toEqual(['content-type', 'x-csrf-token', 'x-kakei-request']);
    expect(headers.get('x-csrf-token')).toBe(csrf);
    expect(headers.get('x-kakei-request')).toBe('1');
    expect(JSON.parse(String(init?.body))).toEqual({ query: expect.stringContaining('mutation CreateGroup'), operationName: 'CreateGroup', variables: { input: { operationId } } });
  });

  it('通信断を結果不明として返し、例外の診断を伝えない', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network synthetic-csrf-token'));
    expect(await createGroupClient(fetcher).createGroup(operationId, csrf)).toEqual({ status: 'unavailable' });
  });

  it('公開Errorを分類して返す', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ errors: [{ message: 'x', extensions: { code: 'OPERATION_MISMATCH', requestId: '00000000-0000-4000-8000-000000000001' } }], data: null }));
    expect(await createGroupClient(fetcher).createGroup(operationId, csrf)).toEqual({ status: 'operation-mismatch' });
  });
});
