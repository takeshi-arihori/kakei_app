import type {
  GoogleIdTokenVerification,
  VerifiedGoogleIdentity,
} from '../google-id-token-verification.js';
import {
  authenticationLifetime,
  type AlreadyAuthenticated,
  type AttemptSnapshot,
  type AuthenticationClock,
  type AuthenticationEntropy,
  type AuthenticationSecretPurpose,
  type AuthenticationStore,
  type AuthenticationUnavailable,
  type AuthenticatedActor,
  type AuthenticatedActorResult,
  type BeginAttemptResult,
  type CompleteAttemptResult,
  type LogoutResult,
  type SessionUsage,
} from './authentication-ports.js';
import type {
  AuthenticationSerializedValue,
  AuthenticationTransactionScope,
} from './authentication-transaction-scope.js';

/** BrowserのCookie由来値のみを受ける。Actorや期待nonceをClient指定させない。 */
export interface BeginGoogleLoginInput {
  /** 不正形式なら旧Recordを選択せず、新規開始だけを行う。 */
  readonly previousAttemptSecret?: unknown;
  /** 有効SessionならStoreが再ログインを拒否する。 */
  readonly currentSessionSecret?: unknown;
}

/** 開始成功時だけCookie setter／GISに必要な秘密値を返す内部結果。 */
export type BeginGoogleLoginResult =
  | (Extract<BeginAttemptResult, { status: 'started' }> & {
      /** HttpOnly Cookieへ渡す秘密値。LogやURLへ出さない。 */
      readonly attemptSecret: string;
      /** Googleへ渡すServer発行nonce。 */
      readonly nonce: string;
      /** 同じ試行へ束縛する専用CSRF。 */
      readonly csrf: string;
    })
  | AlreadyAuthenticated
  | AuthenticationUnavailable;

/** 未検証CredentialをServer保持の試行へ結び付ける入力。 */
export interface CompleteGoogleLoginInput {
  /** Google Verifierで検証する外部値。暗黙変換しない。 */
  readonly credential: unknown;
  /** HttpOnly Cookieから取得する試行秘密値。 */
  readonly attemptSecret: unknown;
  /** 同じ試行に束縛されたCSRF。期待nonceとは独立する。 */
  readonly csrf: unknown;
  /** 有効ならAccountの暗黙切替を拒否する。 */
  readonly currentSessionSecret?: unknown;
}

/** Session発行成功時だけCookie setter向け秘密値を含む内部結果。 */
export type CompleteGoogleLoginResult =
  | (Extract<CompleteAttemptResult, { status: 'authenticated' }> & {
      /** 新Session秘密値。ActorやGoogle IdentityをClientへ返さない。 */
      readonly sessionSecret: string;
    })
  | Exclude<CompleteAttemptResult, { status: 'authenticated' }>
  | {
      /** Google検証拒否。Actor／Session作成や試行消費は行わない。 */
      readonly status: 'invalid-credential';
    };

const isSecret = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
const optionalSecret = (value: unknown) =>
  isSecret(value) ? value : undefined;
const isTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
const isReference = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 255 &&
  value.trim() === value;
const isActorSubject = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

/** Transportと保存実装を分離するGoogle認証内部Use Case。 */
export class GoogleAuthenticationService {
  private readonly checkedClock: AuthenticationClock;

  /**
   * @param verifier Server期待nonceを照合する既存Google検証Port。
   * @param store 原子的な認証保存Port。#216で実DBの保存・監査・競合を検証し、本番Providerは別Gateとする。
   * @param entropy 用途ごとに独立した秘密値を発行するPort。
   * @param clock Storeの判断点で取得するUTC Clock。
   */
  constructor(
    private readonly verifier: GoogleIdTokenVerification,
    private readonly store: AuthenticationStore,
    private readonly entropy: AuthenticationEntropy,
    clock: AuthenticationClock,
  ) {
    this.checkedClock = {
      now: () => {
        const now = clock.now();
        if (
          !isTime(now) ||
          now > Number.MAX_SAFE_INTEGER - authenticationLifetime.absolute
        )
          throw new Error('認証Clockの範囲外');
        return now;
      },
    };
  }

  private generate(
    purposes: readonly AuthenticationSecretPurpose[],
    forbidden: readonly string[] = [],
  ): string[] {
    const values = purposes.map((purpose) => this.entropy.generate(purpose));
    if (
      !values.every(isSecret) ||
      new Set(values).size !== values.length ||
      values.some((value) => forbidden.includes(value))
    )
      throw new Error('認証Entropyの契約違反');
    return values;
  }

  /**
   * @param input 同じBrowserの旧試行と現在Session。ClientのActor指定は受けない。
   * @returns 試行開始と内部秘密値、再ログイン拒否、または障害。障害はrollbackを意味しない。
   */
  async beginGoogleLogin(
    input: BeginGoogleLoginInput = {},
  ): Promise<BeginGoogleLoginResult> {
    try {
      const previousAttemptSecret = optionalSecret(input.previousAttemptSecret);
      const currentSessionSecret = optionalSecret(input.currentSessionSecret);
      const [attemptSecret, nonce, csrf] = this.generate([
        'attempt',
        'nonce',
        'login-csrf',
      ]);
      const result = await this.store.begin(
        Object.freeze({
          attemptSecret,
          nonce,
          csrf,
          previousAttemptSecret,
          currentSessionSecret,
        }),
        this.checkedClock,
      );
      if (result.status !== 'started') return { status: result.status };
      if (!isTime(result.expiresAt)) return { status: 'unavailable' };
      return {
        status: 'started',
        expiresAt: result.expiresAt,
        attemptSecret,
        nonce,
        csrf,
      };
    } catch {
      return { status: 'unavailable' };
    }
  }

