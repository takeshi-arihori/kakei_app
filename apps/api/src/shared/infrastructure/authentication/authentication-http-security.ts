import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthenticationHttpSecurity } from '../../application/authentication/authentication-http-ports.js';
import type { AuthenticationEntropy } from '../../application/authentication/authentication-ports.js';

const canonicalSecret = (value: string): boolean =>
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);

/**
 * HTTP専用の識別子と秘密値照合をNode標準暗号へ適合する。
 * @returns Client値を識別子へ流用しないHTTP能力。
 */
export const createAuthenticationHttpSecurity =
  (): AuthenticationHttpSecurity => ({
    createRequestId: () => randomUUID(),
    equalSecrets(left, right) {
      if (!canonicalSecret(left) || !canonicalSecret(right)) return false;
      return timingSafeEqual(
        Buffer.from(left, 'ascii'),
        Buffer.from(right, 'ascii'),
      );
    },
  });

/**
 * 用途間でも発行ごとに独立したOS乱数を生成する。
 * @returns Cookie/nonce/CSRFの既存32-byte契約を満たすEntropy。
 */
export const createAuthenticationEntropy = (): AuthenticationEntropy => ({
  generate: () => randomBytes(32).toString('base64url'),
});
