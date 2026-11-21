import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Client } from 'pg';
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
  actorAccessIndexDigestInput,
  actorMembershipIndexDigestInput,
  type GroupActorMembershipIndexKeyPort,
  type GroupPolicyDigestPort,
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
  InvitationId,
  ParticipantId,
  UtcInstant,
  type CloseFenceReceipt,
} from '../src/group-management/domain/group.js';
import { PostgresGroupStateWriter } from '../src/group-management/infrastructure/postgres/group-state-writer.js';
import {
  applySqlMigrations,
  type SqlMigration,
} from '../src/group-management/infrastructure/postgres/sql-migration.js';
import {
  createProtectedRecordCodec,
  importProtectedRecordKey,
  importPurposeSeparatedDigest,
} from '../src/shared/infrastructure/protected-record/index.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';

const migrationFiles = {
  1: '0001_group_management_storage',
  2: '0002_group_locator_v2',
  12: '0012_group_actor_membership_index',
} as const;

const migration = async (
  version: keyof typeof migrationFiles,
): Promise<SqlMigration> => ({
  version,
  name: migrationFiles[version].slice(5).replaceAll('_', '-'),
  sql: await readFile(
    resolve(
      import.meta.dirname,
      `../migrations/group-management/${migrationFiles[version]}.sql`,
    ),
    'utf8',
  ),
});

const downMigration = (): Promise<string> =>
  readFile(
    resolve(
      import.meta.dirname,
      '../migrations/group-management/0012_group_actor_membership_index.down.sql',
    ),
    'utf8',
  );

const sha256 = (...parts: (string | Uint8Array)[]): Buffer => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

const accessDigests: GroupPolicyDigestPort = {
  digest: (input) =>
    Promise.resolve({
      digest: importPurposeSeparatedDigest(
        sha256(input.purpose, input.groupId, input.canonicalInput),
      ),
      digestKeyVersion: 'test-access-v1',
    }),
};

/** 現行鍵版を切り替えられ、故障を注入できるContext単位鍵のFake。 */
class FakeMembershipIndexKeys implements GroupActorMembershipIndexKeyPort {
  current = 'membership-v1';
  failure: 'none' | 'throw' | 'empty' | 'badVersion' = 'none';

  static digestFor(subject: ActorSubject, version: string): Buffer {
    return sha256(
      version,
      actorMembershipIndexDigestInput(subject).canonicalInput,
    );
  }

  currentDigest(
    input: Parameters<GroupActorMembershipIndexKeyPort['currentDigest']>[0],
  ) {
    if (this.failure === 'throw') {
      return Promise.reject(new Error('membership key unavailable'));
    }
    return Promise.resolve({
      digest: (this.failure === 'empty'
        ? new Uint8Array()
        : Uint8Array.from(sha256(this.current, input.canonicalInput))) as never,
      digestKeyVersion:
        this.failure === 'badVersion' ? 'bad version' : this.current,
    });
  }

  candidateDigests(): Promise<never> {
    return Promise.reject(new Error('the writer must not read candidates'));
  }
}

const groupA = GroupId.from('00000000-0000-4000-8000-0000000309a0');
const groupB = GroupId.from('00000000-0000-4000-8000-0000000309b0');
const owner = ActorSubject.from('owner-309');
const member = ActorSubject.from('member-309');
const leaver = ActorSubject.from('leaver-309');
const ownerParticipant = ParticipantId.from(
  '00000000-0000-4000-8000-000000030901',
);
const memberParticipant = ParticipantId.from(
  '00000000-0000-4000-8000-000000030902',
);
const leaverParticipant = ParticipantId.from(
  '00000000-0000-4000-8000-000000030903',
);
const closeIntentId = CloseIntentId.from(
  '00000000-0000-4000-8000-000000030904',
);
const at = (day: number): UtcInstant =>
  UtcInstant.from(new Date(Date.UTC(2026, 10, day)));

