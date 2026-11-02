import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, Pool, type PoolClient, type QueryResult } from 'pg';
import { expect, vi, type Mock } from 'vitest';
import {
  createRecipientInvitationRuntime,
  type RecipientInvitationRuntimeOptions,
} from '../../src/recipient-invitation-runtime.js';
import type {
  AuthenticationMacKeyPorts,
  AuthenticationMacPurpose,
} from '../../src/shared/application/authentication/authentication-crypto-keys.js';
import type { AuthenticationSessionRow } from '../../src/shared/application/authentication/authentication-record-protection.js';
import type {
  RecipientCodeKeyQuery,
  RecipientCodeMacPurpose,
} from '../../src/shared/application/authentication/recipient-code-crypto-ports.js';
import { createAuthenticationTransactionScopes } from '../../src/shared/infrastructure/authentication/postgres/authentication-transaction-scopes.js';
import { createRecipientCodeTransactionScopes } from '../../src/shared/infrastructure/authentication/postgres/recipient-code-transaction-scopes.js';
import { createPostgresRecipientCodeConsumer } from '../../src/shared/infrastructure/authentication/postgres/postgres-recipient-code-consumer.js';
import { createPostgresRecipientCodeLeases } from '../../src/shared/infrastructure/authentication/postgres/postgres-recipient-code-leases.js';
import { createEnlistedGroupRepository } from '../../src/group-management/infrastructure/postgres/enlisted-group-repository.js';
import {
  createAuthenticationDigests,
  importAuthenticationMacKey,
} from '../../src/shared/infrastructure/authentication/authentication-digests.js';
import { createAuthenticationRecordCodec } from '../../src/shared/infrastructure/authentication/authentication-record-codec.js';
import {
  createRecipientCodeCrypto,
  importRecipientCodeMacKey,
} from '../../src/shared/infrastructure/authentication/recipient-code-crypto.js';
import {
  insertAuthenticationRecord,
  readStoredAuthenticationSession,
  updateAuthenticationRecord,
} from '../../src/shared/infrastructure/authentication/postgres/authentication-record-rows.js';
import { readRecipientCode } from '../../src/shared/infrastructure/authentication/postgres/recipient-code-selection.js';
import type { AuthenticationConnectionPool } from '../../src/shared/infrastructure/authentication/postgres/authentication-transactions.js';
import {
  SyntheticKeyRegistry,
  ids,
} from '../../src/shared/infrastructure/authentication/test/authentication-crypto-fixtures.js';
import {
  createProtectedRecordCodec,
  encodeCanonicalAad,
  importProtectedRecordKey,
  importPurposeSeparatedDigest,
} from '../../src/shared/infrastructure/protected-record/index.js';
import {
  ActorSubject,
  GroupId,
  InvitationId,
  ParticipantId,
  CloseIntentId,
  Group,
  UtcInstant,
} from '../../src/group-management/domain/group.js';
import {
  CommandFingerprint,
  OperationId,
} from '../../src/group-management/application/group-repository.js';
import { GroupCommandService } from '../../src/group-management/application/group-command-service.js';
import { PostgresGroupRepository } from '../../src/group-management/infrastructure/postgres/group-repository.js';
import { PostgresGroupStateWriter } from '../../src/group-management/infrastructure/postgres/group-state-writer.js';
import {
  createRecipientCodeRequestProof,
  importRecipientCodeRequestProofKey,
} from '../../src/group-management/infrastructure/recipient-code-request-proof.js';
import {
  createGroupInvitationAuditProtector,
  importGroupInvitationAuditKey,
} from '../../src/group-management/infrastructure/group-invitation-audit.js';
import { PostgresGroupInvitationAuditWriter } from '../../src/group-management/infrastructure/postgres/group-invitation-audit-writer.js';
import { applySqlMigrations } from '../../src/group-management/infrastructure/postgres/sql-migration.js';

/** 公開済み合成本人参照。実Actor/Session/鍵を使わない。 */
export const actors = {
  /** 最初のGroup Owner。 */ owner: '10000000-0000-4000-8000-000000000020',
  /** コードを発行する本人。 */ recipient:
    '10000000-0000-4000-8000-000000000010',
  /** 別GroupのOwner。 */ otherOwner: '10000000-0000-4000-8000-000000000040',
  /** 人数/Owner競合用の別本人。 */ member:
    '10000000-0000-4000-8000-000000000050',
};
/** @param byte 合成秘密値の識別子。@returns Test専用canonical 32-byte値。 */
export const sessionSecret = (byte: number) =>
  Buffer.alloc(32, byte).toString('base64url');
