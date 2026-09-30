import assert from 'node:assert/strict';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

import {
  collectGraphqlRootOperations,
  validateGraphqlContractCatalog,
} from './api-docs-validator.mjs';

const schemaSource = `
  type Query {
    apiStatus: ApiStatus!
  }

  type Mutation {
    refreshStatus(reason: String!): ApiStatus!
  }

  type ApiStatus {
    status: String!
  }
`;

const entry = (operation) => `
## ${operation}

- Knowledge State: Confirmed
- Context: Shared API
- Use Case: APIの疎通状態を確認する
- Actor: 現行transportへ到達できるclient
- Authorization: 現行実装に認証Guardはない
- Input: ${operation.startsWith('Query.') ? 'なし' : 'reason'}
- Result: ApiStatus
- Error: Operation固有Errorなし
- Idempotency: 状態を変更しない
- Concurrency / Retry: 同じRequestを再実行できる
- Compatibility: SDLを正本として確認する
- Schema: [schema](../../apps/api/schema.graphql)
- Implementation: [resolver](../../apps/api/src/presentation/graphql/resolvers.ts)
- Test: [test](../../apps/api/src/app.spec.ts)
`;

const validCatalog = `${entry('Query.apiStatus')}${entry(
  'Mutation.refreshStatus',
)}`;

const existingReferences = new Set([
  '../../apps/api/schema.graphql',
  '../../apps/api/src/presentation/graphql/resolvers.ts',
  '../../apps/api/src/app.spec.ts',
]);

const repositoryRoot = '/repository';
const catalogDirectory = '/repository/docs/api';
const existingRepositoryFiles = new Set(
  [...existingReferences].map((reference) =>
    resolve(catalogDirectory, reference),
  ),
);
const boundedReferenceExists = (reference) => {
  const resolvedReference = resolve(catalogDirectory, reference);
  const repositoryRelativePath = relative(repositoryRoot, resolvedReference);

  return (
    repositoryRelativePath !== '..' &&
    !repositoryRelativePath.startsWith(`..${sep}`) &&
    !isAbsolute(repositoryRelativePath) &&
    existingRepositoryFiles.has(resolvedReference)
  );
};

const validate = (
  catalogSource,
  referenceExists = (reference) => existingReferences.has(reference),
) =>
  validateGraphqlContractCatalog({
    schemaSource,
    catalogSource,
    referenceExists,
  });

