import type {
  ProtectedRecordCodec,
  ProtectedRecordHeader,
} from '../../../shared/infrastructure/protected-record/index.js';
import type { QueryResultRow } from 'pg';
import { CommandFingerprint } from '../../application/group-repository.js';
import type { GroupSqlQuery } from './group-storage-contracts.js';
import {
  decodeStoredGroupOperation,
  type StoredGroupOperation,
} from './group-operation-record.js';

import {
  operationLocatorDigestInput,
  type GroupOperationLocatorKeyPort,
} from '../../application/group-access-policy.js';
import type {
  FindOperationResult,
  LoadedGroup,
  OperationId,
} from '../../application/group-repository.js';
import type { ActorSubject, GroupId } from '../../domain/group.js';
import { decodeGroupRecordPayload } from './group-record-payload.js';

type ProtectedRow = QueryResultRow & {
  group_id: string;
  logical_record_id: string;
  aggregate_version: string;
  envelope_version: number;
  algorithm_id: string;
  schema_version: string;
  key_version: string;
  ciphertext: Buffer;
  nonce: Buffer;
  authentication_tag: Buffer;
};

type GroupRow = ProtectedRow & { access_policy_version: string };
type OperationRow = ProtectedRow & { command_fingerprint: Buffer };

export class GroupReadUnavailable extends Error {
  constructor() {
    super('Group read unavailable');
    this.name = 'GroupReadUnavailable';
  }
}

const safeVersion = (value: string | number): number => {
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(value))) {
    throw new GroupReadUnavailable();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new GroupReadUnavailable();
  }
  return parsed;
};

/**
 * standalone/参加Adapterで共用するGM読取。新旧operationは同じlocatorから復元する。
 * このModuleに保存処理や本番Key Providerを隠さない。
 */
export class PostgresGroupReadRepository {
  /**
   * @param options 借用query/既存codec/共通locatorと任意の結果行Lock。接続を所有しない。
   */
  constructor(
    private readonly options: Readonly<{
      /** ownerから借用したquery能力。 */
      database: GroupSqlQuery;
      /** 借用Transactionで結果削除と直列化する。 */
      operationLock?: 'ForShare';
      /** 期待Header照合を行う既存AEAD。 */
      codec: Pick<ProtectedRecordCodec, 'open'>;
      /** 既存Envelopeのcanonical AAD。 */
      encodeAad: (header: ProtectedRecordHeader) => Uint8Array;
      /** Actor内共通namespaceの保持候補。 */
      locatorKeys: GroupOperationLocatorKeyPort;
      /** 入力/元例外を含まない障害通知。 */
      onUnavailable?: () => void;
    }>,
  ) {}

  async load(groupId: GroupId): Promise<LoadedGroup | null> {
    try {
      const found = await this.options.database.query<GroupRow>(
        `SELECT group_id, logical_record_id, aggregate_version,
                access_policy_version, envelope_version, algorithm_id,
                schema_version, key_version, ciphertext, nonce,
                authentication_tag
           FROM group_aggregate_record WHERE group_id = $1`,
        [groupId.value],
      );
      if (found.rows.length === 0) {
        return null;
      }
      if (found.rows.length !== 1) {
        throw new GroupReadUnavailable();
      }
      const row = found.rows[0];
      if (row === undefined || row.group_id !== groupId.value) {
        throw new GroupReadUnavailable();
      }
      const version = safeVersion(row.aggregate_version);
      const plaintext = await this.open(row, 'group', groupId.value);
      const group = decodeGroupRecordPayload(plaintext);
      if (
        !group.id.equals(groupId) ||
        group.accessPolicyVersion !== safeVersion(row.access_policy_version)
      ) {
        throw new GroupReadUnavailable();
      }
      return { group, version };
    } catch {
      return this.unavailable();
    }
  }

  /**
   * 旧Commandから新actionが見つかった場合は明示Mismatchにし、保存本文を偽装しない。
   * @param actorSubject 共通namespaceのActor。
   * @param operationId 全Command/全Group共通ID。
   * @returns 旧保存成功、不在、または異actionのMismatch。
   * @throws GroupReadUnavailable 保存/復号障害。
   */
  async findOperation(
    actorSubject: ActorSubject,
    operationId: OperationId,
  ): Promise<FindOperationResult> {
    const operation = await this.findStoredOperation(actorSubject, operationId);
    if (operation === null) return { kind: 'Missing' };
    if (!(operation.fingerprint instanceof CommandFingerprint))
      return { kind: 'OperationMismatch' };
    return {
      kind: 'Found',
      operation: { ...operation, fingerprint: operation.fingerprint },
    };
  }

