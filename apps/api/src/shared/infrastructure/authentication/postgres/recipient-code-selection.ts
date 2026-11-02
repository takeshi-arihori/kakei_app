import type { RecipientCodeCrypto } from '../../../application/authentication/recipient-code-crypto-ports.js';
import type { RecipientCodeSecret } from '../../../application/authentication/recipient-code-input.js';
import {
  snapshotRecipientCodeRecord,
  type RecipientCodeRecord,
} from '../../../application/authentication/recipient-code-record.js';
import { authenticationBytesEqual } from '../authentication-digests.js';
import { authenticationObject } from '../canonical-authentication.js';
import {
  authenticationDatabaseInteger as integer,
  authenticationDatabaseRow,
} from './authentication-database-values.js';
import { AuthenticationMultipleMatches } from './authentication-record-selection.js';
import type { AuthenticationQueryConnection } from './authentication-transaction-scopes.js';

/**
 * SQLの最小Inventoryを復元する。MAC/本人性認証の代替ではない。
 * @param value 選択した未信頼のpg Row。
 * @returns 未知/不正なFieldを受理しない独立Copy。
 * @throws RecipientCodeUnavailable 不正Metadata。
 */
export const readRecipientCode = (value: unknown): RecipientCodeRecord => {
  const row = authenticationObject(authenticationDatabaseRow(value), [
    'code_id',
    'recipient_actor_id',
    'record_version',
    'epoch',
    'created_at_ms',
    'expires_at_ms',
    'state',
    'terminal_at_ms',
    'lookup_key_version',
    'lookup_digest',
    'mac_key_version',
    'state_mac',
  ]);
  return snapshotRecipientCodeRecord({
    codeId: row.code_id,
    recipientActorId: row.recipient_actor_id,
    recordVersion: integer(row.record_version, 1),
    epoch: row.epoch,
    createdAt: integer(row.created_at_ms, 0),
    expiresAt: integer(row.expires_at_ms, 0),
    status: row.state,
    terminalAt:
      row.terminal_at_ms === null ? null : integer(row.terminal_at_ms, 0),
    lookupKeyVersion: row.lookup_key_version,
    lookupDigest: row.lookup_digest,
    macKeyVersion: row.mac_key_version,
    mac: row.state_mac,
  });
};

/**
 * 全検索世代からActorを先にLockするためのhintだけを選ぶ。MAC鍵はまだ取得しない。
 * @param connection 所有者の同一接続。
 * @param crypto コードlookup専用能力。
 * @param versions key_state共有Lock下の検索世代。
 * @param secret await前にCopyしたcanonical入力。
 * @returns 0-hitならnull、一件なら未認証hint。複数hitは任意選択しない。
 * @throws 鍵/SQL/複数hit/Metadata障害。
 */
export const findRecipientCode = async (
  connection: AuthenticationQueryConnection,
  crypto: RecipientCodeCrypto,
  versions: readonly string[],
  secret: RecipientCodeSecret,
): Promise<RecipientCodeRecord | null> => {
  const candidates = await Promise.all(
    versions.map((keyVersion) => crypto.lookup({ secret, keyVersion })),
  );
  const values: unknown[] = [];
  const conditions = candidates.map((candidate) => {
    values.push(candidate.keyVersion, Buffer.from(candidate.bytes));
    return `(lookup_key_version = $${values.length - 1} AND lookup_digest = $${values.length})`;
  });
  const result = await connection.query(
    `SELECT * FROM authentication.recipient_code WHERE ${conditions.join(' OR ')}`,
    values,
  );
  if (result.rows.length > 1) throw new AuthenticationMultipleMatches();
  if (!result.rows.length) return null;
  const row = readRecipientCode(result.rows[0]);
  if (
    !candidates.some(
      (c) =>
        c.keyVersion === row.lookupKeyVersion &&
        authenticationBytesEqual(c.bytes, row.lookupDigest),
    )
  )
    throw new AuthenticationMultipleMatches();
  return row;
};
