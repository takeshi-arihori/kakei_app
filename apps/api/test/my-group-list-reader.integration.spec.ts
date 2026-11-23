import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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
  actorMembershipIndexDigestInput,
  type GroupActorMembershipIndexCandidate,
  type GroupActorMembershipIndexKeyPort,
  type GroupPolicyDigestPort,
} from '../src/group-management/application/group-access-policy.js';
import {
  CommandFingerprint,
  OperationId,
  type CommitGroupRequest,
} from '../src/group-management/application/group-repository.js';
import { MyGroupQueryService } from '../src/group-management/application/use-cases/list-my-groups.js';
import {
  ActorSubject,
  Group,
  GroupId,
  InvitationId,
  ParticipantId,
  UtcInstant,
} from '../src/group-management/domain/group.js';
import { PostgresMyGroupListReader } from '../src/group-management/infrastructure/postgres/my-group-list-reader.js';
import { PostgresGroupStateWriter } from '../src/group-management/infrastructure/postgres/group-state-writer.js';
import {
  applySqlMigrations,
  type SqlMigration,
} from '../src/group-management/infrastructure/postgres/sql-migration.js';
import {
  createProtectedRecordCodec,
  encodeCanonicalAad,
  importProtectedRecordKey,
  importPurposeSeparatedDigest,
} from '../src/shared/infrastructure/protected-record/index.js';
import { groupActorMembershipIndexMigration } from './support/group-actor-membership-index.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';

const migration = async (
  version: 1 | 2,
  file: string,
): Promise<SqlMigration> => ({
  version,
  name: file.slice(5).replaceAll('_', '-'),
  sql: await readFile(
    resolve(import.meta.dirname, `../migrations/group-management/${file}.sql`),
    'utf8',
  ),
});

const accessDigests: GroupPolicyDigestPort = {
  digest: (input) =>
    Promise.resolve({
      digest: importPurposeSeparatedDigest(
        createHash('sha256')
          .update(input.purpose)
          .update(input.groupId)
          .update(input.canonicalInput)
          .digest(),
      ),
      digestKeyVersion: 'test-access-v1',
    }),
};

/** 鍵版ごとに独立したMaterialを持つContext単位鍵のFake。現行とRetiredを切り替えられる。 */
class FakeMembershipIndexKeys implements GroupActorMembershipIndexKeyPort {
  current = 'membership-v1';
  retired: string[] = [];
  candidateFailure:
    'none' | 'throw' | 'none-left' | 'empty' | 'badVersion' | 'duplicate' =
    'none';
  candidateCalls = 0;
  private readonly materials = new Map<string, Buffer>();

  private digest(version: string, input: Uint8Array) {
    let material = this.materials.get(version);
    if (material === undefined) {
      material = randomBytes(32);
      this.materials.set(version, material);
    }
    return importPurposeSeparatedDigest(
      createHmac('sha256', material).update(input).digest(),
    );
  }

  currentDigest(
    input: Parameters<GroupActorMembershipIndexKeyPort['currentDigest']>[0],
  ) {
    return Promise.resolve({
      digest: this.digest(this.current, input.canonicalInput),
      digestKeyVersion: this.current,
    });
  }

  candidateDigests(
    input: Parameters<GroupActorMembershipIndexKeyPort['candidateDigests']>[0],
  ): Promise<readonly GroupActorMembershipIndexCandidate[]> {
    this.candidateCalls += 1;
    const versions = [this.current, ...this.retired];
    const candidates = versions.map((version) => ({
      digest: this.digest(version, input.canonicalInput),
      digestKeyVersion: version,
    }));
    switch (this.candidateFailure) {
      case 'throw':
        return Promise.reject(new Error('membership key provider down'));
      case 'none-left':
        return Promise.resolve([]);
      case 'empty':
        return Promise.resolve([
          { digest: new Uint8Array() as never, digestKeyVersion: this.current },
        ]);
      case 'badVersion':
        return Promise.resolve([
          { digest: candidates[0].digest, digestKeyVersion: 'bad version' },
        ]);
      case 'duplicate':
        return Promise.resolve([candidates[0], candidates[0]]);
      default:
        return Promise.resolve(candidates);
    }
  }

