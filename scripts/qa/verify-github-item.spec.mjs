import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildExpected, compareItem } from './verify-github-item.mjs';

describe('compareItem', () => {
  it('accepts the same content across line endings and trailing whitespace', () => {
    assert.deepEqual(
      compareItem({ body: 'a\nb\n' }, { body: 'a\r\nb' }),
      [],
    );
  });

  it('reports the first differing body line without dumping the body', () => {
    const [difference] = compareItem(
      { body: 'same\nexpected\nrest' },
      { body: `same\n${'x'.repeat(81)}\nrest` },
    );

    assert.equal(difference.field, 'body');
    assert.match(difference.detail, /^2行目 /);
    assert.ok(difference.detail.includes(`"${'x'.repeat(80)}"`));
  });

  it('detects a body truncated by the save', () => {
    const [difference] = compareItem({ body: 'a\nb' }, { body: 'a' });

    assert.match(difference.detail, /^2行目 expected="b" actual="<なし>"/);
  });

  it('detects text appended to the body', () => {
    const [difference] = compareItem({ body: 'a' }, { body: 'a\nlog' });

    assert.match(difference.detail, /^2行目 expected="<なし>" actual="log"/);
  });

  it('compares labels as a set of names', () => {
    const actual = { labels: [{ name: 'b' }, { name: 'a' }] };

    assert.deepEqual(compareItem({ labels: ['a', 'b'] }, actual), []);
    assert.equal(compareItem({ labels: ['a'] }, actual).length, 1);
  });

  it('compares milestone by title and treats an unset milestone as null', () => {
    assert.deepEqual(compareItem({ milestone: 'M1' }, { milestone: { title: 'M1' } }), []);
    assert.deepEqual(compareItem({ milestone: null }, { milestone: null }), []);
    assert.equal(compareItem({ milestone: 'M1' }, { milestone: null }).length, 1);
  });

  it('compares project status by name', () => {
    const actual = {
      projectItems: [{ title: 'Board', status: { name: 'Backlog', optionId: 'x' } }],
    };

    assert.deepEqual(
      compareItem({ projectItems: [{ title: 'Board', status: 'Backlog' }] }, actual),
      [],
    );
    assert.equal(
      compareItem({ projectItems: [{ title: 'Board', status: 'Ready' }] }, actual).length,
      1,
    );
  });

  it('compares project items regardless of order', () => {
    const actual = {
      projectItems: [
        { title: 'B', status: { name: 'Ready' } },
        { title: 'A', status: { name: 'Backlog' } },
      ],
    };

    assert.deepEqual(
      compareItem(
        {
          projectItems: [
            { title: 'A', status: 'Backlog' },
            { title: 'B', status: 'Ready' },
          ],
        },
        actual,
      ),
      [],
    );
  });

  it('treats an empty project status as unset', () => {
    assert.deepEqual(
      compareItem(
        { projectItems: [{ title: 'A', status: null }] },
        { projectItems: [{ title: 'A', status: { name: '' } }] },
      ),
      [],
    );
  });

  it('detects a boolean mismatch', () => {
    assert.equal(compareItem({ isDraft: true }, { isDraft: false }).length, 1);
  });
});

describe('buildExpected', () => {
  const readBody = async (path) => `body of ${path}`;

  it('loads bodyFile as body', async () => {
    assert.deepEqual(await buildExpected('issue', { bodyFile: 'x.md' }, readBody), {
      body: 'body of x.md',
    });
  });

  it('rejects an empty expectation instead of passing vacuously', async () => {
    await assert.rejects(buildExpected('issue', {}, readBody), /at least one field/);
  });

  it('rejects a non-object expectation', async () => {
    await assert.rejects(buildExpected('issue', [], readBody), /JSON object/);
  });

  it('rejects both body and bodyFile', async () => {
    await assert.rejects(
      buildExpected('issue', { body: 'a', bodyFile: 'x.md' }, readBody),
      /either body or bodyFile/,
    );
  });

  it('rejects a field that cannot be verified for the kind', async () => {
    await assert.rejects(buildExpected('issue', { isDraft: true }, readBody), /unsupported field/);
    await assert.rejects(buildExpected('pr', { assignees: [] }, readBody), /unsupported field/);
  });
});

describe('command line', () => {
  const script = fileURLToPath(new URL('./verify-github-item.mjs', import.meta.url));
  let directory;
  let expectedPath;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'verify-github-item-'));
    expectedPath = join(directory, 'expected.json');
    await writeFile(expectedPath, JSON.stringify({ title: 'saved' }));
    const fakeGh = join(directory, 'gh');
    await writeFile(
      fakeGh,
      '#!/bin/sh\nif [ "$FAKE_GH_FAIL" = "1" ]; then echo denied >&2; exit 1; fi\necho "$FAKE_GH_OUTPUT"\n',
    );
    await chmod(fakeGh, 0o755);
  });

  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const run = (args, env = {}) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH}`,
        ...env,
      },
    });

  it('exits 0 when the saved item matches', () => {
    const output = JSON.stringify({ title: 'saved' });

    assert.equal(run(['issue', '1', expectedPath], { FAKE_GH_OUTPUT: output }).status, 0);
  });

  it('exits 1 when the saved item differs', () => {
    const output = JSON.stringify({ title: 'other' });

    assert.equal(run(['issue', '1', expectedPath], { FAKE_GH_OUTPUT: output }).status, 1);
  });

  it('exits 2 when the item cannot be fetched', () => {
    assert.equal(run(['issue', '1', expectedPath], { FAKE_GH_FAIL: '1' }).status, 2);
  });

  it('exits 2 for invalid arguments', () => {
    for (const args of [[], ['constructor', '1', expectedPath], ['issue', '1;id', expectedPath]]) {
      const { status, stderr } = run(args);

      assert.equal(status, 2);
      assert.match(stderr, /^usage:/);
    }
    assert.equal(run(['issue', '1', join(directory, 'missing.json')]).status, 2);
  });
});
