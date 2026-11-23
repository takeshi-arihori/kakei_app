import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { ActorSubject } from '../../domain/group.js';
import { PostgresMyGroupListReader } from './my-group-list-reader.js';

const candidate = {
  digest: new Uint8Array([1]) as never,
  digestKeyVersion: 'membership-v1',
};

/** SQLの応答を差し替えられるFake接続。接続の扱い（Rollback・破棄）だけを検証する。 */
const setup = (respond: (sql: string) => Promise<unknown>) => {
  const statements: string[] = [];
  const release = vi.fn<(destroy?: boolean) => void>();
  const client = {
    query: (sql: string) => {
      statements.push(sql.trim().split(/\s+/)[0] ?? '');
      return respond(sql);
    },
    release,
  } as unknown as PoolClient;
  const onUnavailable = vi.fn();
  const reader = new PostgresMyGroupListReader({
    pool: { connect: () => Promise.resolve(client) },
    codec: { open: () => Promise.reject(new Error('not used')) },
    encodeAad: () => new Uint8Array(),
    membershipIndexKeys: {
      candidateDigests: () => Promise.resolve([candidate]),
    },
    onUnavailable,
  });
  return { reader, statements, release, onUnavailable };
};

const read = (reader: PostgresMyGroupListReader) =>
  reader.readCandidates({ actorSubject: ActorSubject.from('me'), limit: 51 });

describe('PostgresMyGroupListReaderの接続管理', () => {
  it('索引missではcommitして接続をPoolへ戻す', async () => {
    const { reader, statements, release } = setup(() =>
      Promise.resolve({ rows: [] }),
    );

    await expect(read(reader)).resolves.toEqual({
      kind: 'Read',
      groups: [],
      indexHitCount: 0,
    });
    expect(statements).toEqual(['BEGIN', 'SELECT', 'COMMIT']);
    expect(release).toHaveBeenCalledWith(false);
  });

  it('SQL障害ではrollbackしてから接続をPoolへ戻す', async () => {
    const { reader, statements, release, onUnavailable } = setup((sql) =>
      sql.startsWith('SELECT')
        ? Promise.reject(new Error('lock timeout'))
        : Promise.resolve({ rows: [] }),
    );

    await expect(read(reader)).resolves.toEqual({ kind: 'Unavailable' });
    expect(statements).toEqual(['BEGIN', 'SELECT', 'ROLLBACK']);
    expect(release).toHaveBeenCalledWith(false);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('rollbackにも失敗した接続はPoolへ戻さず破棄する', async () => {
    const { reader, release } = setup((sql) =>
      sql === 'BEGIN'
        ? Promise.resolve({ rows: [] })
        : Promise.reject(new Error('connection lost')),
    );

    await expect(read(reader)).resolves.toEqual({ kind: 'Unavailable' });
    expect(release).toHaveBeenCalledWith(true);
  });

  it('commitに失敗した場合も一部を返さずrollbackする', async () => {
    const { reader, statements } = setup((sql) =>
      sql === 'COMMIT'
        ? Promise.reject(new Error('serialization failure'))
        : Promise.resolve({ rows: [] }),
    );

    await expect(read(reader)).resolves.toEqual({ kind: 'Unavailable' });
    expect(statements).toEqual(['BEGIN', 'SELECT', 'COMMIT', 'ROLLBACK']);
  });
});
