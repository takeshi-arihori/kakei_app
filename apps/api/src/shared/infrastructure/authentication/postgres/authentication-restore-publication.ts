import type {
  AuthenticationRestoreGeneration,
  AuthenticationRestorePublication,
} from '../../../application/authentication/authentication-restore-control.js';
import { AuthenticationCryptoUnavailable } from '../../../application/authentication/authentication-record-protection.js';
import {
  authenticationKeyVersion,
  authenticationObject,
  authenticationUuid,
} from '../canonical-authentication.js';
import { authenticationDatabaseInteger } from './authentication-database-values.js';

const purposes: readonly AuthenticationRestoreGeneration['purpose'][] = [
  'google-identity-search',
  'login-attempt-cookie',
  'session-cookie',
  'actor-state-mac',
  'audit-actor',
  'audit-attempt',
  'audit-session',
  'deleted-actor',
  'deletion-ledger-mac',
];
const fail = (): never => {
  throw new AuthenticationCryptoUnavailable();
};

/**
 * 外部公開の署名検証とは別に、復旧世代の形式/用途/部分公開を拒否する。
 * @param input 外部制御Portの新epoch/世代集合。
 * @returns Byte参照やGetterを共有しない最小Copy。
 * @throws AuthenticationCryptoUnavailable 不正Field/用途/epoch/部分世代/重複。
 */
export const authenticationRestorePublication = (
  input: unknown,
): AuthenticationRestorePublication => {
  const r = authenticationObject(input, [
    'runId',
    'revision',
    'epoch',
    'generations',
  ]);
  const epoch = authenticationUuid(r.epoch);
  if (!Array.isArray(r.generations) || r.generations.length === 0)
    return fail();
  const namespaces = new Set<string>();
  const generations = r.generations.map(
    (value: unknown): AuthenticationRestoreGeneration => {
      const g = authenticationObject(value, [
        'purpose',
        'keyVersion',
        'epoch',
        'searchable',
        'writeRequired',
        'retiredAt',
      ]);
      const purpose =
        purposes.find((candidate) => candidate === g.purpose) ?? fail();
      if (
        typeof g.searchable !== 'boolean' ||
        typeof g.writeRequired !== 'boolean' ||
        (g.writeRequired && !g.searchable)
      )
        return fail();
      const cookie =
        purpose === 'login-attempt-cookie' || purpose === 'session-cookie';
      const rowEpoch = g.epoch === null ? null : authenticationUuid(g.epoch);
      if (cookie !== (rowEpoch !== null)) return fail();
      const retiredAt =
        g.retiredAt === null
          ? null
          : authenticationDatabaseInteger(g.retiredAt, 0);
      if (
        (retiredAt !== null && (g.searchable || g.writeRequired)) ||
        (cookie &&
          rowEpoch !== epoch &&
          (g.searchable || g.writeRequired || retiredAt === null))
      )
        return fail();
      const keyVersion = authenticationKeyVersion(g.keyVersion);
      const namespace = purpose + '/' + keyVersion + '/' + (rowEpoch ?? '');
      if (namespaces.has(namespace)) return fail();
      namespaces.add(namespace);
      return Object.freeze({
        purpose,
        keyVersion,
        epoch: rowEpoch,
        searchable: g.searchable,
        writeRequired: g.writeRequired,
        retiredAt,
      });
    },
  );
  for (const purpose of purposes) {
    const set = generations.filter(
      (g) => g.purpose === purpose && (g.epoch === null || g.epoch === epoch),
    );
    if (!set.some((g) => g.searchable) || !set.some((g) => g.writeRequired))
      return fail();
    if (
      purpose !== 'google-identity-search' &&
      set.filter((g) => g.writeRequired).length !== 1
    )
      return fail();
  }
  return Object.freeze({
    runId: authenticationUuid(r.runId),
    revision: authenticationDatabaseInteger(r.revision, 1),
    epoch,
    generations: Object.freeze(generations),
  });
};
