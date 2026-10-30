import type { QueryResultRow } from 'pg';
import type { AuthenticationTransactionScope } from '../../../shared/application/authentication/authentication-transaction-scope.js';
import type { AuthenticationTransactionParticipants } from '../../../shared/infrastructure/authentication/postgres/authentication-transaction-scopes.js';
import type { RecipientCodeTransactionScopes } from '../../../shared/infrastructure/authentication/postgres/recipient-code-transaction-scopes.js';
import { authenticationObject } from '../../../shared/infrastructure/authentication/canonical-authentication.js';
import { actorAccessIndexDigestInput } from '../../application/group-access-policy.js';
import { CommandFingerprint } from '../../application/group-repository.js';
import type {
  RecipientInvitationRepository,
  RecipientInvitationCommitPlan,
} from '../../application/recipient-invitation-repository.js';
import { ActorSubject, GroupId, UtcInstant } from '../../domain/group.js';
import {
  PostgresGroupCommitKernel,
  type GroupCommitKernelOptions,
} from './group-commit-kernel.js';
import {
  decodeStoredGroupOperation,
  encodeStoredGroupOperation,
} from './group-operation-record.js';
import {
  decodeGroupRecordPayload,
  encodeGroupRecordPayload,
} from './group-record-payload.js';
import type { PostgresGroupInvitationAuditWriter } from './group-invitation-audit-writer.js';
import type { GroupSqlQuery } from './group-storage-contracts.js';

/** 借用Scopeの不正/認可/保存/Audit障害を詳細非開示にする固定Error。 */
export class EnlistedGroupStorageUnavailable extends Error {
  /** 元例外・SQL・IDをcauseへ保持しない。 */
  constructor() {
    super('Enlisted Group storage unavailable');
    this.name = 'EnlistedGroupStorageUnavailable';
  }
}
/** Application参加契約とGM内部の保守診断。鍵破棄/Pool/Transaction制御を公開しない。 */
export interface EnlistedGroupRepository extends RecipientInvitationRepository {
  /**
   * @param scope 同registryの準備済みScope。
   * @param keyVersion 参照する保存proof世代。
   * @returns live参照件数。0件でも関連Backup35日closureなしに破棄してはならない。
   * @throws EnlistedGroupStorageUnavailable Scope/復号/保存障害。破損をskipしない。
   */
  countProofReferences(
    scope: AuthenticationTransactionScope,
    keyVersion: string,
  ): Promise<number>;
}
/** GM登録関数と必要な保存能力だけ。owner registry/Poolは受けない。 */
export interface EnlistedGroupRepositoryOptions extends GroupCommitKernelOptions {
  /** Compositionが一度だけ実GMへ渡す登録関数。返却能力はquery/attestだけ。 */ readonly registerGroupParticipant: RecipientCodeTransactionScopes['registerGroupParticipant'];
  /** 同ScopeのGM Audit成功前にattestしない。 */ readonly auditWriter: Pick<
    PostgresGroupInvitationAuditWriter,
    'write'
  >;
  /** 入力を持たない固定障害通知。 */ readonly onUnavailable?: () => void;
}
type Frame = {
  locatorVersion: string | null;
  proofVersion: string | null;
  lastGroupId: string | null;
  loaded: Map<
    string,
    { actor: ActorSubject; version: number; payload: Uint8Array }
  >;
};
const fail = (): never => {
  throw new EnlistedGroupStorageUnavailable();
};
const validVersion = (value: unknown): number => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return fail();
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : fail();
};
const database = (
  scope: AuthenticationTransactionScope,
  participant: AuthenticationTransactionParticipants,
): GroupSqlQuery =>
  Object.freeze({
    async query<Row extends QueryResultRow>(
      sql: string,
      values?: readonly unknown[],
    ) {
      const result = await participant.query(scope, sql, values);
      return result as import('pg').QueryResult<Row>;
    },
  });

/**
 * #239の実registryへGM準備を登録し、#241のPortを同一接続の保存へ適合する。
 * @param options 登録関数/暗号/既存Writer/Auditの限定能力。余分なowner能力を捕捉しない。
 * @returns query/attest/Pool/Transaction制御を持たないApplication向け参加Adapter。
 * @throws Error 二重登録/lease開始後の登録。Compositionは起動前に一度だけ登録する。
 */
