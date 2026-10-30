import type {
  ProtectedRecordCodec,
  ProtectedRecordHeader,
} from '../../../shared/infrastructure/protected-record/index.js';
import type { Client, Pool, PoolClient } from 'pg';

import {
  type GroupPolicyDigestPort,
  type GroupOperationLocatorKeyPort,
} from '../../application/group-access-policy.js';
import type {
  CommitGroupOutcome,
  CommitGroupRequest,
  FindOperationResult,
  GroupRepository,
  LoadedGroup,
} from '../../application/group-repository.js';
import {
  GroupReadUnavailable,
  PostgresGroupReadRepository,
} from './group-read-repository.js';
import { PostgresGroupCommitKernel } from './group-commit-kernel.js';
import { PostgresGroupStateWriter } from './group-state-writer.js';

type Database = Pick<Client, 'query'>;
/** standalone Transaction owner。保存の意味は参加Adapterと同じkernelへ委譲する。 */
export class PostgresGroupRepository implements GroupRepository {
  /**
   * @param options 接続所有と共通kernelの依存。参加AdapterへPoolを渡さない。
   */
  constructor(
    private readonly options: Readonly<{
      /** standalone ownerだけが所有する接続取得/読取。 */
      pool: Pick<Pool, 'connect' | 'query'>;
      /** 既存CAS/履歴/索引Writer。 */
      stateWriter: Pick<PostgresGroupStateWriter, 'persist'>;
      /** 既存GM Envelopeの保護/復号。 */
      codec: Pick<ProtectedRecordCodec, 'seal' | 'open'>;
      /** 保存形式を変更しないcanonical AAD。 */
      encodeAad: (header: ProtectedRecordHeader) => Uint8Array;
      /** Actor内・全Command共通の保持/現行世代。 */
      locatorKeys: GroupOperationLocatorKeyPort;
      /** 用途別の索引/fingerprint。 */
      accessIndexDigests: GroupPolicyDigestPort;
      /** 入力を含まない固定障害通知。 */
      onUnavailable?: () => void;
      /** Server生成UUIDの注入。 */
      nextRecordId?: () => string;
      /** UTC保存時刻の注入。 */
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

  /**
   * @param request 既存Commandの保存計画。新actionとの衝突も共通namespaceで拒否する。
   * @returns 確定成功/既存成功、またはConflict/Mismatch/Unavailable。COMMIT不明は成功照会で回復する。
   */
  async commit(request: CommitGroupRequest): Promise<CommitGroupOutcome> {
    let client: PoolClient | undefined;
    let transactionOpen = false;
    let commitSent = false;
    try {
      client = await this.options.pool.connect();
      await client.query('BEGIN');
      transactionOpen = true;
      const {
        stateWriter,
        codec,
        encodeAad,
        locatorKeys,
        accessIndexDigests,
        nextRecordId,
        now,
      } = this.options;
      const kernel = new PostgresGroupCommitKernel({
        stateWriter,
        codec,
        encodeAad,
        locatorKeys,
        accessIndexDigests,
        nextRecordId,
        now,
      });
      const currentKeyVersion = await kernel.prepare(client);
      const outcome = await kernel.stage(client, request, currentKeyVersion);
      if (outcome.kind !== 'Staged') {
        await this.rollback(client);
        transactionOpen = false;
        if (outcome.kind === 'LocatorConflict')
          return this.resolveLocatorRace(request);
        if (outcome.kind === 'Replayed')
          return { kind: 'Committed', result: outcome.result };
        if (outcome.kind === 'Unavailable') this.reportUnavailable();
        return outcome;
      }
      commitSent = true;
      await client.query('COMMIT');
      transactionOpen = false;
      return { kind: 'Committed', result: outcome.result };
    } catch {
      if (client !== undefined && transactionOpen && !commitSent)
        await this.rollback(client);
      this.reportUnavailable();
      return { kind: 'Unavailable' };
    } finally {
      // COMMIT送信後の障害は結果不明。rollbackで確定失敗と扱わず接続を破棄する。
      client?.release(commitSent && transactionOpen);
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
      if (found.kind === 'OperationMismatch')
        return { kind: 'OperationMismatch' };
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

  private async rollback(client: PoolClient): Promise<void> {
    try {
      await client.query('ROLLBACK');
    } catch {
      // 接続喪失でRollback不能になっても、汎用Unavailable結果や
      // 呼出し側の冪等な復旧経路を隠さない。
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
      // Alert失敗でRepositoryの汎用結果を置き換えない。
    }
  }
}
