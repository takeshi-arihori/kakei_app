import { createHash } from 'node:crypto';

import { AuthenticationCryptoUnavailable } from '../../../application/authentication/authentication-record-protection.js';
import { encodeAuthenticationTlv } from '../canonical-authentication.js';
import { authenticationDatabaseRow } from './authentication-database-values.js';
import type { AuthenticationQueryConnection } from './authentication-transaction-scopes.js';

const queries = [
  'SELECT actor_id,state,version,created_at_ms,disabled_at_ms,control_key_version,state_mac FROM authentication.actor ORDER BY actor_id',
  'SELECT identity_id,actor_id,version,envelope_version,algorithm_id,schema_version,key_version,ciphertext,nonce,authentication_tag FROM authentication.google_identity ORDER BY identity_id',
  'SELECT purpose,digest_key_version,digest,identity_id FROM authentication.identity_alias ORDER BY purpose,digest_key_version,digest',
  'SELECT state_id,status,generation_version,epoch FROM authentication.key_state ORDER BY state_id',
  'SELECT generation_id,purpose,key_version,epoch,searchable,write_required,retired_at_ms FROM authentication.key_generation ORDER BY generation_id',
  'SELECT operation_id,actor_digest_key_version,actor_digest,version,state,created_at_ms,updated_at_ms FROM authentication.deletion_intent ORDER BY operation_id',
  'SELECT session_id,actor_id,version,epoch FROM authentication.session_record ORDER BY session_id',
  'SELECT attempt_id,version,epoch FROM authentication.login_attempt ORDER BY attempt_id',
];
const cell = (value: unknown): string | null => {
  if (value === null) return null;
  if (value instanceof Uint8Array)
    return 'bytes:' + Buffer.from(value).toString('hex');
  if (typeof value === 'string') return 'text:' + value;
  if (typeof value === 'boolean')
    return value ? 'boolean:true' : 'boolean:false';
  if (typeof value === 'number' && Number.isSafeInteger(value))
    return 'integer:' + String(value);
  throw new AuthenticationCryptoUnavailable();
};

/**
 * 同一Lock下の固定Inventory全体をFingerprintへ束縛する。復号Payloadを含めない。
 * @param connection key_state排他Lockを保持する復旧Transaction。
 * @returns private completionとCheckpointへ束縛する32-byte値。
 * @throws AuthenticationCryptoUnavailable SQL/型不正。Auditの追加はFingerprintを変えない。
 */
export const authenticationRestoreFingerprint = async (
  connection: AuthenticationQueryConnection,
): Promise<Uint8Array> => {
  const digest = createHash('sha256').update(
    encodeAuthenticationTlv(['authentication-restore-evidence/v1']),
  );
  for (const query of queries) {
    digest.update(encodeAuthenticationTlv([query]));
    const result = await connection.query(query);
    for (const value of result.rows as unknown[]) {
      const row = authenticationDatabaseRow(value);
      digest.update(encodeAuthenticationTlv(Object.values(row).map(cell)));
    }
  }
  return digest.digest();
};
