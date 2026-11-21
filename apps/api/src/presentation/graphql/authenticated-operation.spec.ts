import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedActor } from '../../shared/application/authentication/authentication-ports.js';
import { createAuthenticationTransactionScopes } from '../../shared/infrastructure/authentication/postgres/authentication-transaction-scopes.js';
import {
  createAuthenticatedOperation,
  type GraphQLAuthenticationService,
} from './authenticated-operation.js';
import { PublicGraphQLError } from './public-graphql-error.js';

const secret = (n: number) => Buffer.alloc(32, n).toString('base64url');
const actor: AuthenticatedActor = {
  actorSubject: '00000000-0000-4000-8000-000000000317',
  absoluteExpiresAt: 604_801_000,
  csrf: secret(5),
};
const query = { operation: { operation: 'query' } } as const;
const mutation = { operation: { operation: 'mutation' } } as const;

/** 実Scope Adapterでlease内serialize・commit後返却を模す偽Service。 */
const leaseService = (
  outcome:
    'authenticated' | 'unauthenticated' | 'commit-fails' = 'authenticated',
) => {
  const events: string[] = [];
  const calls = vi.fn<(secret: unknown, usage: string) => void>();
  const withAuthenticatedActor: GraphQLAuthenticationService['withAuthenticatedActor'] =
    async (sessionSecret, usage, callback) => {
      calls(sessionSecret, usage);
      events.push(`lease:${usage}`);
      if (outcome === 'unauthenticated') return { status: 'unauthenticated' };
      const lease = createAuthenticationTransactionScopes().open({
        query: () =>
          Promise.resolve({
            rows: [],
            rowCount: 0,
            command: 'SELECT',
            oid: 0,
            fields: [],
          }),
      });
      try {
        const value = await callback(actor, lease.scope);
        lease.seal();
        lease.assertResult(value);
        lease.assertCommittable();
        if (outcome === 'commit-fails') {
          events.push('auth-commit-failed');
          return { status: 'unavailable' };
        }
        events.push('auth-commit');
        return { status: 'authenticated', value };
      } catch {
        events.push('auth-rollback');
        return { status: 'unavailable' };
      } finally {
        lease.close();
      }
    };
  const service: GraphQLAuthenticationService & { calls: typeof calls } = {
    withAuthenticatedActor,
    calls,
  };
  return { service, events };
};
const security = {
  equalSecrets: vi.fn((left: string, right: string) => left === right),
};
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PublicGraphQLError);
    return (error as PublicGraphQLError).code;
  }
  throw new Error('公開Errorを期待した');
};

