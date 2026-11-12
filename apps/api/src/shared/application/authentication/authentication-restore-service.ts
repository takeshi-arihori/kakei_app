import type {
  AuthenticationConsistencyEvidence,
  AuthenticationConsistencyEvidencePort,
  AuthenticationRestoreEvidenceDigest,
} from './authentication-consistency-evidence.js';
import type {
  AuthenticationCleanupDatabase,
  AuthenticationDeletionDatabase,
  AuthenticationRestoreDatabase,
} from './authentication-maintenance-database.js';
import type {
  AuthenticationBackupManifest,
  AuthenticationDestructionTicket,
  AuthenticationKeyDestructionPort,
  AuthenticationLedgerEvidence,
  AuthenticationMaintenanceMonitor,
  AuthenticationRestoreFence,
  AuthenticationVerifiedHead,
  AuthenticationActorDeletionCursor,
} from './authentication-maintenance-ports.js';
import { authenticationRecoveryPointSchemaVersion } from './authentication-maintenance-ports.js';
import type { AuthenticationClock } from './authentication-ports.js';
import { AuthenticationCryptoUnavailable } from './authentication-record-protection.js';
import { assertAuthenticationBackupAge } from './authentication-retention-policy.js';
import type { AuthenticationRestoreControl } from './authentication-restore-control.js';

/** 隔離を維持した復旧の結果。本番Provider実証とは区別する。 */
export interface AuthenticationRestoreResult {
  /** 全検査と開通CAS成功、隔離済み、または隔離結果も確認できない状態。 */
  readonly status: 'complete' | 'quarantined' | 'unavailable';
}

const uuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 証跡同士の復旧点、Context集合、consistencyDigestが一致するか。 */
const sameEvidence = (
  left: AuthenticationConsistencyEvidence,
  right: AuthenticationConsistencyEvidence,
) =>
  left.recoveryPointId === right.recoveryPointId &&
  left.contexts.length === right.contexts.length &&
  left.contexts.every((name) => right.contexts.includes(name)) &&
  left.consistencyDigest.length === right.consistencyDigest.length &&
  left.consistencyDigest.every(
    (value, index) => value === right.consistencyDigest[index],
  );

/**
 * Traffic/Writer閉鎖から最新削除意思、全Credential破棄、鍵更新、開通まで調整する。
 * @param options 外部独立制御と認証専用DB/証跡/全鍵管理の能力。
 * @returns 実Backup差戻しや本番配置を代行しない復旧Use Case。
 */
