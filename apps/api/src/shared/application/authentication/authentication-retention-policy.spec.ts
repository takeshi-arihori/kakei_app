import { describe, expect, it } from 'vitest';

import type {
  AuthenticationAttemptRow,
  AuthenticationSessionRow,
} from './authentication-record-protection.js';
import {
  authenticationRetentionWindow,
  authenticationRetentionState,
  assertAuthenticationBackupAge,
} from './authentication-retention-policy.js';

const day = 86_400_000;
const attempt: AuthenticationAttemptRow = {
  recordKind: 'login-attempt',
  attemptId: '11111111-1111-4111-8111-111111111111',
  version: 1,
  epoch: '22222222-2222-4222-8222-222222222222',
  createdAt: 1000,
  expiresAt: 301000,
  state: 'ready',
  terminalAt: null,
  cookieDigestKeyVersion: 'v1',
  cookieDigest: new Uint8Array(32),
};
const session: AuthenticationSessionRow = {
  recordKind: 'session',
  sessionId: attempt.attemptId,
  actorId: '33333333-3333-4333-8333-333333333333',
  version: 1,
  epoch: attempt.epoch,
  createdAt: 1000,
  absoluteExpiresAt: 1000 + 7 * day,
  idleExpiresAt: 1000 + day,
  state: 'active',
  terminalAt: null,
  cookieDigestKeyVersion: 'v1',
  cookieDigest: new Uint8Array(32),
};

describe('認証Dataの保持期限', () => {
  it('未使用試行は5分期限を削除起算にする', () => {
    expect(authenticationRetentionWindow(attempt)).toEqual({
      dueAt: 301000,
      deadline: 301000 + day,
    });
  });
  it.each(['consumed', 'replaced'] as const)(
    '%s試行はterminalAtから24時間以内に除去する',
    (state) => {
      expect(
        authenticationRetentionWindow({ ...attempt, state, terminalAt: 2000 }),
      ).toEqual({ dueAt: 2000, deadline: 2000 + day });
    },
  );
  it('有効Sessionはidleと絶対期限の早い方を起算にする', () => {
    expect(authenticationRetentionWindow(session)).toEqual({
      dueAt: 1000 + day,
      deadline: 1000 + 2 * day,
    });
  });
  it.each([2000, 1000 + 2 * day])(
    '失効が期限の前後でも最初の無効時点を失わない',
    (terminalAt) => {
      const dueAt = Math.min(terminalAt, session.idleExpiresAt);
      expect(
        authenticationRetentionWindow({
          ...session,
          state: 'revoked',
          terminalAt,
        }),
      ).toEqual({ dueAt, deadline: dueAt + day });
    },
  );
  it('AuditはUTCの90日後から24時間以内に清掃する', () => {
    expect(
      authenticationRetentionWindow({
        recordKind: 'audit-event',
        occurredAt: 1000,
      }),
    ).toEqual({ dueAt: 1000 + 90 * day, deadline: 1000 + 91 * day });
  });
  it.each([
    [-1, 'retained'],
    [0, 'due'],
    [day - 1, 'due'],
    [day, 'overdue'],
  ] as const)('起算から%s msの境界は%s', (offset, expected) => {
    const window = authenticationRetentionWindow(attempt);
    expect(authenticationRetentionState(window, window.dueAt + offset)).toBe(
      expected,
    );
  });
  it.each([-1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    '不正Clock %sでは期限判断しない',
    (now) => {
      expect(() =>
        authenticationRetentionState(
          authenticationRetentionWindow(attempt),
          now,
        ),
      ).toThrow();
    },
  );
  it('日時加算の丸めやoverflowを期限成功にしない', () => {
    expect(() =>
      authenticationRetentionWindow({
        recordKind: 'audit-event',
        occurredAt: Number.MAX_SAFE_INTEGER - day,
      }),
    ).toThrow();
  });
  it.each([
    { ...attempt, state: 'consumed' as const, terminalAt: null },
    { ...attempt, terminalAt: 2000 },
    { ...attempt, state: 'consumed' as const, terminalAt: 999 },
    { ...session, idleExpiresAt: session.absoluteExpiresAt + 1 },
    { ...session, state: 'revoked' as const, terminalAt: null },
  ])('不整合Metadataで削除起算を決めない', (record) => {
    expect(() => authenticationRetentionWindow(record)).toThrow();
  });
  it.each([35 * day - 1, 35 * day])('35日以内のBackupは年齢検証を通る', (age) =>
    expect(() => assertAuthenticationBackupAge(1000, 1000 + age)).not.toThrow(),
  );
  it.each([35 * day + 1, -1])('35日超または未来のBackupを拒否する', (age) =>
    expect(() => assertAuthenticationBackupAge(1000, 1000 + age)).toThrow(),
  );
});
