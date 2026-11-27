import type { AuthenticationHttpSecurity } from '../../shared/application/authentication/authentication-http-ports.js';
import type { GoogleAuthenticationService } from '../../shared/application/authentication/google-authentication-service.js';
import { PublicGraphQLError } from './public-graphql-error.js';

/** 業務GraphQLが使う認証能力。lease取得だけに限定する。 */
export type GraphQLAuthenticationService = Pick<
  GoogleAuthenticationService,
  'withAuthenticatedActor'
>;

/** Context Resolverへ渡す本人性。秘密値・CSRF・期限を含めない。 */
export interface AuthenticatedActorReference {
  /** Server保存Sessionから導出したActor。Client値ではない。 */
  readonly actorSubject: string;
}

/** 実行中のOperation種別だけを読む、GraphQLResolveInfoの部分型。 */
export interface ExecutingOperation {
  /** graphql-jsが実行中のOperation。 */
  readonly operation: { readonly operation: string };
}

/** Resolver Contextに置く、業務Operation単位の認証能力。 */
export interface AuthenticatedOperation {
  /**
   * 認証lease（activity）を開き、その内側で業務処理を実行する。
   * Mutationはlease内でSession束縛CSRFを照合してから実行する。
   * @param info 実行中Operationの種別を持つResolver info。
   * @param work 本人の業務処理。業務Transactionはこの中でcommitする。
   * @returns 認証commit後の業務結果。
   * @throws PublicGraphQLError（本人性なし、CSRF不一致、業務の公開Error、結果不明）。
   */
  run<T>(
    info: ExecutingOperation,
    work: (actor: AuthenticatedActorReference) => Promise<T>,
  ): Promise<T>;
}

/** Context Resolverが参照できるGraphQL Context。秘密値を持たない。 */
export interface GraphQLContext {
  /** 業務Operation単位で認証leaseを開く能力。 */
  readonly authenticated: AuthenticatedOperation;
}

const csrfFormat = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
/**
 * CSRF Header値がSessionの発行形式か。lease前の拒否に使う。
 * @param value Header値または不在。
 * @returns canonical形式ならtrue。
 */
export const isCanonicalCsrfToken = (value: string | null): value is string =>
  value !== null && csrfFormat.test(value);

/** CSRF不一致で認証をrollbackさせるための内部印。外へ出さない。 */
class CsrfMismatch extends Error {}

/**
 * Request単位の認証能力を作る。秘密値はclosureに閉じ込め、Contextのfieldにしない。
 * @param options 注入された能力とRequestから選択した未検証値。
 * @returns Resolverが使う認証能力。能力未注入なら常にSERVICE_UNAVAILABLE。
 */
export const createAuthenticatedOperation = (
  options: Readonly<{
    service?: GraphQLAuthenticationService;
    security?: Pick<AuthenticationHttpSecurity, 'equalSecrets'>;
    sessionSecret: string | undefined;
    csrfToken: string | null;
  }>,
): AuthenticatedOperation => ({
  async run(info, work) {
    const { service, security, sessionSecret, csrfToken } = options;
    const kind = info.operation.operation;
    if (!service || !security || (kind !== 'query' && kind !== 'mutation'))
      throw new PublicGraphQLError('SERVICE_UNAVAILABLE');
    const mutation = kind === 'mutation';
    if (mutation && !isCanonicalCsrfToken(csrfToken))
      throw new PublicGraphQLError('REQUEST_REJECTED');
    let outcome:
      | { readonly ok: true; readonly value: Awaited<ReturnType<typeof work>> }
      | { readonly ok: false; readonly error: PublicGraphQLError }
      | undefined;
    let csrfRejected = false;
    const result = await service.withAuthenticatedActor(
      sessionSecret,
      'activity',
      async (actor, scope) => {
        if (mutation && !security.equalSecrets(actor.csrf, csrfToken!)) {
          csrfRejected = true;
          // 不一致のRequestでidleを延長しない。
          throw new CsrfMismatch();
        }
        try {
          outcome = {
            ok: true,
            value: await work(
              Object.freeze({ actorSubject: actor.actorSubject }),
            ),
          };
        } catch (error) {
          // 予期しない例外は認証もrollbackし、原因を外へ出さない。
          if (!(error instanceof PublicGraphQLError)) throw error;
          outcome = { ok: false, error };
        }
        // 認証Scopeへは固定本文だけを渡し、業務値はcommit後に返す。
        return scope.serialize({});
      },
    );
    if (result.status === 'unauthenticated')
      throw new PublicGraphQLError('AUTHENTICATION_REQUIRED');
    // 照合不一致のrollbackはunavailableで返るが、結果不明ではない。
    if (csrfRejected) throw new PublicGraphQLError('REQUEST_REJECTED');
    if (result.status !== 'authenticated' || outcome === undefined)
      throw new PublicGraphQLError('SERVICE_UNAVAILABLE');
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  },
});
