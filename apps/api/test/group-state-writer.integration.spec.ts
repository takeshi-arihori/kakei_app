import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createProtectedRecordCodec,
  encodeCanonicalAad,
  importProtectedRecordKey,
  importPurposeSeparatedDigest,
  type ProtectedRecordCodec,
} from '@kakei/protected-record';
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
  InvitationId,
  ParticipantId,
  UtcInstant,
} from '../src/group-management/domain/group.js';
import { PostgresGroupStateWriter } from '../src/group-management/infrastructure/postgres/group-state-writer.js';
import {
  applySqlMigrations,
  type SqlMigration,
} from '../src/group-management/infrastructure/postgres/sql-migration.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';
const groupId = GroupId.from('00000000-0000-4000-8000-000000000095');
const participantId = ParticipantId.from(
  '00000000-0000-4000-8000-000000001095',
);
const actor = ActorSubject.from('test-actor-95');
const operation = {
  actorSubject: actor,
  operationId: OperationId.from('test-operation-95'),
  fingerprint: CommandFingerprint.from('test-fingerprint-95'),
};
const now = UtcInstant.from(new Date('2026-09-23T00:00:00.000Z'));

const migration = async (version: 1 | 2): Promise<SqlMigration> => ({
  version,
  name: version === 1 ? 'group-management-storage' : 'group-locator-v2',
  sql: await readFile(
    resolve(
      import.meta.dirname,
      `../migrations/group-management/000${version}_${version === 1 ? 'group_management_storage' : 'group_locator_v2'}.sql`,
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

const makeRequest = (
  group: Group,
  expectedVersion: number | 'Absent',
  stateChanged: boolean,
  changes: Partial<
    Pick<
      CommitGroupRequest,
      'membershipChanges' | 'invitationChanges' | 'groupCloseChanges'
    >
  > = {},
): CommitGroupRequest => ({
  group,
  expectedVersion,
  stateChanged,
  membershipChanges: changes.membershipChanges ?? [],
  invitationChanges: changes.invitationChanges ?? [],
  groupCloseChanges: changes.groupCloseChanges ?? [],
  operation,
  result: {
    kind: 'GroupCreated',
    groupId: group.id,
    participantId,
  },
});

describe('PostgreSQL Group state writer', () => {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  const secondClient = new Client({ connectionString: TEST_DATABASE_URL });
  const dataKey = importProtectedRecordKey(new Uint8Array(32).fill(95));
  let nonceCounter = 0;
  let sequence = 0;
  let schemaName = '';
  let codec: ProtectedRecordCodec;
  let writer: PostgresGroupStateWriter;

  beforeAll(async () => {
    await client.connect();
    await secondClient.connect();
  });

  beforeEach(async () => {
    schemaName = `test_issue_95_${process.pid}_${sequence++}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}`);
    await secondClient.query(`SET search_path TO ${schemaName}`);
    await applySqlMigrations(client, [await migration(1), await migration(2)]);
    nonceCounter = 0;
    codec = createProtectedRecordCodec({
      keyPort: {
        allocateForSeal() {
          nonceCounter += 1;
          const nonce = new Uint8Array(12);
          nonce[8] = (nonceCounter >>> 24) & 0xff;
          nonce[9] = (nonceCounter >>> 16) & 0xff;
          nonce[10] = (nonceCounter >>> 8) & 0xff;
          nonce[11] = nonceCounter & 0xff;
          return Promise.resolve({
            status: 'allocated' as const,
            key: dataKey,
            keyVersion: 'test-key-v1',
            nonce,
            sealCount: BigInt(nonceCounter),
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
    let recordId = 0;
    writer = new PostgresGroupStateWriter({
      codec,
      accessIndexDigests: digestPort,
      now: () => new Date('2026-09-23T02:00:00.000Z'),
      nextRecordId: () => {
        recordId += 1;
        return `00000000-0000-4000-8000-${String(recordId).padStart(12, '0')}`;
      },
    });
  });

  afterEach(async () => {
    await client.query('SET search_path TO public');
    await secondClient.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  });

  afterAll(async () => {
    await client.end();
    await secondClient.end();
  });

  it('atomically creates protected current state, membership history and active access index', async () => {
    const group = Group.create({
      id: groupId,
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    await client.query('BEGIN');
    const outcome = await writer.persist(
      client,
      makeRequest(group, 'Absent', true, {
        membershipChanges: [{ kind: 'Joined', participantId, at: now }],
      }),
    );
    await client.query('COMMIT');

    expect(outcome).toEqual({ kind: 'Committed', version: 1 });
    const rows = await client.query<{
      aggregate_version: string;
      participant_count: string;
      invitation_count: string;
      membership_history_count: string;
      close_history_count: string;
      access_index_count: string;
      stored_text: string;
    }>(
      `
      SELECT a.aggregate_version,
             (SELECT count(*) FROM group_participant_record) AS participant_count,
             (SELECT count(*) FROM group_invitation_record) AS invitation_count,
             (SELECT count(*) FROM group_membership_history_record) AS membership_history_count,
             (SELECT count(*) FROM group_close_history_record) AS close_history_count,
             (SELECT count(*) FROM group_actor_access_index) AS access_index_count,
             concat_ws('|', a.logical_record_id, a.key_version,
               encode(a.ciphertext, 'hex'), encode(a.nonce, 'hex'),
               encode(a.authentication_tag, 'hex')) AS stored_text
        FROM group_aggregate_record a WHERE a.group_id = $1`,
      [groupId.value],
    );
    expect(rows.rows[0]).toMatchObject({
      aggregate_version: '1',
      participant_count: '1',
      invitation_count: '0',
      membership_history_count: '1',
      close_history_count: '0',
      access_index_count: '1',
    });
    expect(rows.rows[0]?.stored_text).not.toContain(actor.value);
    expect(rows.rows[0]?.stored_text).not.toContain(participantId.value);
  });

  it('updates current invitation and appends immutable history under the next CAS version', async () => {
    const group = Group.create({
      id: groupId,
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    await client.query('BEGIN');
    await expect(
      writer.persist(
        client,
        makeRequest(group, 'Absent', true, {
          membershipChanges: [{ kind: 'Joined', participantId, at: now }],
        }),
      ),
    ).resolves.toEqual({ kind: 'Committed', version: 1 });
    await client.query('COMMIT');

    const invitationId = InvitationId.from(
      '00000000-0000-4000-8000-000000001095',
    );
    const targetSubject = ActorSubject.from('invitee:writer-test');
    const invited = group.inviteParticipant({
      actorSubject: actor,
      targetSubject,
      invitationId,
      createdAt: now,
    });
    await client.query('BEGIN');
    const outcome = await writer.persist(
      client,
      makeRequest(invited.group, 1, true, {
        invitationChanges: [
          {
            kind: 'Created',
            invitationId,
            targetSubject,
            issuerParticipantId: participantId,
            createdAt: now,
            expiryAt: invited.invitation.expiryAt,
          },
        ],
      }),
    );
    await client.query('COMMIT');

    expect(outcome).toEqual({ kind: 'Committed', version: 2 });
    const counts = await client.query<{
      aggregate_version: string;
      current_invitation_count: string;
      history_count: string;
      access_index_count: string;
    }>(
      `
      SELECT a.aggregate_version,
             (SELECT count(*) FROM group_invitation_record) AS current_invitation_count,
             (SELECT count(*) FROM group_invitation_history_record) AS history_count,
             (SELECT count(*) FROM group_actor_access_index) AS access_index_count
      FROM group_aggregate_record a WHERE a.group_id = $1`,
      [groupId.value],
    );
    expect(counts.rows[0]).toEqual({
      aggregate_version: '2',
      current_invitation_count: '1',
      history_count: '1',
      access_index_count: '1',
    });
  });

  it('removes a departed actor from the transactional access index', async () => {
    const group = Group.create({
      id: groupId,
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    await client.query('BEGIN');
    await writer.persist(
      client,
      makeRequest(group, 'Absent', true, {
        membershipChanges: [{ kind: 'Joined', participantId, at: now }],
      }),
    );
    await client.query('COMMIT');

    const targetSubject = ActorSubject.from('member:writer-test');
    const invitationId = InvitationId.from(
      '00000000-0000-4000-8000-000000005095',
    );
    const invited = group.inviteParticipant({
      actorSubject: actor,
      targetSubject,
      invitationId,
      createdAt: now,
    });
    const joinedAt = now.plusDays(1);
    const accepted = invited.group.acceptInvitation({
      actorSubject: targetSubject,
      invitationId,
      participantId: ParticipantId.from('00000000-0000-4000-8000-000000006095'),
      acceptedAt: joinedAt,
    });
    await client.query('BEGIN');
    await writer.persist(
      client,
      makeRequest(accepted.group, 1, true, {
        membershipChanges: [
          {
            kind: 'Joined',
            participantId: accepted.participant.id,
            at: joinedAt,
          },
        ],
        invitationChanges: [
          {
            kind: 'Consumed',
            invitationId,
            participantId: accepted.participant.id,
            at: joinedAt,
          },
        ],
      }),
    );
    await client.query('COMMIT');
    const leftAt = joinedAt.plusDays(2);
    const departed = accepted.group.leave({
      actorSubject: targetSubject,
      participantId: accepted.participant.id,
      leftAt,
    });
    await client.query('BEGIN');
    await writer.persist(
      client,
      makeRequest(departed.group, 2, true, {
        membershipChanges: [
          {
            kind: 'Left',
            participantId: accepted.participant.id,
            at: leftAt,
          },
        ],
      }),
    );
    await client.query('COMMIT');

    const state = await client.query<{
      aggregate_version: string;
      active_actor_indexes: string;
      current_participant_rows: string;
      history_rows: string;
    }>(
      `
      SELECT a.aggregate_version,
        (SELECT count(*) FROM group_actor_access_index) AS active_actor_indexes,
        (SELECT count(*) FROM group_participant_record) AS current_participant_rows,
        (SELECT count(*) FROM group_membership_history_record) AS history_rows
      FROM group_aggregate_record a WHERE a.group_id = $1`,
      [groupId.value],
    );
    expect(state.rows[0]).toEqual({
      aggregate_version: '3',
      active_actor_indexes: '1',
      current_participant_rows: '2',
      history_rows: '3',
    });
  });

  it('appends a Group-close history protected with its distinct AAD record kind', async () => {
    const group = Group.create({
      id: groupId,
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    await client.query('BEGIN');
    await writer.persist(
      client,
      makeRequest(group, 'Absent', true, {
        membershipChanges: [{ kind: 'Joined', participantId, at: now }],
      }),
    );
    await client.query('COMMIT');

    const closeIntentId = CloseIntentId.from('test-close-intent-95');
    const closing = group.startClosing({
      actorSubject: actor,
      closeIntentId,
      cutoff: now,
    });
    await client.query('BEGIN');
    const outcome = await writer.persist(
      client,
      makeRequest(closing.group, 1, true, {
        groupCloseChanges: [
          {
            kind: 'ClosingStarted',
            closeIntentId,
            cutoff: now,
            startedBy: actor,
            startedFromVersion: 1,
          },
        ],
      }),
    );
    await client.query('COMMIT');

    expect(outcome).toEqual({ kind: 'Committed', version: 2 });
    const history = await client.query<{
      aggregate_version: string;
      logical_record_id: string;
      envelope_version: number;
      algorithm_id: string;
      schema_version: string;
      key_version: string;
      ciphertext: Buffer;
      nonce: Buffer;
      authentication_tag: Buffer;
    }>(
      `
      SELECT aggregate_version, logical_record_id, envelope_version,
             algorithm_id, schema_version, key_version, ciphertext, nonce,
             authentication_tag
      FROM group_close_history_record
      WHERE group_id = $1`,
      [groupId.value],
    );
    const row = history.rows[0];
    if (row === undefined) {
      throw new Error('Expected the Group-close history row');
    }
    if (row.algorithm_id !== 'AES-256-GCM') {
      throw new Error('Unexpected protected-record algorithm');
    }
    expect(row.aggregate_version).toBe('2');
    expect(row.ciphertext.toString('utf8')).not.toContain(closeIntentId.value);
    const envelope = await codec.open({
      expectedHeader: {
        envelopeVersion: BigInt(row.envelope_version),
        algorithmId: row.algorithm_id,
        app: 'kakei_app',
        contextName: 'group-management',
        recordKind: 'group-close-history',
        groupId: groupId.value,
        logicalRecordId: row.logical_record_id,
        schemaVersion: BigInt(row.schema_version),
        keyVersion: row.key_version,
        aggregateVersion: 2n,
        revisionOrdinal: null,
      },
      envelope: {
        header: {
          envelopeVersion: BigInt(row.envelope_version),
          algorithmId: row.algorithm_id,
          app: 'kakei_app',
          contextName: 'group-management',
          recordKind: 'group-close-history',
          groupId: groupId.value,
          logicalRecordId: row.logical_record_id,
          schemaVersion: BigInt(row.schema_version),
          keyVersion: row.key_version,
          aggregateVersion: 2n,
          revisionOrdinal: null,
        },
        aad: encodeCanonicalAad({
          envelopeVersion: BigInt(row.envelope_version),
          algorithmId: row.algorithm_id,
          app: 'kakei_app',
          contextName: 'group-management',
          recordKind: 'group-close-history',
          groupId: groupId.value,
          logicalRecordId: row.logical_record_id,
          schemaVersion: BigInt(row.schema_version),
          keyVersion: row.key_version,
          aggregateVersion: 2n,
          revisionOrdinal: null,
        }),
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authenticationTag: row.authentication_tag,
      },
    });
    expect(new TextDecoder().decode(envelope)).toContain(closeIntentId.value);
  });

  it('returns Conflict for stale CAS before changing any state or history', async () => {
    const group = Group.create({
      id: groupId,
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    await client.query('BEGIN');
    await writer.persist(
      client,
      makeRequest(group, 'Absent', true, {
        membershipChanges: [{ kind: 'Joined', participantId, at: now }],
      }),
    );
    await client.query('COMMIT');
    const readsBefore = await client.query<{ count: string }>(
      'SELECT count(*) FROM group_aggregate_record',
    );
    await client.query('BEGIN');
    const outcome = await writer.persist(client, makeRequest(group, 2, true));
    await client.query('ROLLBACK');
    const after = await client.query<{
      aggregate_version: string;
      history_count: string;
    }>(
      `
      SELECT aggregate_version,
        (SELECT count(*) FROM group_membership_history_record) AS history_count
      FROM group_aggregate_record WHERE group_id = $1`,
      [groupId.value],
    );

    expect(outcome).toEqual({ kind: 'Conflict' });
    expect(readsBefore.rows[0]?.count).toBe('1');
    expect(after.rows[0]).toEqual({
      aggregate_version: '1',
      history_count: '1',
    });
  });

  it('fails closed and relies on caller rollback when a protected history insert fails', async () => {
    const group = Group.create({
      id: groupId,
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    await client.query('BEGIN');
    await writer.persist(
      client,
      makeRequest(group, 'Absent', true, {
        membershipChanges: [{ kind: 'Joined', participantId, at: now }],
      }),
    );
    await client.query('COMMIT');
    await client.query(`
      CREATE FUNCTION reject_close_history() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_close_history
      BEFORE INSERT ON group_close_history_record
      FOR EACH ROW EXECUTE FUNCTION reject_close_history();
    `);
    const closeIntentId = CloseIntentId.from('test-close-rollback-95');
    const closing = group.startClosing({
      actorSubject: actor,
      closeIntentId,
      cutoff: now,
    });
    await client.query('BEGIN');
    const outcome = await writer.persist(
      client,
      makeRequest(closing.group, 1, true, {
        groupCloseChanges: [
          {
            kind: 'ClosingStarted',
            closeIntentId,
            cutoff: now,
            startedBy: actor,
            startedFromVersion: 1,
          },
        ],
      }),
    );
    expect(outcome).toEqual({ kind: 'Unavailable' });
    await client.query('ROLLBACK');
    const after = await client.query<{
      aggregate_version: string;
      history_count: string;
      invitation_count: string;
      participant_version: string;
      access_index_count: string;
    }>(
      `
      SELECT aggregate_version,
        (SELECT count(*) FROM group_membership_history_record) AS history_count,
        (SELECT count(*) FROM group_invitation_record) AS invitation_count,
        (SELECT min(aggregate_version) FROM group_participant_record) AS participant_version,
        (SELECT count(*) FROM group_actor_access_index) AS access_index_count
      FROM group_aggregate_record WHERE group_id = $1`,
      [groupId.value],
    );
    expect(after.rows[0]).toEqual({
      aggregate_version: '1',
      history_count: '1',
      invitation_count: '0',
      participant_version: '1',
      access_index_count: '1',
    });
    await client.query(
      'DROP TRIGGER reject_close_history ON group_close_history_record',
    );
    await client.query('DROP FUNCTION reject_close_history()');
    await client.query('BEGIN');
    const retry = await writer.persist(
      client,
      makeRequest(closing.group, 1, true, {
        groupCloseChanges: [
          {
            kind: 'ClosingStarted',
            closeIntentId,
            cutoff: now,
            startedBy: actor,
            startedFromVersion: 1,
          },
        ],
      }),
    );
    await client.query('COMMIT');
    expect(retry).toEqual({ kind: 'Committed', version: 2 });
  });

  it('serializes concurrent creates and lets only one caller create the Group', async () => {
    const group = Group.create({
      id: groupId,
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    const firstRequest = makeRequest(group, 'Absent', true, {
      membershipChanges: [{ kind: 'Joined', participantId, at: now }],
    });
    const secondRequest = makeRequest(group, 'Absent', true, {
      membershipChanges: [{ kind: 'Joined', participantId, at: now }],
    });
    await Promise.all([client.query('BEGIN'), secondClient.query('BEGIN')]);
    const persistAndFinish = async (
      transactionClient: Client,
      request: CommitGroupRequest,
    ) => {
      const outcome = await writer.persist(transactionClient, request);
      await transactionClient.query(
        outcome.kind === 'Unavailable' ? 'ROLLBACK' : 'COMMIT',
      );
      return outcome;
    };
    const outcomes = await Promise.all([
      persistAndFinish(client, firstRequest),
      persistAndFinish(secondClient, secondRequest),
    ]);

    expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
      'AlreadyExists',
      'Committed',
    ]);
    const count = await client.query<{ count: string }>(
      'SELECT count(*) FROM group_aggregate_record',
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('serializes concurrent updates and rejects the stale writer without partial history', async () => {
    const group = Group.create({
      id: groupId,
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    await client.query('BEGIN');
    await writer.persist(
      client,
      makeRequest(group, 'Absent', true, {
        membershipChanges: [{ kind: 'Joined', participantId, at: now }],
      }),
    );
    await client.query('COMMIT');
    const invited = group.inviteParticipant({
      actorSubject: actor,
      targetSubject: ActorSubject.from('invitee:race-test'),
      invitationId: InvitationId.from('00000000-0000-4000-8000-000000003095'),
      createdAt: now,
    });
    const nextInvitation = group.inviteParticipant({
      actorSubject: actor,
      targetSubject: ActorSubject.from('invitee:race-test-2'),
      invitationId: InvitationId.from('00000000-0000-4000-8000-000000004095'),
      createdAt: now,
    });
    await Promise.all([client.query('BEGIN'), secondClient.query('BEGIN')]);
    const persistAndFinish = async (
      transactionClient: Client,
      request: CommitGroupRequest,
    ) => {
      const outcome = await writer.persist(transactionClient, request);
      await transactionClient.query(
        outcome.kind === 'Unavailable' ? 'ROLLBACK' : 'COMMIT',
      );
      return outcome;
    };
    const outcomes = await Promise.all([
      persistAndFinish(
        client,
        makeRequest(invited.group, 1, true, {
          invitationChanges: [
            {
              kind: 'Created',
              invitationId: invited.invitation.id,
              targetSubject: invited.invitation.targetSubject,
              issuerParticipantId: invited.invitation.issuerParticipantId,
              createdAt: invited.invitation.createdAt,
              expiryAt: invited.invitation.expiryAt,
            },
          ],
        }),
      ),
      persistAndFinish(
        secondClient,
        makeRequest(nextInvitation.group, 1, true, {
          invitationChanges: [
            {
              kind: 'Created',
              invitationId: nextInvitation.invitation.id,
              targetSubject: nextInvitation.invitation.targetSubject,
              issuerParticipantId:
                nextInvitation.invitation.issuerParticipantId,
              createdAt: nextInvitation.invitation.createdAt,
              expiryAt: nextInvitation.invitation.expiryAt,
            },
          ],
        }),
      ),
    ]);

    expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
      'Committed',
      'Conflict',
    ]);
    const state = await client.query<{
      aggregate_version: string;
      invitation_count: string;
      history_count: string;
    }>(
      `
      SELECT aggregate_version,
        (SELECT count(*) FROM group_invitation_record) AS invitation_count,
        (SELECT count(*) FROM group_invitation_history_record) AS history_count
      FROM group_aggregate_record WHERE group_id = $1`,
      [groupId.value],
    );
    expect(state.rows[0]).toEqual({
      aggregate_version: '2',
      invitation_count: '1',
      history_count: '1',
    });
  });

  it('cascades current records, access indexes and histories when a Group is deleted', async () => {
    const group = Group.create({
      id: groupId,
      creatorSubject: actor,
      initialParticipantId: participantId,
      createdAt: now,
    });
    await client.query('BEGIN');
    await writer.persist(
      client,
      makeRequest(group, 'Absent', true, {
        membershipChanges: [{ kind: 'Joined', participantId, at: now }],
      }),
    );
    await client.query('COMMIT');
    await client.query(
      'DELETE FROM group_aggregate_record WHERE group_id = $1',
      [groupId.value],
    );
    const counts = await client.query(`
      SELECT
        (SELECT count(*) FROM group_participant_record) AS participants,
        (SELECT count(*) FROM group_invitation_record) AS invitations,
        (SELECT count(*) FROM group_membership_history_record) AS memberships,
        (SELECT count(*) FROM group_invitation_history_record) AS invitation_history,
        (SELECT count(*) FROM group_close_history_record) AS close_history,
        (SELECT count(*) FROM group_actor_access_index) AS access_index`);
    expect(counts.rows[0]).toEqual({
      participants: '0',
      invitations: '0',
      memberships: '0',
      invitation_history: '0',
      close_history: '0',
      access_index: '0',
    });
  });
});
