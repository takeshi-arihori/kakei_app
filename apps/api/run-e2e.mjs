import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const result = spawnSync(
  'pnpm',
  ['exec', 'jest', '--config', './test/jest-e2e.json', '--verbose', '--forceExit'],
  {
    cwd: new URL('.', import.meta.url).pathname,
    encoding: 'utf8',
    shell: true,
  },
);

const output = [
  `exitCode: ${result.status}`,
  '--- stdout ---',
  result.stdout ?? '',
  '--- stderr ---',
  result.stderr ?? '',
].join('\n');

writeFileSync(new URL('./e2e-run.log', import.meta.url), output);
process.exit(result.status ?? 1);