export const createEnlistedGroupRepository = (
  options: EnlistedGroupRepositoryOptions,
): EnlistedGroupRepository => {
  const {
    registerGroupParticipant,
    stateWriter,
    codec,
    encodeAad,
    locatorKeys,
    accessIndexDigests,
    nextRecordId,
    now,
    auditWriter,
    onUnavailable,
  } = options;
  const kernel = new PostgresGroupCommitKernel({
    stateWriter,
    codec,
    encodeAad,
    locatorKeys,
    accessIndexDigests,
    nextRecordId,
    now,
  });
  const frames = new WeakMap<AuthenticationTransactionScope, Frame>();
  const frameFor = (scope: AuthenticationTransactionScope): Frame =>
    frames.get(scope) ?? fail();
  const report = (): never => {
    try {
      onUnavailable?.();
    } catch {
      /* 固定通知障害も元例外を露出させない。 */
    }
    return fail();
  };
  const safe = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch {
      return report();
    }
  };
  const participant = registerGroupParticipant({
    async prepare(scope, query) {
      const db = database(scope, query);
      const locatorVersion = await kernel.prepare(db);
      const result = await db.query<{ current_key_version: string | null }>(
        'SELECT current_key_version FROM group_recipient_code_proof_key_state WHERE id = 1 FOR SHARE',
      );
      if (result.rowCount !== 1 || result.rows[0] === undefined) return fail();
      const proofVersion = result.rows[0].current_key_version;
      if (
        proofVersion !== null &&
        (typeof proofVersion !== 'string' ||
          proofVersion.length > 255 ||
          !/^[A-Za-z0-9._:-]+$/.test(proofVersion))
      )
        return fail();
      frames.set(scope, {
        locatorVersion,
        proofVersion,
        lastGroupId: null,
        loaded: new Map(),
      });
    },
  });
  return Object.freeze({
    findOperation: (scope, actor, operationId) =>
      safe(async () => {
        frameFor(scope);
        return await kernel
          .reader(database(scope, participant))
          .findStoredOperation(actor, operationId);
      }),
    currentProofKeyVersion: (scope) =>
      safe(async () => {
        const frame = frameFor(scope);
        // 保存値を返すだけでも受付終了/別registryを拒否する。key-stateへ後付けLockは取らない。
        await participant.query(scope, 'SELECT 1');
        return frame.proofVersion ?? fail();
      }),
    loadForInvitation: (scope, groupId, actor) =>
      safe(async () => {
        const frame = frameFor(scope);
        if (
          !(groupId instanceof GroupId) ||
          !(actor instanceof ActorSubject) ||
          (frame.lastGroupId !== null && frame.lastGroupId > groupId.value)
        )
          return fail();
        const db = database(scope, participant);
        const digest = await accessIndexDigests.digest(
          actorAccessIndexDigestInput(groupId, actor),
        );
        if (
          !(digest.digest instanceof Uint8Array) ||
          digest.digest.length === 0 ||
          !/^[A-Za-z0-9._:-]+$/.test(digest.digestKeyVersion)
        )
          return fail();
        const values = [
          groupId.value,
          Buffer.from(digest.digest),
          digest.digestKeyVersion,
        ];
        const sql =
          'SELECT 1 FROM group_actor_access_index WHERE group_id = $1 AND actor_digest = $2 AND digest_key_version = $3';
        if ((await db.query(sql, values)).rowCount !== 1) return null;
        const locked = await db.query<{
          aggregate_version: string;
          access_policy_version: string;
        }>(
          'SELECT aggregate_version, access_policy_version FROM group_aggregate_record WHERE group_id = $1 FOR UPDATE',
          [groupId.value],
        );
        frame.lastGroupId = groupId.value;
        if (locked.rowCount !== 1 || locked.rows[0] === undefined) return null;
        // Lock待機中に在籍が外れたActorへGroup復号能力を与えない。
        if ((await db.query(sql, values)).rowCount !== 1) return null;
        const loaded = await kernel.reader(db).load(groupId);
        if (
          loaded === null ||
          loaded.version !== validVersion(locked.rows[0].aggregate_version) ||
          loaded.group.accessPolicyVersion !==
            validVersion(locked.rows[0].access_policy_version)
        )
          return fail();
        if (!loaded.group.participants.some((p) => p.subject.equals(actor)))
          return null;
        const snapshot = Object.freeze({
          group: loaded.group,
          version: loaded.version,
        });
        // 呼出し側のGroupは実行時に書換え可能。認可済みRootは独立した非公開byteで保持する。
        frame.loaded.set(groupId.value, {
          actor,
          version: loaded.version,
          payload: encodeGroupRecordPayload(loaded.group),
        });
        return snapshot;
      }),
    stage: (scope, handle, plan) =>
      safe(async () => {
        const frame = frameFor(scope);
        // 最初のawaitより前に入力本文/配列/VOを固定する。
        const operation = decodeStoredGroupOperation(
          encodeStoredGroupOperation(plan.operation),
        );
        if (
          operation.fingerprint instanceof CommandFingerprint ||
          !('binding' in operation)
        )
          return fail();
        const operationGroup = operation.result.groupId;
        const fixed = frame.loaded.get(operationGroup.value);
        const change = plan.invitationChanges[0];
        if (
          fixed === undefined ||
          !fixed.actor.equals(operation.actorSubject) ||
          plan.expectedVersion !== fixed.version ||
          operation.fingerprint.expectedVersion !== fixed.version ||
          operation.fingerprint.proof.keyVersion !== frame.proofVersion ||
          plan.stateChanged !== true ||
          !Array.isArray(plan.membershipChanges) ||
          plan.membershipChanges.length !== 0 ||
          !Array.isArray(plan.groupCloseChanges) ||
          plan.groupCloseChanges.length !== 0 ||
          !Array.isArray(plan.invitationChanges) ||
          plan.invitationChanges.length !== 1
        )
          return fail();
        if (
          change === undefined ||
          change.kind !== 'Created' ||
          !change.invitationId.equals(operation.result.invitationId) ||
          change.targetSubject.value !== operation.binding.recipientActorId
        )
          return fail();
        const createdAt = UtcInstant.from(new Date(change.createdAt.value));
        const expected = decodeGroupRecordPayload(
          fixed.payload,
        ).inviteParticipant({
          actorSubject: operation.actorSubject,
          targetSubject: ActorSubject.from(operation.binding.recipientActorId),
          invitationId: operation.result.invitationId,
          createdAt,
        });
        if (
          !Buffer.from(encodeGroupRecordPayload(expected.group)).equals(
            encodeGroupRecordPayload(plan.group),
          ) ||
          !change.issuerParticipantId.equals(
            expected.invitation.issuerParticipantId,
          ) ||
          change.expiryAt.value !== expected.invitation.expiryAt.value
        )
          return fail();
        const value = plan.value;
        const descriptor = Object.getOwnPropertyDescriptor(value, 'body');
        if (
          descriptor === undefined ||
          !('value' in descriptor) ||
          typeof descriptor.value !== 'string'
        )
          return fail();
        const result = authenticationObject(
          JSON.parse(descriptor.value) as unknown,
          ['kind', 'groupId', 'version', 'invitationId'],
        );
        if (
          result.kind !== 'InvitationCreated' ||
          result.groupId !== operationGroup.value ||
          result.version !== fixed.version + 1 ||
          result.invitationId !== operation.result.invitationId.value
        )
          return fail();
        const snapshot: RecipientInvitationCommitPlan = {
          group: expected.group,
          expectedVersion: fixed.version,
          stateChanged: true,
          membershipChanges: [],
          invitationChanges: [
            {
              kind: 'Created',
              invitationId: expected.invitation.id,
              targetSubject: expected.invitation.targetSubject,
              issuerParticipantId: expected.invitation.issuerParticipantId,
              createdAt: expected.invitation.createdAt,
              expiryAt: expected.invitation.expiryAt,
            },
          ],
          groupCloseChanges: [],
          operation,
          value,
        };
        const db = database(scope, participant);
        const binding = Object.freeze({
          codeId: operation.binding.codeId,
          recipientActorId: operation.binding.recipientActorId,
          operationId: operation.operationId.value,
          value,
        });
        // caller-only/偽handle/再受付を、非SQL障害で部分writeが残り得る段階より前に拒否する。
        participant.beginPlan(scope, handle, binding);
        const saved = await kernel.stage(db, snapshot, frame.locatorVersion);
        if (
          saved.kind !== 'Staged' ||
          saved.result.kind !== 'InvitationCreated' ||
          saved.result.version !== operation.result.version ||
          !saved.result.invitationId.equals(operation.result.invitationId)
        )
          return fail();
        await auditWriter.write(
          db,
          operation,
          expected.group.accessPolicyVersion,
        );
        return participant.attest(scope, handle, binding);
      }),
    countProofReferences: (scope, keyVersion) =>
      safe(async () => {
        frameFor(scope);
        return await kernel
          .reader(database(scope, participant))
          .countProofReferences(keyVersion);
      }),
  } satisfies EnlistedGroupRepository);
};
