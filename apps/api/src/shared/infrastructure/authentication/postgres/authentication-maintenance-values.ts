import type { AuthenticationKeyScope } from '../../../application/authentication/authentication-crypto-keys.js';
import type {
  AuthenticationDestructionTicket,
  AuthenticationKeyDestructionPort,
} from '../../../application/authentication/authentication-maintenance-ports.js';
import { AuthenticationCryptoUnavailable } from '../../../application/authentication/authentication-record-protection.js';
import {
  authenticationRetentionState,
  type AuthenticationRetentionWindow,
} from '../../../application/authentication/authentication-retention-policy.js';
import {
  authenticationObject,
  authenticationUuid,
} from '../canonical-authentication.js';

/**
 * Providerへ渡す認証scopeをCopyし、未知kindや別Namespaceを拒否する。
 * @param input DBまたはProvider ticketのscope。
 * @returns 認証専用kind/UUIDだけのCopy。
 * @throws AuthenticationCryptoUnavailable 不正形式/用途。
 */
export const authenticationMaintenanceScope = (
  input: unknown,
): AuthenticationKeyScope => {
  const r = authenticationObject(input, ['recordKind', 'keyScopeId']);
  if (
    r.recordKind !== 'google-identity' &&
    r.recordKind !== 'login-attempt' &&
    r.recordKind !== 'session'
  )
    throw new AuthenticationCryptoUnavailable();
  return Object.freeze({
    recordKind: r.recordKind,
    keyScopeId: authenticationUuid(r.keyScopeId),
  });
};

/**
 * DB削除前にdurable ticketの全bindingと全scope集合を再照合する。
 * @param keys 全世代Registryの管理能力。
 * @param operationId この削除に固定したUUID。
 * @param inputScopes Lock下で発見した対象集合。
 * @param window 再試行と監視に保持する期限。
 * @returns 対象/版/期限をCopyした検証済みticket。
 * @throws AuthenticationCryptoUnavailable Provider不一致/障害/部分集合。
 */
export const prepareAuthenticationDestruction = async (
  keys: AuthenticationKeyDestructionPort,
  operationId: string,
  inputScopes: readonly AuthenticationKeyScope[],
  window: AuthenticationRetentionWindow,
): Promise<AuthenticationDestructionTicket> => {
  const scopes = inputScopes.map(authenticationMaintenanceScope);
  authenticationUuid(operationId);
  authenticationRetentionState(window, window.dueAt);
  const raw = await keys.prepare(operationId, scopes, { ...window });
  const r = authenticationObject(raw, [
    'operationId',
    'reference',
    'version',
    'inventoryDigest',
    'window',
  ]);
  if (
    r.operationId !== operationId ||
    typeof r.reference !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(r.reference) ||
    typeof r.version !== 'number' ||
    !Number.isSafeInteger(r.version) ||
    r.version < 1 ||
    !(r.inventoryDigest instanceof Uint8Array) ||
    r.inventoryDigest.length !== 32
  )
    throw new AuthenticationCryptoUnavailable();
  const w = authenticationObject(r.window, ['dueAt', 'deadline']);
  if (w.dueAt !== window.dueAt || w.deadline !== window.deadline)
    throw new AuthenticationCryptoUnavailable();
  const ticket = Object.freeze({
    operationId,
    reference: r.reference,
    version: r.version,
    inventoryDigest: Uint8Array.from(r.inventoryDigest),
    window: Object.freeze({ ...window }),
  });
  const actual = (await keys.scopes(ticket)).map(
    authenticationMaintenanceScope,
  );
  const values = (items: readonly AuthenticationKeyScope[]) =>
    items.map((scope) => scope.recordKind + '/' + scope.keyScopeId).sort();
  if (JSON.stringify(values(actual)) !== JSON.stringify(values(scopes)))
    throw new AuthenticationCryptoUnavailable();
  return ticket;
};
