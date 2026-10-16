import type { AuthenticationActorState } from '../../../application/authentication/authentication-crypto-keys.js';
import {
  AuthenticationCryptoUnavailable,
  type AuthenticationAttemptRow,
  type AuthenticationIdentityRow,
  type AuthenticationRecordEnvelope,
  type AuthenticationRow,
  type AuthenticationSessionRow,
} from '../../../application/authentication/authentication-record-protection.js';
import {
  authenticationHeader,
  authenticationKeyVersion,
  authenticationUuid,
  encodeAuthenticationAad,
  parseAuthenticationRow,
} from '../canonical-authentication.js';
import {
  authenticationDatabaseBytes,
  authenticationDatabaseInteger,
  authenticationDatabaseRow,
} from './authentication-database-values.js';
import type { AuthenticationQueryConnection } from './authentication-transaction-scopes.js';

/** 平文Metadataは形式検証済みだが、暗号認証とActor状態検証前には認可へ使わない。 */
export interface StoredAuthenticationRecord<R extends AuthenticationRow> {
  /** 選択行から復元したAAD期待値。 */
  readonly row: R;
  /** Rowとの束縛をCodecが検証する保存Envelope。 */
  readonly envelope: AuthenticationRecordEnvelope;
}

/** 状態MACを検証するための選択Actor。 */
export interface StoredAuthenticationActor {
  /** MACが覆う全状態。 */
  readonly row: AuthenticationActorState;
  /** 行が参照する読取り鍵世代。 */
  readonly keyVersion: string;
  /** 同一ActorのLock下で比較するMAC。 */
  readonly mac: Uint8Array;
}

/**
 * 状態MAC判断前にActorの型・状態整合を確認する。
 * @param value pgの未信頼Row。
 * @returns MAC検証用の全状態と保存MAC。
 * @throws UUID・状態・日時・鍵・MAC形式不正。
 */
export const readStoredAuthenticationActor = (
  value: unknown,
): StoredAuthenticationActor => {
  const r = authenticationDatabaseRow(value);
  const createdAt = authenticationDatabaseInteger(r.created_at_ms, 0);
  const disabledAt =
    r.disabled_at_ms === null
      ? null
      : authenticationDatabaseInteger(r.disabled_at_ms, 0);
  if (
    (r.state !== 'active' && r.state !== 'disabled') ||
    (r.state === 'active') !== (disabledAt === null) ||
    (disabledAt !== null && disabledAt < createdAt)
  )
    throw new AuthenticationCryptoUnavailable();
  return {
    row: {
      actorId: authenticationUuid(r.actor_id),
      state: r.state,
      version: authenticationDatabaseInteger(r.version, 1),
      createdAt,
      disabledAt,
    },
    keyVersion: authenticationKeyVersion(r.control_key_version),
    mac: authenticationDatabaseBytes(r.state_mac, 32),
  };
};

const metadata = (
  r: Record<string, unknown>,
  recordKind: 'login-attempt' | 'session',
) => ({
  recordKind,
  version: authenticationDatabaseInteger(r.version, 1),
  epoch: authenticationUuid(r.epoch),
  createdAt: authenticationDatabaseInteger(r.created_at_ms, 0),
  state: r.state,
  terminalAt:
    r.terminal_at_ms === null
      ? null
      : authenticationDatabaseInteger(r.terminal_at_ms, 0),
  cookieDigestKeyVersion: authenticationKeyVersion(r.cookie_digest_key_version),
  cookieDigest: authenticationDatabaseBytes(r.cookie_digest, 32),
});

const envelope = (
  r: Record<string, unknown>,
  row: AuthenticationRow,
): AuthenticationRecordEnvelope => {
  if (
    r.envelope_version !== 1 ||
    r.algorithm_id !== 'AES-256-GCM' ||
    authenticationDatabaseInteger(r.schema_version, 1) !== 1
  )
    throw new AuthenticationCryptoUnavailable();
  return {
    header: authenticationHeader(row, authenticationKeyVersion(r.key_version)),
    ciphertext: authenticationDatabaseBytes(r.ciphertext),
    nonce: authenticationDatabaseBytes(r.nonce, 12),
    authenticationTag: authenticationDatabaseBytes(r.authentication_tag, 16),
  };
};

/**
 * 試行Metadataを丸めず復元する。有効期限判断はCodec検証後にStoreが行う。
 * @param value pgの未信頼Row。
 * @returns 完全なRow bindingと保存Envelope。
 * @throws 不正Metadata・Envelope形式。
 */
export const readStoredAuthenticationAttempt = (
  value: unknown,
): StoredAuthenticationRecord<AuthenticationAttemptRow> => {
  const r = authenticationDatabaseRow(value);
  const row = parseAuthenticationRow({
    ...metadata(r, 'login-attempt'),
    attemptId: authenticationUuid(r.attempt_id),
    expiresAt: authenticationDatabaseInteger(r.expires_at_ms, 0),
  });
  if (row.recordKind !== 'login-attempt')
    throw new AuthenticationCryptoUnavailable();
  return { row, envelope: envelope(r, row) };
};

/**
 * Sessionの全Metadataを復元する。state／期限を認可へ使う前にAEADを確認する。
 * @param value pgの未信頼Row。
 * @returns Row bindingと保存Envelope。
 * @throws 不正Metadata・Envelope形式。
 */
