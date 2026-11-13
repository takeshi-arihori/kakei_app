import { authenticationRecoveryPointSchemaVersion } from '../../application/authentication/authentication-maintenance-ports.js';
import { AuthenticationCryptoUnavailable } from '../../application/authentication/authentication-record-protection.js';
import {
  authenticationObject,
  authenticationUuid,
} from './canonical-authentication.js';

const fields = [
  'createdAt',
  'schemaVersion',
  'keyStateVersion',
  'epoch',
  'checkpoint',
] as const;

/**
 * Manifestの固定Field集合と`recoveryPointId`の版規則だけを検査する。受理版の判定は呼出し側が行う。
 * @param input 信頼済みBackup catalogから受け取った未検証Manifest。
 * @returns 自身のData Propertyから作ったCopy。`recoveryPointId`は版11以上だけに含まれる。
 * @throws AuthenticationCryptoUnavailable 未知Field、版の型不正、Fieldの欠落または版11未満での存在。
 */
export const authenticationManifestObject = (
  input: unknown,
): Record<string, unknown> => {
  const present =
    typeof input === 'object' &&
    input !== null &&
    Object.prototype.hasOwnProperty.call(input, 'recoveryPointId');
  const m = authenticationObject(
    input,
    present ? [...fields, 'recoveryPointId'] : fields,
  );
  if (
    typeof m.schemaVersion !== 'number' ||
    !Number.isSafeInteger(m.schemaVersion) ||
    m.schemaVersion < 1 ||
    present !== m.schemaVersion >= authenticationRecoveryPointSchemaVersion
  )
    throw new AuthenticationCryptoUnavailable();
  if (present) m.recoveryPointId = authenticationUuid(m.recoveryPointId);
  return m;
};