  /**
   * 新旧の保護本文を同じlocatorから読む。Group現在認可やコード行を再送条件にしない。
   * @param actorSubject 現在callerのActor。
   * @param operationId 共通namespaceのID。
   * @returns binding検証済みの保存成功、または不在。
   * @throws GroupReadUnavailable 複数hit/不整合/Scope/復号障害。
   */
  async findStoredOperation(
    actorSubject: ActorSubject,
    operationId: OperationId,
  ): Promise<StoredGroupOperation | null> {
    try {
      const candidates = await this.options.locatorKeys.candidateDigests(
        operationLocatorDigestInput(actorSubject, operationId),
      );
      if (candidates.length === 0) {
        return null;
      }
      const predicates = candidates.map(
        (_, index) =>
          `(l.locator_digest = $${index * 2 + 1} AND l.digest_key_version = $${index * 2 + 2})`,
      );
      const values = candidates.flatMap(({ digest, digestKeyVersion }) => {
        if (digest.length === 0 || digestKeyVersion.length === 0) {
          throw new GroupReadUnavailable();
        }
        return [Buffer.from(digest), digestKeyVersion];
      });
      const found = await this.options.database.query<OperationRow>(
        `SELECT r.group_id, r.logical_record_id, r.aggregate_version,
                r.envelope_version, r.algorithm_id, r.schema_version,
                r.key_version, r.ciphertext, r.nonce, r.authentication_tag,
                l.command_fingerprint
           FROM group_operation_locator_v2 l
           JOIN group_operation_result_record r
             ON r.group_id = l.group_id
            AND r.logical_record_id = l.operation_result_record_id
          WHERE ${predicates.join(' OR ')}
          LIMIT 2${this.options.operationLock === 'ForShare' ? ' FOR SHARE OF r' : ''}`,
        values,
      );
      if (found.rows.length === 0) {
        // Locatorに一致しない場合は、Group Data Keyの取得も復号も行わない。
        return null;
      }
      if (found.rows.length !== 1) {
        throw new GroupReadUnavailable();
      }
      const row = found.rows[0];
      if (row === undefined || row.command_fingerprint.length === 0) {
        throw new GroupReadUnavailable();
      }
      const plaintext = await this.open(row, 'operation-result', row.group_id);
      const operation = decodeStoredGroupOperation(plaintext);
      if (
        !operation.actorSubject.equals(actorSubject) ||
        !operation.operationId.equals(operationId) ||
        operation.result.groupId.value !== row.group_id ||
        operation.result.version !== safeVersion(row.aggregate_version)
      ) {
        throw new GroupReadUnavailable();
      }
      return operation;
    } catch {
      return this.unavailable();
    }
  }

  /**
   * 保護operation内だけのproof参照を数える。0件だけで鍵破棄を許可しない。
   * @param keyVersion 検査する保存世代。Backup35日closureはProvider側で別途必須。
   * @returns live参照件数。コード清掃/Actor削除の行数に依存しない。
   * @throws GroupReadUnavailable 保存結果の破損/復号障害。未知結果をskipしない。
   */
  async countProofReferences(keyVersion: string): Promise<number> {
    try {
      if (
        typeof keyVersion !== 'string' ||
        keyVersion.length > 255 ||
        !/^[A-Za-z0-9._:-]+$/.test(keyVersion)
      )
        throw new GroupReadUnavailable();
      const found = await this.options.database.query<ProtectedRow>(
        `SELECT group_id, logical_record_id, aggregate_version, envelope_version,
                algorithm_id, schema_version, key_version, ciphertext, nonce, authentication_tag
           FROM group_operation_result_record FOR SHARE`,
      );
      let count = 0;
      for (const row of found.rows) {
        const operation = decodeStoredGroupOperation(
          await this.open(row, 'operation-result', row.group_id),
        );
        if (
          operation.result.groupId.value !== row.group_id ||
          operation.result.version !== safeVersion(row.aggregate_version)
        )
          throw new GroupReadUnavailable();
        if (
          !(operation.fingerprint instanceof CommandFingerprint) &&
          operation.fingerprint.proof.keyVersion === keyVersion
        )
          count += 1;
      }
      return count;
    } catch {
      return this.unavailable();
    }
  }

  private async open(
    row: ProtectedRow,
    recordKind: 'group' | 'operation-result',
    groupId: string,
  ): Promise<Uint8Array> {
    if (
      row.group_id !== groupId ||
      row.envelope_version !== 1 ||
      row.algorithm_id !== 'AES-256-GCM' ||
      safeVersion(row.schema_version) !== 1
    ) {
      throw new GroupReadUnavailable();
    }
    const header: ProtectedRecordHeader = {
      envelopeVersion: 1n,
      algorithmId: 'AES-256-GCM',
      app: 'kakei_app',
      contextName: 'group-management',
      recordKind,
      groupId,
      logicalRecordId: row.logical_record_id,
      schemaVersion: 1n,
      keyVersion: row.key_version,
      aggregateVersion: BigInt(safeVersion(row.aggregate_version)),
      revisionOrdinal: null,
    };
    return this.options.codec.open({
      expectedHeader: header,
      envelope: {
        header,
        aad: this.options.encodeAad(header),
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authenticationTag: row.authentication_tag,
      },
    });
  }

  private unavailable(): never {
    try {
      this.options.onUnavailable?.();
    } catch {
      // Alert失敗で汎用読取失敗を置き換えない。
    }
    throw new GroupReadUnavailable();
  }
}
