import type { AuthenticationMaintenanceMonitor } from './authentication-maintenance-ports.js';
import type { AuthenticationClock } from './authentication-ports.js';
import {
  authenticationRetentionState,
  recipientCodeRetentionWindow,
  type AuthenticationRetentionWindow,
} from './authentication-retention-policy.js';
import type { GuardedRecipientCodeMaintenance } from './recipient-code-maintenance-guard.js';
import type {
  RecipientCodeDestructionTicket,
  RecipientCodeInventoryScope,
  RecipientCodeKeyScope,
} from './recipient-code-maintenance-ports.js';
import { RecipientCodeUnavailable } from './recipient-code-record.js';

/** Actor Lock下で読んだ起算の材料。検証できなかった値はnullで、起算に使わない。 */
export type RecipientCodeCleanupInspection =
  | Readonly<{
      /** コード行を別接続がLock中。待たずに次回へ回す。 */ status: 'locked';
    }>
  | Readonly<{
      /** 行がない孤立scopeもこの結果になる。 */ status: 'read';
      /** MAC検証済みのActor無効化時刻。 */ disabledAt: number | null;
      /** MAC検証済みのコード終端時刻。 */ terminalAt: number | null;
      /** mismatchは確定した不整合、unverifiableは鍵障害等で照合できなかった。 */
      integrity: 'valid' | 'mismatch' | 'unverifiable';
    }>;

/**
 * コード清掃のDB境界。key-state共有Lock→Actor FOR UPDATE→コードSKIP LOCKEDのLock順で扱う（R4）。
 * 既存の認証清掃Adapterの`absent`へコードscopeを渡さない。
 */
