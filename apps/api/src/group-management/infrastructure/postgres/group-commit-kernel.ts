import { randomUUID } from 'node:crypto';
import { importPurposeSeparatedDigest } from '../../../shared/application/purpose-separated-digest.js';
import type {
  ProtectedRecordCodec,
  ProtectedRecordHeader,
} from '../../../shared/infrastructure/protected-record/index.js';
import {
  operationLocatorDigestInput,
  operationFingerprintDigestInput,
  type GroupOperationLocatorKeyPort,
  type GroupPolicyDigestPort,
} from '../../application/group-access-policy.js';
import {
  CommandFingerprint,
  type CommitGroupRequest,
  type CommitGroupOutcome,
  type GroupCommandResult,
} from '../../application/group-repository.js';
import type { RecipientInvitationCommitPlan } from '../../application/recipient-invitation-repository.js';
import { PostgresGroupReadRepository } from './group-read-repository.js';
import {
  encodeStoredGroupOperation,
  type StoredGroupOperation,
} from './group-operation-record.js';
import type { PostgresGroupStateWriter } from './group-state-writer.js';
import type {
  GroupSqlQuery,
  GroupStateWritePlan,
} from './group-storage-contracts.js';

/** 保存共通処理の依存。Transaction owner能力を含めない。 */
export interface GroupCommitKernelOptions {
  /** CAS/現在行/不変履歴/索引の唯一の既存Writer。 */ readonly stateWriter: Pick<
    PostgresGroupStateWriter,
    'persist'
  >;
  /** GM-owned期待Headerで既存AEADを使用する。 */ readonly codec: Pick<
    ProtectedRecordCodec,
    'seal' | 'open'
  >;
  /** 既存Envelopeのcanonical AAD。 */ readonly encodeAad: (
    header: ProtectedRecordHeader,
  ) => Uint8Array;
  /** Actor内共通locatorの現行/保持世代。 */ readonly locatorKeys: GroupOperationLocatorKeyPort;
  /** 既存用途別索引/fingerprint。 */ readonly accessIndexDigests: GroupPolicyDigestPort;
  /** 合成Testでは固定できるServer UUID生成。 */ readonly nextRecordId?: () => string;
  /** 合成Testでは固定できるUTC保存時刻。 */ readonly now?: () => Date;
}

/** kernelは確定commitを返さず、ownerに全rollback/確定を委ねる。 */
export type GroupKernelOutcome =
  | {
      /** このTransaction内だけで保存された。 */ readonly kind: 'Staged';
      /** 保存した版の最小結果。 */ readonly result: GroupCommandResult;
    }
  | {
      /** 保存せず既存成功を発見した。新規消費証跡にしない。 */ readonly kind: 'Replayed';
      /** 元の保存結果。 */ readonly result: GroupCommandResult;
    }
  | Exclude<CommitGroupOutcome, { kind: 'Committed' }>
  | {
      /** 先行writeを全rollbackした後だけ勝者を照会できる。 */ readonly kind: 'LocatorConflict';
    };

const keyPattern = /^[A-Za-z0-9._:-]+$/;
const validDigest = (v: { digest: Uint8Array; digestKeyVersion: string }) =>
  v.digest instanceof Uint8Array &&
  v.digest.length > 0 &&
  keyPattern.test(v.digestKeyVersion);

/** Transaction所有を外へ分離した、新旧GM Commandの唯一の保存kernel。 */
export class PostgresGroupCommitKernel {
  private readonly options: GroupCommitKernelOptions;
  /**
   * @param options 既存State Writer/暗号/locatorの能力。Poolは受けない。
   */
  constructor(options: GroupCommitKernelOptions) {
    // ownerのoptions Object/余分なPool能力を保持せず、必要な依存だけを固定する。
    const {
      stateWriter,
      codec,
      encodeAad,
      locatorKeys,
      accessIndexDigests,
      nextRecordId,
      now,
    } = options;
    this.options = Object.freeze({
      stateWriter,
      codec,
      encodeAad,
      locatorKeys,
      accessIndexDigests,
      nextRecordId,
      now,
    });
  }

