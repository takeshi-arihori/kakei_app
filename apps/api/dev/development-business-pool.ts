import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { GraphQLAuthenticationService } from '../src/presentation/graphql/authenticated-operation.js';

/**
 * 開発用業務Poolの上限（#304 §1・#307 Decision 3）。認証Pool（max 8、接続待機3秒）とは別に持つ。
 * 接続待機をLock待機より短くし、Lock待機をStatement上限より短くする。どれも認証leaseを
 * 保持したまま待つ時間なので、認証側のquery上限（5秒）を超えて業務が止まらないようにする。
 */
export const businessPoolSettings = Object.freeze({
  max: 4,
  connectionTimeoutMillis: 1000,
  lockTimeoutMillis: 2000,
  statementTimeoutMillis: 4000,
  queryTimeoutMillis: 4500,
  idleInTransactionTimeoutMillis: 5000,
});

type ConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: unknown) => void,
) => void;

/** 認証lease 1回分の、業務接続の取得失敗の記録。 */
interface LeaseAcquisition {
  failed: boolean;
}

/**
 * 接続の取得失敗（待機timeout・接続拒否・end後）を、取得を呼んだ認証leaseへ記録するPool。
 * `Pool.query`も内部で`this.connect(callback)`を使うので、両方の経路を記録できる。
 */
class AcquisitionTrackedPool extends Pool {
  constructor(
    config: PoolConfig,
    private readonly leases: AsyncLocalStorage<LeaseAcquisition>,
  ) {
    super(config);
  }

  override connect(): Promise<PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<PoolClient> | void {
    // 呼出し時点のleaseに記録する。Callback内のAsync Contextには依存しない。
    const lease = this.leases.getStore();
    const mark = () => {
      if (lease) lease.failed = true;
    };
    if (callback === undefined)
      return super.connect().catch((error: unknown) => {
        mark();
        throw error;
      });
    super.connect((error, client, done) => {
      if (error) mark();
      callback(error, client, done);
    });
  }
}

/** 開発Compositionが所有する業務Pool。認証Poolを渡さない。 */
export interface DevelopmentBusinessPool {
  /** 業務Adapterへ渡すPool。Transaction設定は接続ごとにServerへ設定済み。 */
  readonly pool: Pool;
  /**
   * 業務GraphQLの本人性Serviceを包み、lease内で業務接続の取得に失敗したOperationの
   * 認証leaseをrollbackさせる（#307 Decision 3）。業務側が失敗を`SERVICE_UNAVAILABLE`へ
   * 写像して正常に戻っても、idle延長・認証Auditをcommitしない。
   * @param service 共有認証のlease能力。
   * @returns 同じ契約を持つService。取得に成功したOperationの挙動は変えない。
   */
  guard(service: GraphQLAuthenticationService): GraphQLAuthenticationService;
  /** 以後の取得を拒否し、接続を閉じる。 */
  end(): Promise<void>;
}

/** 接続取得の失敗をleaseへ伝えるための、入力・原因を含まない例外。 */
class BusinessConnectionUnavailable extends Error {
  constructor() {
    super('業務接続を取得できません');
  }
}

/**
 * 認証Poolと同じ使い捨てDBへ、別の業務Poolを作る。取得順は「認証→業務」に固定し、
 * 業務側から認証leaseを開かない。
 * @param options 検査済みの専用DB接続先。`client`・`max`・`connectionTimeoutMillis`は
 *   DBへ接続しないUnit Testだけが上書きし、開発Runtimeは渡さない。
 * @returns 未接続の業務Pool。接続はOperationごとに取得する。
 */
export const createDevelopmentBusinessPool = (
  options: Readonly<{
    databaseUrl: string;
    client?: PoolConfig['Client'];
    max?: number;
    connectionTimeoutMillis?: number;
  }>,
): DevelopmentBusinessPool => {
  const leases = new AsyncLocalStorage<LeaseAcquisition>();
  const pool = new AcquisitionTrackedPool(
    {
      connectionString: options.databaseUrl,
      ...(options.client ? { Client: options.client } : {}),
      max: options.max ?? businessPoolSettings.max,
      connectionTimeoutMillis:
        options.connectionTimeoutMillis ??
        businessPoolSettings.connectionTimeoutMillis,
      query_timeout: businessPoolSettings.queryTimeoutMillis,
      lock_timeout: businessPoolSettings.lockTimeoutMillis,
      statement_timeout: businessPoolSettings.statementTimeoutMillis,
      idle_in_transaction_session_timeout:
        businessPoolSettings.idleInTransactionTimeoutMillis,
      application_name: 'kakei-group-disposable-development',
    },
    leases,
  );
  pool.on('error', () => {
    /* 待機接続の障害は各操作の汎用失敗とする。値を記録しない。 */
  });
  let ended: Promise<void> | undefined;
  return {
    pool,
    guard: (service) => ({
      withAuthenticatedActor: (secret, usage, callback) =>
        service.withAuthenticatedActor(secret, usage, async (actor, scope) => {
          const lease: LeaseAcquisition = { failed: false };
          const value = await leases.run(lease, () => callback(actor, scope));
          if (lease.failed) throw new BusinessConnectionUnavailable();
          return value;
        }),
    }),
    end: () => (ended ??= pool.end()),
  };
};