  /** 索引へ直接書く不整合の再現用。 */
  digestFor(subject: ActorSubject, version = this.current): Buffer {
    return Buffer.from(
      this.digest(
        version,
        actorMembershipIndexDigestInput(subject).canonicalInput,
      ),
    );
  }
}

const me = ActorSubject.from('reader-310-me');
const other = ActorSubject.from('reader-310-other');
const groupIdOf = (n: number) =>
  GroupId.from(
    `00000000-0000-4000-8000-${String(310_000 + n).padStart(12, '0')}`,
  );
const participantOf = (n: number) =>
  ParticipantId.from(
    `00000000-0000-4000-9000-${String(310_000 + n).padStart(12, '0')}`,
  );
const at = (day: number): UtcInstant =>
  UtcInstant.from(new Date(Date.UTC(2026, 10, day)));

const plan = (
  group: Group,
  expectedVersion: number | 'Absent',
  actorSubject: ActorSubject,
): CommitGroupRequest => ({
  group,
  expectedVersion,
  stateChanged: true,
  membershipChanges: [],
  invitationChanges: [],
  groupCloseChanges: [],
  operation: {
    actorSubject,
    operationId: OperationId.from(`operation-310-${group.id.value}`),
    fingerprint: CommandFingerprint.from('fingerprint-310'),
  },
  result: {
    kind: 'GroupCreated',
    groupId: group.id,
    participantId: participantOf(0),
  },
});

const groupOwnedBy = (n: number, owner: ActorSubject): Group =>
  Group.create({
    id: groupIdOf(n),
    creatorSubject: owner,
    initialParticipantId: participantOf(n * 10),
    createdAt: at(1),
  });

/** ownerのGroupへsubjectを招待・受諾で参加させる。 */
const joined = (
  group: Group,
  owner: ActorSubject,
  subject: ActorSubject,
  participantId: ParticipantId,
): Group => {
  const invitationId = InvitationId.from(
    `00000000-0000-4000-a000-${group.id.value.slice(-12)}`,
  );
  const invited = group.inviteParticipant({
    actorSubject: owner,
    targetSubject: subject,
    invitationId,
    createdAt: at(2),
  });
  return invited.group.acceptInvitation({
    actorSubject: subject,
    invitationId,
    participantId,
    acceptedAt: at(2),
  }).group;
};

