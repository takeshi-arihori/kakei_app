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

import { type GroupPolicyDigestPort } from '../src/group-management/application/group-access-policy.js';
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
import { PostgresGroupAccessPolicy } from '../src/group-management/infrastructure/postgres/group-access-policy.js';
import { PostgresGroupStateWriter } from '../src/group-management/infrastructure/postgres/group-state-writer.js';
import {
  applySqlMigrations,
  type SqlMigration,
} from '../src/group-management/infrastructure/postgres/sql-migration.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';
const actor = ActorSubject.from('group-policy-integration-actor');
const participantId = ParticipantId.from(
  '00000000-0000-4000-8000-000000000197',
);
const now = UtcInstant.from(new Date('2026-09-24T00:00:00.000Z'));

const createDeferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

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

const requestFor = (
  group: Group,
  expectedVersion: number | 'Absent',
): CommitGroupRequest => ({
  group,
  expectedVersion,
  stateChanged: true,
  membershipChanges: [],
  invitationChanges: [],
  groupCloseChanges: [],
  operation: {
    actorSubject: actor,
    operationId: OperationId.from(`policy-${group.id.value}`),
    fingerprint: CommandFingerprint.from(`fingerprint-${group.id.value}`),
  },
  result: {
    kind: 'GroupCreated',
    groupId: group.id,
    participantId,
  },
});

