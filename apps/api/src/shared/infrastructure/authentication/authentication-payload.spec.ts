import { describe, expect, it } from 'vitest';

import {
  encodeAuthenticationPayload,
  decodeAuthenticationPayload,
} from './authentication-payload.js';
import type { AuthenticationIdentityRow } from '../../application/authentication/authentication-record-protection.js';
import { cases } from './test/authentication-crypto-fixtures.js';

const row: AuthenticationIdentityRow = {
  recordKind: 'google-identity',
  identityId: '00000000-0000-4000-8000-000000000001',
  actorId: '00000000-0000-4000-8000-000000000002',
  version: 1,
};
const secrets = {
  issuer: 'https://accounts.google.com' as const,
  subject: 'Synthetic-Subject-é',
};
const encoder = new TextEncoder();
const payload = { payloadVersion: 1, row, ...secrets };

describe('認証Payloadのstrict検証', () => {
  it('Metadata Copyと最小Identityを保持して復号し、Unicodeを補正しない', () => {
    const bytes = encodeAuthenticationPayload(row, secrets);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(payload);
    expect(decodeAuthenticationPayload(bytes, row)).toEqual(secrets);
  });

  it.each([
    JSON.stringify(payload).replace(
      '"payloadVersion":1',
      '"payloadVersion":1,"payloadVersion":1',
    ),
    JSON.stringify(payload).replace(
      '"subject":',
      '"subject":"x","subj\\u0065ct":',
    ),
    JSON.stringify(payload).replace('"version":1', '"version":1,"version":1'),
    JSON.stringify({ ...payload, profile: 'forbidden' }),
    JSON.stringify({ ...payload, row: { ...row, createdAt: 0 } }),
    JSON.stringify({ ...payload, row: { ...row, version: 2 } }),
    JSON.stringify({ ...payload, payloadVersion: 2 }),
    JSON.stringify({ ...payload, issuer: 'accounts.google.com' }),
    JSON.stringify({ ...payload, subject: '\ud800' }),
    JSON.stringify({ ...payload, subject: ' subject ' }),
    JSON.stringify({ ...payload, subject: '' }),
    JSON.stringify({ payloadVersion: 1, row, issuer: secrets.issuer }),
    JSON.stringify(payload) + '{}',
    JSON.stringify(payload).replace(
      '"payloadVersion":1',
      '"payloadVersion":01',
    ),
    JSON.stringify(payload).replace(
      '"payloadVersion":1',
      '"payloadVersion":NaN',
    ),
    '[]',
    'null',
    '{"__proto__":{}}',
  ])('認証Tagが正しくてもPayload %s を拒否する', (text) => {
    expect(() =>
      decodeAuthenticationPayload(encoder.encode(text), row),
    ).toThrow('Authentication crypto unavailable');
  });

  it('不正UTF-8とBOMを補正しない', () => {
    for (const bytes of [
      Uint8Array.of(0xc3, 0x28),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(JSON.stringify(payload)),
      ]),
    ]) {
      expect(() => decodeAuthenticationPayload(bytes, row)).toThrow();
    }
  });

  it.each(cases)(
    '$row.recordKindのPayload Row Copy全Fieldと秘密項目の形式を確認する',
    (sample) => {
      const valid = encodeAuthenticationPayload(sample.row, sample.secrets);
      const text = new TextDecoder().decode(valid);
      const original = JSON.parse(text) as {
        payloadVersion: number;
        row: Record<string, unknown>;
      };
      for (const [key, value] of Object.entries(original.row)) {
        const changed =
          value === null
            ? 1
            : typeof value === 'number'
              ? value + 1
              : typeof value === 'string'
                ? value + '-changed'
                : 'changed';
        const payload = {
          ...original,
          row: { ...original.row, [key]: changed },
        };
        expect(() =>
          decodeAuthenticationPayload(
            encoder.encode(JSON.stringify(payload)),
            sample.row,
          ),
        ).toThrow();
      }
      for (const field of Object.keys(sample.secrets)) {
        const raw = JSON.parse(text) as Record<string, unknown>;
        delete raw[field];
        expect(() =>
          decodeAuthenticationPayload(
            encoder.encode(JSON.stringify(raw)),
            sample.row,
          ),
        ).toThrow();
        raw[field] = null;
        expect(() =>
          decodeAuthenticationPayload(
            encoder.encode(JSON.stringify(raw)),
            sample.row,
          ),
        ).toThrow();
        raw[field] = '';
        expect(() =>
          decodeAuthenticationPayload(
            encoder.encode(JSON.stringify(raw)),
            sample.row,
          ),
        ).toThrow();
      }
    },
  );
});
