/**
 * 認証Tableの読取りで使う明示列。`SELECT *`は将来追加される秘密値・PIIの列を
 * 黙って読み込み、列集合の完全一致を求める読取りも無関係な列で壊すため使わない。
 * 各定数は対応する読取関数（authentication-record-rows.ts等）とMAC/AEAD検証が
 * 実際に参照する列だけを並べる。列を足す場合は読取関数とこの定数を同時に直す。
 */

/** Actor状態MACの検証入力（`readStoredAuthenticationActor`）。 */
export const authenticationActorColumns =
  'actor_id,state,version,created_at_ms,disabled_at_ms,control_key_version,state_mac';

const envelopeColumns =
  'envelope_version,algorithm_id,schema_version,key_version,ciphertext,nonce,authentication_tag';

const recordMetadataColumns =
  'version,epoch,created_at_ms,state,terminal_at_ms,cookie_digest_key_version,cookie_digest';

/** Session Row bindingと保存Envelope（`readStoredAuthenticationSession`）。 */
export const authenticationSessionColumns = `session_id,actor_id,absolute_expires_at_ms,idle_expires_at_ms,${recordMetadataColumns},${envelopeColumns}`;

/** 試行Row bindingと保存Envelope（`readStoredAuthenticationAttempt`）。 */
export const authenticationAttemptColumns = `attempt_id,expires_at_ms,${recordMetadataColumns},${envelopeColumns}`;

/** Identity Row bindingと保存Envelope（`readStoredAuthenticationIdentity`）。 */
export const authenticationIdentityColumns = `identity_id,actor_id,version,${envelopeColumns}`;

/** 削除意思の同一性検証（`assertAuthenticationDeletionIntent`）。 */
export const authenticationDeletionIntentColumns =
  'operation_id,actor_digest_key_version,actor_digest,version,state,created_at_ms,updated_at_ms';

/** 招待コードInventory（`readRecipientCode`は完全一致を要求する）。 */
export const authenticationRecipientCodeColumns =
  'code_id,recipient_actor_id,record_version,epoch,created_at_ms,expires_at_ms,state,terminal_at_ms,lookup_key_version,lookup_digest,mac_key_version,state_mac';

/** HTTP rate policyの照合入力。 */
export const authenticationRatePolicyColumns =
  'state_id,policy_version,deployment_namespace,key_version,key_check';
