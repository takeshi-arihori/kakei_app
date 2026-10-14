import { describe, expect, it } from 'vitest';

import {
  decodeAuthenticationTlv,
  encodeAuthenticationRow,
  encodeAuthenticationTlv,
  parseAuthenticationRow,
  parseAuthenticationSecret,
} from './canonical-authentication.js';
import { cases } from './test/authentication-crypto-fixtures.js';

const id = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000002';
const row = {
  recordKind: 'google-identity',
  identityId: id,
  actorId,
  version: 1,
};
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describe('認証専用Canonical表現', () => {
  it('固定TLVとnullableの唯一のabsence表現を維持する', () => {
    const bytes = encodeAuthenticationTlv(['A', null, Uint8Array.of(0, 255)]);
    expect(hex(bytes)).toBe('0101000000014102000000000003010000000200ff');
    expect(
      decodeAuthenticationTlv(bytes, ['text', 'nullable-text', 'binary']),
    ).toEqual(['A', null, Uint8Array.of(0, 255)]);
  });

  it.each(['', ' a', 'a ', '\u0000', '\u001f', '\u007f', '\u0085', '\ud800'])(
    '文字列 %j を正規化せず拒否する',
    (value) => {
      expect(() => encodeAuthenticationTlv([value])).toThrow();
    },
  );

  it('Unicodeの合成／分解表現とcaseを区別する', () => {
    expect(hex(encodeAuthenticationTlv(['é']))).not.toBe(
      hex(encodeAuthenticationTlv(['e\u0301'])),
    );
    expect(hex(encodeAuthenticationTlv(['Sub']))).not.toBe(
      hex(encodeAuthenticationTlv(['sub'])),
    );
  });

  it.each([
    '010100000002c328', // 不正UTF-8。
    '02010000000141', // 未知tag／欠落。
    '01020000000141', // 不正presence。
    '01000000000141', // absenceに内容。
    '010000000000', // 必須Fieldのabsence。
    '010100000000', // 空文字。
    '01010000000241', // 宣言長より短い。
    '0101000000014100', // 余分byte。
    '0101000000014101010000000141', // 重複tag。
  ])('破損TLV %s を拒否する', (value) => {
    expect(() =>
      decodeAuthenticationTlv(Buffer.from(value, 'hex'), ['text']),
    ).toThrow();
  });

  it('IdentityのRow BindingはID／Actor／版を記載順に束縛する', () => {
    const bytes = encodeAuthenticationRow(parseAuthenticationRow(row));
    expect(decodeAuthenticationTlv(bytes, ['text', 'text', 'text'])).toEqual([
      id,
      actorId,
      '1',
    ]);
  });

  it.each([
    {
      ...row,
      actorId: actorId.toUpperCase().replace('000000000002', '00000000000A'),
    },
    { ...row, identityId: id.replace('-4000-', '-1000-') },
    { ...row, version: 0 },
    { ...row, version: Number.MAX_SAFE_INTEGER + 1 },
    { ...row, version: 1.5 },
    { ...row, createdAt: 0 },
    { recordKind: 'google-identity', identityId: id, version: 1 },
  ])('非Canonical／未知／欠落Rowを拒否する', (value) => {
    expect(() => parseAuthenticationRow(value)).toThrow();
  });

  it('32-byte秘密値はcanonical unpadded Base64URLだけを許す', () => {
    const secret = Buffer.alloc(32, 7).toString('base64url');
    expect(parseAuthenticationSecret(secret)).toEqual(
      new Uint8Array(32).fill(7),
    );
    for (const invalid of [
      secret + '=',
      secret.slice(1),
      'A'.repeat(42) + 'B',
      secret + '\n',
      7,
      null,
    ]) {
      expect(() => parseAuthenticationSecret(invalid)).toThrow();
    }
  });

  it('stateの暗黙文字列変換を実行しない', () => {
    const state = { toString: () => 'consumed' };
    expect(() =>
      parseAuthenticationRow({
        recordKind: 'login-attempt',
        attemptId: id,
        version: 1,
        epoch: actorId,
        createdAt: 0,
        expiresAt: 300_000,
        state,
        terminalAt: 1,
        cookieDigestKeyVersion: 'v1',
        cookieDigest: new Uint8Array(32),
      }),
    ).toThrow();
  });

  it('非nullable binaryの空Fieldを拒否する', () => {
    expect(() => encodeAuthenticationTlv([new Uint8Array()])).toThrow();
    expect(() =>
      decodeAuthenticationTlv(Buffer.from('010100000000', 'hex'), ['binary']),
    ).toThrow();
  });

  it('版とUTCのMAX_SAFE_INTEGER境界を保持する', () => {
    expect(
      parseAuthenticationRow({ ...row, version: Number.MAX_SAFE_INTEGER })
        .version,
    ).toBe(Number.MAX_SAFE_INTEGER);
    for (const sample of cases.slice(1)) {
      const lifetime =
        sample.row.recordKind === 'login-attempt' ? 300_000 : 604_800_000;
      const changed =
        sample.row.recordKind === 'login-attempt'
          ? {
              ...sample.row,
              createdAt: Number.MAX_SAFE_INTEGER - lifetime,
              expiresAt: Number.MAX_SAFE_INTEGER,
            }
          : {
              ...sample.row,
              createdAt: Number.MAX_SAFE_INTEGER - lifetime,
              absoluteExpiresAt: Number.MAX_SAFE_INTEGER,
              idleExpiresAt: Number.MAX_SAFE_INTEGER,
            };
      expect(parseAuthenticationRow(changed).version).toBe(1);
    }
  });

  it.each([-1, -0, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null, 0.1])(
    'UTCの不正値 %s を拒否する',
    (createdAt) => {
      for (const sample of cases.slice(1))
        expect(() =>
          parseAuthenticationRow({ ...sample.row, createdAt }),
        ).toThrow();
    },
  );

  it('Attemptの固定TTL・終端時刻・状態の整合を検証する', () => {
    const row = cases[1].row;
    for (const patch of [
      { expiresAt: 299_999 },
      { expiresAt: 300_001 },
      { state: 'consumed' },
      { terminalAt: 1 },
      { state: 'consumed', terminalAt: -1 },
      { state: 'unknown', terminalAt: 1 },
      { cookieDigest: new Uint8Array(31) },
      { cookieDigestKeyVersion: 'v1/' },
    ]) {
      expect(() => parseAuthenticationRow({ ...row, ...patch })).toThrow();
    }
    expect(
      parseAuthenticationRow({ ...row, state: 'consumed', terminalAt: 0 })
        .recordKind,
    ).toBe('login-attempt');
  });

  it('Sessionの最長期限・idle・終端時刻・状態の整合を検証する', () => {
    const row = cases[2].row;
    for (const patch of [
      { absoluteExpiresAt: 604_800_001 },
      { absoluteExpiresAt: 0 },
      { idleExpiresAt: 0 },
      { idleExpiresAt: 604_800_001 },
      { state: 'revoked' },
      { terminalAt: 1 },
      { state: 'unknown', terminalAt: 1 },
    ]) {
      expect(() => parseAuthenticationRow({ ...row, ...patch })).toThrow();
    }
    expect(
      parseAuthenticationRow({ ...row, state: 'revoked', terminalAt: 0 })
        .recordKind,
    ).toBe('session');
  });
});
