import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as columns from './authentication-columns.js';

const directory = import.meta.dirname;

describe('認証PostgreSQL Adapterの明示列', () => {
  it('Production Codeは認証Tableを`SELECT *`で読まない', () => {
    const offenders = readdirSync(directory)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
      .filter((name) =>
        /SELECT\s+\*\s+FROM/i.test(
          readFileSync(resolve(directory, name), 'utf8').replace(
            /\/\*[\s\S]*?\*\//g,
            '',
          ),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it('列定数は重複列を持たない', () => {
    for (const [name, value] of Object.entries(columns)) {
      const list = value.split(',');
      expect([name, new Set(list).size]).toEqual([name, list.length]);
    }
  });
});