  private copySnapshot(snapshot: AttemptSnapshot): AttemptSnapshot {
    const copy = Object.freeze({
      recordId: snapshot.recordId,
      version: snapshot.version,
      nonce: snapshot.nonce,
      expiresAt: snapshot.expiresAt,
    });
    if (
      !isReference(copy.recordId) ||
      !Number.isSafeInteger(copy.version) ||
      copy.version < 0 ||
      !isSecret(copy.nonce) ||
      !isTime(copy.expiresAt)
    )
      throw new Error('認証Snapshotの契約違反');
    return copy;
  }

  private copyIdentity(
    identity: VerifiedGoogleIdentity,
  ): VerifiedGoogleIdentity {
    const copy = Object.freeze({
      issuer: identity.issuer,
      subject: identity.subject,
    });
    if (
      copy.issuer !== 'https://accounts.google.com' ||
      !isReference(copy.subject)
    )
      throw new Error('Google検証Identityの契約違反');
    return copy;
  }

  /**
   * @param input 未検証CredentialとCookie由来のBrowser試行束縛。
   * @returns 新Session秘密値と期限、検証拒否、再開始、再ログイン拒否、または結果不明を含む障害。
   */
  async completeGoogleLogin(
    input: CompleteGoogleLoginInput,
  ): Promise<CompleteGoogleLoginResult> {
    try {
      const { credential, attemptSecret, csrf } = input;
      const currentSessionSecret = optionalSecret(input.currentSessionSecret);
      if (!isSecret(attemptSecret) || !isSecret(csrf))
        return { status: 'restart-required' };
      const binding = Object.freeze({ attemptSecret, csrf });
      const attempt = await this.store.readAttempt(binding, this.checkedClock);
      if (attempt.status !== 'ready') return { status: attempt.status };
      // Portが保持するObjectをawait越しに共有せず、検証対象の版を固定する。
      const snapshot = this.copySnapshot(attempt.snapshot);
      if (this.checkedClock.now() >= snapshot.expiresAt)
        return { status: 'restart-required' };
      const verified = await this.verifier.verify({
        idToken: credential,
        expectedNonce: snapshot.nonce,
      });
      if (verified.status !== 'verified') return { status: verified.status };
      const identity = this.copyIdentity(verified.identity);
      const [sessionSecret, sessionCsrf] = this.generate(
        ['session', 'session-csrf'],
        [attemptSecret, csrf, snapshot.nonce],
      );
      const result = await this.store.complete(
        Object.freeze({
          ...binding,
          snapshot,
          identity,
          sessionSecret,
          sessionCsrf,
          currentSessionSecret,
        }),
        this.checkedClock,
      );
      if (result.status !== 'authenticated') return { status: result.status };
      if (!isTime(result.absoluteExpiresAt)) return { status: 'unavailable' };
      return {
        status: 'authenticated',
        absoluteExpiresAt: result.absoluteExpiresAt,
        sessionSecret,
      };
    } catch {
      return { status: 'unavailable' };
    }
  }

  /**
   * @param sessionSecret Cookie由来のSession秘密値。不正形式ならStoreもCallbackも呼ばない。
   * @param usage 許可された活動か照会か。照会はidleを延長しない。
   * @param callback Storeのlease下でScopeから本文handleを発行して返す非公開処理。
   * @returns 同Scopeで確定した本文、本人性なし、または結果不明を含む障害。例外causeを返さない。
   */
  async withAuthenticatedActor<T extends AuthenticationSerializedValue>(
    sessionSecret: unknown,
    usage: SessionUsage,
    callback: (
      actor: AuthenticatedActor,
      scope: AuthenticationTransactionScope,
    ) => Promise<T>,
  ): Promise<AuthenticatedActorResult<T>> {
    if (!isSecret(sessionSecret)) return { status: 'unauthenticated' };
    if (usage !== 'inspect' && usage !== 'activity')
      return { status: 'unavailable' };
    try {
      const result = await this.store.withSession(
        sessionSecret,
        usage,
        this.checkedClock,
        (actor, scope) => {
          const copy = Object.freeze({
            actorSubject: actor.actorSubject,
            absoluteExpiresAt: actor.absoluteExpiresAt,
            csrf: actor.csrf,
          });
          if (
            !isActorSubject(copy.actorSubject) ||
            !isSecret(copy.csrf) ||
            !isTime(copy.absoluteExpiresAt) ||
            this.checkedClock.now() >= copy.absoluteExpiresAt
          )
            throw new Error('認証本人性の契約違反');
          return callback(copy, scope);
        },
      );
      return result.status === 'authenticated'
        ? { status: 'authenticated', value: result.value }
        : { status: result.status };
    } catch {
      return { status: 'unavailable' };
    }
  }

  /**
   * @param sessionSecret 現在Cookieの秘密値。他Sessionは失効しない。
   * @returns 冪等な失効成功、または結果不明を含む障害。Cookie削除は後続HTTPの責務。
   */
  async logoutCurrentSession(sessionSecret: unknown): Promise<LogoutResult> {
    if (!isSecret(sessionSecret)) return { status: 'logged-out' };
    try {
      const result = await this.store.revoke(sessionSecret, this.checkedClock);
      return { status: result.status };
    } catch {
      return { status: 'unavailable' };
    }
  }
}
