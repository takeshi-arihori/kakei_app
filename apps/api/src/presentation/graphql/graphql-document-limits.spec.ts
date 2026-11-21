import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';

import {
  GRAPHQL_ENTRY_LIMITS,
  checkGraphQLDocument,
  type GraphQLDocumentPolicy,
} from './graphql-document-limits.js';
import { GraphQLEntryRejection } from './graphql-request-body.js';
import type { GraphQLRequestBody } from './graphql-request-body.js';

const schema = buildSchema(/* GraphQL */ `
  type Query {
    apiStatus: S
    a: S
    b: S
    c: S
    d: S
    e: S
    f: S
    node: N
    echo(n: Int!): Int
    secret1: S
    secret2: S
  }
  type Mutation {
    m1: S
    m2: S
    secretMutation: S
  }
  type N {
    child: N
    value: Int
  }
  type S {
    status: String
  }
`);

const policy: GraphQLDocumentPolicy = {
  publicRootFields: new Set([
    'Query.apiStatus',
    'Query.a',
    'Query.b',
    'Query.c',
    'Query.d',
    'Query.e',
    'Query.f',
    'Query.node',
    'Query.echo',
    'Mutation.m1',
    'Mutation.m2',
  ]),
};

const check = (
  query: string,
  extra: Omit<GraphQLRequestBody, 'query'> = {},
  usedPolicy: GraphQLDocumentPolicy = policy,
) => checkGraphQLDocument(schema, { query, ...extra }, usedPolicy);

const expectRejected = (
  query: string,
  extra: Omit<GraphQLRequestBody, 'query'> = {},
  usedPolicy: GraphQLDocumentPolicy = policy,
) => {
  try {
    check(query, extra, usedPolicy);
  } catch (error) {
    expect(error).toBeInstanceOf(GraphQLEntryRejection);
    expect((error as GraphQLEntryRejection).status).toBe(400);
    return;
  }
  expect.unreachable(`accepted: ${query}`);
};

/** 深さnのnode連鎖。node=1、child=2..n-1、value=n。 */
const nested = (depth: number): string => {
  let inner = 'value';
  for (let level = depth - 1; level >= 2; level--) inner = `child { ${inner} }`;
  return `{ node { ${inner} } }`;
};

