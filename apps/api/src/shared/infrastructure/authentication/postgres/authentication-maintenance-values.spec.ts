import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { AuthenticationKeyScope } from '../../../application/authentication/authentication-crypto-keys.js';
import type { AuthenticationKeyDestructionPort } from '../../../application/authentication/authentication-maintenance-ports.js';
import { AuthenticationCryptoUnavailable } from '../../../application/authentication/authentication-record-protection.js';
import {
  authenticationMaintenanceScope,
  prepareAuthenticationDestruction,
} from './authentication-maintenance-values.js';

const keyScopeId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const window = { dueAt: 1000, deadline: 1000 + 86_400_000 };

describe('既存保守経路へのコードscope混入', () => {
  it('既存scope型に招待コードのkindを含めない', () => {
    expectTypeOf<'recipient-code'>().not.toExtend<
      AuthenticationKeyScope['recordKind']
    >();
  });

  it.each(['google-identity', 'login-attempt', 'session'])(
    '既存の%sだけを受理する',
    (recordKind) => {
      expect(
        authenticationMaintenanceScope({ recordKind, keyScopeId }),
      ).toEqual({ recordKind, keyScopeId });
    },
  );

  it('recipient-codeのscopeを拒否する', () => {
    expect(() =>
      authenticationMaintenanceScope({
        recordKind: 'recipient-code',
        keyScopeId,
      }),
    ).toThrow(AuthenticationCryptoUnavailable);
  });

  it('コード固有のfieldを足したscopeも拒否する', () => {
    expect(() =>
      authenticationMaintenanceScope({
        recordKind: 'session',
        keyScopeId,
        codeId: keyScopeId,
      }),
    ).toThrow(AuthenticationCryptoUnavailable);
  });

  it('recipient-codeを含む破棄ticketをProviderへ渡さない', async () => {
    const prepare = vi.fn();
    const keys = { prepare } as unknown as AuthenticationKeyDestructionPort;
    await expect(
      prepareAuthenticationDestruction(
        keys,
        operationId,
        [
          { recordKind: 'recipient-code', keyScopeId },
        ] as unknown as readonly AuthenticationKeyScope[],
        window,
      ),
    ).rejects.toBeInstanceOf(AuthenticationCryptoUnavailable);
    expect(prepare).not.toHaveBeenCalled();
  });
});