describe('AuthenticatedOperation', () => {
  it('Queryはactivity lease内で業務を実行し、認証commit後に値を返す', async () => {
    const { service, events } = leaseService();
    const operation = createAuthenticatedOperation({
      service,
      security,
      sessionSecret: secret(9),
      csrfToken: null,
    });

    const value = await operation.run(query, (current) => {
      events.push('business');
      expect(current).toEqual({ actorSubject: actor.actorSubject });
      return Promise.resolve({ groups: 1 });
    });

    expect(value).toEqual({ groups: 1 });
    expect(events).toEqual(['lease:activity', 'business', 'auth-commit']);
    expect(service.calls).toHaveBeenCalledWith(secret(9), 'activity');
  });

  it('業務へ渡すActorはactorSubjectだけで、CSRFや期限を含まない', async () => {
    const { service } = leaseService();
    const operation = createAuthenticatedOperation({
      service,
      security,
      sessionSecret: secret(9),
      csrfToken: secret(5),
    });
    await operation.run(mutation, (current) => {
      expect(Object.keys(current)).toEqual(['actorSubject']);
      expect(Object.isFrozen(current)).toBe(true);
      return Promise.resolve(null);
    });
  });

  it('Mutationはlease内でCSRFを定数時間照合し、一致したときだけ業務を実行する', async () => {
    const { service, events } = leaseService();
    const operation = createAuthenticatedOperation({
      service,
      security,
      sessionSecret: secret(9),
      csrfToken: secret(5),
    });

    await expect(
      operation.run(mutation, () => {
        events.push('business');
        return Promise.resolve('created');
      }),
    ).resolves.toBe('created');
    expect(security.equalSecrets).toHaveBeenCalledWith(actor.csrf, secret(5));
    expect(events).toEqual(['lease:activity', 'business', 'auth-commit']);
  });

  it('MutationのCSRF不一致は業務を実行せず、認証をrollbackしてREQUEST_REJECTED', async () => {
    const { service, events } = leaseService();
    const work = vi.fn();
    const operation = createAuthenticatedOperation({
      service,
      security,
      sessionSecret: secret(9),
      csrfToken: secret(6),
    });

    await expect(code(operation.run(mutation, work))).resolves.toBe(
      'REQUEST_REJECTED',
    );
    expect(work).not.toHaveBeenCalled();
    expect(events).toEqual(['lease:activity', 'auth-rollback']);
  });

  it.each([null, 'short', `${secret(5)}x`])(
    'MutationのCSRF欠落・形式不正(%s)はleaseを開かずREQUEST_REJECTED',
    async (csrfToken) => {
      const { service } = leaseService();
      const operation = createAuthenticatedOperation({
        service,
        security,
        sessionSecret: secret(9),
        csrfToken,
      });

      await expect(code(operation.run(mutation, vi.fn()))).resolves.toBe(
        'REQUEST_REJECTED',
      );
      expect(service.calls).not.toHaveBeenCalled();
    },
  );

  it('本人性なしはAUTHENTICATION_REQUIRED、業務は実行しない', async () => {
    const { service } = leaseService('unauthenticated');
    const work = vi.fn();
    const operation = createAuthenticatedOperation({
      service,
      security,
      sessionSecret: undefined,
      csrfToken: null,
    });

    await expect(code(operation.run(query, work))).resolves.toBe(
      'AUTHENTICATION_REQUIRED',
    );
    expect(work).not.toHaveBeenCalled();
  });

  it('業務の公開Errorは認証commit後にそのまま返す', async () => {
    const { service, events } = leaseService();
    const operation = createAuthenticatedOperation({
      service,
      security,
      sessionSecret: secret(9),
      csrfToken: null,
    });

    await expect(
      code(
        operation.run(query, () =>
          Promise.reject(new PublicGraphQLError('NOT_FOUND')),
        ),
      ),
    ).resolves.toBe('NOT_FOUND');
    expect(events).toEqual(['lease:activity', 'auth-commit']);
  });

  it('業務の予期しない例外は認証をrollbackしSERVICE_UNAVAILABLE（原因を返さない）', async () => {
    const { service, events } = leaseService();
    const operation = createAuthenticatedOperation({
      service,
      security,
      sessionSecret: secret(9),
      csrfToken: null,
    });

    await expect(
      code(operation.run(query, () => Promise.reject(new Error('SQL secret')))),
    ).resolves.toBe('SERVICE_UNAVAILABLE');
    expect(events).toEqual(['lease:activity', 'auth-rollback']);
  });

  it('業務commit後に認証commitが失敗したら結果不明としてSERVICE_UNAVAILABLE', async () => {
    const { service, events } = leaseService('commit-fails');
    const operation = createAuthenticatedOperation({
      service,
      security,
      sessionSecret: secret(9),
      csrfToken: null,
    });

    await expect(
      code(
        operation.run(query, () => {
          events.push('business-commit');
          return Promise.resolve('value');
        }),
      ),
    ).resolves.toBe('SERVICE_UNAVAILABLE');
    expect(events).toEqual([
      'lease:activity',
      'business-commit',
      'auth-commit-failed',
    ]);
  });

  it('能力が注入されていなければleaseを開かずSERVICE_UNAVAILABLE', async () => {
    const operation = createAuthenticatedOperation({
      sessionSecret: secret(9),
      csrfToken: secret(5),
    });
    const work = vi.fn();

    await expect(code(operation.run(mutation, work))).resolves.toBe(
      'SERVICE_UNAVAILABLE',
    );
    expect(work).not.toHaveBeenCalled();
  });

  it('Query／Mutation以外の実行種別は業務を実行しない', async () => {
    const { service } = leaseService();
    const operation = createAuthenticatedOperation({
      service,
      security,
      sessionSecret: secret(9),
      csrfToken: secret(5),
    });

    await expect(
      code(
        operation.run({ operation: { operation: 'subscription' } }, vi.fn()),
      ),
    ).resolves.toBe('SERVICE_UNAVAILABLE');
    expect(service.calls).not.toHaveBeenCalled();
  });
});
