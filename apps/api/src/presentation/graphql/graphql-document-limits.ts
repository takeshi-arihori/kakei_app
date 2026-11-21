import {
  Kind,
  NoSchemaIntrospectionCustomRule,
  OperationTypeNode,
  getOperationAST,
  getVariableValues,
  parse,
  specifiedRules,
  validate,
  visit,
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLSchema,
  type SelectionSetNode,
} from 'graphql';

import {
  GraphQLEntryRejection,
  type GraphQLRequestBody,
} from './graphql-request-body.js';

/** #293で承認した`/graphql`の固定上限。値を変えるときはADRを更新する。 */
export const GRAPHQL_ENTRY_LIMITS = {
  /** parseするtoken数（EOFを除く）。 */
  maxTokens: 1000,
  /** fragment展開後のfield選択の深さ。root fieldを1と数える。 */
  maxDepth: 5,
  /** 文書全体のalias数。 */
  maxAliases: 5,
  /** 1 Operationのtop-level field（response key）数。 */
  maxRootFields: 5,
  /** 1 Operationの認証付きtop-level field数。 */
  maxAuthenticatedRootFields: 1,
  /** 1 Mutationのtop-level field数。 */
  maxMutationRootFields: 1,
  /** 文書全体のdirective数。 */
  maxDirectives: 10,
  /** 検証を打ち切るError数。 */
  maxValidationErrors: 1,
} as const;

/** Schema上で「認証付きfield」を判定する方針。 */
export interface GraphQLDocumentPolicy {
  /**
   * 未認証で公開するroot fieldの`Type.field`。ここにないroot fieldは、
   * `__typename`を除きすべて認証付きとして数える（印の付け忘れで上限を迂回させない）。
   */
  readonly publicRootFields: ReadonlySet<string>;
}

/** 実行前検査を通過したOperationの要約。 */
export interface CheckedGraphQLOperation {
  /** 実行するOperationの種別。Schemaにない種別は検査で拒否済み。 */
  readonly operation: 'query' | 'mutation';
}

const reject = (): never => {
  throw new GraphQLEntryRejection(400);
};

const parseDocument = (query: string): DocumentNode => {
  try {
    return parse(query, { maxTokens: GRAPHQL_ENTRY_LIMITS.maxTokens });
  } catch {
    return reject();
  }
};

const countStatic = (document: DocumentNode): void => {
  let aliases = 0;
  let directives = 0;
  visit(document, {
    Field(node) {
      if (node.alias) aliases++;
    },
    Directive() {
      directives++;
    },
  });
  if (
    aliases > GRAPHQL_ENTRY_LIMITS.maxAliases ||
    directives > GRAPHQL_ENTRY_LIMITS.maxDirectives
  )
    reject();
};

/**
 * 標準検証済み（循環なし・既知fragmentのみ）の文書で、fragmentを展開した深さを求める。
 * fragmentごとにmemoし、多重展開でも計算量を文書の大きさに比例させる。
 */
const depthCalculator = (
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
) => {
  const memo = new Map<string, number>();
  const depth = (selectionSet: SelectionSetNode | undefined): number => {
    let deepest = 0;
    for (const selection of selectionSet?.selections ?? []) {
      if (selection.kind === Kind.FIELD)
        deepest = Math.max(deepest, 1 + depth(selection.selectionSet));
      else if (selection.kind === Kind.INLINE_FRAGMENT)
        deepest = Math.max(deepest, depth(selection.selectionSet));
      else {
        const name = selection.name.value;
        if (!memo.has(name))
          memo.set(name, depth(fragments.get(name)?.selectionSet));
        deepest = Math.max(deepest, memo.get(name)!);
      }
    }
    return deepest;
  };
  return depth;
};

/** 実行時のfield収集と同じく、response keyごとに1つのroot fieldとして数える。 */
const rootFieldNames = (
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
): Map<string, string> => {
  const fields = new Map<string, string>();
  const visited = new Set<string>();
  const collect = (current: SelectionSetNode | undefined): void => {
    for (const selection of current?.selections ?? []) {
      if (selection.kind === Kind.FIELD)
        fields.set(
          selection.alias?.value ?? selection.name.value,
          selection.name.value,
        );
      else if (selection.kind === Kind.INLINE_FRAGMENT)
        collect(selection.selectionSet);
      else if (!visited.has(selection.name.value)) {
        visited.add(selection.name.value);
        collect(fragments.get(selection.name.value)?.selectionSet);
      }
    }
  };
  collect(selectionSet);
  return fields;
};

const checkOperations = (
  schema: GraphQLSchema,
  document: DocumentNode,
  policy: GraphQLDocumentPolicy,
): void => {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions)
    if (definition.kind === Kind.FRAGMENT_DEFINITION)
      fragments.set(definition.name.value, definition);
  const depth = depthCalculator(fragments);
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
    const rootType = schema.getRootType(definition.operation);
    if (!rootType || definition.operation === OperationTypeNode.SUBSCRIPTION)
      return reject();
    if (depth(definition.selectionSet) > GRAPHQL_ENTRY_LIMITS.maxDepth)
      reject();
    const fields = rootFieldNames(definition.selectionSet, fragments);
    const authenticated = [...fields.values()].filter(
      (name) =>
        !name.startsWith('__') &&
        !policy.publicRootFields.has(`${rootType.name}.${name}`),
    ).length;
    if (
      fields.size > GRAPHQL_ENTRY_LIMITS.maxRootFields ||
      authenticated > GRAPHQL_ENTRY_LIMITS.maxAuthenticatedRootFields ||
      (definition.operation === OperationTypeNode.MUTATION &&
        fields.size > GRAPHQL_ENTRY_LIMITS.maxMutationRootFields)
    )
      reject();
  }
};

/**
 * GraphQL文書を実行前に検査する。構文・検証・introspection・上限・Operation選択・変数の
 * どれに違反しても同じ400拒否にし、graphql-jsのmessageや候補表示を外へ出さない。
 * 文書内のすべてのOperationへ上限を適用する。
 * @param schema 実行するSchema。
 * @param body 形を検査済みのRequest Body。
 * @param policy 認証付きfieldの判定方針。
 * @returns 実行するOperationの種別。
 * @throws 違反はすべて`GraphQLEntryRejection(400)`。
 */
export const checkGraphQLDocument = (
  schema: GraphQLSchema,
  body: GraphQLRequestBody,
  policy: GraphQLDocumentPolicy,
): CheckedGraphQLOperation => {
  const document = parseDocument(body.query);
  if (
    validate(
      schema,
      document,
      [...specifiedRules, NoSchemaIntrospectionCustomRule],
      { maxErrors: GRAPHQL_ENTRY_LIMITS.maxValidationErrors },
    ).length > 0
  )
    reject();
  countStatic(document);
  checkOperations(schema, document, policy);
  const operation = getOperationAST(document, body.operationName);
  if (!operation || operation.operation === OperationTypeNode.SUBSCRIPTION)
    return reject();
  const coerced = getVariableValues(
    schema,
    operation.variableDefinitions ?? [],
    body.variables ?? {},
    { maxErrors: GRAPHQL_ENTRY_LIMITS.maxValidationErrors },
  );
  if (coerced.errors) reject();
  return {
    operation:
      operation.operation === OperationTypeNode.MUTATION ? 'mutation' : 'query',
  };
};
