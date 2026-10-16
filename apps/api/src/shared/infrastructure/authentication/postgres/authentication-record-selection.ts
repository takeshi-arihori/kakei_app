import type { AuthenticationDigests } from '../../../application/authentication/authentication-digest-ports.js';
import {
  AuthenticationCryptoUnavailable,
  type AuthenticationAttemptRow,
  type AuthenticationSessionRow,
} from '../../../application/authentication/authentication-record-protection.js';
import type { VerifiedGoogleIdentity } from '../../../application/google-id-token-verification.js';
import { authenticationBytesEqual } from '../authentication-digests.js';
import {
  authenticationKeyVersion,
  authenticationUuid,
} from '../canonical-authentication.js';
import {
  authenticationDatabaseBytes,
  authenticationDatabaseRow,
} from './authentication-database-values.js';
import type { AuthenticationStoreKeyState } from './authentication-key-state.js';
import {
  readStoredAuthenticationAttempt,
  readStoredAuthenticationSession,
  type StoredAuthenticationRecord,
} from './authentication-record-rows.js';
import type { AuthenticationQueryConnection } from './authentication-transaction-scopes.js';

/** 候補が複数のRecordを指した場合だけ、秘密値なしで検知できる固定障害。 */
export class AuthenticationMultipleMatches extends Error {
  /** Cookie／Identityどちらでも選択を中止する固定Error。 */
  constructor() {
    super('authentication-multiple-matches');
  }
}

/** 型とSQL検索の両方で用いる独立したCookie用途。 */
export type AuthenticationCookieKind = 'attempt' | 'session';

/**
 * 全searchable世代を検索し、一つのRecordへ選択する。0-hitではDEKを読まない。
 * @param connection Store所有接続。
 * @param digests Cookie専用HMAC能力。
 * @param state 共有Lockで固定したepochと世代集合。
 * @param kind 試行とSessionを混在させない用途。
 * @param secret Cookie由来のcanonical秘密値。省略時は選択しない。
 * @returns 未認証の候補。Actor／Record LockとCodec検証後にだけ有効性を判断する。
 * @throws 鍵・SQL・複数hit・保存形式不正。
 */
export const findAuthenticationCookie = async (
  connection: AuthenticationQueryConnection,
  digests: AuthenticationDigests,
  state: AuthenticationStoreKeyState,
  kind: AuthenticationCookieKind,
  secret: string | undefined,
): Promise<
  | StoredAuthenticationRecord<AuthenticationAttemptRow>
  | StoredAuthenticationRecord<AuthenticationSessionRow>
  | null
> => {
  if (secret === undefined) return null;
  const versions =
    kind === 'attempt' ? state.attemptSearch : state.sessionSearch;
  const candidates = await Promise.all(
    versions.map((keyVersion) =>
      kind === 'attempt'
        ? digests.attemptCookie({ secret, epoch: state.epoch, keyVersion })
        : digests.sessionCookie({ secret, epoch: state.epoch, keyVersion }),
    ),
  );
  const values: unknown[] = [];
  const conditions = candidates.map((candidate) => {
    values.push(candidate.keyVersion, Buffer.from(candidate.bytes));
    return `(cookie_digest_key_version = $${values.length - 1} AND cookie_digest = $${values.length})`;
  });
  const result = await connection.query(
    `SELECT * FROM authentication.${kind === 'attempt' ? 'login_attempt' : 'session_record'} WHERE ${conditions.join(' OR ')}`,
    values,
  );
  if (result.rows.length > 1) throw new AuthenticationMultipleMatches();
  if (result.rows.length === 0) return null;
  const selected =
    kind === 'attempt'
      ? readStoredAuthenticationAttempt(result.rows[0])
      : readStoredAuthenticationSession(result.rows[0]);
  if (
    selected.row.epoch !== state.epoch ||
    !candidates.some(
      (candidate) =>
        candidate.keyVersion === selected.row.cookieDigestKeyVersion &&
        authenticationBytesEqual(candidate.bytes, selected.row.cookieDigest),
    )
  )
    throw new AuthenticationCryptoUnavailable();
  return selected;
};

/** 全Alias hitを同じIdentity／Actorへ解決した、まだLock前のhint。 */
export interface AuthenticationIdentityHint {
  /** Aliasが指す唯一のIdentity。 */
  readonly identityId: string;
  /** ActorをIdentityより先にlockするためのhint。 */
  readonly actorId: string;
  /** 完全照合した検索Aliasの鍵世代。 */
  readonly hitVersions: readonly string[];
}

/**
 * 全searchable Aliasを検索する。複数本人性のhitから任意に一つを選ばない。
 * @param connection Store所有接続。
 * @param digests Identity専用HMAC能力。
 * @param state 共有Lockで固定した全検索世代。
 * @param identity Verifier成功後のcanonical本人性。
 * @returns 0-hitならnull、それ以外はActor Lock前の唯一のhint。
 * @throws 鍵・SQL・異Identity多重hit・保存形式不正。
 */
export const findAuthenticationIdentity = async (
  connection: AuthenticationQueryConnection,
  digests: AuthenticationDigests,
  state: AuthenticationStoreKeyState,
  identity: VerifiedGoogleIdentity,
): Promise<AuthenticationIdentityHint | null> => {
  const candidates = await Promise.all(
    state.identitySearch.map((keyVersion) =>
      digests.identity({ identity, keyVersion }),
    ),
  );
  const values: unknown[] = [];
  const conditions = candidates.map((candidate) => {
    values.push(candidate.keyVersion, Buffer.from(candidate.bytes));
    return `(a.digest_key_version = $${values.length - 1} AND a.digest = $${values.length})`;
  });
  const result = await connection.query(
    `SELECT a.purpose, a.digest_key_version, a.digest, a.identity_id, g.actor_id
    FROM authentication.identity_alias a JOIN authentication.google_identity g USING (identity_id)
    WHERE a.purpose = 'auth-google-identity/v1' AND (${conditions.join(' OR ')})`,
    values,
  );
  if (result.rows.length === 0) return null;
  let hint: AuthenticationIdentityHint | null = null;
  const hitVersions: string[] = [];
  for (const value of result.rows as unknown[]) {
    const row = authenticationDatabaseRow(value);
    const identityId = authenticationUuid(row.identity_id);
    const actorId = authenticationUuid(row.actor_id);
    const version = authenticationKeyVersion(row.digest_key_version);
    const digest = authenticationDatabaseBytes(row.digest, 32);
    if (
      row.purpose !== 'auth-google-identity/v1' ||
      !candidates.some(
        (candidate) =>
          candidate.keyVersion === version &&
          authenticationBytesEqual(candidate.bytes, digest),
      )
    )
      throw new AuthenticationCryptoUnavailable();
    if (
      hint !== null &&
      (hint.identityId !== identityId || hint.actorId !== actorId)
    )
      throw new AuthenticationMultipleMatches();
    if (hitVersions.includes(version))
      throw new AuthenticationCryptoUnavailable();
    hitVersions.push(version);
    hint = { identityId, actorId, hitVersions };
  }
  return hint;
};
