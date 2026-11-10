import type {
  AuthenticationCleanupDatabase,
  AuthenticationDeletionDatabase,
} from './authentication-maintenance-database.js';
import type {
  AuthenticationKeyDestructionPort,
  AuthenticationLedgerEvidence,
  AuthenticationMaintenanceMonitor,
} from './authentication-maintenance-ports.js';
import type { AuthenticationClock } from './authentication-ports.js';
import { AuthenticationCryptoUnavailable } from './authentication-record-protection.js';
import {
  authenticationRetentionState,
  type AuthenticationRetentionWindow,
} from './authentication-retention-policy.js';
import type {
  RecipientCodeActorDeletion,
  RecipientCodeDeletionObserver,
} from './recipient-code-actor-deletion.js';

/** 結果不明でも不可逆意思の再開IDを失わない削除結果。 */
export interface AuthenticationDeletionResult {
  /** unavailable/pendingは受付失敗やrollbackの証明ではない。 */
  readonly status: 'complete' | 'pending' | 'quarantined' | 'unavailable';
  /** 発行後は外部Preparedを再照合する同じoperation。未発行障害だけnull。 */
  readonly operationId: string | null;
}

const equal = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== 32 || b.length !== 32) return false;
  let difference = 0;
  for (let i = 0; i < 32; i += 1) difference |= a[i] ^ b[i];
  return difference === 0;
};
const uuid = (id: string) => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      id,
    )
  )
    throw new AuthenticationCryptoUnavailable();
  return id;
};
class DeletionQuarantined extends Error {
  constructor() {
    super('authentication-deletion-quarantined');
  }
}

/**
 * 外部Prepared、DB原子無効化、全鍵と0-row、外部Completeを順に確定する。
 * @param options 退会受付と独立した内部削除能力。Runtimeへ公開しない。
 * @returns 同operationの再試行と、内部受付後の削除開始だけを提供する。
 */
