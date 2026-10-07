import type { Pool, PoolClient, QueryResultRow } from 'pg';

import {
  GroupManagementDeletionReceiptRecord,
  RetentionIntentVersion,
  type FindGroupManagementDeletionReceiptRequest,
  type GroupManagementDeletionReceiptReadResult,
} from '../../application/group-management-deletion-receipt-port.js';
import type {
  DeleteGroupManagementDataRequest,
  DeleteGroupManagementDataResult,
  GroupManagementRetentionPort,
  PurgeRetiredCloseIntentsResult,
} from '../../application/group-management-retention-port.js';
import { OperationId } from '../../application/group-repository.js';

type FailurePoint =
  | 'afterRegistryRetired'
  | 'afterGroupDeleted'
  | 'beforeReceiptStored'
  | 'afterReceiptStored'
  | 'afterPurgeDeleted'
  | 'afterCommit';

type FailureInjector = Partial<
  Readonly<Record<FailurePoint, () => void | Promise<void>>>
>;

type RetentionAdapterOptions = Readonly<{
  pool: Pool;
  now?: () => Date;
  failureInjector?: FailureInjector;
}>;

type ReceiptRow = QueryResultRow & {
  operation_id: string;
  intent_version: string;
  canonical_receipt: string;
};

type RegistryRow = QueryResultRow & {
  group_id: string | null;
  retain_until: Date | null;
  created_at: Date | null;
};

const TOKYO_OFFSET_MILLISECONDS = 9 * 60 * 60 * 1_000;

/**
 * Group Management所有の削除transactionとCloseIntent registry purgeを
 * PostgreSQLで実装するAdapter。本番Retention wiringや他Context削除は行わない。
 */
export class PostgresGroupManagementRetentionAdapter implements GroupManagementRetentionPort {
  /**
   * PostgreSQL接続、transaction基準時刻、任意の故障注入点を設定する。
   * @param options Group Management DBのPoolと決定的な時刻境界。
   */
  constructor(private readonly options: RetentionAdapterOptions) {}

  /**
   * registry退役、GM業務Data削除、Receipt保存を同じtransactionでcommitする。
   * @param request verified evidenceとの照合を終えたApplication入力。
   * @returns commit後のReceipt、同一Operationの保存済みReceipt、拒否、またはUnavailable。
   */
  async deleteGroupData(
    request: DeleteGroupManagementDataRequest,
  ): Promise<DeleteGroupManagementDataResult> {
    if (
      !request.operationId.equals(request.receipt.operationId) ||
      !request.intentVersion.equals(request.receipt.intentVersion)
    ) {
      return { kind: 'Rejected', reason: 'BindingMismatch' };
    }

    let client: PoolClient | undefined;
    let transactionOpen = false;
    try {
      client = await this.options.pool.connect();
      await client.query('BEGIN');
      transactionOpen = true;

      const existing = await this.selectReceipt(
        client,
        request.operationId,
        true,
      );
      if (existing !== undefined) {
        const replay = this.mapExistingReceipt(
          existing,
          request.intentVersion,
          request.receipt.canonicalReceipt,
        );
        await client.query('ROLLBACK');
        transactionOpen = false;
        return replay;
      }

      const deletedAt = this.txNow();
      const retainUntil = addTokyoCalendarYear(deletedAt);
      const registry = await client.query<RegistryRow>(
        `SELECT group_id, retain_until, created_at
           FROM group_close_intent_registry
          WHERE close_intent_id = $1
          FOR UPDATE`,
        [request.closeIntentId.value],
      );
      if (registry.rowCount !== 1) {
        return await this.reject(
          client,
          'RegistryNotFound',
          () => (transactionOpen = false),
        );
      }
      const registryRow = registry.rows[0];
      if (registryRow?.group_id !== request.groupId.value) {
        return await this.reject(
          client,
          registryRow?.group_id === null
            ? 'RegistryNotLive'
            : 'RegistryBindingMismatch',
          () => (transactionOpen = false),
        );
      }
      if (
        registryRow.retain_until !== null ||
        registryRow.created_at === null
      ) {
        return await this.reject(
          client,
          'RegistryNotLive',
          () => (transactionOpen = false),
        );
      }

      const group = await client.query(
        `SELECT group_id
           FROM group_aggregate_record
          WHERE group_id = $1
          FOR UPDATE`,
        [request.groupId.value],
      );
      if (group.rowCount !== 1) {
        return await this.reject(
          client,
          'GroupNotFound',
          () => (transactionOpen = false),
        );
      }

      const retired = await client.query(
        `UPDATE group_close_intent_registry
            SET group_id = NULL,
                retain_until = $2,
                created_at = NULL
          WHERE close_intent_id = $1
            AND group_id = $3
            AND retain_until IS NULL
            AND created_at IS NOT NULL`,
        [request.closeIntentId.value, retainUntil, request.groupId.value],
      );
      if (retired.rowCount !== 1) {
        throw new Error('CloseIntent registry retirement lost its live row');
      }
      await this.inject('afterRegistryRetired');

      const deleted = await client.query(
        'DELETE FROM group_aggregate_record WHERE group_id = $1',
        [request.groupId.value],
      );
      if (deleted.rowCount !== 1) {
        throw new Error('Group deletion lost its locked aggregate row');
      }
      await this.inject('afterGroupDeleted');
      await this.inject('beforeReceiptStored');

      await client.query(
        `INSERT INTO group_management_deletion_receipt_record (
           operation_id, intent_version, canonical_receipt
         ) VALUES ($1, $2, $3)`,
        [
          request.operationId.value,
          request.intentVersion.value,
          request.receipt.canonicalReceipt,
        ],
      );
      await this.inject('afterReceiptStored');

      await client.query('COMMIT');
      transactionOpen = false;
      await this.inject('afterCommit');
      return { kind: 'Deleted', record: request.receipt };
    } catch {
      if (client !== undefined && transactionOpen) {
        await this.rollback(client);
      }
      return { kind: 'Unavailable' };
    } finally {
      client?.release();
    }
  }

