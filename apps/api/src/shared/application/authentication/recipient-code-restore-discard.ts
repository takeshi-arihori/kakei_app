import type {
  AuthenticationMaintenanceMonitor,
  AuthenticationRestoreFence,
} from './authentication-maintenance-ports.js';
import type { AuthenticationClock } from './authentication-ports.js';
import {
  authenticationRetentionState,
  recipientCodeRetentionWindow,
  type AuthenticationRetentionWindow,
} from './authentication-retention-policy.js';
import type { RecipientCodeMacKeyClosure } from './recipient-code-key-lifecycle.js';
import type { GuardedRecipientCodeMaintenance } from './recipient-code-maintenance-guard.js';
import type {
  RecipientCodeDestructionTicket,
  RecipientCodeInventoryScope,
  RecipientCodeKeyScope,
} from './recipient-code-maintenance-ports.js';
import { RecipientCodeUnavailable } from './recipient-code-record.js';

/**
 * Restoreだけが使うコード表のDB境界。restoring状態と外部fenceの閉鎖を毎回確認する。
 * 期限やMACに関係なく行を除去する経路なので、通常の清掃・削除・HTTPから呼べない。
 */
export interface RecipientCodeRestoreDatabase {
  /**
   * 復旧したDBのコード行をcodeIdの昇順で返す。Providerが知らない行の検出に使う。
   * @param fence 同じRestore runの外部閉鎖能力。
   * @param after 直前Pageの最後のcodeId。nullは先頭から。
   * @param limit 1〜1000件。
   * @returns 行が示すcodeIdとActor。MACは検証しない。
   * @throws Error restoring以外、閉鎖の未確認、SQL障害。
   */
  rows(
    fence: AuthenticationRestoreFence,
    after: string | null,
    limit: number,
  ): Promise<readonly RecipientCodeKeyScope[]>;
  /**
   * 1コードの行を、期限・MACに関係なく除去し、行があればpurge Auditを同じcommitで残す。
   * @param fence 同じRestore runの外部閉鎖能力。
   * @param scope Providerが束縛したcodeIdとActor。
   * @throws Error 行のActorがscopeと異なる、restoring以外、閉鎖の未確認、SQL障害。行がない場合は成功。
   */
  remove(
    fence: AuthenticationRestoreFence,
    scope: RecipientCodeKeyScope,
  ): Promise<void>;
  /**
   * @param fence 同じRestore runの外部閉鎖能力。
   * @param codeId 対象のUUIDv4。
   * @returns そのcodeIdの行が0件ならtrue。
   * @throws Error restoring以外、閉鎖の未確認、SQL障害。不在として扱わない。
   */
  absent(fence: AuthenticationRestoreFence, codeId: string): Promise<boolean>;
  /**
   * @param fence 同じRestore runの外部閉鎖能力。
   * @returns コード表全体が0件ならtrue。
   * @throws Error restoring以外、閉鎖の未確認、SQL障害。不在として扱わない。
   */
  empty(fence: AuthenticationRestoreFence): Promise<boolean>;
}

/** 同じRestore runへの束縛。 */
export interface RecipientCodeRestoreInput {
  /** fenceを所有するRestore run。コードticketの所有operationになる。 */ readonly runId: string;
  /** 同runの外部閉鎖能力。 */ readonly fence: AuthenticationRestoreFence;
  /** 外部Controlが記録した初回閉鎖UTC。dueAtの起点で、再開で変えない。 */ readonly closedAt: number;
}

/** Restore Serviceから呼ぶコード参加。同じ入力で再実行できる。 */
export interface RecipientCodeRestoreDiscard {
  /**
   * 固定snapshot→ticket登録・採用→行の除去→全世代closure→0-row→再snapshotの一致を確定する。
   * 戻った場合だけ開通の前提を満たす（ADR #278 論点5・7）。
   * @param input run、fence、初回閉鎖UTC。
   * @returns codeIdの昇順に並べた、所有operationへ束縛した全closure。
   * @throws RecipientCodeUnavailable 未知の行、列挙不完全、再snapshot不一致、破棄の失敗、Provider障害。
   */
  discard(
    input: RecipientCodeRestoreInput,
  ): Promise<readonly RecipientCodeMacKeyClosure[]>;
}

