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

const agentFiles = (await collectFiles(join(root, '.claude', 'agents'))).filter(
  (path) => extname(path) === '.md',
);

const requiredAgents = [
  'code-reviewer.md',
  'security-reviewer.md',
  'test-reviewer.md',
  'work-planning-evaluator.md',
];
const allowedAgentKeys = new Set(['name', 'description', 'tools', 'readonly']);
const readOnlyTools = new Set(['Read', 'Grep', 'Glob']);

for (const name of requiredAgents) {
  assert(
    agentFiles.some((path) => normalizePath(path).endsWith(`/.claude/agents/${name}`)),
    `.claude/agents/${name} must exist`,
  );
}

for (const path of agentFiles) {
  const source = await readFile(path, 'utf8');
  const repositoryPath = normalizePath(relative(root, path));
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/)?.[1];

  assert(frontmatter, `${repositoryPath} must start with frontmatter`);

  const entries = frontmatter.split('\n').map((line) => line.match(/^([\w-]+):\s*(.*)$/));
  assert(entries.every(Boolean), `${repositoryPath} frontmatter must use single-line keys`);

  const keys = entries.map(([, key]) => key);
  assert(new Set(keys).size === keys.length, `${repositoryPath} must not repeat frontmatter keys`);
  for (const key of keys) {
    assert(allowedAgentKeys.has(key), `${repositoryPath} must not set frontmatter key "${key}"`);
  }

  const values = new Map(entries.map(([, key, value]) => [key, value]));
  assert(values.get('readonly') === 'true', `${repositoryPath} must set readonly: true`);

  const tools = values.get('tools')?.split(',').map((tool) => tool.trim());
  assert(tools, `${repositoryPath} must declare tools explicitly`);
  for (const tool of tools) {
    assert(readOnlyTools.has(tool), `${repositoryPath} must not allow non read-only tool "${tool}"`);
  }
}

for (const path of [...skillFiles, ...agentFiles]) {
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
  `Skill governance check passed (${skillFiles.length} skills, ${agentFiles.length} agents)`,
);
