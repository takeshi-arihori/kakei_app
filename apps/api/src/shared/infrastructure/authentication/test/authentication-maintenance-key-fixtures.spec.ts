import { describe, expect, it } from 'vitest';

import { ids } from './authentication-crypto-fixtures.js';
import { syntheticAuthenticationManagedKeys } from './authentication-maintenance-key-fixtures.js';

const scope = { recordKind: 'google-identity' as const, keyScopeId: ids.actor };
const operation = '11111111-1111-4111-8111-111111111111';
const window = { dueAt: 1000, deadline: 86_401_000 };

describe('合成Providerの全世代・証跡契約', () => {
  it.each([1000, 1001])(
    '%i件の票を欠落なく固定snapshotで列挙し、真の末尾だけnullにする',
    async (count) => {
      const f = syntheticAuthenticationManagedKeys();
      const expected: string[] = [];
      for (let index = 1; index <= count; index += 1) {
        const id =
          '00000000-0000-4000-8000-' + index.toString(16).padStart(12, '0');
        expected.push(id);
        await f.keys.prepare(
          id,
          [{ recordKind: 'google-identity', keyScopeId: id }],
          window,
        );
      }
      const first = await f.keys.pendingActorDeletionPage(null, 1000);
      expect(first.tickets).toHaveLength(1000);
      if (count === 1000) expect(first.nextCursor).toBeNull();
      else {
        expect(first.nextCursor).not.toBeNull();
        const second = await f.keys.pendingActorDeletionPage(
          first.nextCursor,
          1000,
        );
        expect(second.tickets).toHaveLength(1);
        expect(second.nextCursor).toBeNull();
        expect(
          [...first.tickets, ...second.tickets].map(
            (ticket) => ticket.operationId,
          ),
        ).toEqual(expected);
        expect(
          (
            await f.keys.pendingActorDeletions(2, { actorId: expected[1000] })
          )[0].operationId,
        ).toBe(expected[1000]);
      }
    },
  );
  it('別Provider cursorと途中でinventoryが変化したsnapshotを拒否する', async () => {
    const f = syntheticAuthenticationManagedKeys();
    await f.keys.prepare(operation, [scope], window);
    await f.keys.prepare(
      ids.other,
      [{ ...scope, keyScopeId: ids.other }],
      window,
    );
    const first = await f.keys.pendingActorDeletionPage(null, 1);
    expect(first.nextCursor).not.toBeNull();
    await expect(
      syntheticAuthenticationManagedKeys().keys.pendingActorDeletionPage(
        first.nextCursor,
        1,
      ),
    ).rejects.toThrow();
    f.rotate(scope);
    await expect(
      f.keys.pendingActorDeletionPage(first.nextCursor, 1),
    ).rejects.toThrow();
    expect(
      (await f.keys.pendingActorDeletionPage(null, 1000)).tickets,
    ).toHaveLength(2);
  });
  it('prepare後の未参照世代追加でticket版を進め、古いinventoryを破棄証拠にしない', async () => {
    const f = syntheticAuthenticationManagedKeys();
    f.rotate(scope);
    const old = await f.keys.prepare(operation, [scope], window);
    f.rotate(scope);
    await expect(f.keys.destroy(old)).rejects.toThrow();
    const current = (await f.keys.find(operation, old.reference))!;
    expect(current.version).toBe(old.version + 1);
    const proof = await f.keys.destroy(current);
    expect(await f.keys.verify(proof, current)).toBe(true);
    expect(f.inventory(scope).map((entry) => entry.mode)).toEqual([
      'destroyed',
      'destroyed',
    ]);
    expect((await f.provider.allocateForSeal(scope)).status).toBe(
      'seal-disabled',
    );
  });
  it('部分世代破棄で能力を発行せず同ticketの再試行だけで全世代へ収束する', async () => {
    const f = syntheticAuthenticationManagedKeys();
    f.rotate(scope);
    f.rotate(scope);
    const ticket = await f.keys.prepare(operation, [scope], window);
    f.faults.add('after-destroy-version');
    await expect(f.keys.destroy(ticket)).rejects.toThrow();
    expect(f.inventory(scope).map((entry) => entry.mode)).toEqual([
      'destroyed',
      'current',
    ]);
    f.faults.clear();
    const proof = await f.keys.destroy(ticket);
    expect(await f.keys.verify(proof, ticket)).toBe(true);
    await expect(
      f.keys.verify(proof, { ...ticket, version: ticket.version + 1 }),
    ).rejects.toThrow();
    expect(await f.keys.verify({} as typeof proof, ticket)).toBe(false);
  });
});
