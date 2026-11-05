// GitHub Issue／PRを再取得し、保存しようとした内容と一致するかを読取りだけで確認する。
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const COMMON_FIELDS = ['title', 'body', 'state', 'labels', 'milestone', 'projectItems'];
const FIELDS = {
  issue: new Set(COMMON_FIELDS),
  pr: new Set([...COMMON_FIELDS, 'isDraft', 'baseRefName', 'headRefName']),
};
const USAGE = 'usage: verify-github-item.mjs <issue|pr> <number> <expected.json>';

const normalizeText = (text) => text.replaceAll('\r\n', '\n').trimEnd();

const canonicalize = (field, value) => {
  switch (field) {
    case 'body':
      return normalizeText(value ?? '');
    case 'labels':
      return value.map((label) => label.name ?? label).sort();
    case 'milestone':
      return value?.title ?? (typeof value === 'string' ? value : null);
    case 'projectItems':
      return value
        .map(({ title, status }) => ({
          title,
          status: (typeof status === 'string' ? status : status?.name) || null,
        }))
        .sort((left, right) => left.title.localeCompare(right.title));
    default:
      return value;
  }
};

const describeBodyDifference = (expected, actual) => {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const line = expectedLines.findIndex((text, index) => text !== actualLines[index]);
  const at = line === -1 ? expectedLines.length : line;
  const excerpt = (text) => JSON.stringify((text ?? '<なし>').slice(0, 80));

  return `${at + 1}行目 expected=${excerpt(expectedLines[at])} actual=${excerpt(actualLines[at])}`;
};

export const compareItem = (expected, actual) => {
  const differences = [];

  for (const [field, value] of Object.entries(expected)) {
    const wanted = canonicalize(field, value);
    const found = canonicalize(field, actual[field]);

    if (JSON.stringify(wanted) !== JSON.stringify(found)) {
      differences.push({
        field,
        detail:
          field === 'body'
            ? describeBodyDifference(wanted, found)
            : `expected=${JSON.stringify(wanted)} actual=${JSON.stringify(found)}`,
      });
    }
  }

  return differences;
};

export const buildExpected = async (kind, raw, readBody) => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('expected must be a JSON object');
  }

  const { bodyFile, ...expected } = raw;
  if (bodyFile !== undefined) {
    if ('body' in expected) {
      throw new Error('specify either body or bodyFile');
    }
    expected.body = await readBody(bodyFile);
  }

  const fields = Object.keys(expected);
  if (fields.length === 0) {
    throw new Error('expected must name at least one field');
  }
  for (const field of fields) {
    if (!FIELDS[kind].has(field)) {
      throw new Error(`unsupported field for ${kind}: ${field}`);
    }
  }

  return expected;
};

const main = async ([kind, number, expectedPath]) => {
  if (!Object.hasOwn(FIELDS, kind ?? '') || !/^[1-9]\d*$/.test(number ?? '') || !expectedPath) {
    throw new Error(USAGE);
  }

  const raw = JSON.parse(await readFile(expectedPath, 'utf8'));
  const expected = await buildExpected(kind, raw, (path) => readFile(path, 'utf8'));
  const { stdout } = await promisify(execFile)(
    'gh',
    [kind, 'view', number, '--json', Object.keys(expected).join(',')],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  const differences = compareItem(expected, JSON.parse(stdout));

  if (differences.length > 0) {
    for (const { field, detail } of differences) {
      console.error(`${kind} #${number} ${field}: ${detail}`);
    }
    return 1;
  }

  console.log(`${kind} #${number} matches: ${Object.keys(expected).join(', ')}`);
  return 0;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 2;
    },
  );
}