describe('GraphQL contract catalog validator', () => {
  it('正常なQuery／Mutation catalogを受理する', () => {
    assert.doesNotThrow(() => validate(validCatalog));
  });

  it('SDL Operationに対応するcatalog entryがない場合は拒否する', () => {
    assert.throws(
      () => validate(entry('Query.apiStatus')),
      /Missing catalog entries: Mutation\.refreshStatus/,
    );
  });

  it('SDLの同じ行に追加されたOperationのcatalog欠落を拒否する', () => {
    const singleLineSchema =
      'type Query { apiStatus: ApiStatus! @deprecated(reason: "legacy") undocumented: ApiStatus! }';

    assert.throws(
      () =>
        validateGraphqlContractCatalog({
          schemaSource: singleLineSchema,
          catalogSource: entry('Query.apiStatus'),
          referenceExists: (reference) => existingReferences.has(reference),
        }),
      /Missing catalog entries: Query\.undocumented/,
    );
  });

  it('DescriptionとComment内のfield風文字列をOperationとして扱わない', () => {
    const describedSchema = `
      type Query {
        """説明内の fake: String と } は構文ではない"""
        apiStatus: ApiStatus! # ghost: String
      }
    `;

    assert.doesNotThrow(() =>
      validateGraphqlContractCatalog({
        schemaSource: describedSchema,
        catalogSource: entry('Query.apiStatus'),
        referenceExists: (reference) => existingReferences.has(reference),
      }),
    );
  });

  it('type directiveのobject値ではなく実際のbodyからOperationを収集する', () => {
    const directedSchema =
      'type Query @tag(config: {apiStatus: true}) { undocumented: ApiStatus! }';

    assert.deepEqual(collectGraphqlRootOperations(directedSchema), [
      'Query.undocumented',
    ]);
    assert.throws(
      () =>
        validateGraphqlContractCatalog({
          schemaSource: directedSchema,
          catalogSource: entry('Query.apiStatus'),
          referenceExists: boundedReferenceExists,
        }),
      /Missing catalog entries: Query\.undocumented.*Catalog entries absent from SDL: Query\.apiStatus/,
    );
  });

  it('同じOperationのcatalog entryが重複する場合は拒否する', () => {
    assert.throws(
      () => validate(`${validCatalog}${entry('Query.apiStatus')}`),
      /Duplicate catalog entry: Query\.apiStatus/,
    );
  });

  it('SDLに存在しないcatalog entryを拒否する', () => {
    assert.throws(
      () => validate(`${validCatalog}${entry('Query.unknown')}`),
      /Catalog entries absent from SDL: Query\.unknown/,
    );
  });

  it('必須項目が欠落する場合は拒否する', () => {
    const withoutAuthorization = validCatalog.replace(
      '- Authorization: 現行実装に認証Guardはない\n',
      '',
    );

    assert.throws(
      () => validate(withoutAuthorization),
      /Query\.apiStatus is missing required field: Authorization/,
    );
  });

  it('後続の一般H2にある項目でOperation entryの欠落を補えない', () => {
    const querySchema = 'type Query { apiStatus: ApiStatus! }';
    const catalogWithAuthorizationOutsideEntry = `${entry(
      'Query.apiStatus',
    ).replace('- Authorization: 現行実装に認証Guardはない\n', '')}
## Open Questions / Gate

- Authorization: 後続Taskで決定する
`;

    assert.throws(
      () =>
        validateGraphqlContractCatalog({
          schemaSource: querySchema,
          catalogSource: catalogWithAuthorizationOutsideEntry,
          referenceExists: boundedReferenceExists,
        }),
      /Query\.apiStatus is missing required field: Authorization/,
    );
  });

  it('同じOperation entry内の項目重複を拒否する', () => {
    const duplicateActor = validCatalog.replace(
      '- Actor: 現行transportへ到達できるclient',
      '- Actor: 現行transportへ到達できるclient\n- Actor: 重複Actor',
    );

    assert.throws(
      () => validate(duplicateActor),
      /Query\.apiStatus has duplicate field: Actor/,
    );
  });

  it('許可されていないKnowledge Stateを拒否する', () => {
    const invalidKnowledgeState = validCatalog.replace(
      '- Knowledge State: Confirmed',
      '- Knowledge State: Implemented',
    );

    assert.throws(
      () => validate(invalidKnowledgeState),
      /Query\.apiStatus has invalid Knowledge State: Implemented/,
    );
  });

  it('存在しないRepository参照を拒否する', () => {
    assert.throws(
      () => validate(validCatalog, () => false),
      /Repository reference does not exist: \.\.\/\.\.\/apps\/api\/schema\.graphql/,
    );
  });

  it('Input項目にある存在しないRepository参照を拒否する', () => {
    const brokenInputReference = validCatalog.replace(
      '- Input: なし',
      '- Input: [request](missing-openapi.yaml)',
    );

    assert.throws(
      () => validate(brokenInputReference),
      /Repository reference does not exist: missing-openapi\.yaml/,
    );
  });

  it('外部HTTPS参照はRepository存在検査の対象外として受理する', () => {
    const catalogWithExternalEvidence = validCatalog.replace(
      '- Context: Shared API',
      '- Context: Shared API。[Issue](https://github.com/example/repo/issues/1)',
    );

    assert.doesNotThrow(() => validate(catalogWithExternalEvidence));
  });

  for (const invalidReference of [
    'file:///etc/passwd',
    '/etc/passwd',
    '../../../etc/passwd',
  ]) {
    it(`Repository外参照 ${invalidReference} を拒否する`, () => {
      const invalidCatalog = validCatalog.replace(
        '../../apps/api/schema.graphql',
        invalidReference,
      );

      assert.throws(
        () => validate(invalidCatalog, boundedReferenceExists),
        /Invalid repository reference|Repository reference does not exist/,
      );
    });
  }
});