/** @returns 時間順序を外部から解放できるTest-only barrier。 */
export const barrier = () => {
  let release!: () => void;
  const entered = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('合成: barrier未到達')),
      3000,
    );
    timer.unref();
    release = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  void entered.catch(() => {});
  return { entered, release };
};
type SqlEvent = { sql: string; values: unknown[]; pid: number };
/** 実PG通信の前後にだけ故障/順序を注入する合成境界。 */
export type SqlIntercept = (
  /** 実Adapterが発行したSQL。 */ event: SqlEvent,
  /** 実PGへ同じSQLを一度送る処理。 */ run: () => Promise<QueryResult>,
) => Promise<QueryResult>;
const authKey = <P extends AuthenticationMacPurpose>(
  purpose: P,
  byte: number,
) => ({
  readKey: ({
    keyVersion,
    epoch,
  }: {
    keyVersion: string;
    epoch: string | null;
  }) =>
    Promise.resolve({
      status: 'available' as const,
      keyVersion,
      epoch,
      key: importAuthenticationMacKey(purpose, Buffer.alloc(32, byte)),
    }),
});
const keys: AuthenticationMacKeyPorts = {
  identity: authKey('auth-google-identity/v1', 101),
  attemptCookie: authKey('auth-attempt-cookie/v1', 102),
  sessionCookie: authKey('auth-session-cookie/v1', 103),
  actorState: authKey('auth-actor-state/v1', 104),
  auditActor: authKey('auth-audit-actor/v1', 105),
  auditAttempt: authKey('auth-audit-attempt/v1', 106),
  auditSession: authKey('auth-audit-session/v1', 107),
  deletedActor: authKey('auth-deleted-actor/v1', 108),
};

