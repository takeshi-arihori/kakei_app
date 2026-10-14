import { describe, expect, it } from 'vitest';
import {
  createAuthenticationDigests,
  importAuthenticationMacKey,
  authenticationSecretsEqual,
} from './authentication-digests.js';
import type { AuthenticationMacPurpose } from '../../application/authentication/authentication-crypto-keys.js';

const actorId = '00000000-0000-4000-8000-000000000002';
const epoch = '00000000-0000-4000-8000-000000000003';
const secret = Buffer.alloc(32, 7).toString('base64url');
const port = <P extends AuthenticationMacPurpose>(
  purpose: P,
  fill: number,
) => ({
  readKey: (input: { keyVersion: string; epoch: string | null }) => {
    const generations = new Map([
      ['v1', fill],
      ['v2', fill + 32],
    ]);
    const material = generations.get(input.keyVersion);
    if (material === undefined)
      return Promise.resolve({ status: 'unavailable' as const });
    return Promise.resolve({
      status: 'available' as const,
      ...input,
      key: importAuthenticationMacKey(
        purpose,
        new Uint8Array(32).fill(material),
      ),
    });
  },
});
const keys = {
  identity: port('auth-google-identity/v1', 1),
  attemptCookie: port('auth-attempt-cookie/v1', 2),
  sessionCookie: port('auth-session-cookie/v1', 3),
  auditActor: port('auth-audit-actor/v1', 4),
  auditAttempt: port('auth-audit-attempt/v1', 5),
  auditSession: port('auth-audit-session/v1', 6),
  deletedActor: port('auth-deleted-actor/v1', 7),
  actorState: port('auth-actor-state/v1', 8),
};

