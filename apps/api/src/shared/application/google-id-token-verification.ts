/** Google Credentialを検証する入力。期待nonceはServer側のLogin試行から取得する。 */
export interface GoogleIdTokenVerificationInput {
  /** 未検証の外部入力。暗黙の文字列変換を行わない。 */
  readonly idToken: unknown;
  /** Client申告値ではなく、Serverが保持するLogin試行のnonce。 */
  readonly expectedNonce: string;
}

/** Actorとの照合に使う最小の検証済みGoogle識別子。 */
export interface VerifiedGoogleIdentity {
  /** Googleが許可する2表記を正規化したissuer。 */
  readonly issuer: 'https://accounts.google.com';
  /** Googleの安定識別子sub。emailを識別子として使わない。 */
  readonly subject: string;
}

/** 不正Credentialと公開鍵取得障害を分け、SDK例外やTokenを外へ返さない。 */
export type GoogleIdTokenVerificationResult =
  | {
      /** 署名と全Claimの検証が成功した。Session発行や認可の成立を意味しない。 */
      readonly status: 'verified';
      /** 最小の外部識別子。ProfileやCredentialを含まない。 */
      readonly identity: VerifiedGoogleIdentity;
    }
  | {
      /** 入力・署名・Claimのいずれかが不正。詳細は公開しない。 */
      readonly status: 'invalid-credential';
    }
  | {
      /** Google公開鍵の取得に失敗した。再試行方針は呼出し側で扱う。 */
      readonly status: 'unavailable';
    };

/** Provider検証を具体SDKから分離する技術Port。業務Contextを追加しない。 */
export interface GoogleIdTokenVerification {
  /**
   * Google Credentialを検証し、最小の外部識別子へ変換する。
   * @param input 未検証TokenとServer側の期待nonce。
   * @returns 検証済み識別子、不正Credential、または公開鍵取得障害。
   */
  verify(
    input: GoogleIdTokenVerificationInput,
  ): Promise<GoogleIdTokenVerificationResult>;
}