const plan = (
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
    actorSubject: owner,
    operationId: OperationId.from('operation-309'),
    fingerprint: CommandFingerprint.from('fingerprint-309'),
  },
  result: {
    kind: 'GroupCreated',
    groupId: group.id,
    participantId: ownerParticipant,
  },
});

const createGroup = (id: GroupId, participantId = ownerParticipant): Group =>
  Group.create({
    id,
    creatorSubject: owner,
    initialParticipantId: participantId,
    createdAt: at(1),
  });

const join = (
  group: Group,
  invitationId: string,
  subject: ActorSubject,
  participantId: ParticipantId,
  day: number,
): Group => {
  const invited = group.inviteParticipant({
    actorSubject: owner,
    targetSubject: subject,
    invitationId: InvitationId.from(invitationId),
    createdAt: at(day),
  });
  return invited.group.acceptInvitation({
    actorSubject: subject,
    invitationId: InvitationId.from(invitationId),
    participantId,
    acceptedAt: at(day),
  }).group;
};

const fence = (group: Group, context: CloseFenceReceipt['context']): Group =>
  group.recordCloseFenceReceipt({
    kind: 'CloseFenceInstalled',
    groupId: group.id,
    closeIntentId,
    context,
    cutoff: at(10),
    fenceVersion: 1,
    eligible: true,
    completedAt: at(10),
  }).group;