/** 実認証/実GMを同接続で検証するFixture。合成Providerの耐久性を主張しない。 */
export class RecipientInvitationFixture {
  /** Schema所有権とLock観測だけに使う管理接続。 */ readonly admin: Client;
  /** 業務/競合を実行する実PG Pool。 */ pool!: Pool;
  /** 今回所有するGM分離Schema。 */ schema = '';
  /** 合成Clock。 */ now = Date.parse('2026-11-01T00:00:00Z');
  /** 同じClockを全Adapterへ注入する。 */ readonly clock = {
    now: () => this.now,
  };
  /** Clientに公開しないSQL検証記録。 */ sqls: SqlEvent[] = [];
  /** 故障/順序だけを注入し、業務結果をFakeへ置換しない。 */ intercept: SqlIntercept =
    (_e, run) => run();
  /** 破棄された接続の確認記録。 */ released: {
    pid: number;
    destroy: boolean;
  }[] = [];
  /** 固定Alertだけを検証する。 */ alerts: Mock<(...args: unknown[]) => void> =
    vi.fn();
  /** 具体Provider採用を意味しない合成認証Codec。 */ authCodec!: ReturnType<
    typeof createAuthenticationRecordCodec
  >;
  /** 実用途別HMAC Adapter。 */ digests!: ReturnType<
    typeof createAuthenticationDigests
  >;
  /** 実コードlookup/MAC/Audit Adapter。 */ crypto!: ReturnType<
    typeof createRecipientCodeCrypto
  >;
  /** 実Group Envelope Codec。 */ groupCodec!: ReturnType<
    typeof createProtectedRecordCodec
  >;
  /** 保存世代replayに使う実proof Adapter。 */ proof!: ReturnType<
    typeof createRecipientCodeRequestProof
  >;
  /** 合成Providerの読取世代を制御する。 */ proofMaterials = new Map<
    string,
    Uint8Array
  >();
  /** Record鍵喪失を合成するProvider状態。 */ codeMaterials = new Map<
    string,
    Uint8Array
  >();
  /** 同code/versionの明示割当契約を検証する。 */ allocations = new Map<
    string,
    number
  >();
  /** 統合済み内部Use Caseだけ。registry/接続能力を返さない。 */ runtime!: ReturnType<
    typeof createRecipientInvitationRuntime
  >;
  /** 同じ実能力を負例だけのCompositionへ渡すTest用設定。 */ runtimeOptions!: RecipientInvitationRuntimeOptions;
  /** 通常Group Commandを競合として実行する実Repository。 */ standalone!: PostgresGroupRepository;
  /** 実Group遷移を作る既存Application。 */ commands!: GroupCommandService;
  /** 一つ目の合成Group。 */ readonly groupId = GroupId.from(
    '10000000-0000-4000-8000-000000000243',
  );
  /** 別Owner/別Group競合用。 */ readonly otherGroupId = GroupId.from(
    '10000000-0000-4000-8000-000000000244',
  );
  private owned = false;
  private readonly discarded = new WeakSet<PoolClient>();
  private readonly unexpectedErrors: string[] = [];
  /** @param url PG17の_test DB。通常環境を受理しない。 */
  constructor(private readonly url: string) {
    this.admin = new Client({ connectionString: url });
  }
  /** @returns Registryへ閉じた実Pool能力。SQL障害だけ差し替え可能。 */
  connections(): AuthenticationConnectionPool {
    return {
      connect: async () => {
        const c = await this.pool.connect();
        const pid = (
          await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0].pid;
        return {
          on: c.on.bind(c),
          removeListener: c.removeListener.bind(c),
          query: (sql: string, values?: unknown[]) => {
            const event = { sql, values: values ?? [], pid };
            this.sqls.push(event);
            return this.intercept(event, () => c.query(sql, values));
          },
          release: (destroy?: boolean) => {
            this.released.push({ pid, destroy: !!destroy });
            if (destroy) this.discarded.add(c);
            c.release(destroy);
          },
        };
      },
    };
  }
  /** 共有advisory lock下で、存在しないSchemaだけを所有する。 */
  async initialize(): Promise<void> {
    await this.admin.connect();
    const db = (
      await this.admin.query<{ db: string; version: string }>(
        "SELECT current_database() AS db,current_setting('server_version_num') AS version",
      )
    ).rows[0];
    if (
      !db.db.endsWith('_test') ||
      Number(db.version) < 170000 ||
      Number(db.version) >= 180000
    )
      throw new Error('専用PG17 _test DBだけを使用する');
    await this.admin.query('SELECT pg_advisory_lock(1801546597,1635087464)');
    if (
      (
        await this.admin.query<{ ns: string | null }>(
          "SELECT to_regnamespace('authentication') AS ns",
        )
      ).rows[0].ns !== null
    )
      throw new Error('既存Schemaを変更しない');
    this.schema = `test_issue243_${randomUUID().replaceAll('-', '')}`;
    await this.admin.query(`CREATE SCHEMA ${this.schema}`);
    this.owned = true;
    await this.admin.query(`SET search_path TO ${this.schema}`);
    const names = [
      ['group-management', '0001_group_management_storage'],
      ['group-management', '0002_group_locator_v2'],
      ['group-management', '0003_close_intent_registry'],
      ['group-management', '0004_group_management_retention'],
      ['authentication', '0005_authentication_schema'],
      ['authentication', '0006_authentication_inventory'],
      ['authentication', '0008_recipient_code_schema'],
      ['authentication', '0009_recipient_code_audit'],
      ['group-management', '0010_recipient_invitation_enlistment'],
      ['authentication', '0011_recipient_code_consumption_audit'],
    ];
    await applySqlMigrations(
      this.admin,
      await Promise.all(
        names.map(async ([system, name]) => ({
          version: Number(name.slice(0, 4)),
          name,
          sql: await readFile(
            new URL(`../../migrations/${system}/${name}.sql`, import.meta.url),
            'utf8',
          ),
        })),
      ),
    );
    this.pool = new Pool({
      connectionString: this.url,
      options: `-c search_path=${this.schema}`,
      max: 8,
    });
    this.pool.on('error', (e: Error & { code?: string }, c) => {
      if (e.code !== '25P04' || !this.discarded.has(c))
        this.unexpectedErrors.push(e.code ?? 'unknown');
    });
  }
  /** 各Caseへ独立したData/鍵/ID/Clockを用意し、Migrationは書き換えない。 */
  async reset(): Promise<void> {
    const tables = (
      await this.admin.query<{ schemaname: string; tablename: string }>(
        "SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ($1,'authentication') AND tablename NOT LIKE '%key_state' AND tablename <> 'app_schema_migrations'",
        [this.schema],
      )
    ).rows;
    await this.admin.query(
      `TRUNCATE ${tables.map((t) => `"${t.schemaname}"."${t.tablename}"`).join(',')} CASCADE`,
    );
    this.now = Date.parse('2026-11-01T00:00:00Z');
    this.sqls = [];
    this.released = [];
    this.intercept = (_e, run) => run();
    this.alerts = vi.fn();
    this.codeMaterials.clear();
    this.allocations.clear();
    await this.admin.query(
      "UPDATE authentication.key_state SET status='active',generation_version=1,epoch=$1",
      [ids.epoch],
    );
    for (const purpose of [
      'google-identity-search',
      'login-attempt-cookie',
      'session-cookie',
      'actor-state-mac',
      'audit-actor',
      'audit-attempt',
      'audit-session',
      'deleted-actor',
      'deletion-ledger-mac',
      'recipient-code-lookup',
      'recipient-code-state-mac',
    ]) {
      await this.admin.query(
        "INSERT INTO authentication.key_generation(generation_id,purpose,key_version,epoch,searchable,write_required) VALUES($1,$2,'v1',$3,true,true)",
        [randomUUID(), purpose, purpose.endsWith('cookie') ? ids.epoch : null],
      );
    }
    await this.admin.query(
      "UPDATE group_operation_locator_key_state SET current_key_version='locator-v1' WHERE id=1",
    );
    await this.admin.query(
      "UPDATE group_recipient_code_proof_key_state SET current_key_version='proof-v1' WHERE id=1",
    );
    this.authCodec = {
      ...createAuthenticationRecordCodec({
        keys: new SyntheticKeyRegistry().provider(),
      }),
    };
    this.digests = createAuthenticationDigests({ keys });
    this.codeMaterials.set(
      'auth-recipient-code-lookup/v1/authentication/v1',
      randomBytes(32),
    );
    this.codeMaterials.set(
      'auth-audit-recipient-code/v1/authentication/v1',
      randomBytes(32),
    );
    const codeKey = <P extends RecipientCodeMacPurpose>(purpose: P) => ({
      readKey: (q: RecipientCodeKeyQuery) => {
        const material = this.codeMaterials.get(
          `${purpose}/${q.scopeId}/${q.keyVersion}`,
        );
        return Promise.resolve(
          material
            ? {
                status: 'available' as const,
                ...q,
                key: importRecipientCodeMacKey(purpose, material),
              }
            : { status: 'unavailable' as const },
        );
      },
    });
    this.crypto = {
      ...createRecipientCodeCrypto({
        keys: {
          lookup: codeKey('auth-recipient-code-lookup/v1'),
          state: codeKey('auth-recipient-code-state/v1'),
          audit: codeKey('auth-audit-recipient-code/v1'),
        },
      }),
    };
    const groupKeys = new Map<
      string,
      ReturnType<typeof importProtectedRecordKey>
    >();
    let count = 0n;
    this.groupCodec = {
      ...createProtectedRecordCodec({
        keyPort: {
          allocateForSeal: ({ groupId }) => {
            if (!groupKeys.has(groupId))
              groupKeys.set(groupId, importProtectedRecordKey(randomBytes(32)));
            const nonce = Buffer.alloc(12);
            nonce.writeBigUInt64BE(++count, 4);
            return Promise.resolve({
              status: 'allocated' as const,
              key: groupKeys.get(groupId)!,
              keyVersion: 'group-v1',
              nonce,
              sealCount: count,
            });
          },
          readKey: ({ groupId, keyVersion }) =>
            Promise.resolve(
              groupKeys.has(groupId) && keyVersion === 'group-v1'
                ? {
                    status: 'available' as const,
                    lifecycle: 'current' as const,
                    key: groupKeys.get(groupId)!,
                  }
                : { status: 'key-lost' as const },
            ),
          requestRotation: () => Promise.resolve(),
        },
      }),
    };
    const digestMaterial = randomBytes(32),
      locatorMaterial = randomBytes(32);
    const accessIndexDigests = {
      digest: (input: {
        purpose: string;
        groupId: string;
        canonicalInput: Uint8Array;
      }) =>
        Promise.resolve({
          digest: importPurposeSeparatedDigest(
            createHmac('sha256', digestMaterial)
              .update(input.purpose)
              .update(input.groupId)
              .update(input.canonicalInput)
              .digest(),
          ),
          digestKeyVersion: 'index-v1',
        }),
    };
    const currentDigest = (input: { canonicalInput: Uint8Array }) =>
      Promise.resolve({
        digest: importPurposeSeparatedDigest(
          createHmac('sha256', locatorMaterial)
            .update(input.canonicalInput)
            .digest(),
        ),
        digestKeyVersion: 'locator-v1',
      });
    const locatorKeys = {
      currentDigest,
      candidateDigests: async (input: { canonicalInput: Uint8Array }) => [
        await currentDigest(input),
      ],
    };
    const stateWriter = new PostgresGroupStateWriter({
      codec: this.groupCodec,
      accessIndexDigests,
      now: () => new Date(this.now),
    });
    const group = {
      codec: this.groupCodec,
      encodeAad: encodeCanonicalAad,
      stateWriter,
      accessIndexDigests,
      locatorKeys,
      now: () => new Date(this.now),
    };
    // 既存Group Commandの実接続も観測し、認証側とのLock待機を決定的に検証する。
    const observedPool = new Proxy(this.pool, {
      get: (pool, key) => {
        if (key === 'connect')
          return async () => {
            const client = await pool.connect();
            const pid = (
              await client.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
              )
            ).rows[0].pid;
            return new Proxy(client, {
              get: (target, method) => {
                if (method === 'query')
                  return (sql: string, values?: unknown[]) => {
                    const event = { sql, values: values ?? [], pid };
                    this.sqls.push(event);
                    return this.intercept(event, () =>
                      target.query(sql, values),
                    );
                  };
                const value: unknown = Reflect.get(target, method);
                return typeof value === 'function'
                  ? (...args: unknown[]) =>
                      (value as (...args: unknown[]) => unknown).apply(
                        target,
                        args,
                      )
                  : value;
              },
            });
          };
        const value: unknown = Reflect.get(pool, key);
        return typeof value === 'function'
          ? (...args: unknown[]) =>
              (value as (...args: unknown[]) => unknown).apply(pool, args)
          : value;
      },
    });
    this.standalone = new PostgresGroupRepository({
      pool: observedPool,
      ...group,
    });
    this.commands = new GroupCommandService(this.standalone, {
      nextGroupId: () => GroupId.from(randomUUID()),
      nextParticipantId: () => ParticipantId.from(randomUUID()),
      nextInvitationId: () => InvitationId.from(randomUUID()),
      nextCloseIntentId: () => CloseIntentId.from(randomUUID()),
      now: () => UtcInstant.from(new Date(this.now)),
    });
    this.proofMaterials = new Map([['proof-v1', randomBytes(32)]]);
    this.proof = {
      ...createRecipientCodeRequestProof({
        keys: {
          readKey: (q) => {
            const material = this.proofMaterials.get(q.keyVersion);
            return Promise.resolve(
              material
                ? {
                    status: 'available' as const,
                    ...q,
                    key: importRecipientCodeRequestProofKey(material),
                  }
                : { status: 'unavailable' as const },
            );
          },
        },
      }),
    };
    const auditMaterials = new Map<string, Uint8Array>();
    const protector = createGroupInvitationAuditProtector({
      keys: {
        readCurrent: ({ scopeId }) => {
          if (!auditMaterials.has(scopeId))
            auditMaterials.set(scopeId, randomBytes(32));
          return Promise.resolve({
            status: 'available' as const,
            scopeId,
            keyVersion: 'audit-v1',
            key: importGroupInvitationAuditKey(auditMaterials.get(scopeId)!),
          });
        },
      },
    });
    this.runtimeOptions = {
      pool: this.connections(),
      authentication: {
        codec: this.authCodec,
        digests: this.digests,
        crypto: this.crypto,
        stateKeys: {
          allocate: (input) => {
            const k = `${input.codeId}/${input.keyVersion}`;
            if (this.allocations.has(k))
              return Promise.resolve(
                this.allocations.get(k) === input.expiresAt
                  ? { status: 'allocated' as const, ...input, created: false }
                  : { status: 'unavailable' as const },
              );
            this.allocations.set(k, input.expiresAt);
            this.codeMaterials.set(
              `auth-recipient-code-state/v1/${k}`,
              randomBytes(32),
            );
            return Promise.resolve({
              status: 'allocated' as const,
              ...input,
              created: true,
            });
          },
        },
      },
      group: {
        ...group,
        auditWriter: new PostgresGroupInvitationAuditWriter({
          protector,
          now: () => new Date(this.now),
        }),
      },
      proof: this.proof,
      nextInvitationId: () => InvitationId.from(randomUUID()),
      clock: this.clock,
      limits: {
        lockTimeoutMs: 1500,
        statementTimeoutMs: 3000,
        transactionTimeoutMs: 10000,
      },
      onAlert: this.alerts,
    };
    this.runtime = createRecipientInvitationRuntime(this.runtimeOptions);
    for (const actor of Object.values(actors)) await this.setActor(actor);
    for (const [i, actor] of Object.values(actors).entries())
      await this.addSession(actor, (i + 1) * 10);
    await this.addSession(actors.owner, 50);
    await this.seed(this.groupId, actors.owner);
    await this.seed(this.otherGroupId, actors.otherOwner);
    this.sqls = [];
    this.released = [];
  }
  /** @param id 検証対象Actor。@param state 正しいMAC付き状態。@param connection 先行Actor Lockを所有する接続。 */
  async setActor(
    id: string,
    state: 'active' | 'disabled' = 'active',
    connection: Pick<Client, 'query'> = this.admin,
  ): Promise<void> {
    const row = {
      actorId: id,
      state,
      version: state === 'active' ? 1 : 2,
      createdAt: 0,
      disabledAt: state === 'active' ? null : this.now,
    };
    const mac = await this.digests.actorState({ row, keyVersion: 'v1' });
    await connection.query(
      "INSERT INTO authentication.actor(actor_id,state,version,created_at_ms,disabled_at_ms,control_key_version,state_mac) VALUES($1,$2,$3,0,$4,'v1',$5) ON CONFLICT(actor_id) DO UPDATE SET state=$2,version=$3,disabled_at_ms=$4,state_mac=$5",
      [id, state, row.version, row.disabledAt, Buffer.from(mac.bytes)],
    );
  }
  /** @param actorId 実認証済み合成Actor。@param byte 秘密値の識別子。@returns Session参照。 */
  async addSession(actorId: string, byte: number): Promise<string> {
    const sessionId = `20000000-0000-4000-8000-${String(byte).padStart(12, '0')}`;
    const digest = await this.digests.sessionCookie({
      secret: sessionSecret(byte),
      epoch: ids.epoch,
      keyVersion: 'v1',
    });
    const row: AuthenticationSessionRow = {
      recordKind: 'session',
      sessionId,
      actorId,
      version: 1,
      epoch: ids.epoch,
      createdAt: this.now - 1000,
      absoluteExpiresAt: this.now + 604799000,
      idleExpiresAt: this.now + 86400000,
      state: 'active',
      terminalAt: null,
      cookieDigestKeyVersion: 'v1',
      cookieDigest: digest.bytes,
    };
    await insertAuthenticationRecord(
      this.admin,
      row,
      await this.authCodec.seal({
        row,
        secrets: { csrf: sessionSecret(byte + 1) },
      }),
    );
    return sessionId;
  }
  /** @param byte Session合成識別子。正しいEnvelope/CASでlogoutを模す。 */
  async revokeSession(byte = 10): Promise<void> {
    const id = `20000000-0000-4000-8000-${String(byte).padStart(12, '0')}`;
    const stored = readStoredAuthenticationSession(
      (
        await this.admin.query(
          'SELECT * FROM authentication.session_record WHERE session_id=$1',
          [id],
        )
      ).rows[0],
    );
    const row = {
      ...stored.row,
      version: stored.row.version + 1,
      state: 'revoked' as const,
      terminalAt: this.now,
    };
    const secrets = await this.authCodec.open(stored);
    await updateAuthenticationRecord(
      this.admin,
      row,
      await this.authCodec.seal({ row, secrets }),
      stored.row.version,
    );
  }
  /** @param id Group参照。@param actor Owner。初期Participantだけを保存する。 */
  async seed(id: GroupId, actor: string): Promise<void> {
    const at = UtcInstant.from(new Date(this.now)),
      participantId = ParticipantId.from(randomUUID());
    const actorSubject = ActorSubject.from(actor);
    const group = Group.create({
      id,
      creatorSubject: actorSubject,
      initialParticipantId: participantId,
      createdAt: at,
    });
    expect(
      await this.standalone.commit({
        group,
        expectedVersion: 'Absent',
        stateChanged: true,
        membershipChanges: [{ kind: 'Joined', participantId, at }],
        invitationChanges: [],
        groupCloseChanges: [],
        operation: {
          actorSubject,
          operationId: OperationId.from(`seed-${id.value}`),
          fingerprint: CommandFingerprint.from(`seed-${id.value}`),
        },
        result: { kind: 'GroupCreated', groupId: id, participantId },
      }),
    ).toMatchObject({ kind: 'Committed' });
  }
  /** @returns 実Storeで発行しcommit済みの本人コード。 */
  async issue() {
    const r = await this.runtime.issue(sessionSecret(20), this.clock);
    expect(r.status).toBe('issued');
    if (r.status !== 'issued') throw new Error('合成: 発行失敗');
    return r;
  }
  /** @returns MACを検証可能な現在コード行。 */
  async codes() {
    return (
      await this.admin.query(
        'SELECT * FROM authentication.recipient_code ORDER BY code_id',
      )
    ).rows.map(readRecipientCode);
  }
  /** @returns 全業務Tableのbyte同一性を確認する。許可される認証確認Audit/idle更新は別検証。 */
  async snapshot() {
    const names = [
      'group_aggregate_record',
      'group_participant_record',
      'group_invitation_record',
      'group_membership_history_record',
      'group_invitation_history_record',
      'group_operation_result_record',
      'group_actor_access_index',
      'group_operation_locator_v2',
      'group_recipient_invitation_audit_record',
      'authentication.recipient_code',
    ];
    const result: Record<string, unknown> = {};
    for (const name of names)
      result[name] = (
        await this.admin.query(
          `SELECT to_jsonb(t) AS row FROM ${name} t ORDER BY to_jsonb(t)::text`,
        )
      ).rows;
    result.consumeAudit = (
      await this.admin.query(
        "SELECT to_jsonb(t) AS row FROM authentication.audit_event t WHERE action::text='recipient-code-consume' ORDER BY event_id",
      )
    ).rows;
    return result;
  }
  /** @param pid 待機者。@param blocker 先行接続。実Lock待機だけを認める。 */
  async waitBlocked(pid: number, blocker: number): Promise<void> {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (
        (
          await this.admin.query<{ pids: number[] }>(
            'SELECT pg_blocking_pids($1) AS pids',
            [pid],
          )
        ).rows[0].pids.includes(blocker)
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('合成: 実接続間のLock待機なし');
  }
  /** @returns 実装と同じ部品を負例だけのCallbackへ接続するTest-only能力。 */
  components() {
    const o = this.runtimeOptions;
    const scopes = createRecipientCodeTransactionScopes(
      createAuthenticationTransactionScopes(),
    );
    const repository = createEnlistedGroupRepository({
      ...o.group,
      registerGroupParticipant: (r) => scopes.registerGroupParticipant(r),
    });
    const consume = createPostgresRecipientCodeConsumer({
      participants: scopes.scopes.participants,
      ...o.authentication,
    });
    const leases = createPostgresRecipientCodeLeases({
      pool: o.pool,
      scopes,
      ...o.authentication,
      limits: o.limits,
      consume,
      onAlert: this.alerts,
    });
    return { scopes, repository, leases };
  }
  /** 所有Schema/Poolだけを片付け、他Suiteを変更しない。 */
  async dispose(): Promise<void> {
    await this.pool?.end();
    if (this.owned) {
      await this.admin.query('SET search_path TO public');
      await this.admin.query('DROP SCHEMA authentication CASCADE');
      await this.admin.query(`DROP SCHEMA ${this.schema} CASCADE`);
    }
    await this.admin.end();
    expect(this.unexpectedErrors).toEqual([]);
  }
}
