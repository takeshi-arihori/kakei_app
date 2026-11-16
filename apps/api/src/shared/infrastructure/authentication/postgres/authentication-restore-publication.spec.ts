import { describe, expect, it } from 'vitest';

import { AuthenticationCryptoUnavailable } from '../../../application/authentication/authentication-record-protection.js';
import { authenticationRestorePublication } from './authentication-restore-publication.js';

const epoch = '33333333-3333-4333-8333-333333333333';
const base = [
  'google-identity-search',
  'login-attempt-cookie',
  'session-cookie',
  'actor-state-mac',
  'audit-actor',
  'audit-attempt',
  'audit-session',
  'deleted-actor',
  'deletion-ledger-mac',
];
const codes = ['recipient-code-lookup', 'recipient-code-state-mac'];
const generation = (purpose: string, keyVersion = 'v1') => ({
  purpose,
  keyVersion,
  epoch: purpose.includes('cookie') ? epoch : null,
  searchable: true,
  writeRequired: true,
  retiredAt: null,
});
const publication = (purposes: readonly string[], extra: object[] = []) => ({
  runId: '11111111-1111-4111-8111-111111111111',
  revision: 2,
  epoch,
  generations: [...purposes.map((purpose) => generation(purpose)), ...extra],
});

describe('Restoreの公開世代の検査（ADR #278 論点6）', () => {
  it('コード不参加は既存9用途だけを受理し、コード用途を含む公開を拒否する', () => {
    expect(
      authenticationRestorePublication(publication(base)).generations,
    ).toHaveLength(9);
    for (const purpose of codes)
      expect(() =>
        authenticationRestorePublication(publication([...base, purpose])),
      ).toThrow(AuthenticationCryptoUnavailable);
  });

  it('コード参加はコード2用途を含む11用途を受理する', () => {
    const accepted = authenticationRestorePublication(
      publication([...base, ...codes]),
      true,
    );
    expect(accepted.generations.map((g) => g.purpose)).toEqual([
      ...base,
      ...codes,
    ]);
  });

  it.each(codes)('コード参加で%sの世代が欠ければ拒否する', (missing) => {
    expect(() =>
      authenticationRestorePublication(
        publication([...base, ...codes.filter((p) => p !== missing)]),
        true,
      ),
    ).toThrow(AuthenticationCryptoUnavailable);
  });

  it.each(codes)(
    'コード参加で%sの書込必須世代が2つあれば拒否する',
    (purpose) => {
      expect(() =>
        authenticationRestorePublication(
          publication([...base, ...codes], [generation(purpose, 'v2')]),
          true,
        ),
      ).toThrow(AuthenticationCryptoUnavailable);
    },
  );

  it('コード用途の退役世代は検索・書込なしで受理し、epochは持たせない', () => {
    const retired = {
      ...generation('recipient-code-lookup', 'v0'),
      searchable: false,
      writeRequired: false,
      retiredAt: 1000,
    };
    expect(
      authenticationRestorePublication(
        publication([...base, ...codes], [retired]),
        true,
      ).generations,
    ).toHaveLength(12);
    expect(() =>
      authenticationRestorePublication(
        publication([...base, ...codes], [{ ...retired, epoch }]),
        true,
      ),
    ).toThrow(AuthenticationCryptoUnavailable);
  });

  it('未知の用途は参加の有無に依らず拒否する', () => {
    for (const participating of [false, true])
      expect(() =>
        authenticationRestorePublication(
          publication([...base, ...codes, 'future-purpose']),
          participating,
        ),
      ).toThrow(AuthenticationCryptoUnavailable);
  });
});
