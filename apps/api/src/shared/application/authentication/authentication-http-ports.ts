/** HTTP Resource予算の独立した4操作。本人性の入力ではない。 */
export type AuthenticationHttpOperation =
  'attempt' | 'login' | 'session' | 'logout';

/** Rate予約は認証Transactionから独立し、認証拒否でも予算を戻さない。 */
export type AuthenticationHttpRateDecision =
  | Readonly<{ /** 共有予算を予約できた。 */ status: 'allowed' }>
  | Readonly<{
      /** 上限に達した。 */ status: 'limited';
      /** 次Windowまでの最低待機秒。 */ retryAfterSeconds: number;
    }>
  | Readonly<{
      /** 設定/DB/鍵障害。無制限にfallbackしない。 */ status: 'unavailable';
    }>;

/** Peer/globalの予算を全API instanceで共有するHTTP能力。 */
export interface AuthenticationHttpRate {
  /**
   * Google/認証保存へ進む前に共有予算を予約する。
   * @param operation ServerがEndpointから固定した操作。
   * @param peer Headerではなく接続から得たPeer。保存時は専用HMACで仮名化する。
   * @returns 予約、待機秒付き拒否、または封鎖を要する障害。
   */
  reserve(
    operation: AuthenticationHttpOperation,
    peer: string,
  ): Promise<AuthenticationHttpRateDecision>;
}

/** Nodeの具体暗号をHTTP PresentationへImportさせない固定用途の能力。 */
export interface AuthenticationHttpSecurity {
  /**
   * Server生成の相関IDを発行する。Client値を取り込まない。
   * @returns CSPRNG UUIDv4。
   */
  createRequestId(): string;
  /**
   * canonicalな同一長CSRF値を定数時間で照合する。
   * @param left 保存されたSession束縛値。
   * @param right HTTPで形式検証したHeader値。
   * @returns 値が同じ場合だけtrue。
   */
  equalSecrets(left: string, right: string): boolean;
}
