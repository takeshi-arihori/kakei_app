import { describe, expect, it } from 'vitest';

import { AuthenticationCryptoUnavailable } from '../../application/authentication/authentication-record-protection.js';
import { authenticationManifestObject } from './authentication-backup-manifest.js';

const base = {
  createdAt: 1000,
  schemaVersion: 6,
  keyStateVersion: 1,
  epoch: '22222222-2222-4222-8222-222222222222',
  checkpoint: { sequence: 0, hash: '0'.repeat(64) },
};
const recoveryPointId = '44444444-4444-4444-8444-444444444444';

describe('Backup ManifestのrecoveryPointId', () => {
  it('版11未満はFieldなしだけを受理する', () => {
    expect(authenticationManifestObject(base).recoveryPointId).toBeUndefined();
    expect(() =>
      authenticationManifestObject({ ...base, recoveryPointId }),
    ).toThrow(AuthenticationCryptoUnavailable);
  });

  it('境界の版10もFieldなしだけを受理する', () => {
    expect(
      authenticationManifestObject({ ...base, schemaVersion: 10 })
        .recoveryPointId,
    ).toBeUndefined();
    expect(() =>
      authenticationManifestObject({
        ...base,
        schemaVersion: 10,
        recoveryPointId,
      }),
    ).toThrow(AuthenticationCryptoUnavailable);
  });

  it('版11以上はUUIDv4のFieldを必須にする', () => {
    expect(
      authenticationManifestObject({
        ...base,
        schemaVersion: 11,
        recoveryPointId,
      }).recoveryPointId,
    ).toBe(recoveryPointId);
    expect(() =>
      authenticationManifestObject({ ...base, schemaVersion: 11 }),
    ).toThrow(AuthenticationCryptoUnavailable);
    expect(() =>
      authenticationManifestObject({
        ...base,
        schemaVersion: 11,
        recoveryPointId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      }),
    ).toThrow(AuthenticationCryptoUnavailable);
  });

  it.each([
    ['未知Field', { ...base, catalog: 'x' }],
    ['版の型不正', { ...base, schemaVersion: '6' }],
    [
      'Getterの復旧点',
      Object.defineProperty({ ...base, schemaVersion: 11 }, 'recoveryPointId', {
        get: () => recoveryPointId,
        enumerable: true,
      }),
    ],
  ])('%sを拒否する', (_name, manifest) => {
    expect(() => authenticationManifestObject(manifest)).toThrow(
      AuthenticationCryptoUnavailable,
    );
  });
});
