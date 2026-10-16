import { AuthenticationCryptoUnavailable } from '../../../application/authentication/authentication-record-protection.js';
import {
  authenticationKeyVersion,
  authenticationUuid,
} from '../canonical-authentication.js';
import {
  authenticationDatabaseInteger,
  authenticationDatabaseRow,
} from './authentication-database-values.js';
import type { AuthenticationQueryConnection } from './authentication-transaction-scopes.js';

/** key_state共有Lockで公開状態を固定した、認証操作用の世代集合。 */
export interface AuthenticationStoreKeyState {
  /** Restore前Cookieを許可しない現行世代。 */
  readonly epoch: string;
  /** 同じ公開操作の版。 */
  readonly generationVersion: number;
  /** 全既存Identityを覆う検索世代。 */
  readonly identitySearch: readonly string[];
  /** 同Transactionで全Aliasを書き込む世代。 */
  readonly identityWrite: readonly string[];
  /** 現行epochの全試行検索世代。 */
  readonly attemptSearch: readonly string[];
  /** 新試行の唯一の書込世代。 */
  readonly attemptWrite: string;
  /** 現行epochの全Session検索世代。 */
  readonly sessionSearch: readonly string[];
  /** 新Sessionの唯一の書込世代。 */
  readonly sessionWrite: string;
  /** 保持ActorのMACを検証可能な世代。 */
  readonly actorRead: readonly string[];
  /** 新Actor状態MACの唯一の書込世代。 */
  readonly actorWrite: string;
  /** 独立3用途の共通Audit key-setラベル。鍵Materialは共有しない。 */
  readonly auditVersion: string;
}

const known = new Set([
  'google-identity-search',
  'login-attempt-cookie',
  'session-cookie',
  'actor-state-mac',
  'audit-actor',
  'audit-attempt',
  'audit-session',
  'deleted-actor',
  'deletion-ledger-mac',
]);

/**
 * Lock順の先頭で現行世代を固定し、不足・部分公開・Restore中を拒否する。
 * @param connection Storeが所有するTransaction接続。
 * @returns commitまで共有Lockで守られた世代集合。
 * @throws 不正State、世代不足、またはDB障害。
 */
export const readAuthenticationKeyState = async (
  connection: AuthenticationQueryConnection,
): Promise<AuthenticationStoreKeyState> => {
  const stateResult = await connection.query(
    'SELECT state_id, status, generation_version, epoch FROM authentication.key_state WHERE state_id = 1 FOR SHARE',
  );
  if (stateResult.rows.length !== 1)
    throw new AuthenticationCryptoUnavailable();
  const state = authenticationDatabaseRow(stateResult.rows[0]);
  if (
    state.state_id !== 1 ||
    (state.status !== 'active' && state.status !== 'rotating')
  )
    throw new AuthenticationCryptoUnavailable();
  const epoch = authenticationUuid(state.epoch);
  const generationVersion = authenticationDatabaseInteger(
    state.generation_version,
    1,
  );
  const generations = await connection.query(
    'SELECT generation_id, purpose, key_version, epoch, searchable, write_required, retired_at_ms FROM authentication.key_generation ORDER BY purpose, key_version',
  );
  const sets = new Map<string, { search: string[]; write: string[] }>();
  const ids = new Set<string>();
  const namespaces = new Set<string>();
  for (const value of generations.rows as unknown[]) {
    const row = authenticationDatabaseRow(value);
    const id = authenticationUuid(row.generation_id);
    const version = authenticationKeyVersion(row.key_version);
    if (
      typeof row.purpose !== 'string' ||
      !known.has(row.purpose) ||
      typeof row.searchable !== 'boolean' ||
      typeof row.write_required !== 'boolean'
    )
      throw new AuthenticationCryptoUnavailable();
    const cookie =
      row.purpose === 'login-attempt-cookie' ||
      row.purpose === 'session-cookie';
    const rowEpoch = row.epoch === null ? null : authenticationUuid(row.epoch);
    if (cookie !== (rowEpoch !== null))
      throw new AuthenticationCryptoUnavailable();
    if (row.retired_at_ms !== null) {
      authenticationDatabaseInteger(row.retired_at_ms, 0);
      if (row.searchable || row.write_required)
        throw new AuthenticationCryptoUnavailable();
    }
    const namespace = `${row.purpose}/${version}/${rowEpoch ?? ''}`;
    if (ids.has(id) || namespaces.has(namespace))
      throw new AuthenticationCryptoUnavailable();
    ids.add(id);
    namespaces.add(namespace);
    if (cookie && rowEpoch !== epoch) continue;
    const set = sets.get(row.purpose) ?? { search: [], write: [] };
    if (row.searchable) set.search.push(version);
    if (row.write_required) set.write.push(version);
    sets.set(row.purpose, set);
  }
  const requireSet = (purpose: string) => {
    const set = sets.get(purpose);
    if (
      !set ||
      set.search.length === 0 ||
      set.write.length === 0 ||
      set.write.some((version) => !set.search.includes(version))
    )
      throw new AuthenticationCryptoUnavailable();
    return set;
  };
  const singleWrite = (purpose: string): string => {
    const set = requireSet(purpose);
    if (set.write.length !== 1) throw new AuthenticationCryptoUnavailable();
    return set.write[0];
  };
  const identity = requireSet('google-identity-search');
  const auditVersion = singleWrite('audit-actor');
  if (
    singleWrite('audit-attempt') !== auditVersion ||
    singleWrite('audit-session') !== auditVersion
  )
    throw new AuthenticationCryptoUnavailable();
  return Object.freeze({
    epoch,
    generationVersion,
    identitySearch: Object.freeze(identity.search),
    identityWrite: Object.freeze(identity.write),
    attemptSearch: Object.freeze(requireSet('login-attempt-cookie').search),
    attemptWrite: singleWrite('login-attempt-cookie'),
    sessionSearch: Object.freeze(requireSet('session-cookie').search),
    sessionWrite: singleWrite('session-cookie'),
    actorRead: Object.freeze(requireSet('actor-state-mac').search),
    actorWrite: singleWrite('actor-state-mac'),
    auditVersion,
  });
};