export const createAuthenticationDeletionService = (
  options: Readonly<{
    /** Actor/全Session/Intent/AuditのDB原子境界。 */
    database: AuthenticationDeletionDatabase;
    /** 全対象の新Transaction 0-row照合と隔離。 */
    cleanup: AuthenticationCleanupDatabase;
    /** 全DEK世代のdurable Registry。 */
    keys: AuthenticationKeyDestructionPort;
    /** MAC/chain/独立Witnessを検証する専用境界。 */
    ledger: AuthenticationLedgerEvidence;
    /** UTC境界と24時間未達の判断。 */
    clock: AuthenticationClock;
    /** IDや自由文を含まない監視。 */
    monitor: AuthenticationMaintenanceMonitor;
    /** ServerのCSPRNG UUIDv4生成能力。ClientのIDを採用しない。 */
    newOperationId: () => string;
    /** 退役世代も含むActor削除専用HMAC。 */
    deletedActor: (actorId: string, keyVersion: string) => Promise<Uint8Array>;
    /** コード用途の初期化済み環境だけ渡す。有無がDBと食い違えば削除を進めない。 */
    recipientCodes?: RecipientCodeActorDeletion;
  }>,
) => {
  /** コード用途があるのに参加しない削除は、コードを残してCompleteするので止める。 */
  const assertRecipientCodeParticipation = (provisioned: boolean) => {
    if (provisioned !== (options.recipientCodes !== undefined))
      throw new AuthenticationCryptoUnavailable();
  };
  const quarantineIntegrity = async (): Promise<never> => {
    if (!(await options.cleanup.quarantine()))
      throw new AuthenticationCryptoUnavailable();
    try {
      await options.monitor.record({
        operation: 'deletion',
        code: 'QUARANTINED',
        oldest: null,
      });
    } catch {
      /* 封鎖が確認済みなら監視障害でその状態を取り消さない。 */
    }
    throw new DeletionQuarantined();
  };
  const reconciledHead = async () => {
    let head = await options.ledger.latest();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await options.database.reconcileIntents(options.ledger.intents(head)))
        return head;
      const updated = await options.ledger.latest();
      const before = options.ledger.head(head);
      const after = options.ledger.head(updated);
      if (before.sequence === after.sequence && before.hash === after.hash) {
        if (!(await options.cleanup.quarantine()))
          throw new AuthenticationCryptoUnavailable();
        await options.monitor.record({
          operation: 'deletion',
          code: 'QUARANTINED',
          oldest: null,
        });
        throw new DeletionQuarantined();
      }
      head = updated;
    }
    throw new AuthenticationCryptoUnavailable();
  };
  const resume = async (
    operationId: string,
  ): Promise<AuthenticationDeletionResult> => {
    let validatedOperationId: string | null = null;
    let window: AuthenticationRetentionWindow | null = null;
    /** 削除の窓より早い可能性があるコードticketの最早の窓。 */
    let codeWindow: AuthenticationRetentionWindow | null = null;
    let deadlineApplies = false;
    let missed = false;
    let sealed = false;
    let reported = false;
    let codeMismatch = false;
    const earliestWindow = () =>
      codeWindow !== null && window !== null && codeWindow.dueAt < window.dueAt
        ? codeWindow
        : window;
    const enforceDeadline = async () => {
      const earliest = earliestWindow();
      if (
        !deadlineApplies ||
        earliest === null ||
        (!missed &&
          authenticationRetentionState(earliest, options.clock.now()) !==
            'overdue')
      )
        return;
      missed = true;
      if (!sealed) {
        sealed = await options.cleanup.quarantine();
        if (!sealed) throw new AuthenticationCryptoUnavailable();
      }
      if (!reported) {
        await options.monitor.record({
          operation: 'deletion',
          code: 'OVERDUE',
          oldest: earliest,
        });
        reported = true;
      }
    };
    const codeObserver: RecipientCodeDeletionObserver = {
      window: async (observed) => {
        if (codeWindow === null || observed.dueAt < codeWindow.dueAt)
          codeWindow = observed;
        await enforceDeadline();
      },
      integrity: async (kind) => {
        if (kind === 'unverifiable') {
          await options.monitor.record({
            operation: 'deletion',
            code: 'UNAVAILABLE',
            oldest: null,
          });
          return;
        }
        if (!sealed) {
          sealed = await options.cleanup.quarantine();
          if (!sealed) throw new AuthenticationCryptoUnavailable();
        }
        if (codeMismatch) return;
        codeMismatch = true;
        try {
          await options.monitor.record({
            operation: 'deletion',
            code: 'QUARANTINED',
            oldest: null,
          });
        } catch {
          /* 封鎖が確認済みなら監視障害でその状態を取り消さない。 */
        }
      },
    };
    try {
      validatedOperationId = uuid(operationId);
      const head = await reconciledHead();
      const intent = options.ledger.intent(head, operationId);
      if (intent === null) {
        const pending = await options.keys.pendingActorDeletions(2, {
          operationId,
        });
        if (pending.some((ticket) => ticket.operationId !== operationId))
          throw new AuthenticationCryptoUnavailable();
        if (pending.length > 0) {
          if (!(await options.cleanup.quarantine()))
            throw new AuthenticationCryptoUnavailable();
          await options.monitor.record({
            operation: 'deletion',
            code: 'QUARANTINED',
            oldest: null,
          });
          return { status: 'quarantined', operationId };
        }
        return { status: 'pending', operationId };
      }
      const record = options.ledger.resolve(intent);
      deadlineApplies = record.state === 'prepared';
      window = {
        dueAt: record.preparedAt,
        deadline: record.preparedAt + 86_400_000,
      };
      await enforceDeadline();
      const existingTicket = await options.keys.find(
        operationId,
        record.targetReference,
      );
      if (
        existingTicket === null ||
        existingTicket.operationId !== operationId ||
        existingTicket.reference !== record.targetReference ||
        existingTicket.window.dueAt !== window.dueAt ||
        existingTicket.window.deadline !== window.deadline
      )
        return await quarantineIntegrity();
      const identityScopes = (await options.keys.scopes(existingTicket)).filter(
        (scope) => scope.recordKind === 'google-identity',
      );
      if (
        identityScopes.length !== 1 ||
        !equal(
          await options.deletedActor(
            identityScopes[0].keyScopeId,
            record.actorDigestKeyVersion,
          ),
          record.actorDigest,
        )
      )
        return await quarantineIntegrity();
      const related = await options.keys.pendingActorDeletions(2, {
        actorId: identityScopes[0].keyScopeId,
      });
      if (
        related.some(
          (ticket) =>
            ticket.operationId !== operationId ||
            ticket.reference !== record.targetReference,
        )
      ) {
        if (!(await options.cleanup.quarantine()))
          throw new AuthenticationCryptoUnavailable();
        await options.monitor.record({
          operation: 'deletion',
          code: 'QUARANTINED',
          oldest: null,
        });
        return { status: 'quarantined', operationId };
      }
      const codeInput = {
        operationId,
        actorId: identityScopes[0].keyScopeId,
        preparedAt: record.preparedAt,
      };
      await options.recipientCodes?.register(codeInput, codeObserver);
      const disabled = await options.database.disable(intent);
      assertRecipientCodeParticipation(disabled.recipientCodesProvisioned);
      const ticket = disabled.ticket;
      if (
        ticket.operationId !== operationId ||
        ticket.reference !== record.targetReference ||
        ticket.window.dueAt !== window.dueAt ||
        ticket.window.deadline !== window.deadline ||
        disabled.actorId !== identityScopes[0].keyScopeId
      )
        return await quarantineIntegrity();
      if (!(await options.database.remove(intent, disabled)))
        throw new AuthenticationCryptoUnavailable();
      const scopes = (await options.keys.scopes(ticket)).map((scope) =>
        Object.freeze({ ...scope }),
      );
      if (
        scopes.length === 0 ||
        !scopes.some(
          (scope) =>
            scope.recordKind === 'google-identity' &&
            scope.keyScopeId === disabled.actorId,
        )
      )
        return await quarantineIntegrity();
      if (!(await options.cleanup.absent(scopes)))
        throw new AuthenticationCryptoUnavailable();
      const proof = await options.keys.destroy(ticket);
      if (
        !(await options.keys.verify(proof, ticket)) ||
        !(await options.cleanup.absent(scopes))
      )
        throw new AuthenticationCryptoUnavailable();
      await options.recipientCodes?.finish(codeInput, codeObserver);
      let latest = await options.ledger.latest();
      let complete = options.ledger.intent(latest, operationId);
      if (complete === null) throw new AuthenticationCryptoUnavailable();
      const current = options.ledger.resolve(complete);
      if (current.state === 'prepared') {
        latest = await options.ledger.append(latest, {
          ...current,
          state: 'complete',
          version: current.version + 1,
        });
        complete = options.ledger.intent(latest, operationId);
      }
      if (
        complete === null ||
        options.ledger.resolve(complete).state !== 'complete' ||
        !(await options.database.complete(complete))
      )
        throw new AuthenticationCryptoUnavailable();
      await enforceDeadline();
      // 確定した不一致は再開で再観測できないので、durableな封鎖からも成功を止める。
      if (
        missed ||
        codeMismatch ||
        (options.recipientCodes !== undefined && disabled.keyStateQuarantined)
      )
        return { status: 'quarantined', operationId };
      await options.monitor.record({
        operation: 'deletion',
        code: 'OK',
        oldest: null,
      });
      return { status: 'complete', operationId };
    } catch (error) {
      try {
        await enforceDeadline();
      } catch {
        /* 既知の期限未達は途中障害でも封鎖を試みる。 */
      }
      if (error instanceof DeletionQuarantined)
        return { status: 'quarantined', operationId };
      try {
        await options.monitor.record({
          operation: 'deletion',
          code: 'UNAVAILABLE',
          oldest: null,
        });
      } catch {
        /* 成功に変換しない。 */
      }
      return { status: 'unavailable', operationId: validatedOperationId };
    }
  };
  return {
    /**
     * 外部の不可逆意思を同operationで再照合し途中から再開する。
     * @param operationId 外部Preparedと同じServer生成UUIDv4。
     * @returns 全鍵/0-row/両外部証跡を確認した結果。障害を取消と扱わない。
     */
    resume,
    /**
     * 将来の退会業務が受付判断を済ませた後だけ使う内部入口。
     * @param actorId Serverが選択した本人性。HTTPの自己申告を直接接続しない。
     * @returns 結果不明も含む再開operation。退会受付や本番開通は別Gate。
     */
    async begin(actorId: string): Promise<AuthenticationDeletionResult> {
      let operationId: string | null = null;
      let window: AuthenticationRetentionWindow | null = null;
      try {
        uuid(actorId);
        const head = await reconciledHead();
        const matches: string[] = [];
        for (const intent of options.ledger.intents(head)) {
          const record = options.ledger.resolve(intent);
          const digest = await options.deletedActor(
            actorId,
            record.actorDigestKeyVersion,
          );
          if (equal(digest, record.actorDigest))
            matches.push(record.operationId);
        }
        if (matches.length > 1) {
          if (!(await options.cleanup.quarantine()))
            throw new AuthenticationCryptoUnavailable();
          await options.monitor.record({
            operation: 'deletion',
            code: 'QUARANTINED',
            oldest: null,
          });
          return { status: 'quarantined', operationId };
        }
        const pending = await options.keys.pendingActorDeletions(2, {
          actorId,
        });
        if (
          pending.length > 0 &&
          (matches.length !== 1 ||
            pending.some((ticket) => {
              const known = options.ledger.intent(head, ticket.operationId);
              return (
                ticket.operationId !== matches[0] ||
                known === null ||
                options.ledger.resolve(known).targetReference !==
                  ticket.reference
              );
            }))
        ) {
          for (const ticket of pending) {
            uuid(ticket.operationId);
            if (
              !(await options.keys.scopes(ticket)).some(
                (scope) =>
                  scope.recordKind === 'google-identity' &&
                  scope.keyScopeId === actorId,
              )
            )
              throw new AuthenticationCryptoUnavailable();
          }
          operationId = pending.length === 1 ? pending[0].operationId : null;
          if (!(await options.cleanup.quarantine()))
            throw new AuthenticationCryptoUnavailable();
          await options.monitor.record({
            operation: 'deletion',
            code: 'QUARANTINED',
            oldest: null,
          });
          return { status: 'quarantined', operationId };
        }
        if (matches.length === 1) return resume(matches[0]);
        operationId = uuid(options.newOperationId());
        const plan = await options.database.plan(actorId);
        assertRecipientCodeParticipation(plan.recipientCodesProvisioned);
        const preparedAt = options.clock.now();
        window = { dueAt: preparedAt, deadline: preparedAt + 86_400_000 };
        authenticationRetentionState(window, preparedAt);
        const ticket = await options.keys.prepare(
          operationId,
          [
            {
              recordKind: 'google-identity',
              keyScopeId: actorId,
            },
          ],
          window,
        );
        if (
          ticket.operationId !== operationId ||
          ticket.window.dueAt !== preparedAt ||
          ticket.window.deadline !== window.deadline ||
          !/^[A-Za-z0-9._:-]{1,256}$/.test(ticket.reference)
        )
          throw new AuthenticationCryptoUnavailable();
        const scopes = await options.keys.scopes(ticket);
        if (
          scopes.length !== 1 ||
          scopes[0].recordKind !== 'google-identity' ||
          scopes[0].keyScopeId !== actorId
        )
          throw new AuthenticationCryptoUnavailable();
        await options.ledger.append(head, {
          kind: 'actor-deletion',
          operationId,
          actorDigestKeyVersion: plan.keyVersion,
          actorDigest: Uint8Array.from(plan.digest),
          preparedAt,
          version: 1,
          state: 'prepared',
          targetReference: ticket.reference,
        });
        return resume(operationId);
      } catch (error) {
        try {
          if (
            window !== null &&
            authenticationRetentionState(window, options.clock.now()) ===
              'overdue'
          ) {
            if (!(await options.cleanup.quarantine()))
              throw new AuthenticationCryptoUnavailable();
            await options.monitor.record({
              operation: 'deletion',
              code: 'OVERDUE',
              oldest: window,
            });
          }
        } catch {
          /* append結果不明でも既知の期限未達を放置しない。 */
        }
        if (error instanceof DeletionQuarantined)
          return { status: 'quarantined', operationId };
        try {
          await options.monitor.record({
            operation: 'deletion',
            code: 'UNAVAILABLE',
            oldest: null,
          });
        } catch {
          /* 受付失敗を断定しない。 */
        }
        return { status: 'unavailable', operationId };
      }
    },
  };
};
