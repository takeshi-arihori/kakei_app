import type {
  ProtectedRecordCodec,
  ProtectedRecordHeader,
} from '@kakei/protected-record';
import type { Client, QueryResultRow } from 'pg';

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
import {
  decodeGroupRecordPayload,
  decodeOperationResultPayload,
} from './group-record-payload.js';

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
 * Read-only half of GroupRepository. Task #96 composes this with its public
 * commit boundary; no write or production key provider is hidden here.
 */
export class PostgresGroupReadRepository {
  constructor(
    private readonly options: Readonly<{
      database: Pick<Client, 'query'>;
      codec: Pick<ProtectedRecordCodec, 'open'>;
      encodeAad: (header: ProtectedRecordHeader) => Uint8Array;
      locatorKeys: GroupOperationLocatorKeyPort;
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

  async findOperation(
    actorSubject: ActorSubject,
    operationId: OperationId,
  ): Promise<FindOperationResult> {
    try {
      const candidates = await this.options.locatorKeys.candidateDigests(
        operationLocatorDigestInput(actorSubject, operationId),
      );
      if (candidates.length === 0) {
        return { kind: 'Missing' };
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
          LIMIT 2`,
        values,
      );
      if (found.rows.length === 0) {
        // A locator miss must never ask for a Group data key or decrypt.
        return { kind: 'Missing' };
      }
      if (found.rows.length !== 1) {
        throw new GroupReadUnavailable();
      }
      const row = found.rows[0];
      if (row === undefined || row.command_fingerprint.length === 0) {
        throw new GroupReadUnavailable();
      }
      const plaintext = await this.open(row, 'operation-result', row.group_id);
      const operation = decodeOperationResultPayload(plaintext);
      if (
        !operation.actorSubject.equals(actorSubject) ||
        !operation.operationId.equals(operationId) ||
        operation.result.groupId.value !== row.group_id ||
        operation.result.version !== safeVersion(row.aggregate_version)
      ) {
        throw new GroupReadUnavailable();
      }
      return { kind: 'Found', operation };
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
      // Alert failure must not replace the generic read failure.
    }
    throw new GroupReadUnavailable();
  }
}
