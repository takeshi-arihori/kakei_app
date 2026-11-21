import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GRAPHQL_BODY_LIMIT_BYTES,
  GraphQLEntryRejection,
  readGraphQLRequestBody,
} from './graphql-request-body.js';

const post = (
  body: BodyInit | null,
  headers: Record<string, string> = {},
): Request =>
  new Request('http://api.test/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });

const statusOf = async (request: Request): Promise<number | 'accepted'> => {
  try {
    await readGraphQLRequestBody(request);
    return 'accepted';
  } catch (error) {
    if (error instanceof GraphQLEntryRejection) return error.status;
    throw error;
  }
};

/** 文書の長さを調整し、JSON全体を指定byte数にする。 */
const bodyOfBytes = (bytes: number): string => {
  const prefix = '{"query":"';
  const suffix = '"}';
  return prefix + ' '.repeat(bytes - prefix.length - suffix.length) + suffix;
};

describe('readGraphQLRequestBody', () => {
  afterEach(() => vi.useRealTimers());

  it('query・operationName・variablesだけのObjectを受理する', async () => {
    await expect(
      readGraphQLRequestBody(
        post(
          JSON.stringify({
            query: 'query A { apiStatus { status } }',
            operationName: 'A',
            variables: { x: 1 },
          }),
          { 'content-type': 'application/json; charset=utf-8' },
        ),
      ),
    ).resolves.toEqual({
      query: 'query A { apiStatus { status } }',
      operationName: 'A',
      variables: { x: 1 },
    });
  });

  it('operationNameとvariablesのnullを不在と同じに扱う', async () => {
    await expect(
      readGraphQLRequestBody(
        post(
          JSON.stringify({
            query: '{ x }',
            operationName: null,
            variables: null,
          }),
        ),
      ),
    ).resolves.toEqual({ query: '{ x }' });
  });

  it.each([
    ['text/plain', 'text/plain'],
    ['form', 'application/x-www-form-urlencoded'],
    ['multipart', 'multipart/form-data; boundary=x'],
    ['GraphQL文書', 'application/graphql'],
    ['別charset', 'application/json; charset=latin1'],
  ])('Content-Typeが%sなら415', async (_label, type) => {
    expect(
      await statusOf(post('{"query":"{ x }"}', { 'content-type': type })),
    ).toBe(415);
  });

  it('Content-Type欠落は415', async () => {
    const request = new Request('http://api.test/graphql', {
      method: 'POST',
      body: new Uint8Array(new TextEncoder().encode('{"query":"{ x }"}')),
    });
    expect(await statusOf(request)).toBe(415);
  });

  it('identity以外のContent-Encodingは415、identityは受理する', async () => {
    const body = '{"query":"{ x }"}';
    expect(await statusOf(post(body, { 'content-encoding': 'gzip' }))).toBe(
      415,
    );
    expect(await statusOf(post(body, { 'content-encoding': 'identity' }))).toBe(
      'accepted',
    );
  });

  it('Bodyは上限ちょうどを受理し、1 byte超過を413にする', async () => {
    expect(GRAPHQL_BODY_LIMIT_BYTES).toBe(18_432);
    expect(await statusOf(post(bodyOfBytes(18_432)))).toBe('accepted');
    expect(await statusOf(post(bodyOfBytes(18_433)))).toBe(413);
  });

  it('Content-Lengthが上限超過を申告したら読まずに413', async () => {
    expect(
      await statusOf(post('{"query":"{ x }"}', { 'content-length': '18433' })),
    ).toBe(413);
  });

  it('Content-Lengthを小さく偽装してもstream計測で413', async () => {
    expect(
      await statusOf(post(bodyOfBytes(18_433), { 'content-length': '2' })),
    ).toBe(413);
  });

  it('Content-Lengthなしのstreamも上限で413', async () => {
    const data = new TextEncoder().encode(bodyOfBytes(18_433));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data.slice(0, 10_000));
        controller.enqueue(data.slice(10_000));
        controller.close();
      },
    });
    const request = new Request('http://api.test/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(await statusOf(request)).toBe(413);
  });

  it.each([
    ['数字以外', 'abc'],
    ['実長と不一致', '3'],
  ])('Content-Lengthが%sなら400', async (_label, length) => {
    expect(
      await statusOf(post('{"query":"{ x }"}', { 'content-length': length })),
    ).toBe(400);
  });

  it('読取が5秒を超えたら400', async () => {
    vi.useFakeTimers();
    const request = new Request('http://api.test/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new ReadableStream<Uint8Array>({ start() {} }),
      duplex: 'half',
    } as RequestInit);
    const result = statusOf(request);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await result).toBe(400);
  });

  it.each([
    ['Body欠落', null],
    ['不正UTF-8', new Uint8Array([0x7b, 0xff, 0x7d])],
    ['不正JSON', '{"query":'],
    ['batch配列', '[{"query":"{ x }"}]'],
    ['null', 'null'],
    ['文字列', '"{ x }"'],
    ['extensions', '{"query":"{ x }","extensions":{}}'],
    ['未知Key', '{"query":"{ x }","foo":1}'],
    ['query欠落', '{"operationName":"A"}'],
    ['query非文字列', '{"query":1}'],
    ['operationName非文字列', '{"query":"{ x }","operationName":1}'],
    ['variables配列', '{"query":"{ x }","variables":[]}'],
    ['variables文字列', '{"query":"{ x }","variables":"{}"}'],
    ['__proto__', '{"query":"{ x }","__proto__":{}}'],
  ])('%sは400', async (_label, body) => {
    expect(await statusOf(post(body))).toBe(400);
  });

  it('拒否Errorは入力値を保持しない', async () => {
    try {
      await readGraphQLRequestBody(post('{"query":1,"secret":"s3cr3t"}'));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(GraphQLEntryRejection);
      expect(JSON.stringify(error)).not.toContain('s3cr3t');
      expect(String((error as Error).message)).not.toContain('s3cr3t');
      expect((error as Error).cause).toBeUndefined();
    }
  });
});
