import type { RecipientCodeStateKeyAllocationPort } from '../../../application/authentication/recipient-code-key-lifecycle.js';
import type { RecipientCodeCrypto } from '../../../application/authentication/recipient-code-crypto-ports.js';
import type { RecipientCodeTransition } from '../../../application/authentication/recipient-code-policy.js';
import {
  RecipientCodeUnavailable,
  type RecipientCodeRecord,
} from '../../../application/authentication/recipient-code-record.js';
import type { AuthenticationQueryConnection } from './authentication-transaction-scopes.js';

/**
 * 未知Recordの読取で鍵を生成せず、Writerだけが明示割当を検証する。
 * @param keys Record別の鍵確保能力。退役/破棄能力は含まない。
 * @param codeId 同じRecordの参照。
 * @param keyVersion 書込世代。
 * @param expiresAt 延長しないコード期限。
 * @param requireNew 新規発行では既存割当を拒否する。
 * @throws RecipientCodeUnavailable 割当不能または応答の参照/期限/新規性が不一致。
 */
export const allocateRecipientCodeStateKey = async (
  keys: RecipientCodeStateKeyAllocationPort,
  codeId: string,
  keyVersion: string,
  expiresAt: number,
  requireNew = true,
): Promise<void> => {
  const answer = await keys.allocate({ codeId, keyVersion, expiresAt });
  if (
    answer.status !== 'allocated' ||
    answer.codeId !== codeId ||
    answer.keyVersion !== keyVersion ||
    answer.expiresAt !== expiresAt ||
    typeof answer.created !== 'boolean' ||
    (requireNew && !answer.created)
  )
    throw new RecipientCodeUnavailable();
};

/**
 * Policyの終端計画を同接続の新MAC/CASへ写像する。TransactionとAuditは呼出し元が所有する。
 * @param options Lock/MAC検証済みRecordと同Scopeの限定保存能力。
 * @throws RecipientCodeUnavailable 計画不一致、鍵割当/MAC/SQL障害、CAS敗者。
 */
export const writeRecipientCodeTransition = async (options: {
  /** 既にLock済みの同じ接続だけ。 */ readonly connection: AuthenticationQueryConnection;
  /** 変更前Record。原コードを含まない。 */ readonly previous: RecipientCodeRecord;
  /** 純粋Policyの終端化計画。 */ readonly plan: RecipientCodeTransition;
  /** 先頭のkey-state Lockで固定した書込世代。 */ readonly keyVersion: string;
  /** Record MACのみ。 */ readonly crypto: Pick<
    RecipientCodeCrypto,
    'recordMac'
  >;
  /** 世代切替時の明示確保。 */ readonly stateKeys: RecipientCodeStateKeyAllocationPort;
}): Promise<void> => {
  const { previous, plan, keyVersion } = options;
  if (
    plan.codeId !== previous.codeId ||
    plan.expectedRecordVersion !== previous.recordVersion ||
    plan.recordVersion !== previous.recordVersion + 1 ||
    previous.status !== 'issued'
  )
    throw new RecipientCodeUnavailable();
  if (previous.macKeyVersion !== keyVersion)
    await allocateRecipientCodeStateKey(
      options.stateKeys,
      previous.codeId,
      keyVersion,
      previous.expiresAt,
      false,
    );
  const { mac: ignored, ...fields } = previous;
  void ignored;
  const updated = {
    ...fields,
    recordVersion: plan.recordVersion,
    status: plan.status,
    terminalAt: plan.terminalAt,
    macKeyVersion: keyVersion,
  };
  const mac = await options.crypto.recordMac(updated);
  const result = await options.connection.query(
    "UPDATE authentication.recipient_code SET record_version=$1,state=$2,terminal_at_ms=$3,mac_key_version=$4,state_mac=$5 WHERE code_id=$6 AND recipient_actor_id=$7 AND record_version=$8 AND state='issued' RETURNING code_id",
    [
      updated.recordVersion,
      updated.status,
      updated.terminalAt,
      updated.macKeyVersion,
      Buffer.from(mac.bytes),
      previous.codeId,
      previous.recipientActorId,
      plan.expectedRecordVersion,
    ],
  );
  if (result.rows.length !== 1) throw new RecipientCodeUnavailable();
};
