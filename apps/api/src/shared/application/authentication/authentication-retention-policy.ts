import type {
  AuthenticationAttemptRow,
  AuthenticationSessionRow,
} from './authentication-record-protection.js';
import { AuthenticationCryptoUnavailable } from './authentication-record-protection.js';

const day = 86_400_000;

/** Recordの無効化とは独立した、物理除去開始と最遅期限。 */
export interface AuthenticationRetentionWindow {
  /** このUTC以降にだけ行と鍵を除去できる。 */
  readonly dueAt: number;
  /** 起算から24時間。到達した未完了対象は運用違反として扱う。 */
  readonly deadline: number;
}

/** 復号鍵を持たない認証Auditの期限入力。 */
export interface AuthenticationAuditRetentionRecord {
  /** 認証Recordや業務Auditとの混同を防ぐ用途。 */
  readonly recordKind: 'audit-event';
  /** 90日保持の起点となるUTC milliseconds。 */
  readonly occurredAt: number;
}

const time = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new AuthenticationCryptoUnavailable();
  return value;
};
const add = (value: number, duration: number): number =>
  time(time(value) + duration);

/**
 * 認証済みMetadataから削除起算を計算する。SQLの候補選択を最終判断にしない。
 * @param record LockとAEADを検証したRecord、またはAuditの最小日時。
 * @returns 無効化または保持期限と、その24時間後の最遅除去期限。
 * @throws AuthenticationCryptoUnavailable 日時・状態不整合、または整数overflow。
 */
export const authenticationRetentionWindow = (
  record:
    | AuthenticationAttemptRow
    | AuthenticationSessionRow
    | AuthenticationAuditRetentionRecord,
): AuthenticationRetentionWindow => {
  let dueAt: number;
  if (record.recordKind === 'audit-event') {
    dueAt = add(record.occurredAt, 90 * day);
  } else {
    const createdAt = time(record.createdAt);
    const terminalAt =
      record.terminalAt === null ? null : time(record.terminalAt);
    if (terminalAt !== null && terminalAt < createdAt)
      throw new AuthenticationCryptoUnavailable();
    if (record.recordKind === 'login-attempt') {
      if (
        time(record.expiresAt) !== add(createdAt, 300_000) ||
        !['ready', 'consumed', 'replaced'].includes(record.state) ||
        (record.state === 'ready') !== (terminalAt === null)
      )
        throw new AuthenticationCryptoUnavailable();
      dueAt = terminalAt ?? record.expiresAt;
    } else {
      const idle = time(record.idleExpiresAt);
      const absolute = time(record.absoluteExpiresAt);
      if (
        !['active', 'revoked'].includes(record.state) ||
        (record.state === 'active') !== (terminalAt === null) ||
        idle <= createdAt ||
        idle > absolute ||
        absolute - createdAt > 7 * day
      )
        throw new AuthenticationCryptoUnavailable();
      dueAt = Math.min(idle, absolute, terminalAt ?? absolute);
    }
  }
  return Object.freeze({ dueAt, deadline: add(dueAt, day) });
};

/**
 * Lock後Clockで期限前・対象・最遅期限到達を区別する。
 * @param window 検証済みMetadataから算出した保持Window。
 * @param now 判断点で再取得したUTC milliseconds。
 * @returns 期限前、清掃対象、または24時間期限到達。
 * @throws AuthenticationCryptoUnavailable 不正Clockや不整合Window。
 */
export const authenticationRetentionState = (
  window: AuthenticationRetentionWindow,
  now: number,
): 'retained' | 'due' | 'overdue' => {
  time(now);
  if (window.deadline !== add(window.dueAt, day))
    throw new AuthenticationCryptoUnavailable();
  return now < window.dueAt
    ? 'retained'
    : now < window.deadline
      ? 'due'
      : 'overdue';
};

/**
 * 未来または35日超のBackupを復旧対象にしない。
 * @param backupAt Manifestで検証するBackup取得UTC。
 * @param now 隔離開始時の注入Clock。
 * @throws AuthenticationCryptoUnavailable 不正日時、未来、または35日超。
 */
export const assertAuthenticationBackupAge = (
  backupAt: number,
  now: number,
): void => {
  time(backupAt);
  time(now);
  if (backupAt > now || now - backupAt > 35 * day)
    throw new AuthenticationCryptoUnavailable();
};
