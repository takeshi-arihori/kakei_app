import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const collectOpenApiOperations = (source) => {
  const operations = [];
  let currentPath;

  for (const line of source.split('\n')) {
    const pathMatch = line.match(/^  (\/[^:]+):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }

    const methodMatch = line.match(/^    (get|post|put|patch|delete|options|head):\s*$/);
    if (currentPath && methodMatch) {
      operations.push(`${methodMatch[1].toUpperCase()} ${currentPath}`);
    }
  }

  return operations.sort();
};

const collectReadmeEndpoints = (source) =>
  [...source.matchAll(/^- `([A-Z]+ \/[^`]+)`:/gm)]
    .map((match) => match[1])
    .sort();

const expectedPublicEndpoints = ['GET /health', 'POST /graphql'];
const [openApi, apiDocsReadme, apiReadme, compose, app, rootReadme, envExample] =
  await Promise.all([
    read('docs/api/openapi.yaml'),
    read('docs/api/README.md'),
    read('apps/api/README.md'),
    read('compose.yml'),
    read('apps/api/src/app.ts'),
    read('README.md'),
    read('.env.example'),
  ]);

assert(openApi.startsWith('openapi: 3.1.0\n'), 'OpenAPI 3.1.0 must be declared');
assert(
  JSON.stringify(collectOpenApiOperations(openApi)) ===
    JSON.stringify(expectedPublicEndpoints),
  'OpenAPI operations must match the supported public HTTP endpoints',
);
assert(openApi.includes('operationId: getHealth'), 'GET /health needs operationId');
assert(
  openApi.includes('operationId: executeGraphQL'),
  'POST /graphql needs operationId',
);
assert(
  openApi.includes('../apps/api/schema.graphql'),
  'OpenAPI must link to the canonical GraphQL SDL',
);
assert(
  !openApi.includes('apiStatus'),
  'OpenAPI must not duplicate GraphQL business fields',
);

for (const [name, source] of [
  ['docs/api/README.md', apiDocsReadme],
  ['apps/api/README.md', apiReadme],
]) {
  assert(
    JSON.stringify(collectReadmeEndpoints(source)) ===
      JSON.stringify(expectedPublicEndpoints),
    `${name} endpoint list must match OpenAPI`,
  );
  assert(
    source.includes('apps/api/schema.graphql'),
    `${name} must identify the canonical GraphQL SDL`,
  );
}

assert(
  app.includes("app.on(['GET', 'POST', 'OPTIONS'], '/graphql'"),
  'The documented Yoga transport boundary must match app.ts',
);
assert(
  apiDocsReadme.includes('GET`／`OPTIONS /graphql`'),
  'The non-public Yoga transport methods must be documented',
);
assert(
  compose.includes('docker.swagger.io/swaggerapi/swagger-ui:v5.33.0'),
  'Swagger UI image must use the reviewed fixed version',
);
assert(
  compose.includes('SUPPORTED_SUBMIT_METHODS: "[]"'),
  'Swagger UI submit methods must be disabled',
);
assert(
  compose.includes('VALIDATOR_URL: none'),
  'Swagger UI external validator must be disabled',
);
assert(
  compose.includes('./docs/api/openapi.yaml:/spec/openapi.yaml:ro'),
  'OpenAPI document must be mounted read-only',
);
assert(
  rootReadme.includes('docker compose up -d swagger-ui'),
  'Root README must document Swagger UI startup',
);
assert(
  envExample.includes('SWAGGER_UI_PORT=8081'),
  '.env.example must document the Swagger UI port',
);

console.log('API documentation contract check passed');