describe('PostgresGroupAccessPolicy', () => {
  const admin = new Pool({ connectionString: TEST_DATABASE_URL });
  let schemaName = '';
  let sequence = 0;
  let pool: Pool;
  let codec: ReturnType<typeof createProtectedRecordCodec>;
  let stateWriter: PostgresGroupStateWriter;
  let adapter: PostgresGroupAccessPolicy;
  let recordCounter = 0;
  let openCount = 0;

  beforeAll(async () => {
    await admin.query('SELECT 1');
  });

  beforeEach(async () => {
    schemaName = `test_issue_97_${process.pid}_${sequence++}`;
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    const migrationClient = new Client({ connectionString: TEST_DATABASE_URL });
    await migrationClient.connect();
    try {
      await migrationClient.query(`SET search_path TO ${schemaName}`);
      await applySqlMigrations(migrationClient, [
        await loadMigration(1),
        await loadMigration(2),
        await loadMigration(3),
      ]);
    } finally {
      await migrationClient.end();
    }

    pool = new Pool({
      connectionString: TEST_DATABASE_URL,
      max: 6,
      options: `-c search_path=${schemaName}`,
    });
    const dataKey = importProtectedRecordKey(new Uint8Array(32).fill(97));
    let sealCount = 0;
    openCount = 0;
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
          openCount += 1;
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
    recordCounter = 0;
    adapter = new PostgresGroupAccessPolicy({
      pool,
      stateWriter,
      codec,
      encodeAad: encodeCanonicalAad,
      accessIndexDigests: digestPort,
    });
  });

  afterEach(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  });

  afterAll(async () => {
    await admin.end();
  });

  const persistGroup = async (group: Group): Promise<void> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const persisted = await stateWriter.persist(
        client,
        requestFor(group, 'Absent'),
      );
      expect(persisted.kind).toBe('Committed');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  };

  const seedGroup = async (
    id: string,
    creator: ActorSubject = actor,
  ): Promise<Group> => {
    const group = Group.create({
      id: GroupId.from(id),
      creatorSubject: creator,
      initialParticipantId: participantId,
      createdAt: now,
    });
    await persistGroup(group);
    return group;
  };

  it('index miss時はdata keyを読まず、callbackも実行しない', async () => {
    await seedGroup('00000000-0000-4000-8000-000000000197');
    const result = await adapter.withSnapshotRead({
      groupId: GroupId.from('00000000-0000-4000-8000-000000000197'),
      actorSubject: ActorSubject.from('not-a-member'),
      callback: () => {
        throw new Error('callback must not run');
      },
    });

    expect(result).toEqual({ kind: 'Unavailable' });
    expect(openCount).toBe(0);
  });

  it('再参加者の固定policyは旧Participant IDから業務参照権限を継承しない', async () => {
    const rejoiningActor = ActorSubject.from('rejoined-policy-actor');
    const oldParticipantId = ParticipantId.from(
      '00000000-0000-4000-8000-000000000207',
    );
    const currentParticipantId = ParticipantId.from(
      '00000000-0000-4000-8000-000000000208',
    );
    const initial = Group.create({
      id: GroupId.from('00000000-0000-4000-8000-000000000209'),
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    const group = Group.restore({
      ...initial.toSnapshot(),
      accessPolicyVersion: 2,
      participants: [
        ...initial.participants,
        {
          id: oldParticipantId,
          subject: rejoiningActor,
          joinedAt: now,
          joinOrder: 2,
          status: 'Left',
          leftAt: now,
        },
        {
          id: currentParticipantId,
          subject: rejoiningActor,
          joinedAt: now,
          joinOrder: 3,
          status: 'Active',
          leftAt: null,
        },
      ],
    });
    await persistGroup(group);

    const result = await adapter.withSnapshotRead({
      groupId: group.id,
      actorSubject: rejoiningActor,
      callback: (access) => {
        const common = {
          requiredApproverParticipantIds: [],
          paymentPayerParticipantId: null,
          paymentPayeeParticipantId: null,
          allocationParticipantIds: [],
        };
        expect(
          access.canReadSnapshot({
            ...common,
            requesterParticipantId: currentParticipantId,
            expensePayerParticipantId: null,
          }),
        ).toBe(true);
        expect(
          access.canReadSnapshot({
            ...common,
            requesterParticipantId: null,
            expensePayerParticipantId: oldParticipantId,
          }),
        ).toBe(false);
        return Promise.resolve({
          kind: 'Allowed',
          value: 'current-membership-only',
          involvement: {
            ...common,
            requesterParticipantId: currentParticipantId,
            expensePayerParticipantId: null,
          },
        });
      },
    });

    expect(result).toEqual({
      kind: 'Allowed',
      value: 'current-membership-only',
    });
  });

  it('callback denialと不許可involvementはpayloadを返さない', async () => {
    const groupId = GroupId.from('00000000-0000-4000-8000-000000000210');
    const initial = Group.create({
      id: groupId,
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    const otherSubject = ActorSubject.from('other-active-member');
    const otherParticipantId = ParticipantId.from(
      '00000000-0000-4000-8000-000000000215',
    );
    const group = Group.restore({
      ...initial.toSnapshot(),
      participants: [
        ...initial.toSnapshot().participants,
        {
          id: otherParticipantId,
          subject: otherSubject,
          joinedAt: now,
          joinOrder: 2,
          status: 'Active',
          leftAt: null,
        },
      ],
    });
    await persistGroup(group);
    const denied = await adapter.withSnapshotRead({
      groupId: group.id,
      actorSubject: actor,
      callback: () => Promise.resolve({ kind: 'Denied' }),
    });
    const unauthorized = await adapter.withSnapshotRead({
      groupId: group.id,
      actorSubject: otherSubject,
      callback: () =>
        Promise.resolve({
          kind: 'Allowed',
          value: 'must-not-escape',
          involvement: {
            requesterParticipantId: ParticipantId.from(
              '00000000-0000-4000-8000-000000000211',
            ),
            requiredApproverParticipantIds: [],
            paymentPayerParticipantId: null,
            paymentPayeeParticipantId: null,
            expensePayerParticipantId: null,
            allocationParticipantIds: [],
          },
        }),
    });

    expect(denied).toEqual({ kind: 'Unavailable' });
    expect(unauthorized).toEqual({ kind: 'Unavailable' });
  });

  it('data-key failureはcallbackを起動せずUnavailableでfail-closedする', async () => {
    const group = await seedGroup('00000000-0000-4000-8000-000000000212');
    const failingAdapter = new PostgresGroupAccessPolicy({
      pool,
      stateWriter,
      codec: { open: () => Promise.reject(new Error('key unavailable')) },
      encodeAad: encodeCanonicalAad,
      accessIndexDigests: digestPort,
    });
    let callbackCalled = false;
    const result = await failingAdapter.withSnapshotRead({
      groupId: group.id,
      actorSubject: actor,
      callback: () => {
        callbackCalled = true;
        return Promise.resolve({
          kind: 'Allowed',
          value: 'must-not-escape',
          involvement: {
            requesterParticipantId: participantId,
            requiredApproverParticipantIds: [],
            paymentPayerParticipantId: null,
            paymentPayeeParticipantId: null,
            expensePayerParticipantId: null,
            allocationParticipantIds: [],
          },
        });
      },
    });

    expect(result).toEqual({ kind: 'Unavailable' });
    expect(callbackCalled).toBe(false);
  });

  it('FOR SHAREで固定したpolicyをcallback完了まで保持し、payloadを再認可後に返す', async () => {
    const groupId = GroupId.from('00000000-0000-4000-8000-000000000198');
    await seedGroup(groupId.value);
    const locked = createDeferred();
    const finish = createDeferred();
    const read = adapter.withSnapshotRead({
      groupId,
      actorSubject: actor,
      callback: async (access) => {
        expect(access.groupVersion).toBe(1);
        expect(access.accessPolicyVersion).toBe(1);
        expect(
          access.canReadSnapshot({
            requesterParticipantId: participantId,
            requiredApproverParticipantIds: [],
            paymentPayerParticipantId: null,
            paymentPayeeParticipantId: null,
            expensePayerParticipantId: null,
            allocationParticipantIds: [],
          }),
        ).toBe(true);
        locked.resolve();
        await finish.promise;
        return {
          kind: 'Allowed',
          value: 'snapshot-payload',
          involvement: {
            requesterParticipantId: participantId,
            requiredApproverParticipantIds: [],
            paymentPayerParticipantId: null,
            paymentPayeeParticipantId: null,
            expensePayerParticipantId: null,
            allocationParticipantIds: [],
          },
        };
      },
    });

    await locked.promise;
    const competing = new Client({
      connectionString: TEST_DATABASE_URL,
      options: `-c search_path=${schemaName}`,
    });
    await competing.connect();
    try {
      await expect(
        competing.query(
          `SELECT group_id FROM group_aggregate_record WHERE group_id = $1 FOR UPDATE NOWAIT`,
          [groupId.value],
        ),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      finish.resolve();
      await competing.end();
    }
    await expect(read).resolves.toEqual({
      kind: 'Allowed',
      value: 'snapshot-payload',
    });
  });

  it('別Groupへのmutationはsnapshot read lockを待たず、Closing/Archivedのmutation callbackは実行しない', async () => {
    const readGroup = Group.create({
      id: GroupId.from('00000000-0000-4000-8000-000000000202'),
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    const differentGroup = Group.create({
      id: GroupId.from('00000000-0000-4000-8000-000000000203'),
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    const closingBase = Group.create({
      id: GroupId.from('00000000-0000-4000-8000-000000000205'),
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    const closing = closingBase.startClosing({
      actorSubject: actor,
      closeIntentId: CloseIntentId.from('00000000-0000-4000-8000-000000000204'),
      cutoff: now,
    }).group;
    const archivedBase = Group.create({
      id: GroupId.from('00000000-0000-4000-8000-000000000206'),
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    const archived = Group.restore({
      ...archivedBase.toSnapshot(),
      status: 'Archived',
      ownerParticipantId: null,
      ownerAtArchiveParticipantId: participantId,
      accessPolicyVersion: 2,
      archivedAt: now,
      deleteEligibleAt: now.plusCalendarYearInTokyo(),
    });
    await persistGroup(readGroup);
    await persistGroup(differentGroup);
    await persistGroup(closing);
    await persistGroup(archived);

    const readLocked = createDeferred();
    const finishRead = createDeferred();
    const read = adapter.withSnapshotRead({
      groupId: readGroup.id,
      actorSubject: actor,
      callback: async () => {
        readLocked.resolve();
        await finishRead.promise;
        return { kind: 'Denied' };
      },
    });
    await readLocked.promise;
    const mutation = await adapter.withExclusiveMutation({
      expectedPolicies: [
        {
          groupId: differentGroup.id,
          groupVersion: 1,
          accessPolicyVersion: 1,
        },
      ],
      callback: () => Promise.resolve({ value: 'unrelated', mutations: [] }),
    });
    finishRead.resolve();
    await read;

    expect(mutation).toEqual({ kind: 'Allowed', value: 'unrelated' });
    for (const group of [closing, archived]) {
      let callbackCalled = false;
      const result = await adapter.withExclusiveMutation({
        expectedPolicies: [
          {
            groupId: group.id,
            groupVersion: 1,
            accessPolicyVersion: 2,
          },
        ],
        callback: () => {
          callbackCalled = true;
          return Promise.resolve({ value: 'not allowed', mutations: [] });
        },
      });
      expect(result).toEqual({ kind: 'Unavailable' });
      expect(callbackCalled).toBe(false);
    }
  });

  it('同Group mutation競合は最初のcommitだけを許し、後続の古いversionをrollbackする', async () => {
    const group = await seedGroup('00000000-0000-4000-8000-000000000213');
    const locked = createDeferred();
    const finish = createDeferred();
    const winner = adapter.withExclusiveMutation({
      expectedPolicies: [
        { groupId: group.id, groupVersion: 1, accessPolicyVersion: 1 },
      ],
      callback: async ([policy]) => {
        locked.resolve();
        await finish.promise;
        return {
          value: 'winner',
          mutations: [
            requestFor(
              Group.restore({
                ...group.toSnapshot(),
                accessPolicyVersion: 2,
              }),
              policy.groupVersion,
            ),
          ],
        };
      },
    });
    await locked.promise;

    const competing = new Client({
      connectionString: TEST_DATABASE_URL,
      options: `-c search_path=${schemaName}`,
    });
    await competing.connect();
    try {
      await expect(
        competing.query(
          `SELECT group_id FROM group_aggregate_record WHERE group_id = $1 FOR UPDATE NOWAIT`,
          [group.id.value],
        ),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await competing.end();
    }

    const loser = adapter.withExclusiveMutation({
      expectedPolicies: [
        { groupId: group.id, groupVersion: 1, accessPolicyVersion: 1 },
      ],
      callback: () => Promise.resolve({ value: 'loser', mutations: [] }),
    });
    finish.resolve();

    await expect(winner).resolves.toEqual({ kind: 'Allowed', value: 'winner' });
    await expect(loser).resolves.toEqual({ kind: 'Unavailable' });
    const saved = await pool.query(
      `SELECT aggregate_version, access_policy_version
         FROM group_aggregate_record WHERE group_id = $1`,
      [group.id.value],
    );
    expect(saved.rows[0]).toEqual({
      aggregate_version: '2',
      access_policy_version: '2',
    });
  });

  it('stale expected versionはcallbackを起動せず、保存状態を変更しない', async () => {
    const group = await seedGroup('00000000-0000-4000-8000-000000000214');
    let callbackCalled = false;
    const result = await adapter.withExclusiveMutation({
      expectedPolicies: [
        { groupId: group.id, groupVersion: 9, accessPolicyVersion: 1 },
      ],
      callback: () => {
        callbackCalled = true;
        return Promise.resolve({ value: 'not allowed', mutations: [] });
      },
    });
    const saved = await pool.query(
      `SELECT aggregate_version, access_policy_version
         FROM group_aggregate_record WHERE group_id = $1`,
      [group.id.value],
    );

    expect(result).toEqual({ kind: 'Unavailable' });
    expect(callbackCalled).toBe(false);
    expect(saved.rows[0]).toEqual({
      aggregate_version: '1',
      access_policy_version: '1',
    });
  });

  it('access policyを変更するGroup planがpolicy versionを進めなければ全体rollbackする', async () => {
    const group = await seedGroup('00000000-0000-4000-8000-000000000216');
    const closing = group.startClosing({
      actorSubject: actor,
      closeIntentId: CloseIntentId.from('00000000-0000-4000-8000-000000000217'),
      cutoff: now,
    }).group;
    const invalid = Group.restore({
      ...closing.toSnapshot(),
      accessPolicyVersion: group.accessPolicyVersion,
    });
    const result = await adapter.withExclusiveMutation({
      expectedPolicies: [
        { groupId: group.id, groupVersion: 1, accessPolicyVersion: 1 },
      ],
      callback: ([policy]) =>
        Promise.resolve({
          value: 'must-not-commit',
          mutations: [requestFor(invalid, policy.groupVersion)],
        }),
    });
    const saved = await pool.query(
      `SELECT aggregate_version, access_policy_version
         FROM group_aggregate_record WHERE group_id = $1`,
      [group.id.value],
    );

    expect(result).toEqual({ kind: 'Unavailable' });
    expect(saved.rows[0]).toEqual({
      aggregate_version: '1',
      access_policy_version: '1',
    });
  });

  it('exclusive mutationはlock内でstate writerを使いGroup stateとpolicy versionを一括commitする', async () => {
    const group = await seedGroup('00000000-0000-4000-8000-000000000199');
    const updated = Group.restore({
      ...group.toSnapshot(),
      accessPolicyVersion: 2,
    });
    const result = await adapter.withExclusiveMutation({
      expectedPolicies: [
        { groupId: group.id, groupVersion: 1, accessPolicyVersion: 1 },
      ],
      callback: ([policy]) =>
        Promise.resolve({
          value: 'committed',
          mutations: [requestFor(updated, policy.groupVersion)],
        }),
    });

    expect(result).toEqual({ kind: 'Allowed', value: 'committed' });
    const saved = await pool.query(
      `SELECT aggregate_version, access_policy_version
         FROM group_aggregate_record WHERE group_id = $1`,
      [group.id.value],
    );
    expect(saved.rows[0]).toEqual({
      aggregate_version: '2',
      access_policy_version: '2',
    });
  });

  it('callback例外時はfail-closedで、policy lockだけでなくcallback後の変更もrollbackする', async () => {
    const group = await seedGroup('00000000-0000-4000-8000-000000000200');
    const result = await adapter.withExclusiveMutation({
      expectedPolicies: [
        { groupId: group.id, groupVersion: 1, accessPolicyVersion: 1 },
      ],
      callback: () => Promise.reject(new Error('callback failed')),
    });
    expect(result).toEqual({ kind: 'Unavailable' });
    const saved = await pool.query(
      `SELECT aggregate_version, access_policy_version
         FROM group_aggregate_record WHERE group_id = $1`,
      [group.id.value],
    );
    expect(saved.rows[0]).toEqual({
      aggregate_version: '1',
      access_policy_version: '1',
    });
  });

  it('writerの途中失敗はadapter所有transaction全体をrollbackする', async () => {
    const group = await seedGroup('00000000-0000-4000-8000-000000000201');
    const failingAdapter = new PostgresGroupAccessPolicy({
      pool,
      codec,
      encodeAad: encodeCanonicalAad,
      accessIndexDigests: digestPort,
      stateWriter: {
        async persist(transaction: Pick<PoolClient, 'query'>) {
          await transaction.query(
            `UPDATE group_aggregate_record SET aggregate_version = 99 WHERE group_id = $1`,
            [group.id.value],
          );
          throw new Error('writer failed after a partial update');
        },
      },
    });
    const updated = Group.restore({
      ...group.toSnapshot(),
      accessPolicyVersion: 2,
    });
    const result = await failingAdapter.withExclusiveMutation({
      expectedPolicies: [
        { groupId: group.id, groupVersion: 1, accessPolicyVersion: 1 },
      ],
      callback: ([policy]) =>
        Promise.resolve({
          value: 'not committed',
          mutations: [requestFor(updated, policy.groupVersion)],
        }),
    });

    expect(result).toEqual({ kind: 'Unavailable' });
    const saved = await pool.query(
      `SELECT aggregate_version, access_policy_version
         FROM group_aggregate_record WHERE group_id = $1`,
      [group.id.value],
    );
    expect(saved.rows[0]).toEqual({
      aggregate_version: '1',
      access_policy_version: '1',
    });
  });
});
