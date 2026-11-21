import { GraphQLError } from 'graphql';
import { describe, expect, it } from 'vitest';

import {
  PUBLIC_GRAPHQL_ERROR_CODES,
  PublicGraphQLError,
  maskPublicGraphQLError,
  publicGraphQLErrorResponse,
} from './public-graphql-error.js';

const requestId = '6f1c2f8e-3b1a-4c5d-9e7f-0a1b2c3d4e5f';

describe('公開GraphQL Error', () => {
  it('許可codeは8種類に限る', () => {
    expect(PUBLIC_GRAPHQL_ERROR_CODES).toEqual([
      'INVALID_REQUEST',
      'REQUEST_REJECTED',
      'AUTHENTICATION_REQUIRED',
      'NOT_FOUND',
      'CONFLICT',
      'OPERATION_MISMATCH',
      'INVALID_INPUT',
      'SERVICE_UNAVAILABLE',
    ]);
  });

  it('codeごとのmessageは固定文で、codeどうしで重複しない', () => {
    const messages = PUBLIC_GRAPHQL_ERROR_CODES.map(
      (code) => new PublicGraphQLError(code).message,
    );
    expect(new Set(messages).size).toBe(messages.length);
    // 入力値・ID・原因を埋め込む余地のない、数字や記号のない短い固定文。
    for (const message of messages)
      expect(message).toMatch(/^[^0-9{}<>"'`$]{1,40}$/);
  });

  it('許可外codeは構築できない', () => {
    expect(() => new PublicGraphQLError('FORBIDDEN' as 'NOT_FOUND')).toThrow();
  });

  it('Resolver由来の公開Errorはcodeと固定文だけを残す', () => {
    const wrapped = new GraphQLError('ignored', {
      originalError: new PublicGraphQLError('NOT_FOUND'),
      extensions: { leaked: 'group-id' },
    });

    const masked = maskPublicGraphQLError(wrapped);

    expect(masked.toJSON()).toEqual({
      message: new PublicGraphQLError('NOT_FOUND').message,
      extensions: { code: 'NOT_FOUND' },
    });
  });

  it.each([
    new Error('SELECT secret FROM sessions'),
    new GraphQLError('Did you mean "groups"?', {
      extensions: { code: 'NOT_FOUND' },
    }),
    new GraphQLError('x', { originalError: new Error('stack') }),
    'string throw',
    undefined,
  ])('許可外の例外(%#)はSERVICE_UNAVAILABLEへmaskする', (error) => {
    const masked = maskPublicGraphQLError(error);

    expect(masked.toJSON()).toEqual({
      message: new PublicGraphQLError('SERVICE_UNAVAILABLE').message,
      extensions: { code: 'SERVICE_UNAVAILABLE' },
    });
    expect(masked.originalError).toBeUndefined();
  });

  it('YogaのHTTP層4xx（originalErrorなし）はINVALID_REQUESTとstatus・Allowだけを残す', () => {
    const masked = maskPublicGraphQLError(
      new GraphQLError('Unexpected token in JSON at position 3', {
        extensions: {
          http: { status: 405, headers: { Allow: 'POST', 'X-Leak': 'v' } },
        },
      }),
    );

    expect(masked.message).toBe(
      new PublicGraphQLError('INVALID_REQUEST').message,
    );
    expect(masked.extensions).toEqual({
      code: 'INVALID_REQUEST',
      http: { status: 405, headers: { Allow: 'POST' } },
    });
  });

  it.each([500, 401, 403])(
    'HTTP層でも許可外status(%s)はSERVICE_UNAVAILABLEへmaskする',
    (status) => {
      expect(
        maskPublicGraphQLError(
          new GraphQLError('x', { extensions: { http: { status } } }),
        ).extensions,
      ).toEqual({ code: 'SERVICE_UNAVAILABLE' });
    },
  );

  it('405の実行前拒否はAllow: POSTを付ける', () => {
    const response = publicGraphQLErrorResponse(
      'INVALID_REQUEST',
      405,
      requestId,
    );
    expect(response.headers.get('allow')).toBe('POST');
    expect(
      publicGraphQLErrorResponse('INVALID_REQUEST', 400, requestId).headers.has(
        'allow',
      ),
    ).toBe(false);
  });

  it('実行前拒否のResponseはdataなし・no-store・nosniff', async () => {
    const response = publicGraphQLErrorResponse(
      'REQUEST_REJECTED',
      403,
      requestId,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-type')).toBe('application/json');
    await expect(response.json()).resolves.toEqual({
      errors: [
        {
          message: new PublicGraphQLError('REQUEST_REJECTED').message,
          extensions: { code: 'REQUEST_REJECTED', requestId },
        },
      ],
    });
  });
});
