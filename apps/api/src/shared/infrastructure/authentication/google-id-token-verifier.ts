import { OAuth2Client } from 'google-auth-library';

import type {
  GoogleIdTokenVerification,
  GoogleIdTokenVerificationInput,
  GoogleIdTokenVerificationResult,
} from '../../application/google-id-token-verification.js';

/** 起動時にServerが与えるGoogle Client IDの許可集合。 */
export interface GoogleIdTokenVerifierConfig {
  /** Client入力から決めず、空や前後空白を許可しない。 */
  readonly allowedAudiences: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// 未検証JSONは拒否のためだけに使い、本人性や鍵取得先を決定しない。
const hasSupportedStructure = (idToken: unknown): idToken is string => {
  if (
    typeof idToken !== 'string' ||
    idToken.length === 0 ||
    idToken.length > 16 * 1024
  )
    return false;
  const segments = idToken.split('.');
  if (
    segments.length !== 3 ||
    !segments.every((segment) => /^[A-Za-z0-9_-]+$/.test(segment))
  )
    return false;
  try {
    const header: unknown = JSON.parse(
      Buffer.from(segments[0], 'base64url').toString('utf8'),
    );
    const payload: unknown = JSON.parse(
      Buffer.from(segments[1], 'base64url').toString('utf8'),
    );
    return (
      isRecord(payload) &&
      isRecord(header) &&
      header.alg === 'RS256' &&
      typeof header.kid === 'string' &&
      header.kid.trim().length > 0
    );
  } catch {
    return false;
  }
};

/** Google公式SDKを閉じ込めるCredential検証Adapter。 */
export class GoogleIdTokenVerifier implements GoogleIdTokenVerification {
  private readonly client: OAuth2Client;
  private readonly allowedAudiences: string[];

  /**
   * @param config Server管理のaudience設定。検証中の差替えを防ぐためコピーする。
   * @throws TypeError 許可集合が空、または不正なClient IDを含む場合。
   */
  constructor(config: GoogleIdTokenVerifierConfig) {
    const configuredAudiences: unknown = config.allowedAudiences;
    const audiences: unknown[] = Array.isArray(configuredAudiences)
      ? Array.from(configuredAudiences)
      : [];
    if (
      audiences.length === 0 ||
      !audiences.every(
        (value: unknown): value is string =>
          typeof value === 'string' &&
          value.length > 0 &&
          value === value.trim(),
      )
    )
      throw new TypeError('Google audience設定が不正です');
    this.allowedAudiences = [...audiences];
    // timeoutは通信1試行の上限。SDK既定retryを含む全体の上限ではない。
    this.client = new OAuth2Client({ transporterOptions: { timeout: 5000 } });
  }

  /**
   * @param input 外部TokenとServer保持の期待nonce。nonce発行・原子的消費は呼出し側の責務。
   * @returns 検証済み識別子、不正Credential、または公開鍵取得障害。SDK例外を返さない。
   */
  async verify(
    input: GoogleIdTokenVerificationInput,
  ): Promise<GoogleIdTokenVerificationResult> {
    const { idToken, expectedNonce } = input;
    if (
      !hasSupportedStructure(idToken) ||
      typeof expectedNonce !== 'string' ||
      expectedNonce.length === 0 ||
      expectedNonce.length > 256
    ) {
      return { status: 'invalid-credential' };
    }

    let certificates;
    try {
      certificates = await this.client.getFederatedSignonCertsAsync();
    } catch {
      return { status: 'unavailable' };
    }

    try {
      const ticket = await this.client.verifySignedJwtWithCertsAsync(
        idToken,
        certificates.certs,
        this.allowedAudiences,
        ['accounts.google.com', 'https://accounts.google.com'],
      );
      const payload: unknown = ticket.getPayload();
      const now = Math.floor(Date.now() / 1000);
      // SDKの型強制変換・300秒の許容を本人性Portへ持ち込まない。
      if (
        !isRecord(payload) ||
        (payload.iss !== 'accounts.google.com' &&
          payload.iss !== 'https://accounts.google.com') ||
        typeof payload.aud !== 'string' ||
        !this.allowedAudiences.includes(payload.aud) ||
        typeof payload.sub !== 'string' ||
        payload.sub.length === 0 ||
        payload.sub.length > 255 ||
        payload.sub !== payload.sub.trim() ||
        typeof payload.iat !== 'number' ||
        !Number.isSafeInteger(payload.iat) ||
        typeof payload.exp !== 'number' ||
        !Number.isSafeInteger(payload.exp) ||
        payload.iat > now ||
        now >= payload.exp ||
        payload.iat >= payload.exp ||
        typeof payload.nonce !== 'string' ||
        payload.nonce !== expectedNonce
      ) {
        return { status: 'invalid-credential' };
      }
      return {
        status: 'verified',
        identity: {
          issuer: 'https://accounts.google.com',
          subject: payload.sub,
        },
      };
    } catch {
      // SDK例外にはJWTやPayloadを含む場合があるのでcauseにもLogにも出さない。
      return { status: 'invalid-credential' };
    }
  }
}