export interface RecipientCodeCleanupDatabase {
  /**
   * 起算の材料をLock下で読む。
   * @param scope Providerが束縛したActorとcodeId。
   * @returns コード行がLock中か、検証済みの時刻と照合結果。
   * @throws Error key-state不正、Actor不在、SQL障害。
   */
  inspect(
    scope: RecipientCodeKeyScope,
  ): Promise<RecipientCodeCleanupInspection>;
  /**
   * Lock後のClockでdueAtを再検証し、行とpurge Auditを同じcommitで確定する。
   * 登録済みticketを根拠にし、MACを検証できなくても残さない。行がなければAuditを書かない。
   * @param scope Providerが束縛したActorとcodeId。
   * @param dueAt 登録済みticketのdueAt。
   * @returns removedは0-rowを含む。retainedは期限前、lockedはコード行がLock中で、何も変えていない。
   * @throws Error key-state不正、Actor不在、SQL・Audit障害、commit結果不明。
   */
  remove(
    scope: RecipientCodeKeyScope,
    dueAt: number,
  ): Promise<'removed' | 'retained' | 'locked'>;
  /**
   * コード表だけを照合する。他の表の同じIDを結果に混ぜない。
   * @param codeId 対象のUUIDv4。
   * @returns コード行が0件ならtrue。
   * @throws Error key-state不正、SQL障害。不在として扱わない。
   */
  absent(codeId: string): Promise<boolean>;
  /**
   * 期限到達が疑われる行を、Lockせず最早の順に返す。候補であり判断の根拠にしない。
   * @param now 判定時刻。
   * @param limit 1〜1000件。
   * @returns 未検証のscopeとdueAt。
   * @throws Error key-state不正、SQL障害。
   */
  dueHints(
    now: number,
    limit: number,
  ): Promise<
    readonly Readonly<{
      /** 行が示す未検証のActorとcodeId。 */ scope: RecipientCodeKeyScope;
      /** 並び替えだけに使う未検証の時刻。 */ dueAt: number;
    }>[]
  >;
  /**
   * 孤立scopeの候補を選ぶため、ActorのdisabledAtをLockせず返す。候補であり判断の根拠にしない。
   * @param actorIds Provider列挙のActor。
   * @returns disabledのActorと未検証の時刻。
   * @throws Error key-state不正、SQL障害。
   */
  disabledHints(
    actorIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>>;
  /**
   * 利用受付を封鎖する。解除する能力は持たない。
   * @returns 封鎖を確認できた場合だけtrue。
   * @throws Error SQL障害。封鎖済みとして扱わない。
   */
  quarantine(): Promise<boolean>;
}

/**
 * 1件の清掃結果。完了を数えてよいのはcompletedだけ。
 * already-completeは完了済みticketの再確認、retainedはdueAt未到達、skippedは行がLock中で、
 * どちらも何も変えていない。quarantinedは封鎖を確定した場合で、除去が進んでも完了を数えない。
 */
export type RecipientCodeCleanupResult = Readonly<{
  /** 結果の分類。unavailableは同じ入力で再開できる。 */ status:
    | 'completed'
    | 'already-complete'
    | 'retained'
    | 'skipped'
    | 'quarantined'
    | 'unavailable';
}>;

/** Batch全体の結果。件数を返すのは全対象を確認できたcompleteだけ。 */
export type RecipientCodeCleanupRunResult =
  | Readonly<{
      /** 期限到達の全対象を処理し、未達も障害もない。 */ status: 'complete';
      /** 今回の実行で完了したticket数。 */ removed: number;
    }>
  | Readonly<{
      /** 残件・障害・封鎖あり。成功件数を返さない。 */ status:
        'pending' | 'quarantined' | 'unavailable';
    }>;

const scopePageLimit = 1000;

/** 一回の実行の封鎖状態。同じ実行で封鎖と通知を繰り返さない。 */
type Seal = {
  /** 封鎖が必要と判明した。 */ required: boolean;
  /** 封鎖を確認した。 */ sealed: boolean;
  /** 通知済みの固定Code。 */ reported: Set<'OVERDUE' | 'QUARANTINED'>;
  /** 通知に失敗した。封鎖は維持するが、封鎖済みとして報告しない。 */ unreported: boolean;
};

/**
 * 期限切れ・終端・Actor無効化のコードを、durable ticket→行除去→全世代closure→0-rowの順で完了する。
 * Actor削除は扱わない。通常入口へwireしない。
 * @param options 検証済みの保守入口、コード専用DB境界、Clock、operationの生成、固定Code監視。
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
    /** ID/自由文を渡さない監視。失敗も成功にしない。 */
    monitor: AuthenticationMaintenanceMonitor;
  }>,
) => {
  const { maintenance, database, clock, monitor } = options;

  const newSeal = (): Seal => ({
    required: false,
    sealed: false,
    reported: new Set(),
    unreported: false,
  });
  /** 封鎖と通知の両方を確認できた場合だけquarantinedと報告する。 */
  const confirmed = (state: Seal) =>
    state.required && state.sealed && !state.unreported;

  /** 封鎖を先に確定してから通知する。通知の障害で封鎖を取り消さない。 */
  const seal = async (
    state: Seal,
    code: 'OVERDUE' | 'QUARANTINED',
    oldest: AuthenticationRetentionWindow | null,
  ) => {
    state.required = true;
    if (!state.sealed) {
      state.sealed = await database.quarantine();
      if (!state.sealed) throw new RecipientCodeUnavailable();
    }
    if (state.reported.has(code)) return;
    try {
      await monitor.record({ operation: 'cleanup', code, oldest });
    } catch (error) {
      state.unreported = true;
      throw error;
    }
    state.reported.add(code);
  };

  /** Lock skipや障害の前に確認し、既知の未達を隠さない。 */
  const enforceDeadline = async (
    state: Seal,
    window: AuthenticationRetentionWindow,
  ) => {
    if (authenticationRetentionState(window, clock.now()) === 'overdue')
      await seal(state, 'OVERDUE', window);
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
    const removed = await database.remove(scope, ticket.window.dueAt);
    if (removed === 'retained') return { status: 'retained' };
    if (removed === 'locked') return { status: 'skipped' };
    const closure = await maintenance.close(ticket);
    await assertAbsent(scope.codeId);
    await maintenance.complete(ticket, closure);
    return { status: 'completed' };
  };

  /** 完了済みticketは再作成せず、Providerが束縛したscopeで戻った行だけを除去する。 */
  const recheckComplete = async (
    scope: RecipientCodeKeyScope,
    ticket: RecipientCodeDestructionTicket,
  ): Promise<RecipientCodeCleanupResult> => {
    const [bound] = await maintenance.scopes(ticket);
    if (bound.recipientActorId !== scope.recipientActorId)
      throw new RecipientCodeUnavailable();
    const removed = await database.remove(bound, ticket.window.dueAt);
    if (removed === 'locked') return { status: 'skipped' };
    await assertAbsent(bound.codeId);
    return { status: 'already-complete' };
  };

  /** ticket未登録のscopeをActor Lock下で起算し、到達していればticketを登録して進める。 */
  const start = async (
    state: Seal,
    known: RecipientCodeInventoryScope,
  ): Promise<RecipientCodeCleanupResult> => {
    const scope = {
      codeId: known.codeId,
      recipientActorId: known.recipientActorId,
    };
    // Actor LockやMACの障害でも、Providerが保持する期限の未達は隠さない。
    await enforceDeadline(
      state,
      recipientCodeRetentionWindow({
        expiresAt: known.expiresAt,
        terminalAt: null,
        actorCutoffAt: null,
      }),
    );
    const inspection = await database.inspect(scope);
    if (inspection.status === 'locked') return { status: 'skipped' };
    if (inspection.integrity === 'mismatch')
      await seal(state, 'QUARANTINED', null);
    else if (inspection.integrity === 'unverifiable')
      await monitor.record({
        operation: 'cleanup',
        code: 'UNAVAILABLE',
        oldest: null,
      });
    const window = recipientCodeRetentionWindow({
      expiresAt: known.expiresAt,
      terminalAt: inspection.terminalAt,
      actorCutoffAt: inspection.disabledAt,
    });
    await enforceDeadline(state, window);
    if (authenticationRetentionState(window, clock.now()) === 'retained')
      return { status: 'retained' };
    const { ticket } = await maintenance.prepare({
      scope,
      operationId: options.nextOperationId(),
      window,
      expected: null,
    });
    return finish(scope, ticket);
  };

  /** ticketの状態に応じて、再確認・新規開始・再開のいずれかへ進める。cleanOneとrunで共有する。 */
  const advance = async (
    state: Seal,
    scope: RecipientCodeKeyScope,
    known: RecipientCodeInventoryScope | null,
    found: RecipientCodeDestructionTicket | null,
  ): Promise<RecipientCodeCleanupResult> => {
    if (found?.state === 'complete') return recheckComplete(scope, found);
    if (known === null) throw new RecipientCodeUnavailable();
    if (found === null) return start(state, known);
    knownForTicket(new Map([[known.codeId, known]]), found);
    await enforceDeadline(state, found.window);
    return finish(scope, found);
  };

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

  /** 固定snapshotの全Pageを読む。途中の失敗や不完全な列挙を部分集合として使わない。 */
  const snapshot = async () => {
    const scopes = new Map<string, RecipientCodeInventoryScope>();
    let cursor = null;
    do {
      const page = await maintenance.scopePage({
        cursor,
        limit: scopePageLimit,
        recipientActorId: null,
      });
      for (const scope of page.scopes) scopes.set(scope.codeId, scope);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return scopes;
  };

  /** 未知scope・版不一致は、Providerとの不整合として実行全体を止める。 */
  const knownForTicket = (
    scopes: ReadonlyMap<string, RecipientCodeInventoryScope>,
    ticket: RecipientCodeDestructionTicket,
  ) => {
    const known = scopes.get(ticket.codeId);
    if (
      known === undefined ||
      known.inventoryRevision !== ticket.inventoryRevision
    )
      throw new RecipientCodeUnavailable();
    return known;
  };

  /** 未完了ticket・行の候補・Provider列挙から、Lockなしで今回の候補を作る。 */
  const candidates = async (limit: number) => {
    const now = clock.now();
    // 行はallocateの後にしか現れないので、先に読めば後のsnapshotは必ず含む。未知行の誤検出を防ぐ。
    const hints = await database.dueHints(now, limit);
    const scopes = await snapshot();
    const tickets = await maintenance.pending(limit);
    const selected = new Map<
      string,
      {
        scope: RecipientCodeKeyScope;
        known: RecipientCodeInventoryScope | null;
        dueAt: number;
        hasRow: boolean;
      }
    >();
    for (const ticket of tickets) {
      const known = knownForTicket(scopes, ticket);
      selected.set(ticket.codeId, {
        scope: known,
        known,
        dueAt: ticket.window.dueAt,
        hasRow: false,
      });
    }
    for (const hint of hints) {
      const known = scopes.get(hint.scope.codeId);
      if (
        known !== undefined &&
        known.recipientActorId !== hint.scope.recipientActorId
      )
        throw new RecipientCodeUnavailable();
      if (known === undefined) {
        // 列挙にない行は、完了済みticketの復元行だけを許す。
        const ticket = await maintenance.find(hint.scope.codeId);
        if (ticket?.state !== 'complete') throw new RecipientCodeUnavailable();
      }
      const previous = selected.get(hint.scope.codeId);
      selected.set(hint.scope.codeId, {
        scope: known ?? hint.scope,
        known: known ?? null,
        dueAt: Math.min(hint.dueAt, previous?.dueAt ?? hint.dueAt),
        hasRow: true,
      });
    }
    const disabled = await database.disabledHints([
      ...new Set([...scopes.values()].map((s) => s.recipientActorId)),
    ]);
    for (const known of scopes.values()) {
      if (selected.has(known.codeId)) continue;
      const dueAt = Math.min(
        known.expiresAt,
        disabled.get(known.recipientActorId) ?? Infinity,
      );
      if (dueAt <= now)
        selected.set(known.codeId, {
          scope: known,
          known,
          dueAt,
          hasRow: false,
        });
    }
    // 最早の期限から処理し、limitの外に古い未達を残さない。
    return [...selected.values()].sort((a, b) => a.dueAt - b.dueAt);
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
      const state = newSeal();
      try {
        const found = await maintenance.find(scope.codeId);
        // 完了済みticketはProviderのscopesで解決し、列挙が完了済みscopeを残すかに依存しない。
        const known =
          found?.state === 'complete' ? null : await inventoryScope(scope);
        const result = await advance(state, scope, known, found);
        if (confirmed(state)) return { status: 'quarantined' };
        if (state.required) throw new RecipientCodeUnavailable();
        return result;
      } catch {
        // Providerや暗号の例外に入力やIDが含まれ得るので、原因を外へ出さない。
        return { status: confirmed(state) ? 'quarantined' : 'unavailable' };
      }
    },
    /**
     * 未完了ticketの再開、行の候補、孤立scopeを最早の期限から小Batchで処理する。
     * 列挙が不完全な場合と未知scopeでは何も進めず止める。個別の障害は残りを進めてから止める。
     * @param limit 内部上限1〜1000。頻度/本番SLOの採用ではない。
     * @returns 全対象を確認できた場合だけ件数を返す。
     */
    async run(limit: number): Promise<RecipientCodeCleanupRunResult> {
      const state = newSeal();
      let failed = false;
      try {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
          throw new RecipientCodeUnavailable();
        const selected = await candidates(limit);
        let removed = 0;
        let attempted = 0;
        let remaining = false;
        for (const { scope, known, hasRow } of selected) {
          try {
            const found = await maintenance.find(scope.codeId);
            // 行のない完了済みscopeは履歴が増えても予算とDBを消費しない。
            if (found?.state === 'complete' && !hasRow) continue;
            // 最早の期限から処理するので、残した候補は処理済みのものより新しい。
            if (attempted >= limit) {
              remaining = true;
              break;
            }
            attempted += 1;
            const result = await advance(state, scope, known, found);
            if (result.status === 'completed') removed += 1;
            if (result.status === 'skipped') remaining = true;
          } catch {
            // 1件のLock timeoutや障害で他の期限到達を止めない。完了は数えない。
            failed = true;
          }
        }
        if (confirmed(state)) return { status: 'quarantined' };
        if (failed || state.required) throw new RecipientCodeUnavailable();
        await monitor.record({
          operation: 'cleanup',
          code: 'OK',
          oldest: null,
        });
        return remaining
          ? { status: 'pending' }
          : { status: 'complete', removed };
      } catch {
        try {
          await monitor.record({
            operation: 'cleanup',
            code: 'UNAVAILABLE',
            oldest: null,
          });
        } catch {
          /* 監視障害も許可結果へ変換しない。 */
        }
        return { status: 'unavailable' };
      }
    },
  };
};
