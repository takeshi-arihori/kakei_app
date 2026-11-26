import { afterEach, describe, expect, it, vi } from 'vitest';
import { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } from './route';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const body = '{"query":"mutation CreateGroup($input: CreateGroupInput!) { createGroup(input: $input) { groupId } }","operationName":"CreateGroup","variables":{"input":{"operationId":"7c1f0a52-3a4c-4f7e-9d1b-2f5e6a7b8c9d"}}}';
const browserRequest = (headers: Record<string, string> = {}) =>
  new Request('http://localhost:3000/graphql', {
    method: 'POST',
    headers: {
      Origin: 'http://localhost:3000',
      'Content-Type': 'application/json',
      'X-Kakei-Request': '1',
      'X-CSRF-Token': 'synthetic-csrf',
      'Sec-Fetch-Site': 'same-origin',
      Cookie: 'kakei_dev_auth_session=synthetic-session',
      Connection: 'keep-alive',
      'Keep-Alive': 'timeout=5',
      'Proxy-Authorization': 'Basic synthetic',
      ...headers,
    },
    body,
  });
const expectFixedFailure = async (response: Response, status: number, code: string) => {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-type')).toMatch(/^application\/json/);
  const payload: unknown = await response.json();
  expect(payload).toEqual({
    errors: [
      {
        message: expect.any(String),
        extensions: { code, requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) },
      },
    ],
  });
};

describe('業務GraphQLの開発用同一Origin転送', () => {
  it('developmentのPOSTを固定loopbackへ、Browserの値を補わず改変せずに転送する', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const upstream = new Response('{"data":{"createGroup":{"groupId":"synthetic-group"}}}', {
      status: 200,
      headers: [
        ['Content-Type', 'application/json; charset=utf-8'],
        ['Set-Cookie', 'kakei_dev_auth_session=overwritten; HttpOnly'],
        ['X-Powered-By', 'synthetic'],
      ],
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(upstream);
    vi.stubGlobal('fetch', fetcher);

    const response = await POST(browserRequest());

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [target, init] = fetcher.mock.calls[0];
    expect(target).toBe('http://127.0.0.1:3001/graphql');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    expect(init?.cache).toBe('no-store');
    const forwarded = new Headers(init?.headers);
    expect(forwarded.get('origin')).toBe('http://localhost:3000');
    expect(forwarded.get('x-kakei-request')).toBe('1');
    expect(forwarded.get('x-csrf-token')).toBe('synthetic-csrf');
    expect(forwarded.get('sec-fetch-site')).toBe('same-origin');
    expect(forwarded.get('cookie')).toBe('kakei_dev_auth_session=synthetic-session');
    expect(forwarded.get('content-type')).toBe('application/json');
    for (const name of ['host', 'connection', 'keep-alive', 'proxy-authorization']) expect(forwarded.has(name)).toBe(false);
    expect(await new Response(init?.body).text()).toBe(body);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"data":{"createGroup":{"groupId":"synthetic-group"}}}');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.has('x-powered-by')).toBe(false);
  });

  it.each([['https://other.example.test'], [null]])('Originを補わずAPIの照合に任せる: %s', async (origin) => {
    vi.stubEnv('NODE_ENV', 'development');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: null }));
    vi.stubGlobal('fetch', fetcher);
    const request = browserRequest();
    const headers = new Headers(request.headers);
    if (origin === null) headers.delete('origin');
    else headers.set('origin', origin);

    await POST(new Request(request.url, { method: 'POST', headers, body }));

    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('origin')).toBe(origin);
  });

  it('APIの公開Errorと403／503のstatusをそのまま返す', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const rejected = '{"errors":[{"message":"Requestを受け付けられません。","extensions":{"code":"REQUEST_REJECTED","requestId":"00000000-0000-4000-8000-000000000001"}}]}';
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(rejected, { status: 403, headers: { 'Content-Type': 'application/json' } })));

    const response = await POST(browserRequest());

    expect(response.status).toBe(403);
    expect(await response.text()).toBe(rejected);
  });

  it.each([
    ['GET', GET],
    ['HEAD', HEAD],
    ['OPTIONS', OPTIONS],
    ['PUT', PUT],
    ['PATCH', PATCH],
    ['DELETE', DELETE],
  ] as const)('%sは転送せず405とAllow: POSTを返す', async (method, handler) => {
    vi.stubEnv('NODE_ENV', 'development');
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);

    const response = await handler(new Request('http://localhost:3000/graphql', { method }));

    expect(fetcher).not.toHaveBeenCalled();
    expect(response.headers.get('allow')).toBe('POST');
    await expectFixedFailure(response, 405, 'INVALID_REQUEST');
  });

  it.each(['production', 'test'])('%sではloopback APIへ接続せず503を返す', async (mode) => {
    vi.stubEnv('NODE_ENV', mode);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);

    const response = await POST(browserRequest());

    expect(fetcher).not.toHaveBeenCalled();
    await expectFixedFailure(response, 503, 'SERVICE_UNAVAILABLE');
  });

  it('接続障害の診断・Cookie・CSRFを応答へ出さず503を返す', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('synthetic-session synthetic-csrf ECONNREFUSED')));

    const response = await POST(browserRequest());

    const text = await response.clone().text();
    expect(text).not.toMatch(/synthetic|ECONNREFUSED|127\.0\.0\.1/);
    await expectFixedFailure(response, 503, 'SERVICE_UNAVAILABLE');
  });
});
