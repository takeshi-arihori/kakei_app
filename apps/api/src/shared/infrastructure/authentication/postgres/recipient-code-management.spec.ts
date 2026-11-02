import { describe, expect, it, vi } from 'vitest';

import { createPostgresRecipientCodeStore } from './postgres-recipient-code-store.js';

describe('招待コード管理の本人性境界', () => {
  it('未認証なら秘密値/Record鍵を発行せず、コードSQLも実行しない', async () => {
    const query = vi.fn();
    const generate = vi.fn(() => new Uint8Array(32));
    const allocate = vi.fn();
    const unavailable = () => Promise.reject(new Error('合成: 呼出し禁止'));
    const store = createPostgresRecipientCodeStore({
      leases: {
        withActor: () => Promise.resolve({ status: 'unauthenticated' }),
        inspectActor: () => Promise.resolve({ status: 'unauthenticated' }),
      },
      participants: { query },
      guard: vi.fn(),
      digests: {
        identity: unavailable,
        attemptCookie: unavailable,
        sessionCookie: unavailable,
        actorState: unavailable,
        verifyActorState: unavailable,
        auditActor: unavailable,
        auditAttempt: unavailable,
        auditSession: unavailable,
        deletedActor: unavailable,
      },
      crypto: {
        lookup: unavailable,
        verifyLookup: unavailable,
        recordMac: unavailable,
        verifyRecord: unavailable,
        audit: unavailable,
      },
      entropy: {
        generate,
        codeId: () => '10000000-0000-4000-8000-000000000001',
      },
      stateKeys: { allocate },
    });
    expect(await store.issue('synthetic-session', { now: () => 1000 })).toEqual(
      { status: 'unauthenticated' },
    );
    expect(generate).not.toHaveBeenCalled();
    expect(allocate).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