describe('Actor単位のGroup索引（#309）', () => {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  const dataKey = importProtectedRecordKey(new Uint8Array(32).fill(9));
  let sequence = 0;
  let schemaName = '';
  let keys: FakeMembershipIndexKeys;
  let writer: PostgresGroupStateWriter;

  beforeAll(async () => {
    await client.connect();
  });

  beforeEach(async () => {
    schemaName = `test_issue_309_${process.pid}_${sequence++}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}`);
    await applySqlMigrations(client, [await migration(1), await migration(2)]);
    keys = new FakeMembershipIndexKeys();
    let nonceCounter = 0;
    let recordId = 0;
    writer = new PostgresGroupStateWriter({
      codec: createProtectedRecordCodec({
        keyPort: {
          allocateForSeal() {
            nonceCounter += 1;
            const nonce = new Uint8Array(12);
            new DataView(nonce.buffer).setUint32(8, nonceCounter);
            return Promise.resolve({
              status: 'allocated' as const,
              key: dataKey,
              keyVersion: 'test-key-v1',
              nonce,
              sealCount: BigInt(nonceCounter),
            });
          },
          readKey: () =>
            Promise.resolve({
              status: 'available' as const,
              key: dataKey,
              lifecycle: 'current' as const,
            }),
          async requestRotation() {},
        },
      }),
      accessIndexDigests: accessDigests,
      membershipIndexKeys: keys,
      now: () => new Date('2026-11-21T00:00:00.000Z'),
      nextRecordId: () => {
        recordId += 1;
        return `00000000-0000-4000-8000-${String(recordId).padStart(12, '0')}`;
      },
    });
  });

  afterEach(async () => {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  });

  afterAll(async () => {
    await client.end();
  });

  const persist = async (request: CommitGroupRequest) => {
    await client.query('BEGIN');
    const outcome = await writer.persist(client, request);
    await client.query(outcome.kind === 'Committed' ? 'COMMIT' : 'ROLLBACK');
    return outcome;
  };

  const membershipRows = async (groupId?: GroupId) =>
    (
      await client.query<{
        actor_digest: Buffer;
        digest_key_version: string;
        group_id: string;
      }>(
        `SELECT actor_digest, digest_key_version, group_id
           FROM group_actor_membership_index
          WHERE $1::uuid IS NULL OR group_id = $1
          ORDER BY group_id, actor_digest`,
        [groupId?.value ?? null],
      )
    ).rows;

  /** 新索引の行と既存索引の行が、同じActor集合から作られていることを確認する。 */
  const expectIndexesFor = async (
    groupId: GroupId,
    subjects: readonly ActorSubject[],
    version = 'membership-v1',
  ) => {
    const membership = await membershipRows(groupId);
    expect(
      membership.map((row) => [
        row.actor_digest.toString('hex'),
        row.digest_key_version,
      ]),
    ).toEqual(
      subjects
        .map((subject) => [
          FakeMembershipIndexKeys.digestFor(subject, version).toString('hex'),
          version,
        ])
        .sort(([left], [right]) => (left < right ? -1 : 1)),
    );
    const access = await client.query<{ actor_digest: Buffer }>(
      'SELECT actor_digest FROM group_actor_access_index WHERE group_id = $1',
      [groupId.value],
    );
    expect(
      access.rows.map((row) => row.actor_digest.toString('hex')).sort(),
    ).toEqual(
      subjects
        .map((subject) => {
          const input = actorAccessIndexDigestInput(groupId, subject);
          return sha256(
            input.purpose,
            input.groupId,
            input.canonicalInput,
          ).toString('hex');
        })
        .sort(),
    );
  };

  describe('Migration 0012（IX-PRE-1）', () => {
    it('Group行が0件なら表を追加し、再実行はSkipし、許可したColumnだけを持つ', async () => {
      const v12 = await migration(12);
      expect(await applySqlMigrations(client, [v12])).toEqual({
        appliedVersions: [12],
        skippedVersions: [],
      });
      expect(await applySqlMigrations(client, [v12])).toEqual({
        appliedVersions: [],
        skippedVersions: [12],
      });
      const columns = await client.query<{ name: string }>(
        `SELECT column_name AS name FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'group_actor_membership_index'
          ORDER BY ordinal_position`,
      );
      expect(columns.rows.map(({ name }) => name)).toEqual([
        'actor_digest',
        'digest_key_version',
        'group_id',
        'created_at',
      ]);
      await expect(
        client.query(
          `INSERT INTO group_actor_membership_index
             (actor_digest, digest_key_version, group_id, created_at)
           VALUES (decode('01', 'hex'), 'v1', $1, now())`,
          [groupA.value],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        client.query(
          `INSERT INTO group_actor_membership_index
             (actor_digest, digest_key_version, group_id, created_at)
           VALUES (decode('', 'hex'), 'v1', $1, now())`,
          [groupA.value],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('既存のGroup行が1件でもあれば中断し、Schemaと適用記録を変えない', async () => {
      await client.query(
        `INSERT INTO group_aggregate_record (
           group_id, logical_record_id, aggregate_version, access_policy_version,
           envelope_version, algorithm_id, schema_version, key_version,
           ciphertext, nonce, authentication_tag, created_at, updated_at
         ) VALUES (
           $1, $2, 1, 1, 1, 'AES-256-GCM', 1, 'test-key-v1', decode('01', 'hex'),
           decode('000102030405060708090a0b', 'hex'),
           decode('000102030405060708090a0b0c0d0e0f', 'hex'), now(), now()
         )`,
        [groupA.value, '00000000-0000-4000-8000-000000030999'],
      );

      await expect(
        applySqlMigrations(client, [await migration(12)]),
      ).rejects.toThrow(/existing group rows require an owner decision/);
      const state = await client.query<{
        table_oid: string | null;
        applied: string;
      }>(
        `SELECT to_regclass('group_actor_membership_index')::text AS table_oid,
                (SELECT count(*) FROM app_schema_migrations WHERE version = 12) AS applied`,
      );
      expect(state.rows[0]).toEqual({ table_oid: null, applied: '0' });
    });

    it('Downは索引が空なら表と適用記録を消し、行があれば拒否する', async () => {
      await applySqlMigrations(client, [await migration(12)]);
      await expect(
        persist(plan(createGroup(groupA), 'Absent')),
      ).resolves.toEqual({
        kind: 'Committed',
        version: 1,
      });

      await expect(client.query(await downMigration())).rejects.toThrow(
        /requires an empty index/,
      );
      expect(await membershipRows()).toHaveLength(1);

      await client.query('DELETE FROM group_aggregate_record');
      await client.query(await downMigration());
      const state = await client.query<{
        table_oid: string | null;
        applied: string;
      }>(
        `SELECT to_regclass('group_actor_membership_index')::text AS table_oid,
                (SELECT count(*) FROM app_schema_migrations WHERE version = 12) AS applied`,
      );
      expect(state.rows[0]).toEqual({ table_oid: null, applied: '0' });
    });
  });

  describe('State Writerでの保守', () => {
    beforeEach(async () => {
      await applySqlMigrations(client, [await migration(12)]);
    });

    it('IX-INV-1: 作成・受諾・Owner移譲・Leave・Close・Archiveの各commit後、既存索引と同じActor集合だけを載せる', async () => {
      let group = createGroup(groupA);
      let version = 1;
      await expect(persist(plan(group, 'Absent'))).resolves.toEqual({
        kind: 'Committed',
        version,
      });
      await expectIndexesFor(groupA, [owner]);

      const steps: readonly [
        string,
        (current: Group) => Group,
        ActorSubject[],
      ][] = [
        [
          'member受諾',
          (current) =>
            join(
              current,
              '00000000-0000-4000-8000-000000030911',
              member,
              memberParticipant,
              2,
            ),
          [owner, member],
        ],
        [
          'leaver受諾',
          (current) =>
            join(
              current,
              '00000000-0000-4000-8000-000000030912',
              leaver,
              leaverParticipant,
              3,
            ),
          [owner, member, leaver],
        ],
        [
          'Owner移譲',
          (current) =>
            current.transferOwnership({
              actorSubject: owner,
              targetParticipantId: memberParticipant,
            }).group,
          [owner, member, leaver],
        ],
        [
          'Leave',
          (current) =>
            current.leave({
              actorSubject: leaver,
              participantId: leaverParticipant,
              leftAt: at(4),
            }).group,
          [owner, member],
        ],
        [
          'Close開始',
          (current) =>
            current.startClosing({
              actorSubject: member,
              closeIntentId,
              cutoff: at(10),
            }).group,
          [owner, member],
        ],
        [
          'fence Receipt',
          (current) => fence(fence(current, 'ExpenseRecording'), 'Settlement'),
          [owner, member],
        ],
        [
          'Archive',
          (current) =>
            current.archive({
              actorSubject: member,
              closeIntentId,
              archivedAt: at(11),
            }).group,
          [member],
        ],
      ];
      for (const [label, transition, subjects] of steps) {
        group = transition(group);
        await expect(persist(plan(group, version)), label).resolves.toEqual({
          kind: 'Committed',
          version: version + 1,
        });
        version += 1;
        await expectIndexesFor(groupA, subjects);
      }
      expect(await membershipRows()).toHaveLength(1);
    });

    it('IX-INV-3: 同じActorのdigestは別Groupでも同じ値になり、Actorから全Groupを引ける', async () => {
      await persist(plan(createGroup(groupA), 'Absent'));
      await persist(
        plan(
          createGroup(
            groupB,
            ParticipantId.from('00000000-0000-4000-8000-000000030905'),
          ),
          'Absent',
        ),
      );

      const found = await client.query<{ group_id: string }>(
        `SELECT group_id FROM group_actor_membership_index
          WHERE actor_digest = $1 AND digest_key_version = 'membership-v1'
          ORDER BY group_id`,
        [FakeMembershipIndexKeys.digestFor(owner, 'membership-v1')],
      );
      expect(found.rows.map(({ group_id }) => group_id)).toEqual([
        groupA.value,
        groupB.value,
      ]);
      const access = await client.query<{ distinct_digests: string }>(
        'SELECT count(DISTINCT actor_digest) AS distinct_digests FROM group_actor_access_index',
      );
      expect(access.rows[0]?.distinct_digests).toBe('2');
    });

    it('IX-ROT-1: 書込は現行鍵版だけを使い、更新で旧鍵版の行を残さない', async () => {
      let group = createGroup(groupA);
      await persist(plan(group, 'Absent'));
      await expectIndexesFor(groupA, [owner], 'membership-v1');

      keys.current = 'membership-v2';
      group = join(
        group,
        '00000000-0000-4000-8000-000000030913',
        member,
        memberParticipant,
        2,
      );
      await expect(persist(plan(group, 1))).resolves.toEqual({
        kind: 'Committed',
        version: 2,
      });

      await expectIndexesFor(groupA, [owner, member], 'membership-v2');
      const versions = await client.query<{ digest_key_version: string }>(
        'SELECT DISTINCT digest_key_version FROM group_actor_membership_index',
      );
      expect(versions.rows).toEqual([{ digest_key_version: 'membership-v2' }]);
    });

    it.each(['throw', 'empty', 'badVersion'] as const)(
      'IX-FAIL-1: 鍵Portの%sは作成・更新ともUnavailableにし、Group行と両索引を保存しない',
      async (failure) => {
        keys.failure = failure;
        await expect(
          persist(plan(createGroup(groupA), 'Absent')),
        ).resolves.toEqual({
          kind: 'Unavailable',
        });
        const empty = await client.query<{
          groups: string;
          access: string;
          membership: string;
        }>(
          `SELECT (SELECT count(*) FROM group_aggregate_record) AS groups,
                  (SELECT count(*) FROM group_actor_access_index) AS access,
                  (SELECT count(*) FROM group_actor_membership_index) AS membership`,
        );
        expect(empty.rows[0]).toEqual({
          groups: '0',
          access: '0',
          membership: '0',
        });

        keys.failure = 'none';
        const group = createGroup(groupA);
        await persist(plan(group, 'Absent'));
        keys.failure = failure;
        await expect(
          persist(
            plan(
              join(
                group,
                '00000000-0000-4000-8000-000000030914',
                member,
                memberParticipant,
                2,
              ),
              1,
            ),
          ),
        ).resolves.toEqual({ kind: 'Unavailable' });
        const version = await client.query<{ aggregate_version: string }>(
          'SELECT aggregate_version FROM group_aggregate_record',
        );
        expect(version.rows).toEqual([{ aggregate_version: '1' }]);
        await expectIndexesFor(groupA, [owner]);
      },
    );

    it('IX-INV-2: 索引の後に続く保存が失敗すると、呼出し側のrollbackで新索引も戻る', async () => {
      const group = createGroup(groupA);
      await persist(plan(group, 'Absent'));
      await client.query(`
        CREATE FUNCTION reject_membership_history() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'injected failure'; END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER reject_membership_history
        BEFORE INSERT ON group_membership_history_record
        FOR EACH ROW EXECUTE FUNCTION reject_membership_history();
      `);
      const joined = join(
        group,
        '00000000-0000-4000-8000-000000030915',
        member,
        memberParticipant,
        2,
      );

      await client.query('BEGIN');
      const outcome = await writer.persist(client, {
        ...plan(joined, 1),
        membershipChanges: [
          { kind: 'Joined', participantId: memberParticipant, at: at(2) },
        ],
      });
      expect(outcome).toEqual({ kind: 'Unavailable' });
      await client.query('ROLLBACK');

      const version = await client.query<{ aggregate_version: string }>(
        'SELECT aggregate_version FROM group_aggregate_record',
      );
      expect(version.rows).toEqual([{ aggregate_version: '1' }]);
      await expectIndexesFor(groupA, [owner]);
    });

    it('Group削除のFK cascadeで対象Groupの行だけが消える', async () => {
      await persist(plan(createGroup(groupA), 'Absent'));
      await persist(
        plan(
          createGroup(
            groupB,
            ParticipantId.from('00000000-0000-4000-8000-000000030906'),
          ),
          'Absent',
        ),
      );

      await client.query(
        'DELETE FROM group_aggregate_record WHERE group_id = $1',
        [groupA.value],
      );

      expect(await membershipRows(groupA)).toEqual([]);
      expect(await membershipRows(groupB)).toHaveLength(1);
    });
  });
});