describe('PostgresMyGroupListReader（#310）', () => {
  const admin = new Pool({ connectionString: TEST_DATABASE_URL });
  let sequence = 0;
  let schemaName = '';
  let pool: Pool;
  let keys: FakeMembershipIndexKeys;
  let writer: PostgresGroupStateWriter;
  let reader: PostgresMyGroupListReader;
  let readKeyCalls = 0;
  let readKeyFailure = false;
  let unavailableSignals = 0;
  let writtenAt = new Date('2026-11-22T00:00:00.000Z');
  let recordId = 0;

  beforeAll(async () => {
    await admin.query('SELECT 1');
  });

  beforeEach(async () => {
    schemaName = `test_issue_310_${process.pid}_${sequence++}`;
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    const setup = new Client({ connectionString: TEST_DATABASE_URL });
    await setup.connect();
    try {
      await setup.query(`SET search_path TO ${schemaName}`);
      await applySqlMigrations(setup, [
        await migration(1, '0001_group_management_storage'),
        await migration(2, '0002_group_locator_v2'),
        await groupActorMembershipIndexMigration(),
      ]);
    } finally {
      await setup.end();
    }
    pool = new Pool({
      connectionString: TEST_DATABASE_URL,
      options: `-c search_path=${schemaName}`,
    });
    keys = new FakeMembershipIndexKeys();
    readKeyCalls = 0;
    readKeyFailure = false;
    unavailableSignals = 0;
    recordId = 0;
    writtenAt = new Date('2026-11-22T00:00:00.000Z');
    const dataKey = importProtectedRecordKey(new Uint8Array(32).fill(31));
    let sealCount = 0;
    const codec = createProtectedRecordCodec({
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
          readKeyCalls += 1;
          return Promise.resolve(
            readKeyFailure
              ? { status: 'key-lost' as const }
              : {
                  status: 'available' as const,
                  key: dataKey,
                  lifecycle: 'current' as const,
                },
          );
        },
        async requestRotation() {},
      },
    });
    writer = new PostgresGroupStateWriter({
      codec,
      accessIndexDigests: accessDigests,
      membershipIndexKeys: keys,
      now: () => writtenAt,
      nextRecordId: () => {
        recordId += 1;
        return `00000000-0000-4000-8000-${String(recordId).padStart(12, '0')}`;
      },
    });
    reader = new PostgresMyGroupListReader({
      pool,
      codec,
      encodeAad: encodeCanonicalAad,
      membershipIndexKeys: keys,
      onUnavailable: () => {
        unavailableSignals += 1;
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

  const persistWith = async (
    client: PoolClient,
    group: Group,
    expectedVersion: number | 'Absent',
    actorSubject = me,
  ) => {
    const outcome = await writer.persist(
      client,
      plan(group, expectedVersion, actorSubject),
    );
    expect(outcome.kind).toBe('Committed');
  };

  /** Groupを保存し、保存時刻（索引の並びKey）を指定する。 */
  const save = async (
    group: Group,
    expectedVersion: number | 'Absent' = 'Absent',
    options: Readonly<{ at?: string; actorSubject?: ActorSubject }> = {},
  ) => {
    if (options.at !== undefined) writtenAt = new Date(options.at);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await persistWith(client, group, expectedVersion, options.actorSubject);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  };

  const readMine = (limit = 51) =>
    reader.readCandidates({ actorSubject: me, limit });

  const readIds = async (limit = 51) => {
    const result = await readMine(limit);
    if (result.kind !== 'Read') throw new Error('expected Read');
    return {
      ids: result.groups.map(({ id }) => id.value),
      indexHitCount: result.indexHitCount,
    };
  };

  /** 別接続のTransactionがLockを持つ間に読取を始め、読取がLock待ちになるまで待つ。 */
  const startWhileLocked = async <T>(
    lockHolder: PoolClient,
    start: () => Promise<T>,
  ): Promise<{ pending: Promise<T> }> => {
    const holderPid = (
      await lockHolder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    ).rows[0].pid;
    const pending = start();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await admin.query(
        'SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
        [holderPid],
      );
      // async関数からPromiseを直接返すと読取の完了まで待ってしまうので包む。
      if (waiting.rowCount === 1) return { pending };
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error('the reader never waited for the Group lock');
  };

  const readWhileLocked = (lockHolder: PoolClient) =>
    startWhileLocked(lockHolder, () => readMine());

  const expectConnectionsReleased = () => {
    expect(pool.totalCount).toBe(pool.idleCount);
  };

  /** 読取が失敗した後、対象GroupのLockが残っていないことを確かめる。 */
  const expectNoLockLeft = async (groupId: GroupId) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT 1 FROM group_aggregate_record WHERE group_id = $1 FOR UPDATE NOWAIT',
        [groupId.value],
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  };

  describe('索引のmissと存在非開示（RL-POST-1）', () => {
    it('索引に自分の行がなければ空を返し、Group鍵の取得も復号もしない', async () => {
      await save(groupOwnedBy(1, other), 'Absent', { actorSubject: other });
      readKeyCalls = 0;

      await expect(readMine()).resolves.toEqual({
        kind: 'Read',
        groups: [],
        indexHitCount: 0,
      });
      expect(readKeyCalls).toBe(0);
      expect(keys.candidateCalls).toBe(1);
      expectConnectionsReleased();
    });

    it('他Actorと共有しないGroupは返さず、共有するGroupは自分の行でだけhitする', async () => {
      await save(groupOwnedBy(1, other), 'Absent', { actorSubject: other });
      await save(groupOwnedBy(2, me));
      await save(
        joined(groupOwnedBy(3, other), other, me, participantOf(31)),
        'Absent',
        {
          actorSubject: other,
        },
      );

      await expect(readIds()).resolves.toEqual({
        ids: [groupIdOf(2).value, groupIdOf(3).value],
        indexHitCount: 2,
      });
    });

    it('Leaveした旧ParticipantのGroupは索引にないので復号しない', async () => {
      const group = joined(
        groupOwnedBy(1, other),
        other,
        me,
        participantOf(11),
      );
      await save(group, 'Absent', { actorSubject: other });
      await save(
        group.leave({
          actorSubject: me,
          participantId: participantOf(11),
          leftAt: at(3),
        }).group,
        1,
      );
      readKeyCalls = 0;

      await expect(readIds()).resolves.toEqual({ ids: [], indexHitCount: 0 });
      expect(readKeyCalls).toBe(0);
    });
  });

  describe('並び・上限・鍵世代（RL-POST-2）', () => {
    it('保存時刻の新しい順に上限件数だけhitし、同時刻はGroupId昇順で選ぶ', async () => {
      await save(groupOwnedBy(1, me), 'Absent', {
        at: '2026-11-22T00:00:01.000Z',
      });
      await save(groupOwnedBy(2, me), 'Absent', {
        at: '2026-11-22T00:00:03.000Z',
      });
      await save(groupOwnedBy(4, me), 'Absent', {
        at: '2026-11-22T00:00:02.000Z',
      });
      await save(groupOwnedBy(3, me), 'Absent', {
        at: '2026-11-22T00:00:02.000Z',
      });

      await expect(readIds(2)).resolves.toEqual({
        ids: [groupIdOf(2).value, groupIdOf(3).value],
        indexHitCount: 2,
      });
      await expect(readIds(3)).resolves.toEqual({
        ids: [groupIdOf(2).value, groupIdOf(3).value, groupIdOf(4).value],
        indexHitCount: 3,
      });
    });

    it('返すGroupは固定した版・Policy版と復号結果が一致する', async () => {
      const created = groupOwnedBy(1, me);
      await save(created);
      await save(joined(created, me, other, participantOf(12)), 1);

      const result = await readMine();
      expect(result.kind).toBe('Read');
      if (result.kind !== 'Read') return;
      const [group] = result.groups;
      const stored = await pool.query<{ access_policy_version: string }>(
        'SELECT access_policy_version FROM group_aggregate_record WHERE group_id = $1',
        [groupIdOf(1).value],
      );
      expect(group?.id.equals(groupIdOf(1))).toBe(true);
      expect(group?.activeParticipantCount).toBe(2);
      expect(String(group?.accessPolicyVersion)).toBe(
        stored.rows[0]?.access_policy_version,
      );
    });

    it('Retired鍵版の行もhitし、候補から外れた鍵版の行はhitしない', async () => {
      await save(groupOwnedBy(1, me));
      keys.current = 'membership-v2';
      keys.retired = ['membership-v1'];
      await save(groupOwnedBy(2, me));

      await expect(readIds()).resolves.toEqual({
        ids: [groupIdOf(1).value, groupIdOf(2).value],
        indexHitCount: 2,
      });

      keys.retired = [];
      readKeyCalls = 0;
      await expect(readIds()).resolves.toEqual({
        ids: [groupIdOf(2).value],
        indexHitCount: 1,
      });
      expect(readKeyCalls).toBe(1);
    });
  });

  describe('Lock後の索引行の再確認（RL-POST-3、RL-CON-1）', () => {
    it('Lock待ちの間に自分がLeaveしたGroupは、復号もAlertもせずに除き、hit数には数える', async () => {
      const shared = joined(
        groupOwnedBy(1, other),
        other,
        me,
        participantOf(11),
      );
      await save(shared, 'Absent', { actorSubject: other });
      await save(groupOwnedBy(2, me));
      readKeyCalls = 0;

      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          'SELECT 1 FROM group_aggregate_record WHERE group_id = $1 FOR UPDATE',
          [groupIdOf(1).value],
        );
        const { pending } = await readWhileLocked(holder);
        await persistWith(
          holder,
          shared.leave({
            actorSubject: me,
            participantId: participantOf(11),
            leftAt: at(3),
          }).group,
          1,
        );
        await holder.query('COMMIT');

        const result = await pending;
        expect(result.kind).toBe('Read');
        if (result.kind !== 'Read') return;
        expect(result.groups.map(({ id }) => id.value)).toEqual([
          groupIdOf(2).value,
        ]);
        expect(result.indexHitCount).toBe(2);
        expect(readKeyCalls).toBe(1);
      } finally {
        holder.release();
      }
    });

    it('Lock待ちの間に削除されたGroupは黙って除く', async () => {
      await save(groupOwnedBy(1, me));
      readKeyCalls = 0;

      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          'DELETE FROM group_aggregate_record WHERE group_id = $1',
          [groupIdOf(1).value],
        );
        const { pending } = await readWhileLocked(holder);
        await holder.query('COMMIT');

        await expect(pending).resolves.toEqual({
          kind: 'Read',
          groups: [],
          indexHitCount: 1,
        });
        expect(readKeyCalls).toBe(0);
      } finally {
        holder.release();
      }
    });

    it('Lock待ちの間に他の参加者が増えたGroupは、commit後の版で返す', async () => {
      const created = groupOwnedBy(1, me);
      await save(created);

      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          'SELECT 1 FROM group_aggregate_record WHERE group_id = $1 FOR UPDATE',
          [groupIdOf(1).value],
        );
        const { pending } = await readWhileLocked(holder);
        await persistWith(
          holder,
          joined(created, me, other, participantOf(12)),
          1,
        );
        await holder.query('COMMIT');

        const result = await pending;
        expect(result.kind).toBe('Read');
        if (result.kind !== 'Read') return;
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0]?.activeParticipantCount).toBe(2);
      } finally {
        holder.release();
      }
    });
  });

  describe('索引の不整合（RL-POST-4、RL-POST-5）', () => {
    it('索引行が残るのに再認可で否のGroupは返し、Use Caseが除外してgroupIdだけを通知する', async () => {
      await save(groupOwnedBy(1, other), 'Absent', { actorSubject: other });
      await save(groupOwnedBy(2, me));
      await pool.query(
        `INSERT INTO group_actor_membership_index
           (actor_digest, digest_key_version, group_id, created_at)
         VALUES ($1, $2, $3, now())`,
        [keys.digestFor(me), keys.current, groupIdOf(1).value],
      );
      const alerts: string[] = [];
      const service = new MyGroupQueryService(reader, {
        reportDeniedIndexHit: ({ groupId }) => {
          alerts.push(groupId.value);
          return Promise.resolve();
        },
      });

      const list = await service.listMyGroups({ actorSubject: me });

      expect(list.items.map(({ groupId }) => groupId.value)).toEqual([
        groupIdOf(2).value,
      ]);
      expect(list.hasMore).toBe(false);
      expect(alerts).toEqual([groupIdOf(1).value]);
    });

    it('51件hitすれば、Lock後に1件が競合で除かれても続きありを返す', async () => {
      for (let n = 1; n <= 51; n += 1) {
        await save(groupOwnedBy(n, me), 'Absent', {
          at: new Date(Date.UTC(2026, 10, 22, 0, 0, n)).toISOString(),
        });
      }
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          'DELETE FROM group_aggregate_record WHERE group_id = $1',
          [groupIdOf(51).value],
        );
        const service = new MyGroupQueryService(reader, {
          reportDeniedIndexHit: () =>
            Promise.reject(new Error('no alert expected')),
        });
        const { pending } = await startWhileLocked(holder, () =>
          service.listMyGroups({ actorSubject: me }),
        );
        await holder.query('COMMIT');

        const list = await pending;
        expect(list.items).toHaveLength(50);
        expect(list.hasMore).toBe(true);
      } finally {
        holder.release();
      }
    });
  });

  describe('障害は一覧全体を失敗にする（RL-PRE-1、RL-FAIL-1）', () => {
    it.each([
      ['鍵Portの例外', 'throw'],
      ['候補鍵が0件', 'none-left'],
      ['空のdigest', 'empty'],
      ['不正な鍵版', 'badVersion'],
      ['同じ鍵版の重複', 'duplicate'],
    ] as const)('%sはUnavailableにし、Groupを読まない', async (_, failure) => {
      await save(groupOwnedBy(1, me));
      keys.candidateFailure = failure;
      readKeyCalls = 0;

      await expect(readMine()).resolves.toEqual({ kind: 'Unavailable' });
      expect(readKeyCalls).toBe(0);
      expect(unavailableSignals).toBe(1);
      expectConnectionsReleased();
    });

    it.each([0, 52, 1.5, -1])(
      '件数上限%sはUnavailableにし、鍵Portも呼ばない',
      async (limit) => {
        await expect(readMine(limit)).resolves.toEqual({ kind: 'Unavailable' });
        expect(keys.candidateCalls).toBe(0);
        expect(unavailableSignals).toBe(1);
      },
    );

    it('復号鍵を得られなければUnavailableにし、Lockを残さない', async () => {
      await save(groupOwnedBy(1, me));
      await save(groupOwnedBy(2, me));
      readKeyFailure = true;

      await expect(readMine()).resolves.toEqual({ kind: 'Unavailable' });
      expectConnectionsReleased();
      await expectNoLockLeft(groupIdOf(1));
    });

    it('版を書き換えたGroupは復号に失敗し、他のGroupも返さない', async () => {
      await save(groupOwnedBy(1, me));
      await save(groupOwnedBy(2, me));
      await pool.query(
        'UPDATE group_aggregate_record SET aggregate_version = aggregate_version + 1 WHERE group_id = $1',
        [groupIdOf(2).value],
      );

      await expect(readMine()).resolves.toEqual({ kind: 'Unavailable' });
      await expectNoLockLeft(groupIdOf(1));
    });

    it('Policy版の不一致はUnavailableにする', async () => {
      await save(groupOwnedBy(1, me));
      await pool.query(
        'UPDATE group_aggregate_record SET access_policy_version = access_policy_version + 1 WHERE group_id = $1',
        [groupIdOf(1).value],
      );

      await expect(readMine()).resolves.toEqual({ kind: 'Unavailable' });
    });

    it('1つのGroupが複数の鍵版でhitする不整合はUnavailableにし、復号しない', async () => {
      await save(groupOwnedBy(1, me));
      keys.retired = ['membership-v0'];
      await pool.query(
        `INSERT INTO group_actor_membership_index
           (actor_digest, digest_key_version, group_id, created_at)
         VALUES ($1, 'membership-v0', $2, now())`,
        [keys.digestFor(me, 'membership-v0'), groupIdOf(1).value],
      );
      readKeyCalls = 0;

      await expect(readMine()).resolves.toEqual({ kind: 'Unavailable' });
      expect(readKeyCalls).toBe(0);
    });

    it('SQL障害はUnavailableにし、接続を返す', async () => {
      await pool.query('DROP TABLE group_actor_membership_index');

      await expect(readMine()).resolves.toEqual({ kind: 'Unavailable' });
      expect(unavailableSignals).toBe(1);
      expectConnectionsReleased();
    });

    it('障害通知の例外でUnavailableの結果を置き換えない', async () => {
      const throwingReader = new PostgresMyGroupListReader({
        pool,
        codec: { open: () => Promise.reject(new Error('unused')) },
        encodeAad: encodeCanonicalAad,
        membershipIndexKeys: keys,
        onUnavailable: () => {
          throw new Error('alert sink down');
        },
      });
      keys.candidateFailure = 'throw';

      await expect(
        throwingReader.readCandidates({ actorSubject: me, limit: 51 }),
      ).resolves.toEqual({ kind: 'Unavailable' });
    });
  });
});