describe('認証HMACの用途分離', () => {
  it('Identityの独立Python参照vectorと一致し、caseを保持する', async () => {
    const purpose = 'auth-google-identity/v1' as const;
    const keys = {
      identity: {
        readKey: () =>
          Promise.resolve({
            status: 'available' as const,
            keyVersion: 'v1',
            epoch: null,
            key: importAuthenticationMacKey(
              purpose,
              new Uint8Array(32).fill(1),
            ),
          }),
      },
    };
    const digests = createAuthenticationDigests({ keys });
    const input = {
      identity: {
        issuer: 'https://accounts.google.com' as const,
        subject: 'Synthetic-Subject-é',
      },
      keyVersion: 'v1',
    };
    const digest = await digests.identity(input);
    expect(digest.purpose).toBe(purpose);
    expect(Buffer.from(digest.bytes).toString('hex')).toBe(
      'f01c67c8ea2451068368044be918eab3f2170fda348038d21699e66abdb991cd',
    );
    expect(
      (
        await digests.identity({
          ...input,
          identity: { ...input.identity, subject: 'synthetic-subject-é' },
        })
      ).bytes,
    ).not.toEqual(digest.bytes);
  });

  it('32-byte秘密値を定数時間で比較し、不正表記を一致にしない', () => {
    expect(authenticationSecretsEqual(secret, secret)).toBe(true);
    expect(
      authenticationSecretsEqual(
        secret,
        Buffer.alloc(32, 8).toString('base64url'),
      ),
    ).toBe(false);
    expect(
      authenticationSecretsEqual('A'.repeat(42) + 'B', 'A'.repeat(42) + 'B'),
    ).toBe(false);
    expect(authenticationSecretsEqual(null, null)).toBe(false);
  });

  it('独立鍵と固定用途の全HMACがPython参照vectorに一致する', async () => {
    const d = createAuthenticationDigests({ keys });
    const values = [
      await d.attemptCookie({ secret, epoch, keyVersion: 'v1' }),
      await d.sessionCookie({ secret, epoch, keyVersion: 'v1' }),
      await d.auditActor({ subjectId: actorId, keyVersion: 'v1' }),
      await d.auditAttempt({ subjectId: actorId, keyVersion: 'v1' }),
      await d.auditSession({ subjectId: actorId, keyVersion: 'v1' }),
      await d.deletedActor({ subjectId: actorId, keyVersion: 'v1' }),
      await d.actorState({
        row: {
          actorId,
          version: 1,
          state: 'active',
          createdAt: 0,
          disabledAt: null,
        },
        keyVersion: 'v1',
      }),
    ];
    expect(
      values.map((value) => Buffer.from(value.bytes).toString('hex')),
    ).toEqual([
      'a01a2f854dff87d30adb9873470fba7984c6e7f0317a4f843fc8f12a514f705e',
      'f26507b2218f0b87b8a33ff5ba8da74b5aa0e96fbd41003ca5f9771cec22afe1',
      '81a0753f069b774e00fb0ca166acc16470bb34666c5296941a4eb79b6f43349d',
      'ef26faec98c20c0522e180de9ca6d78c5569bc3d9ba26c2f6ad0401873288797',
      '070a09ca1995970b9fda971b2dd8fd5d8f796d7dc784463762305ff23005bc27',
      'bd00469b7fe88d1bbb0f50394821cc3ce2bed25ec2c44f6d07aa1f4b12852670',
      '2e10bc321b2b74b8cd3c849c7b2ca9f1cb7a5339e21cdfdbe1ce248138a70b90',
    ]);
  });

  it('Cookieのepochと独立した用途を混同せず、原値を保存値へ返さない', async () => {
    const d = createAuthenticationDigests({ keys });
    const first = await d.attemptCookie({ secret, epoch, keyVersion: 'v1' });
    const other = await d.attemptCookie({
      secret,
      epoch: actorId,
      keyVersion: 'v1',
    });
    expect(first.bytes).not.toEqual(other.bytes);
    expect(Object.keys(first).sort()).toEqual([
      'bytes',
      'keyVersion',
      'purpose',
    ]);
    expect(first.bytes).not.toEqual(
      (await d.sessionCookie({ secret, epoch, keyVersion: 'v1' })).bytes,
    );
  });

  it('全8用途で有効な鍵世代を分離し、旧世代を引き続き照合できる', async () => {
    const d = createAuthenticationDigests({ keys });
    const row = {
      actorId,
      version: 1,
      state: 'active' as const,
      createdAt: 0,
      disabledAt: null,
    };
    const values = (keyVersion: string) =>
      Promise.all([
        d.identity({
          identity: {
            issuer: 'https://accounts.google.com',
            subject: 'Synthetic-Subject-é',
          },
          keyVersion,
        }),
        d.attemptCookie({ secret, epoch, keyVersion }),
        d.sessionCookie({ secret, epoch, keyVersion }),
        d.auditActor({ subjectId: actorId, keyVersion }),
        d.auditAttempt({ subjectId: actorId, keyVersion }),
        d.auditSession({ subjectId: actorId, keyVersion }),
        d.deletedActor({ subjectId: actorId, keyVersion }),
        d.actorState({ row, keyVersion }),
      ]);
    const previous = await values('v1');
    const current = await values('v2');
    for (const [index, value] of previous.entries()) {
      expect(value.keyVersion).toBe('v1');
      expect(current[index].keyVersion).toBe('v2');
      expect(value.purpose).toBe(current[index].purpose);
      expect(value.bytes).not.toEqual(current[index].bytes);
    }
    expect(await values('v1')).toEqual(previous);
    expect(
      await d.verifyActorState({
        row,
        keyVersion: 'v1',
        mac: previous[7].bytes,
      }),
    ).toBe(true);
    expect(
      await d.verifyActorState({
        row,
        keyVersion: 'v2',
        mac: previous[7].bytes,
      }),
    ).toBe(false);
  });

  it.each(['attemptCookie', 'sessionCookie'] as const)(
    '%sはProviderが別の有効epochを返すと汎用失敗にする',
    async (method) => {
      const d = createAuthenticationDigests({
        keys: {
          attemptCookie: {
            readKey: async (input) => ({
              ...(await keys.attemptCookie.readKey(input)),
              epoch: actorId,
            }),
          },
          sessionCookie: {
            readKey: async (input) => ({
              ...(await keys.sessionCookie.readKey(input)),
              epoch: actorId,
            }),
          },
        },
      });
      await expect(
        d[method]({ secret, epoch, keyVersion: 'v1' }),
      ).rejects.toThrow('Authentication crypto unavailable');
    },
  );

  it('Actorの状態MACは全状態・版・日時・本人性を束縛する', async () => {
    const d = createAuthenticationDigests({ keys });
    const row = {
      actorId,
      version: 1,
      state: 'active' as const,
      createdAt: 0,
      disabledAt: null,
    };
    const mac = (await d.actorState({ row, keyVersion: 'v1' })).bytes;
    expect(await d.verifyActorState({ row, keyVersion: 'v1', mac })).toBe(true);
    for (const changed of [
      { ...row, actorId: epoch },
      { ...row, version: 2 },
      { ...row, createdAt: 1 },
      { ...row, state: 'disabled' as const, disabledAt: 1 },
    ]) {
      expect(
        await d.verifyActorState({ row: changed, keyVersion: 'v1', mac }),
      ).toBe(false);
    }
    expect(
      await d.verifyActorState({
        row,
        keyVersion: 'v1',
        mac: new Uint8Array(31),
      }),
    ).toBe(false);
  });

  it('用途違い／世代違い／epoch違いのProvider結果と障害を汎用失敗にする', async () => {
    const identity = {
      issuer: 'https://accounts.google.com' as const,
      subject: 'Synthetic-Subject-é',
    };
    for (const keyPort of [
      { readKey: () => Promise.resolve({ status: 'unavailable' as const }) },
      {
        readKey: () => Promise.reject(new Error('synthetic provider detail')),
      },
      {
        readKey: () =>
          Promise.resolve({
            status: 'available' as const,
            keyVersion: 'other',
            epoch: null,
            key: importAuthenticationMacKey(
              'auth-google-identity/v1',
              new Uint8Array(32),
            ),
          }),
      },
      {
        readKey: () =>
          Promise.resolve({
            status: 'available' as const,
            keyVersion: 'v1',
            epoch,
            key: importAuthenticationMacKey(
              'auth-google-identity/v1',
              new Uint8Array(32),
            ),
          }),
      },
    ]) {
      await expect(
        createAuthenticationDigests({ keys: { identity: keyPort } }).identity({
          identity,
          keyVersion: 'v1',
        }),
      ).rejects.toThrow('Authentication crypto unavailable');
    }
    const wrong = port('auth-session-cookie/v1', 3);
    // @ts-expect-error Session Cookie鍵PortをIdentity用途へ渡せない。
    const d = createAuthenticationDigests({ keys: { identity: wrong } });
    await expect(d.identity({ identity, keyVersion: 'v1' })).rejects.toThrow(
      'Authentication crypto unavailable',
    );
  });
});
