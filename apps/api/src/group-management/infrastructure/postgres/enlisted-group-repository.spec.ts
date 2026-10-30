import { describe, expect, it, vi } from 'vitest';
import { createAuthenticationTransactionScopes } from '../../../shared/infrastructure/authentication/postgres/authentication-transaction-scopes.js';
import { createRecipientCodeTransactionScopes } from '../../../shared/infrastructure/authentication/postgres/recipient-code-transaction-scopes.js';
import type { AuthenticationTransactionScope } from '../../../shared/application/authentication/authentication-transaction-scope.js';
import { ActorSubject } from '../../domain/group.js';
import { OperationId } from '../../application/group-repository.js';
import { createEnlistedGroupRepository } from './enlisted-group-repository.js';

describe('GM参加Adapterの能力境界', () => {
  it('偽ScopeをSQL/復号前に拒否し、Pool/Transaction/query/証跡発行を公開しない', async () => {
    const scopes = createRecipientCodeTransactionScopes(
      createAuthenticationTransactionScopes(),
    );
    const open = vi.fn(),
      seal = vi.fn();
    const repository = createEnlistedGroupRepository({
      registerGroupParticipant: (registration) =>
        scopes.registerGroupParticipant(registration),
      codec: { open, seal },
      encodeAad: () => new Uint8Array(),
      stateWriter: { persist: vi.fn() },
      locatorKeys: { currentDigest: vi.fn(), candidateDigests: vi.fn() },
      accessIndexDigests: { digest: vi.fn() },
      auditWriter: { write: vi.fn() },
    });
    // 型Brandを偽造した入力でもregistry Object identityを持たない。
    const forged = Object.freeze({}) as AuthenticationTransactionScope;
    await expect(
      repository.findOperation(
        forged,
        ActorSubject.from('synthetic-caller'),
        OperationId.from('op'),
      ),
    ).rejects.toThrow();
    await expect(repository.currentProofKeyVersion(forged)).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
    for (const capability of [
      'pool',
      'beginPlan',
      'connect',
      'open',
      'query',
      'attest',
      'prepare',
      'commit',
      'rollback',
      'release',
    ])
      expect(repository).not.toHaveProperty(capability);
  });
});
