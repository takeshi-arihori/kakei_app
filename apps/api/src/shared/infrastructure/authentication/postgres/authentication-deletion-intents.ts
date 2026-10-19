import type { AuthenticationDigests } from '../../../application/authentication/authentication-digest-ports.js';
import type {
  AuthenticationDeletionRecord,
  AuthenticationKeyDestructionPort,
} from '../../../application/authentication/authentication-maintenance-ports.js';
import { AuthenticationCryptoUnavailable } from '../../../application/authentication/authentication-record-protection.js';
import {
  authenticationKeyVersion,
  authenticationUuid,
} from '../canonical-authentication.js';
import { authenticationBytesEqual } from '../authentication-digests.js';
import {
  authenticationDatabaseBytes,
  authenticationDatabaseInteger,
  authenticationDatabaseRow,
} from './authentication-database-values.js';
import { authenticationMaintenanceScope } from './authentication-maintenance-values.js';
import type { AuthenticationQueryConnection } from './authentication-transaction-scopes.js';

const fail = (): never => {
  throw new AuthenticationCryptoUnavailable();
};

/**
 * DB Intentを外部の同operation/仮名/起算/状態/版へ照合する。
 * @param raw 信頼前のDB行。
 * @param record 検証済み外部削除意思。
 * @throws AuthenticationCryptoUnavailable 不一致、欠損、または不正状態。
 */
export const assertAuthenticationDeletionIntent = (
  raw: unknown,
  record: AuthenticationDeletionRecord,
): void => {
  const r = authenticationDatabaseRow(raw);
  if (
    authenticationUuid(r.operation_id) !== record.operationId ||
    authenticationKeyVersion(r.actor_digest_key_version) !==
      record.actorDigestKeyVersion ||
    !authenticationBytesEqual(
      authenticationDatabaseBytes(r.actor_digest, 32),
      record.actorDigest,
    ) ||
    authenticationDatabaseInteger(r.created_at_ms, 0) !== record.preparedAt ||
    !(
      (r.state === 'prepared' &&
        authenticationDatabaseInteger(r.version, 1) === 1) ||
      (r.state === 'complete' &&
        authenticationDatabaseInteger(r.version, 1) === 2 &&
        record.state === 'complete')
    )
  )
    fail();
  authenticationDatabaseInteger(r.updated_at_ms, record.preparedAt);
};

/**
 * Provider管理参照をhintとし、Actor削除仮名へ照合して対象を解決する。
 * @param keys DB消失後も全scopeを保持する外部Registry。
 * @param digests 退役世代も検証する独立削除用途のHMAC。
 * @param record 正真正銘の同じoperationのLedger本文。
 * @returns Actor hint、全scopeと最新ticket。Actor MAC/Lockは別途必須。
 * @throws AuthenticationCryptoUnavailable 対象/版/期限/用途/仮名不一致。
 */
export const resolveAuthenticationDeletionTarget = async (
  keys: AuthenticationKeyDestructionPort,
  digests: AuthenticationDigests,
  record: AuthenticationDeletionRecord,
) => {
  const ticket =
    (await keys.find(record.operationId, record.targetReference)) ?? fail();
  if (
    ticket.operationId !== record.operationId ||
    ticket.reference !== record.targetReference ||
    ticket.window.dueAt !== record.preparedAt ||
    ticket.window.deadline !== record.preparedAt + 86_400_000
  )
    return fail();
  const scopes = (await keys.scopes(ticket)).map(
    authenticationMaintenanceScope,
  );
  const identities = scopes.filter(
    (scope) => scope.recordKind === 'google-identity',
  );
  if (
    identities.length !== 1 ||
    scopes.some((scope) => scope.recordKind === 'login-attempt')
  )
    return fail();
  const actorId = identities[0].keyScopeId;
  const digest = await digests.deletedActor({
    subjectId: actorId,
    keyVersion: record.actorDigestKeyVersion,
  });
  if (
    digest.keyVersion !== record.actorDigestKeyVersion ||
    !authenticationBytesEqual(digest.bytes, record.actorDigest)
  )
    return fail();
  return {
    /** 仮名照合済みのActor hint。利用前にActor Lock/MACを再検証する。 */
    actorId,
    /** 当該operationのdurable scope集合。 */
    scopes,
    /** 全世代破棄へ束縛する最新管理票。 */
    ticket,
  };
};

/**
 * 既存Intentの同一性を確認し、外部意思だけが残る場合はPreparedを再構成する。
 * @param connection Actor以降の順序で制御する所有Transaction。
 * @param record 外部検証済み削除意思。
 * @param now Lock後の判断UTC。
 * @throws AuthenticationCryptoUnavailable 別operation/版/仮名、SQL障害。
 */
export const ensureAuthenticationDeletionIntent = async (
  connection: AuthenticationQueryConnection,
  record: AuthenticationDeletionRecord,
  now: number,
) => {
  const found = await connection.query(
    'SELECT * FROM authentication.deletion_intent WHERE operation_id=$1 OR (actor_digest_key_version=$2 AND actor_digest=$3) FOR UPDATE',
    [
      record.operationId,
      record.actorDigestKeyVersion,
      Buffer.from(record.actorDigest),
    ],
  );
  if (found.rows.length > 1) return fail();
  if (found.rows.length === 1) {
    assertAuthenticationDeletionIntent(found.rows[0], record);
    return;
  }
  await connection.query(
    "INSERT INTO authentication.deletion_intent(operation_id,actor_digest_key_version,actor_digest,version,state,created_at_ms,updated_at_ms) VALUES($1,$2,$3,1,'prepared',$4,$5)",
    [
      record.operationId,
      record.actorDigestKeyVersion,
      Buffer.from(record.actorDigest),
      record.preparedAt,
      now,
    ],
  );
};
