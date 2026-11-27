import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: 'apps/api/schema.graphql',
  documents: ['apps/web/src/**/*.ts'],
  generates: {
    'apps/api/src/presentation/graphql/generated/resolvers.ts': {
      plugins: ['typescript', 'typescript-resolvers'],
    },
    // typescript-operations v6は、Operationが使う入力型・enumを自前で出力する。
    // `typescript` pluginを併用すると同名型が重複宣言になる。
    'apps/web/src/shared/graphql/generated.ts': {
      plugins: ['typescript-operations'],
    },
  },
  ignoreNoDocuments: false,
};

export default config;
