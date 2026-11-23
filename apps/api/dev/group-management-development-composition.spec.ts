import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { PoolConfig } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { GraphQLAuthenticationService } from '../src/presentation/graphql/authenticated-operation.js';
import { createAuthenticationHttpSecurity } from '../src/shared/infrastructure/authentication/authentication-http-security.js';
import { createDevelopmentBusinessPool } from './development-business-pool.js';
import { createGroupManagementDevelopmentUseCases } from './group-management-development-composition.js';
import { createGroupManagementDevelopmentKeys } from './group-management-development-keys.js';

/** 接続を常に拒否する、pgのClient互換の最小Fake。DBへ接続しない。 */
class RefusingClient extends EventEmitter {
  connect(callback: (error?: Error) => void) {
    setImmediate(() => callback(new Error('synthetic/refused')));
  }
  isConnected() {
    return false;
  }
  end(callback?: () => void) {
    callback?.();
    return Promise.resolve();
  }
}

/** 共有認証と同じ43文字の形式（32 byteのbase64url。最後の6 bitのうち下位2 bitが0）。 */
const secret = () => {
  const bytes = randomBytes(32);
  return bytes.toString('base64url');
};

describe('開発Compositionの/graphqlからGroup Managementまでの接続取得失敗（#314 DC-6）', () => {
  it('createGroup・myGroupsは業務接続を取得できないとSERVICE_UNAVAILABLEになり、認証leaseをrollbackする', async () => {
    const business = createDevelopmentBusinessPool({
      databaseUrl: 'postgresql://user@127.0.0.1:5432/synthetic_auth_dev',
      client: RefusingClient as unknown as PoolConfig['Client'],
    });
    const keys = createGroupManagementDevelopmentKeys();
    const csrf = secret();
    const outcomes: string[] = [];
    // 共有認証の契約（Callbackの例外はrollbackしてunavailable）を模すFake。
    const service: GraphQLAuthenticationService = {
      async withAuthenticatedActor(_secret, _usage, callback) {
        try {
          const value = await callback(
            {
              actorSubject: 'synthetic-314-actor',
              csrf,
              absoluteExpiresAt: Date.now() + 60_000,
            },
            { serialize: (v: unknown) => JSON.stringify(v) } as never,
          );
          outcomes.push('commit');
          return { status: 'authenticated', value };
        } catch {
          outcomes.push('rollback');
          return { status: 'unavailable' };
        }
      },
    };
    const alert = vi.fn();
    const app = createApp({
      graphql: {
        origin: 'http://localhost:3000',
        profile: 'local-development',
        service: business.guard(service),
        security: createAuthenticationHttpSecurity(),
      },
      groupManagement: createGroupManagementDevelopmentUseCases({
        pool: business.pool,
        keys,
        onIntegrityAlert: alert,
      }),
    });
    const send = async (query: string) => {
      const response = await app.request('/graphql', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:3000',
          'X-Kakei-Request': '1',
          'Content-Type': 'application/json',
          Cookie: 'kakei_dev_auth_session=' + secret(),
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({ query }),
      });
      return (await response.json()) as {
        data?: unknown;
        errors?: { extensions?: { code?: string } }[];
      };
    };
    try {
      for (const query of [
        'mutation { createGroup(input: { operationId: "' +
          randomUUID() +
          '" }) { groupId } }',
        'query { myGroups { items { groupId } hasMore } }',
      ]) {
        const body = await send(query);
        expect(body.errors?.map((e) => e.extensions?.code)).toEqual([
          'SERVICE_UNAVAILABLE',
        ]);
        expect(JSON.stringify(body)).not.toMatch(/synthetic|refused/);
      }
      // 両Operationとも業務接続の取得失敗で認証leaseをrollbackした。
      expect(outcomes).toEqual(['rollback', 'rollback']);
      expect(alert).not.toHaveBeenCalled();
    } finally {
      keys.dispose();
      await business.end();
    }
  });
});
