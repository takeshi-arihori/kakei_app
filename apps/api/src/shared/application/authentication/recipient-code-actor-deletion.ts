import {
  recipientCodeRetentionWindow,
  type AuthenticationRetentionWindow,
} from './authentication-retention-policy.js';
import type { RecipientCodeCleanupDatabase } from './recipient-code-cleanup-service.js';
import type { GuardedRecipientCodeMaintenance } from './recipient-code-maintenance-guard.js';
import type { RecipientCodeInventoryScope } from './recipient-code-maintenance-ports.js';
import { RecipientCodeUnavailable } from './recipient-code-record.js';

/** Actor削除が使うコードのDB境界。清掃と同じLock順と0-row照合を再利用する。 */
export interface RecipientCodeDeletionDatabase extends Pick<
  RecipientCodeCleanupDatabase,
  'inspect' | 'remove' | 'absent'
> {
  /**
   * Actorのコード行が1件も残っていないことを確認する。Providerが知らない行も検出する。
   * @param recipientActorId 削除対象のActor UUIDv4。
   * @returns 行が0件ならtrue。
   * @throws Error key-state不正、SQL障害。不在として扱わない。
   */
  actorAbsent(recipientActorId: string): Promise<boolean>;
}

/** 削除Serviceへ状況を渡す口。期限未達と封鎖の判断は削除Serviceが所有する。 */
export interface RecipientCodeDeletionObserver {
  /**
   * 観測したコードの窓を渡す。未達なら削除Serviceが封鎖する。
   * @param window 登録前の推定、または登録済みticketの窓。
   * @throws Error 封鎖を確認できない場合。処理を止める。
   */
  window(window: AuthenticationRetentionWindow): Promise<void>;
  /**
   * 照合できなかったコードを渡す。行は残さず除去を続ける。
   * @param kind mismatchは確定した不整合、unverifiableは鍵障害等。
   * @throws Error 封鎖や通知を確認できない場合。処理を止める。
   */
  integrity(kind: 'mismatch' | 'unverifiable'): Promise<void>;
}

/** 同じActor削除operationへの束縛。 */
export interface RecipientCodeDeletionInput {
  /** Ledger Preparedと同じ削除operation。 */ readonly operationId: string;
  /** Ledgerの削除意思で確認済みのActor。 */ readonly actorId: string;
  /** 外部Preparedの時刻。起算の上限に使う。 */ readonly preparedAt: number;
}

/** 削除Serviceから呼ぶコード参加の2段階。どちらも同じ入力で再実行できる。 */
export interface RecipientCodeActorDeletion {
  /**
   * allocateの封鎖→固定snapshot→ticket登録を行う。再実行は不足分だけを登録する（ADR D5）。
   * @param input 削除operationとActor。
   * @param observer 窓と照合結果の受け手。
   * @throws RecipientCodeUnavailable 列挙不完全、版不一致、Lock中、Provider障害。
   */
  register(
    input: RecipientCodeDeletionInput,
    observer: RecipientCodeDeletionObserver,
  ): Promise<void>;
  /**
   * 全ticketの行除去→全世代closure→0-rowを確定し、再snapshotとの一致を確認する。
   * 戻った場合だけ削除Completeの前提を満たす。
   * @param input 削除operationとActor。
   * @param observer 窓の受け手。
   * @throws RecipientCodeUnavailable 破棄の途中失敗、不一致、未知の行、Provider障害。
   */
  finish(
    input: RecipientCodeDeletionInput,
    observer: RecipientCodeDeletionObserver,
  ): Promise<void>;
}

const scopePageLimit = 1000;
const reject = (): never => {
  throw new RecipientCodeUnavailable();
};

/**
 * Actor削除operationへコード専用ticketを参加させる（ADR D2の別ticket方式）。
 * closureは採用経由でも常に所有operationへ束縛する（ADR D3）。通常入口へwireしない。
 * @param options 検証済みの保守入口とコードのDB境界。
 * @returns 削除Serviceが使う登録と完了確認。
 */
