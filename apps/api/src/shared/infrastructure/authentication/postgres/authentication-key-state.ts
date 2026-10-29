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
 * Lock順の先頭で世代を固定し、専用入口が許可したState以外と部分公開を拒否する。
 * @param connection 呼出し元が所有するTransaction接続。
 * @param statuses 各専用入口で固定した許可State。
 * @returns commitまで共有Lockで守られた世代集合。
 * @throws 不正State、世代不足、またはDB障害。
 */
const readState = async (
  connection: AuthenticationQueryConnection,
  statuses: readonly string[],
  additionalPurposes: readonly string[] = [],
): Promise<
  AuthenticationStoreKeyState & {
    codeLookup: readonly string[];
    codeMac: readonly string[];
  }
> => {
  const stateResult = await connection.query(
    'SELECT state_id, status, generation_version, epoch FROM authentication.key_state WHERE state_id = 1 FOR SHARE',
  );
  if (stateResult.rows.length !== 1)
    throw new AuthenticationCryptoUnavailable();
  const state = authenticationDatabaseRow(stateResult.rows[0]);
  if (
    state.state_id !== 1 ||
    typeof state.status !== 'string' ||
    !statuses.includes(state.status)
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
      (!known.has(row.purpose) && !additionalPurposes.includes(row.purpose)) ||
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
  for (const purpose of additionalPurposes) singleWrite(purpose);
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
    codeLookup: Object.freeze(
      additionalPurposes.length
        ? requireSet('recipient-code-lookup').search
        : [],
    ),
    codeMac: Object.freeze(
      additionalPurposes.length
        ? requireSet('recipient-code-state-mac').search
        : [],
    ),
  });
};

/**
 * 新用途を明示した専用leaseだけがコード世代を受理する。旧Writerのfail closedを維持する。
 * @param connection 所有者の同一Transaction。Actorより前にkey_stateを共有Lockする。
 * @returns 既存認証世代と、全保持コードを覆うlookup/MACの読取世代。
 * @throws AuthenticationCryptoUnavailable 未初期化・隔離・未知用途・不正/不足世代。
 */
export const readRecipientCodeKeyState = (
  connection: AuthenticationQueryConnection,
): Promise<
  AuthenticationStoreKeyState & {
    /** 全searchable lookup世代。current以外の旧コードも検索する。 */ readonly codeLookup: readonly string[];
    /** 保持コードMACの公開読取世代。Record別の鍵取得とは別契約。 */ readonly codeMac: readonly string[];
  }
> =>
  readState(
    connection,
    ['active', 'rotating'],
    ['recipient-code-lookup', 'recipient-code-state-mac'],
  );

/**
 * 通常認証Writerはactive/rotatingだけを許可する。
 * @param connection 認証操作が所有するTransaction接続。
 * @returns commitまで共有Lockで固定した現行世代集合。
 * @throws 不正State、隔離/復旧中、世代不足、またはDB障害。
 */
export const readAuthenticationKeyState = (
  connection: AuthenticationQueryConnection,
): Promise<AuthenticationStoreKeyState> =>
  readState(connection, ['active', 'rotating']);

/**
 * 清掃は隔離後も再試行できるがRestoreと並行しない。
 * @param connection 保守操作が所有するTransaction接続。
 * @returns 通常運転またはquarantinedの共有Lock付き世代。
 * @throws 未初期化/Restore中、不正State、鍵世代不足。
 */
export const readAuthenticationMaintenanceKeyState = (
  connection: AuthenticationQueryConnection,
): Promise<AuthenticationStoreKeyState> =>
  readState(connection, ['active', 'rotating', 'quarantined']);

/**
 * 外部fenceを検証した復旧専用Adapterだけが使う。
 * @param connection 復旧処理が所有するTransaction接続。
 * @returns restoringに限定した共有Lock付き世代。
 * @throws restoring以外、不正State、鍵世代不足。
 */
export const readAuthenticationRestoreKeyState = (
  connection: AuthenticationQueryConnection,
): Promise<AuthenticationStoreKeyState> => readState(connection, ['restoring']);
