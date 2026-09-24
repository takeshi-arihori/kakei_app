import type {
  ProtectedRecordCodec,
  ProtectedRecordHeader,
} from '@kakei/protected-record';
import { randomUUID } from 'node:crypto';
import type { Client, Pool, PoolClient, QueryResultRow } from 'pg';

import {
  operationLocatorDigestInput,
  operationFingerprintDigestInput,
  type GroupPolicyDigestPort,
  type GroupOperationLocatorKeyPort,
} from '../../application/group-access-policy.js';
import type {
  CommitGroupOutcome,
  CommitGroupRequest,
  FindOperationResult,
  GroupCommandResult,
  GroupRepository,
  LoadedGroup,
  StoredOperation,
} from '../../application/group-repository.js';
import {
  GroupReadUnavailable,
  PostgresGroupReadRepository,
} from './group-read-repository.js';
import { encodeOperationResultPayload } from './group-record-payload.js';
import { PostgresGroupStateWriter } from './group-state-writer.js';

type Database = Pick<Client, 'query'>;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyVersionPattern = /^[A-Za-z0-9._:-]+$/;

export class PostgresGroupRepository implements GroupRepository {
  constructor(
    private readonly options: Readonly<{
      pool: Pick<Pool, 'connect' | 'query'>;
      stateWriter: Pick<PostgresGroupStateWriter, 'persist'>;
      codec: Pick<ProtectedRecordCodec, 'seal' | 'open'>;
      encodeAad: (header: ProtectedRecordHeader) => Uint8Array;
      locatorKeys: GroupOperationLocatorKeyPort;
      accessIndexDigests: GroupPolicyDigestPort;
      onUnavailable?: () => void;
      nextRecordId?: () => string;
      now?: () => Date;
    }>,
  ) {}

  async load(
    groupId: Parameters<GroupRepository['load']>[0],
  ): Promise<LoadedGroup | null> {
    try {
      return await this.readRepository(this.options.pool).load(groupId);
    } catch {
      return this.unavailable();
    }
  }

  async findOperation(
    actorSubject: Parameters<GroupRepository['findOperation']>[0],
    operationId: Parameters<GroupRepository['findOperation']>[1],
  ): Promise<FindOperationResult> {
    try {
      return await this.readRepository(this.options.pool).findOperation(
        actorSubject,
        operationId,
      );
    } catch {
      return this.unavailable();
    }
  }