describe('checkGraphQLDocument', () => {
  it('承認値どおりの上限を持つ', () => {
    expect(GRAPHQL_ENTRY_LIMITS).toEqual({
      maxTokens: 1000,
      maxDepth: 5,
      maxAliases: 5,
      maxRootFields: 5,
      maxAuthenticatedRootFields: 1,
      maxMutationRootFields: 1,
      maxDirectives: 10,
      maxValidationErrors: 1,
    });
  });

  it('上限内のQueryとMutationを受理し、Operation種別を返す', () => {
    expect(check('query A { apiStatus { status } }')).toEqual({
      operation: 'query',
    });
    expect(check('mutation { m1 { status } }')).toEqual({
      operation: 'mutation',
    });
  });

  describe('構文・検証', () => {
    it.each([
      ['構文Error', '{ apiStatus { status }'],
      ['未知field', '{ apiStatuss { status } }'],
      ['空文書', ''],
      ['型定義', 'type X { a: Int }'],
      ['fragment循環', '{ node { ...F } } fragment F on N { child { ...F } }'],
    ])('%sを拒否する', (_label, query) => expectRejected(query));
  });

  describe('introspection', () => {
    it.each([
      ['__schema', '{ __schema { types { name } } }'],
      ['__type', '{ __type(name: "S") { name } }'],
      [
        '入れ子の__schema',
        '{ node { ... on N { value } } __schema { queryType { name } } }',
      ],
    ])('%sを拒否する', (_label, query) => expectRejected(query));

    it('__typenameは許可する', () => {
      expect(check('{ __typename node { __typename } }')).toEqual({
        operation: 'query',
      });
    });
  });

  describe('token数', () => {
    /** `{`と`}`を含めてcount個のtokenになる文書。 */
    const tokens = (count: number) => `{ ${'__typename '.repeat(count - 2)}}`;

    it('1,000 tokenちょうどは受理し、1,001は拒否する', () => {
      expect(check(tokens(1000))).toEqual({ operation: 'query' });
      expectRejected(tokens(1001));
    });
  });

  describe('深さ', () => {
    it('深さ5は受理し、6は拒否する', () => {
      expect(check(nested(5))).toEqual({ operation: 'query' });
      expectRejected(nested(6));
    });

    it('fragmentとinline fragmentを展開した深さで数える', () => {
      expect(
        check(
          '{ node { ...F } } fragment F on N { child { ... on N { child { child { value } } } } }',
        ),
      ).toEqual({ operation: 'query' });
      expectRejected(
        '{ node { ...F } } fragment F on N { child { ... on N { child { child { child { value } } } } } }',
      );
    });

    it('fragmentの多重展開でも計算量が増えない', () => {
      const fragments = Array.from(
        { length: 12 },
        (_unused, index) =>
          `fragment F${index} on N { ${index === 11 ? 'value' : `...F${index + 1} ...F${index + 1}`} }`,
      ).join(' ');
      expect(check(`{ node { ...F0 } } ${fragments}`)).toEqual({
        operation: 'query',
      });
    });
  });

  describe('alias', () => {
    const aliases = (count: number) =>
      `{ node { ${Array.from({ length: count }, (_unused, index) => `v${index}: value`).join(' ')} } }`;

    it('文書全体で5は受理し、6は拒否する', () => {
      expect(check(aliases(5))).toEqual({ operation: 'query' });
      expectRejected(aliases(6));
    });

    it('fragment内のaliasも数える', () => {
      expectRejected(
        '{ node { x1: value x2: value x3: value ...F } } fragment F on N { y1: value y2: value y3: value }',
      );
    });
  });

  describe('top-level field', () => {
    it('5は受理し、6は拒否する', () => {
      expect(
        check(
          '{ apiStatus { status } a { status } b { status } c { status } d { status } }',
        ),
      ).toEqual({
        operation: 'query',
      });
      expectRejected(
        '{ apiStatus { status } a { status } b { status } c { status } d { status } e { status } }',
      );
    });

    it('fragment経由のroot fieldも数える', () => {
      expectRejected(
        '{ apiStatus { status } ...R } fragment R on Query { a { status } b { status } c { status } d { status } e { status } }',
      );
    });

    it('同じresponse keyの重複は実行時と同じく1つと数える', () => {
      expect(
        check(
          '{ a { status } a { status } ...R } fragment R on Query { a { status } }',
        ),
      ).toEqual({ operation: 'query' });
    });
  });

  describe('認証付きtop-level field', () => {
    it('1は受理し、2は拒否する', () => {
      expect(check('{ secret1 { status } apiStatus { status } }')).toEqual({
        operation: 'query',
      });
      expectRejected('{ secret1 { status } secret2 { status } }');
    });

    it('aliasによる同一fieldの複製も数える', () => {
      expectRejected('{ x: secret1 { status } y: secret1 { status } }');
    });

    it('fragment経由でも数える', () => {
      expectRejected(
        '{ ...R } fragment R on Query { secret1 { status } ... on Query { secret2 { status } } }',
      );
    });

    it('許可Listにないroot fieldは認証付きとして数える（空Listでも検証できる）', () => {
      const empty: GraphQLDocumentPolicy = { publicRootFields: new Set() };
      expect(check('{ apiStatus { status } __typename }', {}, empty)).toEqual({
        operation: 'query',
      });
      expectRejected('{ apiStatus { status } a { status } }', {}, empty);
    });

    it('Mutationのroot fieldにも適用する', () => {
      expectRejected(
        'mutation { secretMutation { status } x: secretMutation { status } }',
      );
    });
  });

  describe('Mutation field', () => {
    it('1は受理し、2は拒否する', () => {
      expect(check('mutation { m1 { status } }')).toEqual({
        operation: 'mutation',
      });
      expectRejected('mutation { m1 { status } m2 { status } }');
    });
  });

  describe('directive', () => {
    const directives = (count: number) =>
      `{ node { ${'value @include(if: true) '.repeat(count)}} }`;

    it('文書全体で10は受理し、11は拒否する', () => {
      expect(check(directives(10))).toEqual({ operation: 'query' });
      expectRejected(directives(11));
    });
  });

  describe('Operation選択', () => {
    const two = 'query A { apiStatus { status } } query B { a { status } }';

    it('operationNameで1つを選ぶ', () => {
      expect(check(two, { operationName: 'B' })).toEqual({
        operation: 'query',
      });
    });

    it.each([
      ['名前なしで複数', {}],
      ['存在しない名前', { operationName: 'C' }],
    ])('%sは拒否する', (_label, extra) => expectRejected(two, extra));

    it('Schemaにないsubscriptionは拒否する', () => {
      expectRejected('subscription { a { status } }');
    });

    it('選択しないOperationの上限違反も拒否する', () => {
      expectRejected(
        `query A { apiStatus { status } } ${nested(6).replace('{', 'query B {')}`,
        {
          operationName: 'A',
        },
      );
    });
  });

  describe('変数', () => {
    const query = 'query Q($n: Int!) { echo(n: $n) }';

    it('型の合う変数を受理する', () => {
      expect(check(query, { variables: { n: 1 } })).toEqual({
        operation: 'query',
      });
    });

    it.each([
      ['型不正', { variables: { n: 'x' } }],
      ['必須の欠落', {}],
    ])('%sは実行前に拒否する', (_label, extra) => expectRejected(query, extra));
  });
});