const pageLimit = 1000;
const reject = (): never => {
  throw new RecipientCodeUnavailable();
};

/**
 * Restoreのrunを所有operationとするコードticketで、復旧した全コードの全世代を破棄する。
 * restoring中は受付を閉じているので、deadline到達はOVERDUE通知だけで封鎖の根拠にしない（副論点B）。
 * @param options 検証済みの保守入口、Restore専用のDB境界、Clock、監視。
 * @returns Restore Serviceが手順5で呼ぶコード参加。
 */
export const createRecipientCodeRestoreDiscard = (
  options: Readonly<{
    /** guardを通したProvider。closureと全世代破棄を検証する。 */
    maintenance: GuardedRecipientCodeMaintenance;
    /** restoring専用のコード表境界。 */
    database: RecipientCodeRestoreDatabase;
    /** dueAt到達とdeadline到達の判定。 */
    clock: AuthenticationClock;
    /** ID/自由文を渡さない監視。 */
    monitor: AuthenticationMaintenanceMonitor;
  }>,
): RecipientCodeRestoreDiscard => {
  const { maintenance, database, clock, monitor } = options;

  /** 全Actorの固定snapshotを全Page読む。途中の失敗を部分集合として使わない。 */
  const snapshot = async () => {
    const scopes = new Map<string, RecipientCodeInventoryScope>();
    let cursor = null;
    do {
      const page = await maintenance.scopePage({
        cursor,
        limit: pageLimit,
        recipientActorId: null,
      });
      for (const scope of page.scopes) scopes.set(scope.codeId, scope);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return scopes;
  };

  /**
   * 復旧したDBの全行をinventoryへ束縛する。束縛できない行は全世代の破棄を証明できないので止める（論点7）。
   * snapshotにない行は、完了済みticketを`scopes`で同じActorへ解決できる場合だけ受理する。
   * Providerは完了済みscopeをsnapshotから落としてよいので、snapshotだけに依存しない（#259／#260と同じ）。
   * @returns snapshotにない行の、完了済みticket。
   */
  const bindRows = async (
    fence: AuthenticationRestoreFence,
    known: ReadonlyMap<string, RecipientCodeInventoryScope>,
  ) => {
    const completed = new Map<string, RecipientCodeDestructionTicket>();
    let after: string | null = null;
    for (;;) {
      const rows = await database.rows(fence, after, pageLimit);
      if (rows.length > pageLimit) reject();
      for (const row of rows) {
        if (after !== null && row.codeId <= after) reject();
        after = row.codeId;
        const scope = known.get(row.codeId);
        if (scope !== undefined) {
          if (scope.recipientActorId !== row.recipientActorId) reject();
          continue;
        }
        const ticket = await maintenance.find(row.codeId);
        if (ticket === null || ticket.state !== 'complete') return reject();
        const [bound] = await maintenance.scopes(ticket);
        if (bound.recipientActorId !== row.recipientActorId) reject();
        completed.set(row.codeId, ticket);
      }
      if (rows.length < pageLimit) return completed;
    }
  };

  /** 1件の障害で他のコードの破棄を遅らせない。全件を試してから止める。 */
  const everyItem = async <T>(
    items: Iterable<T>,
    work: (item: T) => Promise<void>,
  ) => {
    let failed = false;
    for (const item of items) {
      try {
        await work(item);
      } catch {
        failed = true;
      }
    }
    if (failed) reject();
  };

  /** 所有・採用した未完了ticketのうち、deadline到達の最古を通知する。 */
  const notifyOverdue = async (
    windows: readonly AuthenticationRetentionWindow[],
  ) => {
    const now = clock.now();
    const overdue = windows
      .filter(
        (window) => authenticationRetentionState(window, now) === 'overdue',
      )
      .sort((a, b) => a.dueAt - b.dueAt);
    if (overdue.length > 0)
      await monitor.record({
        operation: 'restore',
        code: 'OVERDUE',
        oldest: overdue[0],
      });
  };

  return {
    async discard({ runId, fence, closedAt }) {
      // 行の期限ではなく初回閉鎖UTCで起算する。再開でも同じ値なので延びない。
      const window = recipientCodeRetentionWindow({
        expiresAt: closedAt,
        terminalAt: null,
        actorCutoffAt: null,
      });
      const known = await snapshot();
      const completedRows = await bindRows(fence, known);
      // 処理対象のcodeIdと、Providerが束縛したActor。
      const targets = new Map<string, string>();
      for (const scope of known.values())
        targets.set(scope.codeId, scope.recipientActorId);
      await everyItem(known.values(), async (scope) => {
        const found = await maintenance.find(scope.codeId);
        if (
          found !== null &&
          found.inventoryRevision !== scope.inventoryRevision
        )
          reject();
        await maintenance.prepare({
          scope: {
            codeId: scope.codeId,
            recipientActorId: scope.recipientActorId,
          },
          operationId: runId,
          window,
          expected: found,
          basis: 'restore-fence',
        });
      });
      // snapshotにない完了済みticketも採用し、行の除去とclosureの再検証の対象にする。
      await everyItem(completedRows.values(), async (ticket) => {
        const [bound] = await maintenance.scopes(ticket);
        targets.set(ticket.codeId, bound.recipientActorId);
        await maintenance.prepare({
          scope: bound,
          operationId: runId,
          window,
          expected: ticket,
          basis: 'restore-fence',
        });
      });
      // 対象は全部このrunの所有・採用になっている。対象外のticketは、前回の試行で完了し
      // 列挙から落ちたものに限る（未完了なら所在を証明できない）。
      const tickets = await maintenance.byOperation(runId);
      const owned = new Set(tickets.map((ticket) => ticket.codeId));
      if (
        [...targets.keys()].some((codeId) => !owned.has(codeId)) ||
        tickets.some(
          (ticket) =>
            !targets.has(ticket.codeId) && ticket.state !== 'complete',
        )
      )
        reject();
      await notifyOverdue(
        tickets
          .filter((ticket) => ticket.state === 'pending')
          .map((ticket) => ticket.window),
      );
      const closures = new Map<string, RecipientCodeMacKeyClosure>();
      await everyItem(tickets, async (ticket) => {
        const [bound] = await maintenance.scopes(ticket);
        const expectedActor = targets.get(ticket.codeId);
        if (
          expectedActor !== undefined &&
          bound.recipientActorId !== expectedActor
        )
          reject();
        // 完了済みticketでも、Backupから戻った行を残さない。
        await database.remove(fence, bound);
        if (ticket.state === 'complete') {
          closures.set(ticket.codeId, await maintenance.verifyComplete(ticket));
          if ((await database.absent(fence, ticket.codeId)) !== true) reject();
          return;
        }
        // guardはClockを持たないので、破棄の前にdueAt到達をここで確かめる。
        if (clock.now() < ticket.window.dueAt) reject();
        const closure = await maintenance.close(ticket);
        if ((await database.absent(fence, ticket.codeId)) !== true) reject();
        await maintenance.complete(ticket, closure);
        closures.set(ticket.codeId, closure);
      });
      // 閉鎖後に受理されたallocateがないこと、全ticketが閉じたことを開通の前に確かめる。
      const settled = await maintenance.byOperation(runId);
      const settledIds = new Set(settled.map((ticket) => ticket.codeId));
      if (
        [...targets.keys()].some((codeId) => !settledIds.has(codeId)) ||
        settled.some(
          (ticket) =>
            ticket.state !== 'complete' || !closures.has(ticket.codeId),
        )
      )
        reject();
      // 再snapshotは、scopeが増えず、版とActorが変わらないことを確かめる（ADR 5A）。
      // 完了したscopeは列挙から落ちてよい（完了はsettledで確認済み）。
      const again = await snapshot();
      for (const scope of again.values())
        if (
          known.get(scope.codeId)?.inventoryRevision !==
            scope.inventoryRevision ||
          known.get(scope.codeId)?.recipientActorId !== scope.recipientActorId
        )
          reject();
      if ((await database.empty(fence)) !== true) reject();
      return Object.freeze(
        [...closures.values()].sort((a, b) =>
          a.codeId < b.codeId ? -1 : a.codeId > b.codeId ? 1 : 0,
        ),
      );
    },
  };
};