export const createRecipientCodeActorDeletion = (
  options: Readonly<{
    /** guardを通したProvider。closureと全世代破棄を検証する。 */
    maintenance: GuardedRecipientCodeMaintenance;
    /** Lock順と0-rowを所有する境界。 */
    database: RecipientCodeDeletionDatabase;
  }>,
): RecipientCodeActorDeletion => {
  const { maintenance, database } = options;

  /** 固定snapshotの全Pageを読む。途中の失敗を部分集合として使わない。 */
  const snapshot = async (recipientActorId: string) => {
    const scopes: RecipientCodeInventoryScope[] = [];
    let cursor = null;
    do {
      const page = await maintenance.scopePage({
        cursor,
        limit: scopePageLimit,
        recipientActorId,
      });
      scopes.push(...page.scopes);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return scopes;
  };

  const assertAbsent = async (codeId: string) => {
    if ((await database.absent(codeId)) !== true) reject();
  };

  /** 1件の障害で他のコードの期限を遅らせない。全件を試してから止める。 */
  const everyItem = async <T>(
    items: readonly T[],
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

  return {
    async register({ operationId, actorId, preparedAt }, observer) {
      await maintenance.blockActor(actorId);
      await everyItem(await snapshot(actorId), async (known) => {
        const scope = {
          codeId: known.codeId,
          recipientActorId: known.recipientActorId,
        };
        const estimated = recipientCodeRetentionWindow({
          expiresAt: known.expiresAt,
          terminalAt: null,
          actorCutoffAt: preparedAt,
        });
        // Actor LockやMACの障害でも、Providerが保持する期限の未達は隠さない。
        await observer.window(estimated);
        const found = await maintenance.find(known.codeId);
        if (
          found !== null &&
          found.inventoryRevision !== known.inventoryRevision
        )
          reject();
        let window = estimated;
        // 完了済みticketは充足済みなので、行を読まずに採用だけを記録する。
        if (found?.state !== 'complete') {
          const inspection = await database.inspect(scope);
          if (inspection.status === 'locked') return reject();
          if (inspection.integrity !== 'valid')
            await observer.integrity(inspection.integrity);
          window = recipientCodeRetentionWindow({
            expiresAt: known.expiresAt,
            terminalAt: inspection.terminalAt,
            actorCutoffAt: preparedAt,
          });
          await observer.window(window);
        }
        const { ticket } = await maintenance.prepare({
          scope,
          operationId,
          window,
          expected: found,
        });
        await observer.window(ticket.window);
      });
    },
    async finish({ operationId, actorId }, observer) {
      const verified = new Set<string>();
      const tickets = await maintenance.byOperation(operationId);
      await everyItem(tickets, async (ticket) => {
        await observer.window(ticket.window);
        const [bound] = await maintenance.scopes(ticket);
        if (bound.recipientActorId !== actorId) reject();
        // 完了済みでも、Restoreや競合で戻った行を残さない。
        if ((await database.remove(bound, ticket.window.dueAt)) !== 'removed')
          reject();
        if (ticket.state === 'complete') {
          await maintenance.verifyComplete(ticket);
          await assertAbsent(ticket.codeId);
        } else {
          const closure = await maintenance.close(ticket);
          await assertAbsent(ticket.codeId);
          await maintenance.complete(ticket, closure);
        }
        verified.add(ticket.codeId);
      });
      // 封鎖後に受理されたallocateがないこと、全ticketが閉じたことをCompleteの前に確かめる。
      const settled = new Map(
        (await maintenance.byOperation(operationId)).map((ticket) => [
          ticket.codeId,
          ticket,
        ]),
      );
      for (const ticket of settled.values())
        if (ticket.state !== 'complete' || !verified.has(ticket.codeId))
          reject();
      for (const scope of await snapshot(actorId))
        if (
          settled.get(scope.codeId)?.inventoryRevision !==
          scope.inventoryRevision
        )
          reject();
      if ((await database.actorAbsent(actorId)) !== true) reject();
    },
  };
};
