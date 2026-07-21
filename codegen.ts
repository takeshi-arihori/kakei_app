import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: 'apps/api/schema.graphql',
  documents: ['apps/web/src/**/*.ts'],
  generates: {
    'apps/api/src/presentation/graphql/generated/resolvers.ts': {
      plugins: ['typescript', 'typescript-resolvers'],
    },
    'apps/web/src/shared/graphql/generated.ts': {
      plugins: ['typescript', 'typescript-operations'],
    },
  },
  ignoreNoDocuments: false,
};

export default config;