  /**
   * Group/Actorより先に既存locator key-stateを固定する。
   * @param query 同じTransactionのquery限定能力。
   * @returns 固定した現行世代。nullでも保持済み成功の読取は可能。
   * @throws Error 行不在/不正世代/SQL障害。
   */
  async prepare(query: GroupSqlQuery): Promise<string | null> {
    const result = await query.query<{ current_key_version: string | null }>(
      'SELECT current_key_version FROM group_operation_locator_key_state WHERE id = 1 FOR SHARE',
    );
    if (result.rowCount !== 1 || result.rows[0] === undefined)
      throw new Error('Group storage unavailable');
    const version = result.rows[0].current_key_version;
    if (
      version !== null &&
      (typeof version !== 'string' || !keyPattern.test(version))
    )
      throw new Error('Group storage unavailable');
    return version;
  }

  /**
   * 既存codec/同じlocatorを使う読取を組み立てる。
   * @param query 借用接続。Poolを取得しない。
   * @param locatorKeys Transaction内で固定した候補。通常読取は既存Portを使う。
   * @returns 結果行をFOR SHAREする共通Reader。
   */
  reader(
    query: GroupSqlQuery,
    locatorKeys = this.options.locatorKeys,
  ): PostgresGroupReadRepository {
    return new PostgresGroupReadRepository({
      database: query,
      codec: this.options.codec,
      encodeAad: this.options.encodeAad,
      locatorKeys,
      operationLock: 'ForShare',
    });
  }

