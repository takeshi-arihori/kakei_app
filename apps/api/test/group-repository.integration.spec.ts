import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createProtectedRecordCodec,
  encodeCanonicalAad,
  importProtectedRecordKey,
  importPurposeSeparatedDigest,
} from '@kakei/protected-record';
import { Client, Pool, type PoolClient } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  type GroupPolicyDigestPort,
  type GroupOperationLocatorKeyPort,
} from '../src/group-management/application/group-access-policy.js';
import {
  CommandFingerprint,
  OperationId,
  type CommitGroupRequest,
} from '../src/group-management/application/group-repository.js';
import {
  ActorSubject,
  CloseIntentId,
  Group,
  GroupId,
  ParticipantId,
  UtcInstant,
} from '../src/group-management/domain/group.js';
import { PostgresGroupRepository } from '../src/group-management/infrastructure/postgres/group-repository.js';
import { PostgresGroupStateWriter } from '../src/group-management/infrastructure/postgres/group-state-writer.js';
import {
  applySqlMigrations,
  type SqlMigration,
} from '../src/group-management/infrastructure/postgres/sql-migration.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';
const actor = ActorSubject.from('repository-integration-actor');
const participantId = ParticipantId.from(
  '00000000-0000-4000-8000-000000000196',
);
const now = UtcInstant.from(new Date('2026-09-24T00:00:00.000Z'));
const loadMigration = async (version: 1 | 2 | 3): Promise<SqlMigration> => ({
  version,
  name:
    version === 1
      ? 'group-management-storage'
      : version === 2
        ? 'group-locator-v2'
        : 'close-intent-registry',
  sql: await readFile(
    resolve(
      import.meta.dirname,
      `../migrations/group-management/000${version}_${version === 1 ? 'group_management_storage' : version === 2 ? 'group_locator_v2' : 'close_intent_registry'}.sql`,
    ),
    'utf8',
  ),
});

const digestPort: GroupPolicyDigestPort = {
  digest(input) {
    return Promise.resolve({
      digest: importPurposeSeparatedDigest(
        createHash('sha256')
          .update(input.purpose)
          .update(input.groupId)
          .update(input.canonicalInput)
          .digest(),
      ),
      digestKeyVersion: 'test-access-v1',
    });
  },
};

const locatorKeys = (): GroupOperationLocatorKeyPort => {
  const digest = (
    input: Parameters<GroupOperationLocatorKeyPort['currentDigest']>[0],
  ) => importPurposeSeparatedDigest(Buffer.from(input.canonicalInput));
  return {
    currentDigest(input) {
      return Promise.resolve({
        digest: digest(input),
        digestKeyVersion: 'test-locator-v1',
      });
    },
    candidateDigests(input) {
      return Promise.resolve([
        {
          digest: digest(input),
          digestKeyVersion: 'test-locator-v1',
        },
      ]);
    },
  };
};

