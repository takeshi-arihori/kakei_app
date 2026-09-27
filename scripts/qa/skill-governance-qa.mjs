import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const normalizePath = (path) => path.replaceAll('\\', '/');

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const collectFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else {
      files.push(path);
    }
  }

  return files;
};

const forbiddenTechnologyTerms = [
  'PostgreSQL',
  'MySQL',
  'SQLite',
  'DynamoDB',
  'MongoDB',
  'Prisma',
  'Drizzle',
  'TypeScript',
  'JavaScript',
  'PHP',
  'Laravel',
  'NestJS',
  'Hono',
  'Next.js',
  'React',
  'GraphQL',
];

const skillFiles = (await collectFiles(join(root, '.agents', 'skills'))).filter(
  (path) => normalizePath(path).endsWith('/SKILL.md'),
);

const evaluatorFiles = (await collectFiles(join(root, '.codex', 'agents'))).filter(
  (path) => extname(path) === '.toml',
);

for (const path of [...skillFiles, ...evaluatorFiles]) {
  const source = await readFile(path, 'utf8');
  const repositoryPath = normalizePath(relative(root, path));

  for (const term of forbiddenTechnologyTerms) {
    assert(
      !source.includes(term),
      `${repositoryPath} must not hard-code project technology "${term}"; read it from docs instead`,
    );
  }
}

const ruleReferences = (await collectFiles(join(root, '.agents', 'skills'))).filter(
  (path) => {
    const normalized = normalizePath(path);
    return normalized.includes('/references/') && /rules?\.md$/i.test(normalized);
  },
);

for (const path of ruleReferences) {
  const source = await readFile(path, 'utf8');
  const repositoryPath = normalizePath(relative(root, path));

  assert(
    source.includes('docs/') && source.includes('移行済み'),
    `${repositoryPath} must be a compatibility pointer; normative rules belong under docs/`,
  );
}

console.log(
  `Skill governance check passed (${skillFiles.length} skills, ${evaluatorFiles.length} evaluators)`,
);