  async commit(request: CommitGroupRequest): Promise<CommitGroupOutcome> {
    let client: PoolClient | undefined;
    let transactionOpen = false;
    try {
      client = await this.options.pool.connect();
      await client.query('BEGIN');
      transactionOpen = true;

      const keyState = await client.query<
        QueryResultRow & { current_key_version: string | null }
      >(
        `SELECT current_key_version
           FROM group_operation_locator_key_state
          WHERE id = 1
          FOR SHARE`,
      );
      const currentKeyVersion = keyState.rows[0]?.current_key_version;
      if (
        keyState.rowCount !== 1 ||
        currentKeyVersion === null ||
        currentKeyVersion === undefined
      ) {
        await this.rollback(client);
        transactionOpen = false;
        this.reportUnavailable();
        return { kind: 'Unavailable' };
      }

      const locatorInput = operationLocatorDigestInput(
        request.operation.actorSubject,
        request.operation.operationId,
      );
      const [currentDigest, candidates] = await Promise.all([
        this.options.locatorKeys.currentDigest(locatorInput),
        this.options.locatorKeys.candidateDigests(locatorInput),
      ]);
      if (
        !this.isValidDigest(currentDigest) ||
        currentDigest.digestKeyVersion !== currentKeyVersion ||
        candidates.length === 0 ||
        !candidates.every((candidate) => this.isValidDigest(candidate)) ||
        !candidates.some(
          (candidate) =>
            candidate.digestKeyVersion === currentKeyVersion &&
            Buffer.from(candidate.digest).equals(
              Buffer.from(currentDigest.digest),
            ),
        )
      ) {
        await this.rollback(client);
        transactionOpen = false;
        this.reportUnavailable();
        return { kind: 'Unavailable' };
      }

      const transactionLocatorKeys: GroupOperationLocatorKeyPort = {
        currentDigest: () => Promise.resolve(currentDigest),
        candidateDigests: () => Promise.resolve(candidates),
      };
      const read = this.readRepository(client, transactionLocatorKeys);
      const existing = await read.findOperation(
        request.operation.actorSubject,
        request.operation.operationId,
      );
      if (existing.kind === 'Found') {
        await this.rollback(client);
        transactionOpen = false;
        return existing.operation.fingerprint.equals(
          request.operation.fingerprint,
        )
          ? { kind: 'Committed', result: existing.operation.result }
          : { kind: 'OperationMismatch' };
      }

      const closeIntentId = request.groupCloseChanges.find(
        (change) => change.kind === 'ClosingStarted',
      )?.closeIntentId;
      if (closeIntentId !== undefined) {
        const registered = await client.query(
          `INSERT INTO group_close_intent_registry (close_intent_id, group_id)
           VALUES ($1, $2)
           ON CONFLICT (close_intent_id) DO NOTHING
           RETURNING close_intent_id`,
          [closeIntentId.value, request.group.id.value],
        );
        if (registered.rowCount !== 1) {
          const replay = await read.findOperation(
            request.operation.actorSubject,
            request.operation.operationId,
          );
          await this.rollback(client);
          transactionOpen = false;
          if (replay.kind === 'Found') {
            return replay.operation.fingerprint.equals(
              request.operation.fingerprint,
            )
              ? { kind: 'Committed', result: replay.operation.result }
              : { kind: 'OperationMismatch' };
          }
          return { kind: 'CloseIntentAlreadyExists' };
        }
      }

      const state = await this.options.stateWriter.persist(client, request);
      if (state.kind !== 'Committed') {
        await this.rollback(client);
        transactionOpen = false;
        return state;
      }

      const result = {
        ...request.result,
        version: state.version,
      } as GroupCommandResult;
      const storedOperation: StoredOperation = {
        ...request.operation,
        result,
      };
      const recordId = (this.options.nextRecordId ?? randomUUID)();
      if (!uuidPattern.test(recordId)) {
        throw new TypeError('Invalid operation-result record ID');
      }
      const createdAt = this.options.now?.() ?? new Date();
      if (Number.isNaN(createdAt.getTime())) {
        throw new TypeError('Invalid operation-result timestamp');
      }
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
        plaintext: encodeOperationResultPayload(storedOperation),
      });
      await client.query(
        `INSERT INTO group_operation_result_record (
           logical_record_id, group_id, aggregate_version, envelope_version,
           algorithm_id, schema_version, key_version, ciphertext, nonce,
           authentication_tag, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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

      const fingerprintDigest = await this.options.accessIndexDigests.digest({
        ...operationFingerprintDigestInput(
          request.group.id,
          'command-fingerprint',
          request.operation.fingerprint.value,
        ),
      });
      if (!this.isValidDigest(fingerprintDigest)) {
        throw new TypeError('Invalid command fingerprint digest');
      }
      const locator = await client.query(
        `INSERT INTO group_operation_locator_v2 (
           locator_digest, digest_key_version, command_fingerprint, group_id,
           operation_result_record_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (locator_digest, digest_key_version) DO NOTHING
         RETURNING locator_digest`,
        [
          Buffer.from(currentDigest.digest),
          currentDigest.digestKeyVersion,
          Buffer.from(fingerprintDigest.digest),
          request.group.id.value,
          recordId,
          createdAt,
        ],
      );
      if (locator.rowCount !== 1) {
        await this.rollback(client);
        transactionOpen = false;
        return this.resolveLocatorRace(request);
      }

      await client.query('COMMIT');
      transactionOpen = false;
      return { kind: 'Committed', result };
    } catch {
      if (client !== undefined && transactionOpen) {
        await this.rollback(client);
      }
      this.reportUnavailable();
      return { kind: 'Unavailable' };
    } finally {
      client?.release();
    }
  }

  private async resolveLocatorRace(
    request: CommitGroupRequest,
  ): Promise<CommitGroupOutcome> {
    try {
      const found = await this.findOperation(
        request.operation.actorSubject,
        request.operation.operationId,
      );
      if (found.kind !== 'Found') {
        return { kind: 'Unavailable' };
      }
      return found.operation.fingerprint.equals(request.operation.fingerprint)
        ? { kind: 'Committed', result: found.operation.result }
        : { kind: 'OperationMismatch' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  private readRepository(
    database: Database,
    locatorKeys: GroupOperationLocatorKeyPort = this.options.locatorKeys,
  ): PostgresGroupReadRepository {
    return new PostgresGroupReadRepository({
      database,
      codec: this.options.codec,
      encodeAad: this.options.encodeAad,
      locatorKeys,
    });
  }

  private isValidDigest(candidate: {
    digest: Uint8Array;
    digestKeyVersion: string;
  }): boolean {
    return (
      candidate.digest.length > 0 &&
      keyVersionPattern.test(candidate.digestKeyVersion)
    );
  }

  private async rollback(client: PoolClient): Promise<void> {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A lost connection can make rollback impossible; it must not hide the
      // generic Unavailable result or the caller's idempotent recovery path.
    }
  }

  private unavailable(): never {
    this.reportUnavailable();
    throw new GroupReadUnavailable();
  }

  private reportUnavailable(): void {
    try {
      this.options.onUnavailable?.();
    } catch {
      // Alert failure cannot replace the generic repository outcome.
    }
  }
}