export const readStoredAuthenticationSession = (
  value: unknown,
): StoredAuthenticationRecord<AuthenticationSessionRow> => {
  const r = authenticationDatabaseRow(value);
  const row = parseAuthenticationRow({
    ...metadata(r, 'session'),
    sessionId: authenticationUuid(r.session_id),
    actorId: authenticationUuid(r.actor_id),
    absoluteExpiresAt: authenticationDatabaseInteger(
      r.absolute_expires_at_ms,
      0,
    ),
    idleExpiresAt: authenticationDatabaseInteger(r.idle_expires_at_ms, 0),
  });
  if (row.recordKind !== 'session') throw new AuthenticationCryptoUnavailable();
  return { row, envelope: envelope(r, row) };
};

/**
 * IdentityにはAccepted InventoryのIDと版だけを復元する。
 * @param value pgの未信頼Row。
 * @returns Identity bindingと保存Envelope。
 * @throws 不正Metadata・Envelope形式。
 */
export const readStoredAuthenticationIdentity = (
  value: unknown,
): StoredAuthenticationRecord<AuthenticationIdentityRow> => {
  const r = authenticationDatabaseRow(value);
  const row: AuthenticationIdentityRow = {
    recordKind: 'google-identity',
    identityId: authenticationUuid(r.identity_id),
    actorId: authenticationUuid(r.actor_id),
    version: authenticationDatabaseInteger(r.version, 1),
  };
  return { row, envelope: envelope(r, row) };
};

const databaseFields = (
  row: AuthenticationRow,
  protectedValue: AuthenticationRecordEnvelope,
): Record<string, unknown> => {
  // 注入Codecの出力も、書込み対象の行と完全一致させる。
  encodeAuthenticationAad(protectedValue.header, row);
  const fields: Record<string, unknown> = {
    version: row.version,
    envelope_version: protectedValue.header.envelopeVersion,
    algorithm_id: protectedValue.header.algorithmId,
    schema_version: protectedValue.header.schemaVersion,
    key_version: protectedValue.header.keyVersion,
    ciphertext: Buffer.from(
      authenticationDatabaseBytes(protectedValue.ciphertext),
    ),
    nonce: Buffer.from(authenticationDatabaseBytes(protectedValue.nonce, 12)),
    authentication_tag: Buffer.from(
      authenticationDatabaseBytes(protectedValue.authenticationTag, 16),
    ),
  };
  if (row.recordKind === 'google-identity')
    return { identity_id: row.identityId, actor_id: row.actorId, ...fields };
  Object.assign(fields, {
    epoch: row.epoch,
    created_at_ms: row.createdAt,
    state: row.state,
    terminal_at_ms: row.terminalAt,
    cookie_digest_key_version: row.cookieDigestKeyVersion,
    cookie_digest: Buffer.from(row.cookieDigest),
  });
  return row.recordKind === 'login-attempt'
    ? { attempt_id: row.attemptId, expires_at_ms: row.expiresAt, ...fields }
    : {
        session_id: row.sessionId,
        actor_id: row.actorId,
        absolute_expires_at_ms: row.absoluteExpiresAt,
        idle_expires_at_ms: row.idleExpiresAt,
        ...fields,
      };
};

const table = (
  row: AuthenticationRow,
): { name: string; idColumn: string; id: string } =>
  row.recordKind === 'google-identity'
    ? { name: 'google_identity', idColumn: 'identity_id', id: row.identityId }
    : row.recordKind === 'login-attempt'
      ? { name: 'login_attempt', idColumn: 'attempt_id', id: row.attemptId }
      : { name: 'session_record', idColumn: 'session_id', id: row.sessionId };

/**
 * 許可したTable／列だけへ保護Recordを新規挿入する。衝突を上書きしない。
 * @param connection Store所有のTransaction接続。
 * @param row 新規Recordの全Metadata。
 * @param protectedValue 同じRowでsealしたEnvelope。
 * @throws DB制約・暗号入力不正。
 */
export const insertAuthenticationRecord = async (
  connection: AuthenticationQueryConnection,
  row: AuthenticationRow,
  protectedValue: AuthenticationRecordEnvelope,
): Promise<void> => {
  const fields = databaseFields(row, protectedValue);
  const columns = Object.keys(fields);
  await connection.query(
    `INSERT INTO authentication.${table(row).name} (${columns.join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    Object.values(fields),
  );
};

/**
 * Row Lockに加え旧版CASを必須とし、暗号文と全Metadataを同時に更新する。
 * @param connection Store所有のTransaction接続。
 * @param row 版増加済みの更新Row。
 * @param protectedValue 更新Rowで再sealしたEnvelope。
 * @param expectedVersion Lock下で確認した旧版。
 * @throws CAS不一致・制約・暗号入力不正。
 */
export const updateAuthenticationRecord = async (
  connection: AuthenticationQueryConnection,
  row: AuthenticationRow,
  protectedValue: AuthenticationRecordEnvelope,
  expectedVersion: number,
): Promise<void> => {
  if (row.version !== expectedVersion + 1 || !Number.isSafeInteger(row.version))
    throw new AuthenticationCryptoUnavailable();
  const target = table(row);
  const fields = databaseFields(row, protectedValue);
  delete fields[target.idColumn];
  const columns = Object.keys(fields);
  const values = Object.values(fields);
  const result = await connection.query(
    `UPDATE authentication.${target.name} SET ${columns.map((column, index) => `${column} = $${index + 1}`).join(', ')} WHERE ${target.idColumn} = $${values.length + 1} AND version = $${values.length + 2}`,
    [...values, target.id, expectedVersion],
  );
  if (result.rowCount !== 1) throw new AuthenticationCryptoUnavailable();
};
