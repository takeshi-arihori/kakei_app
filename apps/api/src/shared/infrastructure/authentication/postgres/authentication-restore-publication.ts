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

type Purpose = AuthenticationRestoreGeneration['purpose'];
const basePurposes: readonly Purpose[] = [
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
/** コード参加の構成だけが公開する2用途。 */
const recipientCodePurposes: readonly Purpose[] = [
  'recipient-code-lookup',
  'recipient-code-state-mac',
];
const fail = (): never => {
  throw new AuthenticationCryptoUnavailable();
};

/**
 * 外部公開の署名検証とは別に、復旧世代の形式/用途/部分公開を拒否する。
 * @param input 外部制御Portの新epoch/世代集合。
 * @param recipientCodes コード参加の構成ならtrue。コード2用途を必須にする。falseではコード用途を拒否する。
 * @returns Byte参照やGetterを共有しない最小Copy。
 * @throws AuthenticationCryptoUnavailable 不正Field/用途/epoch/部分世代/重複、構成と用途の不一致。
 */
export const authenticationRestorePublication = (
  input: unknown,
  recipientCodes = false,
): AuthenticationRestorePublication => {
  const purposes = recipientCodes
    ? [...basePurposes, ...recipientCodePurposes]
    : basePurposes;
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