  /**
   * 同一Transactionへ状態/履歴/operation/共通locatorをstageする。
   * @param query ownerが開始済みのquery限定能力。
   * @param request 旧Commandまたは新コード招待計画。原コードを含めない。
   * @param currentKeyVersion Group/Actorより前にprepareで固定済みのlocator世代。
   * @returns 新規stage、既存成功、または全rollbackを要する失敗。確定commitではない。
   * @throws Error 暗号/入力/SQL障害。ownerは全rollbackして元例外を公開しない。
   */
  async stage(
    query: GroupSqlQuery,
    request: CommitGroupRequest | RecipientInvitationCommitPlan,
    currentKeyVersion: string | null,
  ): Promise<GroupKernelOutcome> {
    if (currentKeyVersion === null) return { kind: 'Unavailable' };
    // Provider返却値を次のawaitより先にCopyし、保持候補と参照を共有しない。
    const current = await this.options.locatorKeys.currentDigest(
      operationLocatorDigestInput(
        request.operation.actorSubject,
        request.operation.operationId,
      ),
    );
    if (!validDigest(current)) return { kind: 'Unavailable' };
    const currentDigest = {
      digest: importPurposeSeparatedDigest(current.digest),
      digestKeyVersion: current.digestKeyVersion,
    };
    const supplied = await this.options.locatorKeys.candidateDigests(
      operationLocatorDigestInput(
        request.operation.actorSubject,
        request.operation.operationId,
      ),
    );
    const candidates = supplied.map((v) => ({
      digest: importPurposeSeparatedDigest(v.digest),
      digestKeyVersion: v.digestKeyVersion,
    }));
    if (
      currentDigest.digestKeyVersion !== currentKeyVersion ||
      candidates.length === 0 ||
      !candidates.every(validDigest) ||
      !candidates.some(
        (v) =>
          v.digestKeyVersion === currentKeyVersion &&
          Buffer.from(v.digest).equals(currentDigest.digest),
      )
    )
      return { kind: 'Unavailable' };
    const fixedKeys: GroupOperationLocatorKeyPort = {
      currentDigest: () => Promise.resolve(currentDigest),
      candidateDigests: () => Promise.resolve(candidates),
    };
    const read = this.reader(query, fixedKeys);
    const replay = async (): Promise<GroupKernelOutcome | null> => {
      const saved = await read.findStoredOperation(
        request.operation.actorSubject,
        request.operation.operationId,
      );
      if (saved === null) return null;
      const wanted = request.operation.fingerprint;
      const matches =
        saved.fingerprint instanceof CommandFingerprint
          ? wanted instanceof CommandFingerprint &&
            saved.fingerprint.equals(wanted)
          : !(wanted instanceof CommandFingerprint) &&
            Buffer.from(saved.fingerprint.canonicalInput).equals(
              Buffer.from(wanted.canonicalInput),
            );
      return matches
        ? { kind: 'Replayed', result: saved.result }
        : { kind: 'OperationMismatch' };
    };
    const existing = await replay();
    if (existing !== null) return existing;
    const closeChange = request.groupCloseChanges.find(
      (v) => v.kind === 'ClosingStarted',
    );
    const closeIntentId =
      closeChange?.kind === 'ClosingStarted'
        ? closeChange.closeIntentId
        : undefined;
    if (closeIntentId !== undefined) {
      const registered = await query.query(
        'INSERT INTO group_close_intent_registry (close_intent_id, group_id) VALUES ($1, $2) ON CONFLICT (close_intent_id) DO NOTHING RETURNING close_intent_id',
        [closeIntentId.value, request.group.id.value],
      );
      if (registered.rowCount !== 1)
        return (await replay()) ?? { kind: 'CloseIntentAlreadyExists' };
    }
    const unversioned =
      'result' in request ? request.result : request.operation.result;
    const plan: GroupStateWritePlan = { ...request, result: unversioned };
    const state = await this.options.stateWriter.persist(query, plan);
    if (state.kind !== 'Committed') return state;
    const result = {
      ...unversioned,
      version: state.version,
    } as GroupCommandResult;
    const operation: StoredGroupOperation =
      'result' in request
        ? { ...request.operation, result }
        : {
            ...request.operation,
            result: { ...request.operation.result, version: state.version },
          };
    const recordId = (this.options.nextRecordId ?? randomUUID)();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        recordId,
      )
    )
      throw new Error('Group storage unavailable');
    const suppliedAt = this.options.now?.() ?? new Date();
    if (!(suppliedAt instanceof Date) || Number.isNaN(suppliedAt.getTime()))
      throw new Error('Group storage unavailable');
    const createdAt = new Date(suppliedAt.getTime());
    const envelope = await this.options.codec.seal({
      header: {
        envelopeVersion: 1n,
        algorithmId: 'AES-256-GCM',
        app: 'kakei_app',
        contextName: 'group-management',
        recordKind: 'operation-result',
        groupId: request.group.id.value,
        logicalRecordId: recordId,
        schemaVersion: 1n,
        aggregateVersion: BigInt(state.version),
        revisionOrdinal: null,
      },
      plaintext: encodeStoredGroupOperation(operation),
    });
    await query.query(
      `INSERT INTO group_operation_result_record (logical_record_id, group_id, aggregate_version, envelope_version, algorithm_id, schema_version, key_version, ciphertext, nonce, authentication_tag, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        recordId,
        request.group.id.value,
        state.version,
        Number(envelope.header.envelopeVersion),
        envelope.header.algorithmId,
        Number(envelope.header.schemaVersion),
        envelope.header.keyVersion,
        Buffer.from(envelope.ciphertext),
        Buffer.from(envelope.nonce),
        Buffer.from(envelope.authenticationTag),
        createdAt,
      ],
    );
    const fingerprint = request.operation.fingerprint;
    const digest = await this.options.accessIndexDigests.digest(
      operationFingerprintDigestInput(
        request.group.id,
        fingerprint instanceof CommandFingerprint
          ? 'command-fingerprint'
          : 'CreateInvitationFromRecipientCode/v1',
        fingerprint instanceof CommandFingerprint
          ? fingerprint.value
          : Buffer.from(fingerprint.canonicalInput).toString('hex'),
      ),
    );
    if (!validDigest(digest)) throw new Error('Group storage unavailable');
    const locator = await query.query(
      `INSERT INTO group_operation_locator_v2 (locator_digest, digest_key_version, command_fingerprint, group_id, operation_result_record_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (locator_digest, digest_key_version) DO NOTHING RETURNING locator_digest`,
      [
        Buffer.from(currentDigest.digest),
        currentDigest.digestKeyVersion,
        Buffer.from(digest.digest),
        request.group.id.value,
        recordId,
        createdAt,
      ],
    );
    return locator.rowCount === 1
      ? { kind: 'Staged', result }
      : { kind: 'LocatorConflict' };
  }
}
