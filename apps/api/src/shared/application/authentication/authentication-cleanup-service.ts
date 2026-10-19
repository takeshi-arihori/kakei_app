import type { AuthenticationCleanupDatabase } from './authentication-maintenance-database.js';
import type {
  AuthenticationDestructionTicket,
  AuthenticationKeyDestructionPort,
  AuthenticationMaintenanceMonitor,
} from './authentication-maintenance-ports.js';
import type { AuthenticationClock } from './authentication-ports.js';
import { AuthenticationCryptoUnavailable } from './authentication-record-protection.js';
import {
  authenticationRetentionState,
  type AuthenticationRetentionWindow,
} from './authentication-retention-policy.js';

/** DB commitと鍵完了、期限未達を区別する清掃結果。 */
export type AuthenticationCleanupResult =
  | Readonly<{
      /** 対象のDB/全鍵除去を確認し期限未達がない。 */
      status: 'complete';
      /** DB不存在と全世代Destroyedを確認した対象数。 */
      credentials: number;
      /** 今回共通commitした期限切れAuditの削除数。 */
      audits: number;
    }>
  | Readonly<{
      /** 未完了、隔離済み、または結果不明。成功件数を返さない。 */
      status: 'pending' | 'quarantined' | 'unavailable';
    }>;

const copyTicket = (
  ticket: AuthenticationDestructionTicket,
): AuthenticationDestructionTicket => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      ticket.operationId,
    ) ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(ticket.reference) ||
    !Number.isSafeInteger(ticket.version) ||
    ticket.version < 1 ||
    !(ticket.inventoryDigest instanceof Uint8Array) ||
    ticket.inventoryDigest.length !== 32
  )
    throw new AuthenticationCryptoUnavailable();
  const window = Object.freeze({ ...ticket.window });
  authenticationRetentionState(window, window.dueAt);
  return Object.freeze({
    ...ticket,
    inventoryDigest: Uint8Array.from(ticket.inventoryDigest),
    window,
  });
};

/**
 * DB行が消えた後もdurable ticketを追跡し、全鍵と0-rowを両方確認する。
 * @param options 認証DB、独立鍵Registry、Clockと固定Code監視。
 * @returns 外部Schedulerへ本番wiringしない内部清掃Use Case。
 */
export const createAuthenticationCleanupService = (
  options: Readonly<{
    /** 版付きDELETE/Auditと0-rowのDB境界。 */
    database: AuthenticationCleanupDatabase;
    /** DBとは独立した全鍵世代と再試行情報。 */
    keys: AuthenticationKeyDestructionPort;
    /** Lock後時刻と同じUTC定義の注入Clock。 */
    clock: AuthenticationClock;
    /** ID/自由文を渡さない監視。失敗も成功にしない。 */
    monitor: AuthenticationMaintenanceMonitor;
  }>,
) => ({
  /**
   * 小Batchを清掃し、前回のDB削除後の未完了鍵破棄も再開する。
   * @param limit 内部上限1〜1000。頻度/本番SLOの採用ではない。
   * @returns DB/全鍵完了、未完了、隔離、または結果不明。
   */
  async run(limit: number): Promise<AuthenticationCleanupResult> {
    let oldest: AuthenticationRetentionWindow | null = null;
    let missed = false;
    let sealed = false;
    let reported = false;
    const enforceDeadline = async (
      window: AuthenticationRetentionWindow | null,
    ) => {
      if (
        !missed &&
        (window === null ||
          authenticationRetentionState(window, options.clock.now()) !==
            'overdue')
      )
        return;
      missed = true;
      if (!sealed) {
        sealed = await options.database.quarantine();
        if (!sealed) throw new AuthenticationCryptoUnavailable();
      }
      if (!reported) {
        await options.monitor.record({
          operation: 'cleanup',
          code: 'OVERDUE',
          oldest,
        });
        reported = true;
      }
    };
    const observeTicket = async (raw: AuthenticationDestructionTicket) => {
      const ticket = copyTicket(raw);
      if (oldest === null || ticket.window.dueAt < oldest.dueAt)
        oldest = ticket.window;
      await enforceDeadline(ticket.window);
      return ticket;
    };
    try {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new AuthenticationCryptoUnavailable();
      const result = await options.database.deleteExpired(limit);
      if (result.status !== 'committed')
        throw new AuthenticationCryptoUnavailable();
      oldest =
        result.oldest === null ? null : Object.freeze({ ...result.oldest });
      await enforceDeadline(oldest);
      const candidates: AuthenticationDestructionTicket[] = [];
      for (const ticket of result.tickets)
        candidates.push(await observeTicket(ticket));
      for (const ticket of await options.keys.pendingCredentials(limit))
        candidates.push(await observeTicket(ticket));
      const selected = new Map<string, AuthenticationDestructionTicket>();
      for (const ticket of candidates) {
        const key = ticket.operationId + '/' + ticket.reference;
        const previous = selected.get(key);
        if (
          previous !== undefined &&
          previous.version === ticket.version &&
          (!previous.inventoryDigest.every(
            (value, index) => value === ticket.inventoryDigest[index],
          ) ||
            previous.window.dueAt !== ticket.window.dueAt ||
            previous.window.deadline !== ticket.window.deadline)
        )
          throw new AuthenticationCryptoUnavailable();
        if (previous === undefined || previous.version < ticket.version)
          selected.set(key, ticket);
      }
      let credentials = 0;
      let pending = false;
      for (const ticket of selected.values()) {
        await enforceDeadline(ticket.window);
        const scopes = (await options.keys.scopes(ticket)).map((scope) =>
          Object.freeze({ ...scope }),
        );
        if (scopes.length === 0) throw new AuthenticationCryptoUnavailable();
        // Actor削除は外部Prepared/Witnessを検証する別Workflowだけが破棄を所有する。
        if (scopes.some((scope) => scope.recordKind === 'google-identity')) {
          pending = true;
          continue;
        }
        if (!(await options.database.absent(scopes))) {
          pending = true;
          continue;
        }
        const proof = await options.keys.destroy(ticket);
        if (
          !(await options.keys.verify(proof, ticket)) ||
          !(await options.database.absent(scopes))
        )
          throw new AuthenticationCryptoUnavailable();
        credentials += 1;
      }
      await enforceDeadline(oldest);
      if (missed) return { status: 'quarantined' };
      await options.monitor.record({
        operation: 'cleanup',
        code: 'OK',
        oldest: pending ? oldest : result.oldest,
      });
      return pending
        ? { status: 'pending' }
        : { status: 'complete', credentials, audits: result.auditCount };
    } catch {
      try {
        await enforceDeadline(oldest);
      } catch {
        /* 既知の期限未達は鍵/監視故障でも封鎖を試みる。 */
      }
      try {
        await options.monitor.record({
          operation: 'cleanup',
          code: 'UNAVAILABLE',
          oldest,
        });
      } catch {
        /* 監視障害も許可結果へ変換しない。 */
      }
      return { status: 'unavailable' };
    }
  },
});
