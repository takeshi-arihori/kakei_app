import { randomUUID } from 'node:crypto';

import type { AuthenticationDigests } from '../../../application/authentication/authentication-digest-ports.js';
import type { AuthenticationStoreKeyState } from './authentication-key-state.js';
import type { AuthenticationQueryConnection } from './authentication-transaction-scopes.js';

/** 本Taskが保存する認証操作。削除・無効化Workflowは後続Taskが所有する。 */
export type AuthenticationStoreAction =
  'begin' | 'read-attempt' | 'complete' | 'inspect' | 'activity' | 'logout';
/** 外部入力や例外自由文を含まない拒否理由。 */
export type AuthenticationStoreReason =
  | 'success'
  | 'expired'
  | 'replayed'
  | 'disabled'
  | 'already-authenticated'
  | 'restart-required'
  | 'csrf-invalid'
  | 'state-mismatch';

/** StoreがLock下で確認した内部参照。保存時には独立用途の仮名へ変換する。 */
export interface AuthenticationAuditSubjects {
  /** 存在するActorだけ。未解決なら省略する。 */
  readonly actorId?: string;
  /** Cookieで実際に選択した試行だけ。 */
  readonly attemptId?: string;
  /** Cookieで実際に選択または作成したSessionだけ。 */
  readonly sessionId?: string;
}

/**
 * Storeの変更と同じ接続へ、最小の固定Enum／用途別仮名だけを保存する。
 * @param connection Store所有のTransaction接続。
 * @param digests 独立3用途のHMAC能力。
 * @param state 共有Lock下の同じAudit key-set。
 * @param event 操作・判断・時刻と、実在を確認した参照。
 * @throws 鍵またはinsert障害。拒否判断でも成功へ変換しない。
 */
export const insertAuthenticationAudit = async (
  connection: AuthenticationQueryConnection,
  digests: AuthenticationDigests,
  state: AuthenticationStoreKeyState,
  event: {
    /** Store内で選択した固定操作。 */
    readonly action: AuthenticationStoreAction;
    /** Callback／認証変更を許可したか。 */
    readonly decision: 'allow' | 'deny';
    /** 例外詳細を含まない固定理由。 */
    readonly reason: AuthenticationStoreReason;
    /** 全Lock取得後の注入Clock。 */
    readonly now: number;
    /** 保存前に仮名化する内部参照。 */
    readonly subjects: AuthenticationAuditSubjects;
  },
): Promise<void> => {
  const keyVersion = state.auditVersion;
  const { actorId, attemptId, sessionId } = event.subjects;
  const actor =
    actorId === undefined
      ? null
      : await digests.auditActor({ subjectId: actorId, keyVersion });
  const attempt =
    attemptId === undefined
      ? null
      : await digests.auditAttempt({ subjectId: attemptId, keyVersion });
  const session =
    sessionId === undefined
      ? null
      : await digests.auditSession({ subjectId: sessionId, keyVersion });
  await connection.query(
    `INSERT INTO authentication.audit_event (
    event_id, request_id, occurred_at_ms, action, decision, reason,
    actor_digest_key_version, actor_digest, attempt_digest_key_version, attempt_digest,
    session_digest_key_version, session_digest, audit_key_version
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      randomUUID(),
      randomUUID(),
      event.now,
      event.action,
      event.decision,
      event.reason,
      actor?.keyVersion ?? null,
      actor === null ? null : Buffer.from(actor.bytes),
      attempt?.keyVersion ?? null,
      attempt === null ? null : Buffer.from(attempt.bytes),
      session?.keyVersion ?? null,
      session === null ? null : Buffer.from(session.bytes),
      keyVersion,
    ],
  );
};
