import { describe, expect, it } from 'vitest';

import {
  authenticationDatabaseBytes,
  authenticationDatabaseInteger,
  authenticationDatabaseRow,
} from './authentication-database-values.js';

describe('認証DB境界の精度と参照独立性', () => {
  it.each([
    '01',
    '-0',
    ' 1',
    '1.0',
    '1e3',
    '9007199254740992',
    -0,
    NaN,
    Infinity,
    0.5,
    null,
    1n,
  ])('非Canonical／範囲外のcase %#を拒否する', (value) => {
    expect(() => authenticationDatabaseInteger(value, 0)).toThrow();
  });
  it('bigint上限を丸めず復元し、版0を拒否する', () => {
    expect(authenticationDatabaseInteger('9007199254740991', 0)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(authenticationDatabaseInteger('0', 0)).toBe(0);
    expect(() => authenticationDatabaseInteger('0', 1)).toThrow();
  });
  it('byteaはCopyしAccessorは呼ばない', () => {
    const input = Buffer.alloc(32, 1);
    const copy = authenticationDatabaseBytes(input, 32);
    input.fill(2);
    expect(copy).toEqual(new Uint8Array(32).fill(1));
    expect(() => authenticationDatabaseBytes(Buffer.alloc(31), 32)).toThrow();
    expect(() => authenticationDatabaseBytes(Buffer.alloc(0))).toThrow();
    let called = false;
    expect(() =>
      authenticationDatabaseRow({
        get state() {
          called = true;
          return 'active';
        },
      }),
    ).toThrow();
    expect(called).toBe(false);
  });
});