  /**
   * Operation IDとIntent Versionへ束縛されたcommit済みReceiptを再取得する。
   * @param request 再取得対象のOperation IDとIntent Version。
   * @returns 一致するReceipt、未保存、不一致、古い証拠、またはUnavailable。
   */
  async findReceipt(
    request: FindGroupManagementDeletionReceiptRequest,
  ): Promise<GroupManagementDeletionReceiptReadResult> {
    try {
      const row = await this.selectReceipt(
        this.options.pool,
        request.operationId,
        false,
      );
      if (row === undefined) return { kind: 'NotFound' };
      const storedVersion = this.parseIntentVersion(row.intent_version);
      if (storedVersion.value > request.intentVersion.value) {
        return { kind: 'StaleEvidence' };
      }
      if (!storedVersion.equals(request.intentVersion)) {
        return { kind: 'BindingMismatch' };
      }
      return {
        kind: 'Found',
        record: GroupManagementDeletionReceiptRecord.create({
          operationId: OperationId.from(row.operation_id),
          intentVersion: storedVersion,
          canonicalReceipt: row.canonical_receipt,
        }),
      };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  /**
   * transaction開始時に一度だけ取得したUTC時刻へ到達したretired行をpurgeする。
   * @returns commit済み削除件数と基準時刻、またはUnavailable。
   */
  async purgeRetiredCloseIntents(): Promise<PurgeRetiredCloseIntentsResult> {
    let client: PoolClient | undefined;
    let transactionOpen = false;
    try {
      client = await this.options.pool.connect();
      await client.query('BEGIN');
      transactionOpen = true;
      const txNow = this.txNow();
      const purged = await client.query(
        `DELETE FROM group_close_intent_registry
          WHERE group_id IS NULL
            AND retain_until <= $1`,
        [txNow],
      );
      await this.inject('afterPurgeDeleted');
      await client.query('COMMIT');
      transactionOpen = false;
      await this.inject('afterCommit');
      return {
        kind: 'Purged',
        txNow,
        purgedCount: purged.rowCount ?? 0,
      };
    } catch {
      if (client !== undefined && transactionOpen) {
        await this.rollback(client);
      }
      return { kind: 'Unavailable' };
    } finally {
      client?.release();
    }
  }

  private async selectReceipt(
    database: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
    operationId: OperationId,
    lock: boolean,
  ): Promise<ReceiptRow | undefined> {
    const receipt = await database.query<ReceiptRow>(
      `SELECT operation_id, intent_version::text, canonical_receipt
         FROM group_management_deletion_receipt_record
        WHERE operation_id = $1${lock ? ' FOR UPDATE' : ''}`,
      [operationId.value],
    );
    return receipt.rows[0];
  }

  private mapExistingReceipt(
    row: ReceiptRow,
    requestedVersion: RetentionIntentVersion,
    canonicalReceipt: string,
  ): DeleteGroupManagementDataResult {
    const storedVersion = this.parseIntentVersion(row.intent_version);
    if (storedVersion.value > requestedVersion.value) {
      return { kind: 'Rejected', reason: 'StaleEvidence' };
    }
    if (
      !storedVersion.equals(requestedVersion) ||
      row.canonical_receipt !== canonicalReceipt
    ) {
      return { kind: 'Rejected', reason: 'BindingMismatch' };
    }
    return {
      kind: 'AlreadyDeleted',
      record: GroupManagementDeletionReceiptRecord.create({
        operationId: OperationId.from(row.operation_id),
        intentVersion: storedVersion,
        canonicalReceipt: row.canonical_receipt,
      }),
    };
  }

  private parseIntentVersion(value: string): RetentionIntentVersion {
    const parsed = Number(value);
    return RetentionIntentVersion.from(parsed);
  }

  private txNow(): Date {
    const value = this.options.now?.() ?? new Date();
    if (Number.isNaN(value.getTime())) {
      throw new TypeError(
        'Retention transaction clock returned an invalid date',
      );
    }
    return new Date(value.getTime());
  }

  private async inject(point: FailurePoint): Promise<void> {
    await this.options.failureInjector?.[point]?.();
  }

  private async reject(
    client: PoolClient,
    reason:
      | 'GroupNotFound'
      | 'RegistryNotFound'
      | 'RegistryBindingMismatch'
      | 'RegistryNotLive',
    onRolledBack: () => void,
  ): Promise<DeleteGroupManagementDataResult> {
    await client.query('ROLLBACK');
    onRolledBack();
    return { kind: 'Rejected', reason };
  }

  private async rollback(client: PoolClient): Promise<void> {
    try {
      await client.query('ROLLBACK');
    } catch {
      // 呼出し側には引き続きUnavailableを返し、Poolは壊れたClientを破棄する。
    }
  }
}

function addTokyoCalendarYear(deletedAt: Date): Date {
  const local = new Date(deletedAt.getTime() + TOKYO_OFFSET_MILLISECONDS);
  const targetYear = local.getUTCFullYear() + 1;
  const month = local.getUTCMonth();
  const sourceDay = local.getUTCDate();
  const day =
    month === 1 && sourceDay === 29 && !isLeapYear(targetYear) ? 28 : sourceDay;
  return new Date(
    Date.UTC(
      targetYear,
      month,
      day,
      local.getUTCHours(),
      local.getUTCMinutes(),
      local.getUTCSeconds(),
      local.getUTCMilliseconds(),
    ) - TOKYO_OFFSET_MILLISECONDS,
  );
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
