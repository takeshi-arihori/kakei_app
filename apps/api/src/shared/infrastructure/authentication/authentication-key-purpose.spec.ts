import { expect, it } from 'vitest';

import type {
  AuthenticationDataKey,
  AuthenticationMacKey,
  AuthenticationDigest,
} from '../../application/authentication/authentication-crypto-keys.js';
import { importProtectedRecordKey } from '../protected-record/protected-record-codec.js';
import {
  createAuthenticationDigests,
  importAuthenticationMacKey,
} from './authentication-digests.js';
import { importAuthenticationDataKey } from './authentication-record-codec.js';
import {
  SyntheticKeyRegistry,
  cases,
} from './test/authentication-crypto-fixtures.js';

it('認証DEK・Group DEK・HMAC鍵・Digestの型を相互に転用できない', () => {
  const auth = importAuthenticationDataKey(new Uint8Array(32));
  const group = importProtectedRecordKey(new Uint8Array(32));
  const key = importAuthenticationMacKey(
    'auth-attempt-cookie/v1',
    new Uint8Array(32),
  );
  const accepts = (input: AuthenticationDataKey): Uint8Array => input;
  expect(accepts(auth)).toEqual(auth);
  // @ts-expect-error Group DEKを認証DEKとして使えない。
  expect(accepts(group)).toEqual(group);
  // @ts-expect-error 用途別HMAC鍵をDEKとして使えない。
  expect(accepts(key.material)).toEqual(key.material);
  // @ts-expect-error Attempt鍵をSession用途へ転用できない。
  const wrong: AuthenticationMacKey<'auth-session-cookie/v1'> = key;
  expect(wrong.purpose).toBe('auth-attempt-cookie/v1');
});

it('Cookie出力の用途を型に保持し、Identity DEK破棄後も独立状態MACを検証する', async () => {
  const registry = new SyntheticKeyRegistry();
  const row = cases[0].row;
  if (row.recordKind !== 'google-identity') throw new Error('合成Identity');
  const scope = { recordKind: row.recordKind, keyScopeId: row.actorId };
  registry.state(scope).mode = 'destroyed';
  const digests = createAuthenticationDigests({
    keys: {
      actorState: {
        readKey: ({ keyVersion }) =>
          Promise.resolve({
            status: 'available',
            keyVersion,
            epoch: null,
            key: importAuthenticationMacKey(
              'auth-actor-state/v1',
              new Uint8Array(32).fill(4),
            ),
          }),
      },
      attemptCookie: {
        readKey: ({ keyVersion, epoch }) =>
          Promise.resolve({
            status: 'available',
            keyVersion,
            epoch,
            key: importAuthenticationMacKey(
              'auth-attempt-cookie/v1',
              new Uint8Array(32).fill(5),
            ),
          }),
      },
    },
  });
  const state = {
    actorId: row.actorId,
    version: 2,
    state: 'disabled' as const,
    createdAt: 0,
    disabledAt: 1,
  };
  const mac = await digests.actorState({ row: state, keyVersion: 'v1' });
  expect(
    await digests.verifyActorState({
      row: state,
      keyVersion: 'v1',
      mac: mac.bytes,
    }),
  ).toBe(true);
  const attempt = await digests.attemptCookie({
    secret: Buffer.alloc(32, 1).toString('base64url'),
    epoch: row.actorId,
    keyVersion: 'v1',
  });
  // @ts-expect-error Attempt出力をSession出力として利用できない。
  const wrong: AuthenticationDigest<'auth-session-cookie/v1'> = attempt;
  expect(wrong.purpose).toBe('auth-attempt-cookie/v1');
});
