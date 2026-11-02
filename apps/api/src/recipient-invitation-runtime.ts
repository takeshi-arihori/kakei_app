import { RegisteredRecipientInvitationService } from './group-management/application/use-cases/registered-recipient-invitation-service.js';
import type { RecipientCodeRequestProofPort } from './group-management/application/recipient-code-request-proof.js';
import {
  createEnlistedGroupRepository,
  type EnlistedGroupRepositoryOptions,
} from './group-management/infrastructure/postgres/enlisted-group-repository.js';
import type { InvitationId } from './group-management/domain/group.js';
import type { AuthenticationClock } from './shared/application/authentication/authentication-ports.js';
import type { RecipientCodeSessionPort } from './shared/application/authentication/recipient-code-ports.js';
import { createAuthenticationTransactionScopes } from './shared/infrastructure/authentication/postgres/authentication-transaction-scopes.js';
import { createRecipientCodeTransactionScopes } from './shared/infrastructure/authentication/postgres/recipient-code-transaction-scopes.js';
import { createPostgresRecipientCodeLeases } from './shared/infrastructure/authentication/postgres/postgres-recipient-code-leases.js';
import { createPostgresRecipientCodeStore } from './shared/infrastructure/authentication/postgres/postgres-recipient-code-store.js';
import { createPostgresRecipientCodeConsumer } from './shared/infrastructure/authentication/postgres/postgres-recipient-code-consumer.js';
import type {
  AuthenticationConnectionPool,
  AuthenticationTransactionLimits,
} from './shared/infrastructure/authentication/postgres/authentication-transactions.js';

type LeaseOptions = Parameters<typeof createPostgresRecipientCodeLeases>[0];
type StoreOptions = Parameters<typeof createPostgresRecipientCodeStore>[0];
/** 内部Compositionへ注入する既存能力。Providerや本番運用値を暗黙選択しない。 */
export interface RecipientInvitationRuntimeOptions {
  /** 唯一の認証Transaction ownerが取得する接続。 */ readonly pool: AuthenticationConnectionPool;
  /** 認証専用の既存Codec/用途別HMAC/Record鍵確保。 */ readonly authentication: Pick<
    LeaseOptions,
    'codec' | 'digests' | 'crypto'
  > &
    Pick<StoreOptions, 'stateKeys'>;
  /** GM所有Tableだけを借用queryで操作する既存能力。Poolは渡さない。 */ readonly group: Omit<
    EnlistedGroupRepositoryOptions,
    'registerGroupParticipant'
  >;
  /** コードRecord MAC/検索鍵と独立したGM再送proof。 */ readonly proof: RecipientCodeRequestProofPort;
  /** Clientから渡さないServer側Invitation ID生成。 */ readonly nextInvitationId: () => InvitationId;
  /** Group Lock後/serialize前/commit前で共通に再取得するClock。 */ readonly clock: AuthenticationClock;
  /** 具体運用値は利用先が明示する。 */ readonly limits: Omit<
    AuthenticationTransactionLimits,
    'signal'
  >;
  /** 秘密/原因/直接IDを持たない障害通知。 */ readonly onAlert?: (alert: {
    /** この内部Use Caseの固定分類。 */ readonly code: 'RECIPIENT_INVITATION_UNAVAILABLE';
  }) => void;
}
/** 通常HTTP/main/Devへ未接続の内部入口。Scope/Pool/証跡issuerを公開しない。 */
export interface RecipientInvitationRuntime extends Pick<
  RecipientCodeSessionPort,
  'issue' | 'revoke' | 'inspect'
> {
  /** 有効Sessionと現在Group判断の下、共通commit後だけ最小結果を返す。 */ readonly create: RegisteredRecipientInvitationService['create'];
}

/**
 * 同じregistryへGMを一度登録し、実コード消費/GM保存/両Auditを共通commitへ接続する。
 * @param options Accepted契約の保存/暗号/Clock/ID能力。通常の起動や公開Routeを有効化しない。
 * @returns 内部create/発行/取消/状態照会だけ。失敗/結果不明の区別と再照会はleaseが所有する。
 * @throws Error 二重登録等のComposition不整合。起動前に一度だけ組み立てる。
 */
export const createRecipientInvitationRuntime = (
  options: RecipientInvitationRuntimeOptions,
): RecipientInvitationRuntime => {
  const scopes = createRecipientCodeTransactionScopes(
    createAuthenticationTransactionScopes(),
  );
  const repository = createEnlistedGroupRepository({
    ...options.group,
    registerGroupParticipant: (registration) =>
      scopes.registerGroupParticipant(registration),
  });
  const report = () =>
    options.onAlert?.(
      Object.freeze({ code: 'RECIPIENT_INVITATION_UNAVAILABLE' }),
    );
  const { codec, digests, crypto, stateKeys } = options.authentication;
  const consume = createPostgresRecipientCodeConsumer({
    participants: scopes.scopes.participants,
    digests,
    crypto,
    stateKeys,
  });
  const leases = createPostgresRecipientCodeLeases({
    pool: options.pool,
    scopes,
    codec,
    digests,
    crypto,
    limits: options.limits,
    consume,
    onAlert: report,
  });
  const store = createPostgresRecipientCodeStore({
    leases,
    participants: scopes.scopes.participants,
    guard: scopes.guard.bind(scopes),
    crypto,
    digests,
    stateKeys,
    onAlert: report,
  });
  const service = new RegisteredRecipientInvitationService({
    sessions: leases,
    repository,
    proof: options.proof,
    nextInvitationId: options.nextInvitationId,
    clock: options.clock,
  });
  return Object.freeze({ ...store, create: service.create.bind(service) });
};
