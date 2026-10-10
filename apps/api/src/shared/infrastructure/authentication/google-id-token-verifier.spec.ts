import { generateKeyPairSync, sign } from 'node:crypto';

import { gaxios, OAuth2Client } from 'google-auth-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GoogleIdTokenVerifier } from './google-id-token-verifier.js';

const now = 1_791_590_400;
const audience = 'synthetic-web-client';
const nonce = 'synthetic-server-login-attempt';
// 鍵もJWTも実行中だけ生成し、実GoogleのCredentialをFixtureへ保存しない。
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const certificate = keys.publicKey.export({ type: 'spki', format: 'pem' });
const claims = () => ({
  iss: 'https://accounts.google.com',
  sub: 'synthetic-google-subject',
  aud: audience,
  iat: now - 60,
  exp: now + 3600,
  nonce,
  email: 'fictional@example.test',
  name: '架空の利用者',
});

const rawToken = (payload: unknown, header: unknown, key = keys.privateKey) => {
  const body = [header, payload]
    .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
    .join('.');
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
};
const token = (
  overrides: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key = keys.privateKey,
) =>
  rawToken(
    { ...claims(), ...overrides },
    { alg: 'RS256', kid: 'synthetic-key', ...header },
    key,
  );

const createVerifier = () =>
  new GoogleIdTokenVerifier({ allowedAudiences: [audience] });
const verify = (idToken: unknown, expectedNonce = nonce) =>
  createVerifier().verify({ idToken, expectedNonce });
const invalid = { status: 'invalid-credential' };

const spyOnCertificates = () =>
  vi.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync');