describe('PostgresGroupRepository', () => {
  const admin = new Pool({ connectionString: TEST_DATABASE_URL });
  let sequence = 0;
  let schemaName = '';
  let pool: Pool;
  let repository: PostgresGroupRepository;
  let stateWriter: PostgresGroupStateWriter;
  let codec: ReturnType<typeof createProtectedRecordCodec>;
  let recordCounter = 0;

  beforeAll(async () => {
    await admin.query('SELECT 1');
  });

  beforeEach(async () => {
    schemaName = `test_issue_96_${process.pid}_${sequence++}`;
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`SET search_path TO ${schemaName}`);
      await applySqlMigrations(client, [
        await loadMigration(1),
        await loadMigration(2),
        await loadMigration(3),
      ]);
    } finally {
      await client.end();
    }
    pool = new Pool({
      connectionString: TEST_DATABASE_URL,
      options: `-c search_path=${schemaName}`,
    });
    await pool.query(
      "UPDATE group_operation_locator_key_state SET current_key_version = 'test-locator-v1' WHERE id = 1",
    );
    recordCounter = 0;
    const dataKey = importProtectedRecordKey(new Uint8Array(32).fill(96));
    let sealCount = 0;
    codec = createProtectedRecordCodec({
      keyPort: {
        allocateForSeal() {
          sealCount += 1;
          return Promise.resolve({
            status: 'allocated' as const,
            key: dataKey,
            keyVersion: 'test-data-v1',
            nonce: randomBytes(12),
            sealCount: BigInt(sealCount),
          });
        },
        readKey() {
          return Promise.resolve({
            status: 'available' as const,
            key: dataKey,
            lifecycle: 'current' as const,
          });
        },
        async requestRotation() {},
      },
    });
    stateWriter = new PostgresGroupStateWriter({
      codec,
      accessIndexDigests: digestPort,
      now: () => new Date('2026-09-24T01:00:00.000Z'),
      nextRecordId: () => {
        recordCounter += 1;
        return `00000000-0000-4000-8000-${String(recordCounter).padStart(12, '0')}`;
      },
    });
    repository = new PostgresGroupRepository({
      pool,
      stateWriter,
      codec,
      encodeAad: encodeCanonicalAad,
      locatorKeys: locatorKeys(),
      accessIndexDigests: digestPort,
      now: () => new Date('2026-09-24T01:00:00.000Z'),
      nextRecordId: () => {
        recordCounter += 1;
        return `00000000-0000-4000-8000-${String(recordCounter).padStart(12, '0')}`;
      },
    });
  });

  afterEach(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  });

  afterAll(async () => {
    await admin.end();
  });

  it('state, operation result, access index and locator commit together', async () => {
    const groupId = GroupId.from('00000000-0000-4000-8000-000000000296');
    const group = Group.create({
      id: groupId,
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    const operationId = OperationId.from('create-group-96');
    const request: CommitGroupRequest = {
      group,
      expectedVersion: 'Absent',
      stateChanged: true,
      membershipChanges: [{ kind: 'Joined', participantId, at: now }],
      invitationChanges: [],
      groupCloseChanges: [],
      operation: {
        actorSubject: actor,
        operationId,
        fingerprint: CommandFingerprint.from('["CreateGroup"]'),
      },
      result: { kind: 'GroupCreated', groupId, participantId },
    };

    await expect(repository.commit(request)).resolves.toMatchObject({
      kind: 'Committed',
      result: { kind: 'GroupCreated', groupId, participantId, version: 1 },
    });
    await expect(repository.load(groupId)).resolves.toMatchObject({
      version: 1,
      group: { id: groupId },
    });
    await expect(
      repository.findOperation(actor, operationId),
    ).resolves.toMatchObject({
      kind: 'Found',
      operation: { fingerprint: request.operation.fingerprint },
    });
    await expect(repository.commit(request)).resolves.toMatchObject({
      kind: 'Committed',
      result: { kind: 'GroupCreated', version: 1 },
    });
    await expect(
      repository.commit({
        ...request,
        operation: {
          ...request.operation,
          fingerprint: CommandFingerprint.from('["CreateGroup","different"]'),
        },
      }),
    ).resolves.toEqual({ kind: 'OperationMismatch' });
    const rows = await pool.query<{ count: string }>(
      `SELECT (
         (SELECT count(*) FROM group_operation_result_record) +
         (SELECT count(*) FROM group_operation_locator_v2) +
         (SELECT count(*) FROM group_actor_access_index)
       )::text AS count`,
    );
    expect(rows.rows).toEqual([{ count: '3' }]);
  });

  it('SQL locator key-state版とdigest key版が違う場合はfail-closedで書き込まない', async () => {
    await pool.query(
      "UPDATE group_operation_locator_key_state SET current_key_version = 'unexpected-v2' WHERE id = 1",
    );
    const groupId = GroupId.from('00000000-0000-4000-8000-000000000421');
    const group = Group.create({
      id: groupId,
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    const outcome = await repository.commit({
      group,
      expectedVersion: 'Absent',
      stateChanged: true,
      membershipChanges: [],
      invitationChanges: [],
      groupCloseChanges: [],
      operation: {
        actorSubject: actor,
        operationId: OperationId.from('key-state-mismatch'),
        fingerprint: CommandFingerprint.from('key-state-mismatch'),
      },
      result: { kind: 'GroupCreated', groupId, participantId },
    });
    expect(outcome).toEqual({ kind: 'Unavailable' });
    const rows = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM group_aggregate_record',
    );
    expect(rows.rows).toEqual([{ count: '0' }]);
  });

  it('state writer障害時は先に登録したCloseIntent registryをrollbackする', async () => {
    const groupId = GroupId.from('00000000-0000-4000-8000-000000000424');
    const closeIntentId = CloseIntentId.from(
      '00000000-0000-4000-8000-000000000425',
    );
    const group = Group.create({
      id: groupId,
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    const closing = group.startClosing({
      actorSubject: actor,
      closeIntentId,
      cutoff: now,
    });
    const failingRepository = new PostgresGroupRepository({
      pool,
      stateWriter: {
        persist: () => Promise.resolve({ kind: 'Unavailable' as const }),
      },
      codec,
      encodeAad: encodeCanonicalAad,
      locatorKeys: locatorKeys(),
      accessIndexDigests: digestPort,
    });

    await expect(
      failingRepository.commit({
        group: closing.group,
        expectedVersion: 'Absent',
        stateChanged: true,
        membershipChanges: [],
        invitationChanges: [],
        groupCloseChanges: [
          {
            kind: 'ClosingStarted',
            closeIntentId,
            cutoff: now,
            startedBy: actor,
            startedFromVersion: 1,
          },
        ],
        operation: {
          actorSubject: actor,
          operationId: OperationId.from('injected-state-writer-failure'),
          fingerprint: CommandFingerprint.from('injected-state-writer-failure'),
        },
        result: { kind: 'GroupClosingStarted', groupId, closeIntentId },
      }),
    ).resolves.toEqual({ kind: 'Unavailable' });
    const rows = await pool.query<{ groups: string; registry: string }>(
      `SELECT
         (SELECT count(*) FROM group_aggregate_record)::text AS groups,
         (SELECT count(*) FROM group_close_intent_registry)::text AS registry`,
    );
    expect(rows.rows).toEqual([{ groups: '0', registry: '0' }]);
  });

  it('locator書込み障害時は先行したregistryとGroup状態をtransaction rollbackする', async () => {
    await pool.query(`
      CREATE FUNCTION fail_locator_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected locator failure';
      END
      $$;
      CREATE TRIGGER injected_locator_failure
      BEFORE INSERT ON group_operation_locator_v2
      FOR EACH ROW EXECUTE FUNCTION fail_locator_insert();
    `);
    const groupId = GroupId.from('00000000-0000-4000-8000-000000000422');
    const closeIntentId = CloseIntentId.from(
      '00000000-0000-4000-8000-000000000423',
    );
    const group = Group.create({
      id: groupId,
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    const closing = group.startClosing({
      actorSubject: actor,
      closeIntentId,
      cutoff: now,
    });
    const outcome = await repository.commit({
      group: closing.group,
      expectedVersion: 'Absent',
      stateChanged: true,
      membershipChanges: [],
      invitationChanges: [],
      groupCloseChanges: [
        {
          kind: 'ClosingStarted',
          closeIntentId,
          cutoff: now,
          startedBy: actor,
          startedFromVersion: 1,
        },
      ],
      operation: {
        actorSubject: actor,
        operationId: OperationId.from('injected-locator-failure'),
        fingerprint: CommandFingerprint.from('injected-locator-failure'),
      },
      result: { kind: 'GroupClosingStarted', groupId, closeIntentId },
    });
    expect(outcome).toEqual({ kind: 'Unavailable' });
    const rows = await pool.query<{ groups: string; registry: string }>(
      `SELECT
         (SELECT count(*) FROM group_aggregate_record)::text AS groups,
         (SELECT count(*) FROM group_close_intent_registry)::text AS registry`,
    );
    expect(rows.rows).toEqual([{ groups: '0', registry: '0' }]);
  });

  it('registry書込み障害はGroup状態writerを呼ばずUnavailableへ収束する', async () => {
    await pool.query(`
      CREATE FUNCTION fail_close_registry_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected registry failure';
      END
      $$;
      CREATE TRIGGER injected_registry_failure
      BEFORE INSERT ON group_close_intent_registry
      FOR EACH ROW EXECUTE FUNCTION fail_close_registry_insert();
    `);
    const groupId = GroupId.from('00000000-0000-4000-8000-000000000426');
    const closeIntentId = CloseIntentId.from(
      '00000000-0000-4000-8000-000000000427',
    );
    const group = Group.create({
      id: groupId,
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    const closing = group.startClosing({
      actorSubject: actor,
      closeIntentId,
      cutoff: now,
    });
    const outcome = await repository.commit({
      group: closing.group,
      expectedVersion: 'Absent',
      stateChanged: true,
      membershipChanges: [],
      invitationChanges: [],
      groupCloseChanges: [
        {
          kind: 'ClosingStarted',
          closeIntentId,
          cutoff: now,
          startedBy: actor,
          startedFromVersion: 1,
        },
      ],
      operation: {
        actorSubject: actor,
        operationId: OperationId.from('injected-registry-failure'),
        fingerprint: CommandFingerprint.from('injected-registry-failure'),
      },
      result: { kind: 'GroupClosingStarted', groupId, closeIntentId },
    });
    expect(outcome).toEqual({ kind: 'Unavailable' });
    const rows = await pool.query<{ groups: string; registry: string }>(
      `SELECT
         (SELECT count(*) FROM group_aggregate_record)::text AS groups,
         (SELECT count(*) FROM group_close_intent_registry)::text AS registry`,
    );
    expect(rows.rows).toEqual([{ groups: '0', registry: '0' }]);
  });

  it('別Actorなら同じoperation IDを独立して使用できる', async () => {
    const createRequest = (
      id: string,
      actorSubject: ActorSubject,
    ): CommitGroupRequest => {
      const groupId = GroupId.from(id);
      const group = Group.create({
        id: groupId,
        creatorSubject: actorSubject,
        initialParticipantId: participantId,
        createdAt: now,
      });
      return {
        group,
        expectedVersion: 'Absent',
        stateChanged: true,
        membershipChanges: [],
        invitationChanges: [],
        groupCloseChanges: [],
        operation: {
          actorSubject,
          operationId: OperationId.from('shared-operation-id'),
          fingerprint: CommandFingerprint.from(`create:${id}`),
        },
        result: { kind: 'GroupCreated', groupId, participantId },
      };
    };

    const first = createRequest('00000000-0000-4000-8000-000000000401', actor);
    const otherActor = ActorSubject.from('repository-integration-other-actor');
    const second = createRequest(
      '00000000-0000-4000-8000-000000000402',
      otherActor,
    );
    await expect(repository.commit(first)).resolves.toMatchObject({
      kind: 'Committed',
    });
    await expect(repository.commit(second)).resolves.toMatchObject({
      kind: 'Committed',
    });
  });

  it('同じlocatorを別Groupから同時作成した競合は一方をrollbackし照合する', async () => {
    const createRequest = (
      id: string,
      fingerprint: string,
    ): CommitGroupRequest => {
      const groupId = GroupId.from(id);
      const group = Group.create({
        id: groupId,
        creatorSubject: actor,
        initialParticipantId: participantId,
        createdAt: now,
      });
      return {
        group,
        expectedVersion: 'Absent',
        stateChanged: true,
        membershipChanges: [],
        invitationChanges: [],
        groupCloseChanges: [],
        operation: {
          actorSubject: actor,
          operationId: OperationId.from('concurrent-operation-id'),
          fingerprint: CommandFingerprint.from(fingerprint),
        },
        result: { kind: 'GroupCreated', groupId, participantId },
      };
    };

    const outcomes = await Promise.all([
      repository.commit(
        createRequest('00000000-0000-4000-8000-000000000411', 'first-payload'),
      ),
      repository.commit(
        createRequest('00000000-0000-4000-8000-000000000412', 'second-payload'),
      ),
    ]);
    expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
      'Committed',
      'OperationMismatch',
    ]);
    const groups = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM group_aggregate_record',
    );
    expect(groups.rows).toEqual([{ count: '1' }]);
    const locators = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM group_operation_locator_v2',
    );
    expect(locators.rows).toEqual([{ count: '1' }]);
  });

  it('COMMIT後に応答が失われても再送で保存済み結果を回復する', async () => {
    const lostResponsePool = {
      query: pool.query.bind(pool),
      async connect() {
        const connection = await pool.connect();
        return {
          async query(sql: string, values?: readonly unknown[]) {
            const result = await connection.query(sql, values as never);
            if (sql === 'COMMIT') {
              throw new Error('injected lost commit response');
            }
            return result;
          },
          release: connection.release.bind(connection),
        } as unknown as PoolClient;
      },
    } as unknown as Pick<Pool, 'connect' | 'query'>;
    const lostResponseRepository = new PostgresGroupRepository({
      pool: lostResponsePool,
      stateWriter,
      codec,
      encodeAad: encodeCanonicalAad,
      locatorKeys: locatorKeys(),
      accessIndexDigests: digestPort,
    });
    const groupId = GroupId.from('00000000-0000-4000-8000-000000000431');
    const group = Group.create({
      id: groupId,
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    const request: CommitGroupRequest = {
      group,
      expectedVersion: 'Absent',
      stateChanged: true,
      membershipChanges: [],
      invitationChanges: [],
      groupCloseChanges: [],
      operation: {
        actorSubject: actor,
        operationId: OperationId.from('lost-commit-response'),
        fingerprint: CommandFingerprint.from('lost-commit-response'),
      },
      result: { kind: 'GroupCreated', groupId, participantId },
    };

    await expect(lostResponseRepository.commit(request)).resolves.toEqual({
      kind: 'Unavailable',
    });
    await expect(repository.commit(request)).resolves.toMatchObject({
      kind: 'Committed',
      result: { kind: 'GroupCreated', version: 1 },
    });
  });

  it('CloseIntentIdはglobal一意で、他Groupによる再利用を拒否する', async () => {
    const closeIntentId = CloseIntentId.from(
      '00000000-0000-4000-8000-000000000397',
    );
    const createClosingRequest = (suffix: string): CommitGroupRequest => {
      const groupId = GroupId.from(`00000000-0000-4000-8000-${suffix}`);
      const group = Group.create({
        id: groupId,
        creatorSubject: actor,
        initialParticipantId: participantId,
        createdAt: now,
      });
      const closing = group.startClosing({
        actorSubject: actor,
        closeIntentId,
        cutoff: now,
      });
      return {
        group: closing.group,
        expectedVersion: 'Absent',
        stateChanged: true,
        membershipChanges: [],
        invitationChanges: [],
        groupCloseChanges: [
          {
            kind: 'ClosingStarted',
            closeIntentId,
            cutoff: now,
            startedBy: actor,
            startedFromVersion: 1,
          },
        ],
        operation: {
          actorSubject: actor,
          operationId: OperationId.from(`close-${suffix}`),
          fingerprint: CommandFingerprint.from(`close:${suffix}`),
        },
        result: { kind: 'GroupClosingStarted', groupId, closeIntentId },
      };
    };

    await expect(
      repository.commit(createClosingRequest('000000000397')),
    ).resolves.toMatchObject({
      kind: 'Committed',
    });
    await expect(
      repository.commit(createClosingRequest('000000000398')),
    ).resolves.toEqual({
      kind: 'CloseIntentAlreadyExists',
    });
    const registry = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM group_close_intent_registry',
    );
    expect(registry.rows).toEqual([{ count: '1' }]);
  });
});
