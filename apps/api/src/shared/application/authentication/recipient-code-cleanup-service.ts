import type { AuthenticationClock } from './authentication-ports.js';
import {
  authenticationRetentionState,
  recipientCodeRetentionWindow,
} from './authentication-retention-policy.js';
import type { GuardedRecipientCodeMaintenance } from './recipient-code-maintenance-guard.js';
import type {
  RecipientCodeDestructionTicket,
  RecipientCodeInventoryScope,
  RecipientCodeKeyScope,
} from './recipient-code-maintenance-ports.js';
import { RecipientCodeUnavailable } from './recipient-code-record.js';

/**
 * コード清掃のDB境界。Actor FOR UPDATE→コードFOR UPDATEのLock順で扱う（R4）。
 * 既存の認証清掃Adapterの`absent`へコードscopeを渡さない。
 */
export interface RecipientCodeCleanupDatabase {
  /**
   * 行のMACを検証できた場合だけ終端時刻を返す。検証できない行の値を起算に使わない。
   * @param scope Providerが束縛したActorとcodeId。
   * @returns MAC検証済みの終端時刻。行がない、未終端、検証できない場合はnull。
   * @throws Error key-state不正、Actor不在、SQL障害。
   */
  verifiedTerminalAt(scope: RecipientCodeKeyScope): Promise<number | null>;
  /**
   * 行を冪等に除去する。登録済みticketを根拠にし、MACを検証できなくても残さない。
   * @param scope Providerが束縛したActorとcodeId。
   * @throws Error key-state不正、Actor不在、SQL障害、commit結果不明。
   */
  remove(scope: RecipientCodeKeyScope): Promise<void>;
  /**
   * コード表だけを照合する。他の表の同じIDを結果に混ぜない。
   * @param codeId 対象のUUIDv4。
   * @returns コード行が0件ならtrue。
   * @throws Error key-state不正、SQL障害。不在として扱わない。
   */
  absent(codeId: string): Promise<boolean>;
}

/**
 * 1件の清掃結果。完了を数えてよいのはcompletedだけ。
 * already-completeは完了済みticketの再確認、retainedはdueAt未到達で何も変えていない。
 */
export type RecipientCodeCleanupResult = Readonly<{
  /** 結果の分類。unavailableは同じ入力で再開できる。 */ status:
    'completed' | 'already-complete' | 'retained' | 'unavailable';
}>;

const scopePageLimit = 1000;

/**
 * 期限切れまたは終端済みのコード1件を、durable ticket→行除去→全世代closure→0-rowの順で完了する。
 * Actorのdisabled起算、小Batch、孤立scopeの列挙、overdue封鎖、Auditはこの入口に含まない。
 * @param options 検証済みの保守入口、コード専用DB境界、Clock、operationの生成。
 * @returns 通常入口へwireしない内部の清掃入口。
 */
export const createRecipientCodeCleanupService = (
  options: Readonly<{
    /** guardを通したProvider。closureと全世代破棄を検証する。 */
    maintenance: GuardedRecipientCodeMaintenance;
    /** Lock順とコード表だけの0-rowを所有する境界。 */
    database: RecipientCodeCleanupDatabase;
    /** guardはClockを持たないので、dueAt到達はここで確認する。 */
    clock: AuthenticationClock;
    /** 新規ticketの所有operation。再開ではticketの値を使い続ける。 */
    nextOperationId: () => string;
  }>,
) => {
  const { maintenance, database, clock } = options;

  /** 呼出し側の値を信じず、Providerが束縛した期限と全世代版を取得する。 */
  const inventoryScope = async (
    scope: RecipientCodeKeyScope,
  ): Promise<RecipientCodeInventoryScope> => {
    let cursor = null;
    do {
      const page = await maintenance.scopePage({
        cursor,
        limit: scopePageLimit,
        recipientActorId: scope.recipientActorId,
      });
      const found = page.scopes.find(({ codeId }) => codeId === scope.codeId);
      if (found !== undefined) return found;
      cursor = page.nextCursor;
    } while (cursor !== null);
    throw new RecipientCodeUnavailable();
  };

  /** 0-rowを確認できない完了はない。 */
  const assertAbsent = async (codeId: string) => {
    if ((await database.absent(codeId)) !== true)
      throw new RecipientCodeUnavailable();
  };

  /** dueAt到達後だけ、登録済みticketを同operationで完了まで進める。 */
  const finish = async (
    scope: RecipientCodeKeyScope,
    ticket: RecipientCodeDestructionTicket,
  ): Promise<RecipientCodeCleanupResult> => {
    if (authenticationRetentionState(ticket.window, clock.now()) === 'retained')
      return { status: 'retained' };
    await database.remove(scope);
    const closure = await maintenance.close(ticket);
    await assertAbsent(scope.codeId);
    await maintenance.complete(ticket, closure);
    return { status: 'completed' };
  };

  return {
    /**
     * 1件を清掃する。途中の失敗は完了として数えず、同じ入力の再実行が同operationで再開する。
     * @param scope 対象のcodeIdと束縛Actor。Providerが知らない組合せは止める。
     * @returns 清掃結果。原因の詳細は返さない。
     */
    async cleanOne(
      scope: RecipientCodeKeyScope,
    ): Promise<RecipientCodeCleanupResult> {
      try {
        const known = await inventoryScope(scope);
        const found = await maintenance.find(scope.codeId);
        if (found?.state === 'complete') {
          // 完了済みでも行が戻っていれば除去し、0-rowを確認する。完了は数えない。
          await database.remove(scope);
          await assertAbsent(scope.codeId);
          return { status: 'already-complete' };
        }
        if (found !== null) return await finish(scope, found);
        const window = recipientCodeRetentionWindow({
          expiresAt: known.expiresAt,
          terminalAt: await database.verifiedTerminalAt(scope),
          actorCutoffAt: null,
        });
        if (authenticationRetentionState(window, clock.now()) === 'retained')
          return { status: 'retained' };
        const { ticket } = await maintenance.prepare({
          scope,
          operationId: options.nextOperationId(),
          window,
          expected: null,
        });
        return await finish(scope, ticket);
      } catch {
        // Providerや暗号の例外に入力やIDが含まれ得るので、原因を外へ出さない。
        return { status: 'unavailable' };
      }
    },
  };
};