const spyOnRequest = () => vi.spyOn(gaxios.Gaxios.prototype, 'request');
let certificateSpy: ReturnType<typeof spyOnCertificates>;
let requestSpy: ReturnType<typeof spyOnRequest>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now * 1000);
  certificateSpy = spyOnCertificates();
  requestSpy = spyOnRequest().mockResolvedValue(
    Object.assign(
      new Response(null, {
        headers: { 'cache-control': 'public, max-age=3600' },
      }),
      {
        config: {
          url: new URL('https://www.googleapis.com/oauth2/v1/certs'),
          headers: new Headers(),
        },
        data: { 'synthetic-key': certificate },
      },
    ),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Google IDトークン検証境界', () => {
  it.each(['https://accounts.google.com', 'accounts.google.com'])(
    'Google署名と全契約が成立したissuer %sをcanonical issuerとsubだけへ変換する',
    async (iss) => {
      expect(await verify(token({ iss }))).toEqual({
        status: 'verified',
        identity: {
          issuer: 'https://accounts.google.com',
          subject: 'synthetic-google-subject',
        },
      });
    },
  );

  it('署名後にPayloadを差し替えたTokenを拒否する', async () => {
    const parts = token().split('.');
    parts[1] = Buffer.from(
      JSON.stringify({ ...claims(), sub: 'other-subject' }),
    ).toString('base64url');
    expect(await verify(parts.join('.'))).toEqual(invalid);
  });

  it('Google公開鍵と対応しない鍵の署名を拒否する', async () => {
    expect(await verify(token({}, {}, otherKeys.privateKey))).toEqual(invalid);
  });

  it.each([
    ['別audience', { aud: 'attacker-client' }],
    ['audience配列', { aud: [audience] }],
    ['audience欠落', { aud: undefined }],
    ['別issuer', { iss: 'https://accounts.google.com.attacker.test' }],
    ['issuer型不正', { iss: 1 }],
    ['issuer欠落', { iss: undefined }],
    ['期限ちょうど', { exp: now }],
    ['期限切れ', { exp: now - 1 }],
    ['SDK上限以上の期限', { exp: now + 86400 }],
    ['未来発行1秒', { iat: now + 1 }],
    ['期限より後の発行', { iat: now + 3600 }],
    ['発行日時文字列', { iat: String(now - 60) }],
    ['期限文字列', { exp: String(now + 3600) }],
    ['発行日時小数', { iat: now - 0.5 }],
    ['期限小数', { exp: now + 0.5 }],
    ['発行日時欠落', { iat: undefined }],
    ['期限欠落', { exp: undefined }],
    ['sub空', { sub: '' }],
    ['sub空白', { sub: ' ' }],
    ['sub前後空白', { sub: ' subject ' }],
    ['sub長過ぎ', { sub: 's'.repeat(256) }],
    ['sub型不正', { sub: 1 }],
    ['sub欠落', { sub: undefined }],
    ['nonce不一致', { nonce: 'other-attempt' }],
    ['nonce型不正', { nonce: 1 }],
    ['nonce欠落', { nonce: undefined }],
  ])('%sではidentityを返さない', async (_reason, overrides) => {
    expect(await verify(token(overrides))).toEqual(invalid);
  });

  it('発行時刻ちょうど・期限1秒前は有効とする', async () => {
    expect((await verify(token({ iat: now, exp: now + 1 }))).status).toBe(
      'verified',
    );
  });

  it.each(['none', 'HS256', 'RS512', 'ES256'])(
    'RSA署名が一致してもalg %sを拒否する',
    async (alg) => {
      expect(await verify(token({}, { alg }))).toEqual(invalid);
      expect(certificateSpy).not.toHaveBeenCalled();
    },
  );

  it.each(['unknown-key', '__proto__'])(
    'Google公開鍵に存在しないkid %sを拒否する',
    async (kid) => {
      expect(await verify(token({}, { kid }))).toEqual(invalid);
    },
  );

  it.each(
    [
      null,
      undefined,
      1,
      {},
      [],
      '',
      'not-a-jwt',
      'a.b.c',
      'a.b.c.d',
      'e30=.e30.sig',
      'e30.e30.s+g',
      'a'.repeat(16385),
    ].map((idToken) => ({ idToken })),
  )('不正外部入力 %#を公開鍵取得前に拒否する', async ({ idToken }) => {
    expect(await verify(idToken)).toEqual(invalid);
    expect(certificateSpy).not.toHaveBeenCalled();
  });

  it.each(
    [
      null,
      [],
      'header',
      { alg: 'RS256' },
      { alg: 'RS256', kid: '' },
      { alg: 'RS256', kid: ' ' },
    ].map((header) => ({ header })),
  )('不正header %#を公開鍵取得前に拒否する', async ({ header }) => {
    expect(await verify(rawToken(claims(), header))).toEqual(invalid);
    expect(certificateSpy).not.toHaveBeenCalled();
  });

  it.each([null, [], 'payload'].map((payload) => ({ payload })))(
    '署名付きでも不正Payload %#を拒否する',
    async ({ payload }) => {
      expect(
        await verify(rawToken(payload, { alg: 'RS256', kid: 'synthetic-key' })),
      ).toEqual(invalid);
      expect(certificateSpy).not.toHaveBeenCalled();
    },
  );

  it.each(['', 'n'.repeat(257)])(
    '不正なServer nonce %#で公開鍵を取得しない',
    async (expectedNonce) => {
      expect(await verify(token(), expectedNonce)).toEqual(invalid);
      expect(certificateSpy).not.toHaveBeenCalled();
    },
  );

  it.each(
    [[], [''], [' '], [' client '], new Array<string>(1)].map(
      (allowedAudiences) => ({
        allowedAudiences,
      }),
    ),
  )('不正audience設定 %#を起動時に拒否する', ({ allowedAudiences }) => {
    expect(() => new GoogleIdTokenVerifier({ allowedAudiences })).toThrow(
      TypeError,
    );
  });

  it('公開鍵取得を待つ間に入力Objectが変わっても検証対象を差し替えない', async () => {
    const input = { idToken: token(), expectedNonce: nonce };
    const result = createVerifier().verify(input);
    input.idToken = 'changed';
    input.expectedNonce = 'changed';
    expect((await result).status).toBe('verified');
  });

  it('設定配列の変更で検証対象を差し替えられない', async () => {
    const allowedAudiences = [audience];
    const verifier = new GoogleIdTokenVerifier({ allowedAudiences });
    allowedAudiences[0] = 'attacker-client';
    expect(
      (await verifier.verify({ idToken: token(), expectedNonce: nonce }))
        .status,
    ).toBe('verified');
    expect(
      await verifier.verify({
        idToken: token({ aud: 'attacker-client' }),
        expectedNonce: nonce,
      }),
    ).toEqual(invalid);
  });

  it('Serverが設定した複数audienceから選択できる', async () => {
    const verifier = new GoogleIdTokenVerifier({
      allowedAudiences: [audience, 'other-trusted-client'],
    });
    expect(
      (
        await verifier.verify({
          idToken: token({ aud: 'other-trusted-client' }),
          expectedNonce: nonce,
        })
      ).status,
    ).toBe('verified');
  });

  it('公開鍵取得障害はCredential不正と区別し詳細を返却・Logしない', async () => {
    const credential = token();
    requestSpy.mockRejectedValue(new Error(credential));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await verify(credential)).toEqual({ status: 'unavailable' });
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('同じAdapterはGoogle固定endpointの証明書を有効期限まで再利用する', async () => {
    const verifier = createVerifier();
    expect(
      (await verifier.verify({ idToken: token(), expectedNonce: nonce }))
        .status,
    ).toBe('verified');
    expect(
      (await verifier.verify({ idToken: token(), expectedNonce: nonce }))
        .status,
    ).toBe('verified');
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://www.googleapis.com/oauth2/v1/certs',
        retry: true,
      }),
    );
    const client = certificateSpy.mock.contexts[0];
    expect(client).toBeInstanceOf(OAuth2Client);
    if (!(client instanceof OAuth2Client))
      throw new Error('SDK境界のClientが見つからない');
    expect(client.transporter.defaults.timeout).toBe(5000);
  });

  it('不正なPayload JSONを公開鍵取得前に拒否する', async () => {
    const parts = token().split('.');
    parts[1] = Buffer.from('{').toString('base64url');
    expect(await verify(parts.join('.'))).toEqual(invalid);
    expect(certificateSpy).not.toHaveBeenCalled();
  });

  it('subと期待nonceの長さ上限を受け入れる', async () => {
    expect(
      (
        await verify(
          token({ sub: 's'.repeat(255), nonce: 'n'.repeat(256) }),
          'n'.repeat(256),
        )
      ).status,
    ).toBe('verified');
  });

  it('証明書cache期限後は再取得して署名を検証する', async () => {
    const verifier = createVerifier();
    expect(
      (await verifier.verify({ idToken: token(), expectedNonce: nonce }))
        .status,
    ).toBe('verified');
    vi.setSystemTime((now + 3600) * 1000);
    expect(
      (
        await verifier.verify({
          idToken: token({ iat: now + 3600, exp: now + 7200 }),
          expectedNonce: nonce,
        })
      ).status,
    ).toBe('verified');
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it('SDK検証の例外にTokenが含まれてもResultやLogへ伝播しない', async () => {
    const credential = token();
    vi.spyOn(
      OAuth2Client.prototype,
      'verifySignedJwtWithCertsAsync',
    ).mockRejectedValue(new Error(credential));
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    expect(await verify(credential)).toEqual(invalid);
    expect(error).not.toHaveBeenCalled();
  });
});