export const createAuthenticationRestoreService = (
  options: Readonly<{
    /** DB Backupで巻き戻らない所有fence/epoch/Nonce制御。 */
    control: AuthenticationRestoreControl;
    /** 隔離専用の全破棄、Identity移行、開通CAS。 */
    database: AuthenticationRestoreDatabase;
    /** DBにしかないIntentを検出する照合能力。 */
    deletion: AuthenticationDeletionDatabase;
    /** scopeの新Transaction 0-rowとDB拒否状態への移行。 */
    cleanup: AuthenticationCleanupDatabase;
    /** MAC/chain/最新Checkpoint/Witnessを検証する能力。 */
    ledger: AuthenticationLedgerEvidence;
    /** 全KeyVersionとdurableな未完了Credential ticket。 */
    keys: AuthenticationKeyDestructionPort;
    /** Backup35日境界と復旧checkpoint UTC。 */
    clock: AuthenticationClock;
    /** ID/秘密/自由文を受け取らない監視。 */
    monitor: AuthenticationMaintenanceMonitor;
    /** recovery checkpointへappendする`evidenceDigest`の固定書式。 */
    evidenceDigest: AuthenticationRestoreEvidenceDigest;
    /** Manifestの受理版の明示allowlist。既定は6だけ。 */
    acceptedSchemaVersions?: readonly number[];
    /** 全Context整合証跡を必須にするManifestの最小版。既定は11。 */
    consistencyRequiredFrom?: number;
    /** 全Context整合証跡。未注入で証跡が必要な版は開通せず隔離する。 */
    consistency?: Readonly<{
      /** 証跡Adapterのregistryが発行・単回消費するPort。 */
      evidence: AuthenticationConsistencyEvidencePort;
      /** Compositionが設定する必須Context名の閉じた集合。空は不可。 */
      requiredContexts: readonly string[];
    }>;
  }>,
) => {
  const fail = (): never => {
    throw new AuthenticationCryptoUnavailable();
  };
  const acceptedSchemaVersions = new Set(options.acceptedSchemaVersions ?? [6]);
  const consistencyRequiredFrom =
    options.consistencyRequiredFrom ?? authenticationRecoveryPointSchemaVersion;
  /**
   * 受理版と`recoveryPointId`の版規則を確認し、証跡が必要なら要求条件を返す。
   * 不可逆な操作の前（isolate前）に呼ぶ。
   */
  const consistencyRequirement = (manifest: AuthenticationBackupManifest) => {
    const version = manifest.schemaVersion;
    if (!Number.isSafeInteger(version) || !acceptedSchemaVersions.has(version))
      return fail();
    const present = Object.prototype.hasOwnProperty.call(
      manifest,
      'recoveryPointId',
    );
    if (present !== version >= authenticationRecoveryPointSchemaVersion)
      return fail();
    if (version < consistencyRequiredFrom) return null;
    const consistency = options.consistency ?? fail();
    const required = new Set(consistency.requiredContexts);
    if (
      required.size === 0 ||
      required.size !== consistency.requiredContexts.length ||
      typeof manifest.recoveryPointId !== 'string' ||
      !uuidV4.test(manifest.recoveryPointId)
    )
      return fail();
    return {
      evidence: consistency.evidence,
      required,
      recoveryPointId: manifest.recoveryPointId,
    };
  };
  type ConsistencyRequirement = Exclude<
    ReturnType<typeof consistencyRequirement>,
    null
  >;
  /** P1〜P3: 毎回新しいhandleを発行させ、同じbindingで単回消費する。 */
  const prove = async (
    requirement: ConsistencyRequirement,
    runId: string,
    head: AuthenticationVerifiedHead,
  ): Promise<AuthenticationConsistencyEvidence> => {
    const binding = {
      runId,
      recoveryPointId: requirement.recoveryPointId,
      head: options.ledger.head(head),
    };
    const evidence = requirement.evidence.consume(
      await requirement.evidence.verify(binding),
      binding,
    );
    const contexts = [...evidence.contexts];
    if (
      evidence.recoveryPointId !== requirement.recoveryPointId ||
      !(evidence.consistencyDigest instanceof Uint8Array) ||
      evidence.consistencyDigest.length !== 32 ||
      contexts.length !== requirement.required.size ||
      new Set(contexts).size !== contexts.length ||
      contexts.some((name) => !requirement.required.has(name))
    )
      return fail();
    return Object.freeze({
      recoveryPointId: evidence.recoveryPointId,
      contexts: Object.freeze(contexts),
      consistencyDigest: Uint8Array.from(evidence.consistencyDigest),
    });
  };
  const destroy = async (ticket: AuthenticationDestructionTicket) => {
    const scopes = (await options.keys.scopes(ticket)).map((scope) =>
      Object.freeze({ ...scope }),
    );
    if (scopes.length === 0 || !(await options.cleanup.absent(scopes)))
      return fail();
    const proof = await options.keys.destroy(ticket);
    if (
      !(await options.keys.verify(proof, ticket)) ||
      !(await options.cleanup.absent(scopes))
    )
      return fail();
  };
  const applyDeletions = async (
    fence: AuthenticationRestoreFence,
    initial: AuthenticationVerifiedHead,
  ): Promise<AuthenticationVerifiedHead> => {
    let head = initial;
    if (
      !(await options.deletion.reconcileIntents(options.ledger.intents(head)))
    )
      return fail();
    for (const intent of options.ledger.intents(initial)) {
      const record = options.ledger.resolve(intent);
      await destroy(await options.database.reapplyDeletion(fence, intent));
      if (record.state === 'prepared') {
        head = await options.ledger.latest();
        const current =
          options.ledger.intent(head, record.operationId) ?? fail();
        const binding = options.ledger.resolve(current);
        if (binding.state === 'prepared') {
          head = await options.ledger.append(head, {
            ...binding,
            state: 'complete',
            version: binding.version + 1,
          });
        }
        const complete =
          options.ledger.intent(head, record.operationId) ?? fail();
        if (options.ledger.resolve(complete).state !== 'complete')
          return fail();
        await destroy(await options.database.reapplyDeletion(fence, complete));
      }
    }
    return head;
  };
  const checkActorTickets = async (head: AuthenticationVerifiedHead) => {
    let cursor: AuthenticationActorDeletionCursor | null = null;
    const cursors = new Set<AuthenticationActorDeletionCursor>();
    const operations = new Set<string>();
    for (;;) {
      const page = await options.keys.pendingActorDeletionPage(cursor, 1000);
      const tickets = page.tickets;
      if (
        !Array.isArray(page.tickets) ||
        page.tickets.length > 1000 ||
        (page.tickets.length === 0 && page.nextCursor !== null)
      )
        return fail();
      for (const ticket of tickets) {
        if (operations.has(ticket.operationId)) return fail();
        operations.add(ticket.operationId);
        const intent = options.ledger.intent(head, ticket.operationId);
        if (
          intent === null ||
          options.ledger.resolve(intent).targetReference !== ticket.reference
        )
          return fail();
      }
      if (page.nextCursor === null) return;
      if (typeof page.nextCursor !== 'object' || cursors.has(page.nextCursor))
        return fail();
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  };
  return {
    /**
     * 外部Operatorが閉鎖下で選んだBackupを検証し、同じrunで復旧を再開する。
     * @param runId Server生成UUIDv4。再試行で新しい受付へ置換しない。
     * @param manifest Backup取得時に保持した非秘密Metadata。
     * @returns 全検証/開通CAS成功、またはTrafficを許可しない失敗。
     */
    async run(
      runId: string,
      manifest: AuthenticationBackupManifest,
    ): Promise<AuthenticationRestoreResult> {
      let validRun = false;
      let fence: AuthenticationRestoreFence | null = null;
      try {
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            runId,
          )
        )
          return fail();
        validRun = true;
        fence = await options.control.close(runId);
        if (!(await options.control.verifyClosed(fence))) return fail();
        assertAuthenticationBackupAge(manifest.createdAt, options.clock.now());
        const requirement = consistencyRequirement(manifest);
        const generationVersion = await options.database.isolate(
          fence,
          manifest,
        );
        let head = await options.ledger.latest(manifest);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await checkActorTickets(head);
          // P1: 削除再適用、破棄、epoch公開は戻せないので、その前に整合を確認する。
          const p1 =
            requirement === null ? null : await prove(requirement, runId, head);
          head = await applyDeletions(fence, head);
          for (const ticket of await options.database.discardCredentials(fence))
            await destroy(ticket);
          // DB削除後に応答喪失した対象も、durableな外部情報から全部再開する。
          const seen = new Set<string>();
          for (;;) {
            const tickets = await options.keys.pendingCredentials(1000);
            if (tickets.length === 0) break;
            if (tickets.length > 1000) return fail();
            for (const ticket of tickets) {
              const id =
                ticket.operationId +
                '/' +
                ticket.reference +
                '/' +
                String(ticket.version);
              if (seen.has(id)) return fail();
              seen.add(id);
              const scopes = await options.keys.scopes(ticket);
              if (
                scopes.some((scope) => scope.recordKind === 'google-identity')
              )
                return fail();
              await destroy(ticket);
            }
          }
          await checkActorTickets(head);
          const publication = await options.control.publishEpoch(
            fence,
            manifest.epoch,
          );
          if (
            publication.runId !== runId ||
            publication.epoch === manifest.epoch ||
            !Number.isSafeInteger(publication.revision) ||
            publication.revision < 1 ||
            !(await options.control.verifyPublication(fence, publication))
          )
            return fail();
          if (
            publication.generations.find(
              (generation) =>
                generation.purpose === 'deletion-ledger-mac' &&
                generation.writeRequired,
            )?.keyVersion !== options.ledger.writeKeyVersion
          )
            return fail();
          const digest = Uint8Array.from(
            await options.database.migrateIdentity(fence, publication),
          );
          if (digest.length !== 32) return fail();
          const expected = options.ledger.head(head);
          // P2: append直前のheadで再検証し、P1から変化していれば開通しない。
          const p2 =
            requirement === null ? null : await prove(requirement, runId, head);
          if (p1 !== null && (p2 === null || !sameEvidence(p1, p2)))
            return fail();
          const evidenceDigest = Uint8Array.from(
            options.evidenceDigest.digest({
              fingerprint: digest,
              codeClosure: null,
              consistency: p2,
            }),
          );
          if (evidenceDigest.length !== 32) return fail();
          const refreshed = await options.ledger.latest(manifest);
          const fresh = options.ledger.head(refreshed);
          if (
            fresh.sequence !== expected.sequence ||
            fresh.hash !== expected.hash
          ) {
            head = refreshed;
            continue;
          }
          head = await options.ledger.append(refreshed, {
            kind: 'recovery',
            operationId: runId,
            epoch: publication.epoch,
            completedAt: options.clock.now(),
            evidenceDigest,
          });
          if (options.ledger.head(head).sequence !== expected.sequence + 1)
            continue;
          // P3: append済みのentryは開通の証拠でない。activate前に不変を確認する。
          if (p2 !== null) {
            const p3 = await prove(requirement ?? fail(), runId, head);
            if (!sameEvidence(p2, p3)) return fail();
          }
          if (
            !(await options.control.verifyClosed(fence)) ||
            !(await options.control.verifyPublication(fence, publication)) ||
            !(await options.database.activate(
              fence,
              generationVersion,
              publication.epoch,
            ))
          )
            return fail();
          if (
            !(await options.control.open(
              fence,
              publication,
              options.ledger.head(head),
              evidenceDigest,
            ))
          )
            return fail();
          await options.monitor.record({
            operation: 'restore',
            code: 'OK',
            oldest: null,
          });
          return { status: 'complete' };
        }
        return fail();
      } catch {
        let closed = false;
        if (validRun) {
          try {
            fence = await options.control.close(runId);
          } catch {
            /* 開通応答喪失も同runで再閉鎖する。 */
          }
          if (fence !== null) {
            try {
              closed = await options.control.verifyClosed(fence);
            } catch {
              /* 外部閉鎖の未確認を隠さない。 */
            }
          }
        }
        let quarantined = false;
        try {
          quarantined = (await options.cleanup.quarantine()) && closed;
        } catch {
          /* DBの拒否状態を確認できない。 */
        }
        try {
          await options.monitor.record({
            operation: 'restore',
            code: quarantined ? 'QUARANTINED' : 'UNAVAILABLE',
            oldest: null,
          });
        } catch {
          /* 監視失敗を開通に変換しない。 */
        }
        return { status: quarantined ? 'quarantined' : 'unavailable' };
      }
    },
  };
};
