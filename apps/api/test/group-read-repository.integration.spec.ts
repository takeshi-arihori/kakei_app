import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createProtectedRecordCodec,
  encodeCanonicalAad,
  importProtectedRecordKey,
  importPurposeSeparatedDigest,
  type ProtectedRecordEnvelope,
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

import {
  operationLocatorDigestInput,
  type GroupOperationLocatorKeyPort,
} from '../src/group-management/application/group-access-policy.js';
import {
  GroupCommandApplicationError,
  GroupCommandService,
} from '../src/group-management/application/group-command-service.js';
import {
  CommandFingerprint,
  OperationId,
  type GroupRepository,
} from '../src/group-management/application/group-repository.js';
import {
  ActorSubject,
  Group,
  GroupId,
  ParticipantId,
  UtcInstant,
} from '../src/group-management/domain/group.js';
import {
  PostgresGroupReadRepository,
  GroupReadUnavailable,
} from '../src/group-management/infrastructure/postgres/group-read-repository.js';
import {
  encodeGroupRecordPayload,
  encodeOperationResultPayload,
} from '../src/group-management/infrastructure/postgres/group-record-payload.js';
import {
  applySqlMigrations,
  type SqlMigration,
} from '../src/group-management/infrastructure/postgres/sql-migration.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';
const groupId = GroupId.from('00000000-0000-4000-8000-000000000094');
const groupRecordId = '00000000-0000-4000-8000-000000001094';
const operationRecordId = '00000000-0000-4000-8000-000000002094';
const actor = ActorSubject.from('test-actor-94');
const operationId = OperationId.from('test-operation-94');

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

const testLocatorKeys = (): GroupOperationLocatorKeyPort => ({
  currentDigest(input) {
    return Promise.resolve({
      digest: importPurposeSeparatedDigest(
        createHash('sha256')
          .update('current')
          .update(input.canonicalInput)
          .digest(),
      ),
      digestKeyVersion: 'current',
    });
  },
  candidateDigests(input) {
    return Promise.resolve(
      ['current', 'retired'].map((version) => ({
        digest: importPurposeSeparatedDigest(
          createHash('sha256')
            .update(version)
            .update(input.canonicalInput)
            .digest(),
        ),
        digestKeyVersion: version,
      })),
    );
  },
});

describe('PostgreSQL Group read and replay', () => {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  const locatorKeys = testLocatorKeys();
  const dataKey = importProtectedRecordKey(new Uint8Array(32).fill(94));
  let schemaName = '';
  let sequence = 0;
  let keyReads = 0;
  let opens = 0;
  let nonceCounter = 0;
  let keyAvailable = true;
  const baseCodec = createProtectedRecordCodec({
    keyPort: {
      allocateForSeal() {
        nonceCounter += 1;
        const nonce = new Uint8Array(12);
        nonce[11] = nonceCounter;
        return Promise.resolve({
          status: 'allocated' as const,
          key: dataKey,
          keyVersion: 'test-key-v1',
          nonce,
          sealCount: BigInt(nonceCounter),
        });
      },
      readKey() {
        keyReads += 1;
        if (!keyAvailable) {
          return Promise.resolve({ status: 'key-lost' as const });
        }
        return Promise.resolve({
          status: 'available' as const,
          key: dataKey,
          lifecycle: 'current' as const,
        });
      },
      async requestRotation() {},
    },
  });
  const codec = {
    seal: baseCodec.seal,
    async open(input: Parameters<typeof baseCodec.open>[0]) {
      opens += 1;
      return baseCodec.open(input);
    },
  };

  const repository = new PostgresGroupReadRepository({
    database: client,
    codec,
    encodeAad: encodeCanonicalAad,
    locatorKeys,
  });

  const insertGroup = async (): Promise<ProtectedRecordEnvelope> => {
    const group = Group.create({
      id: groupId,
      initialParticipantId: ParticipantId.from('participant-94'),
      creatorSubject: actor,
      createdAt: UtcInstant.from(new Date('2026-09-23T00:00:00.000Z')),
    });
    const envelope = await codec.seal({
      header: {
        envelopeVersion: 1n,
        algorithmId: 'AES-256-GCM',
        app: 'kakei_app',
        contextName: 'group-management',
        recordKind: 'group',
        groupId: groupId.value,
        logicalRecordId: groupRecordId,
        schemaVersion: 1n,
        aggregateVersion: 1n,
        revisionOrdinal: null,
      },
      plaintext: encodeGroupRecordPayload(group),
    });
    await client.query(
      `INSERT INTO group_aggregate_record (
        group_id, logical_record_id, aggregate_version, access_policy_version,
        envelope_version, algorithm_id, schema_version, key_version,
        ciphertext, nonce, authentication_tag, created_at, updated_at
      ) VALUES ($1, $2, 1, 1, 1, 'AES-256-GCM', 1, $3, $4, $5, $6, now(), now())`,
      [
        groupId.value,
        groupRecordId,
        envelope.header.keyVersion,
        Buffer.from(envelope.ciphertext),
        Buffer.from(envelope.nonce),
        Buffer.from(envelope.authenticationTag),
      ],
    );
    return envelope;
  };

  const insertOperation = async (
    version: 'current' | 'retired' = 'current',
  ): Promise<void> => {
    const operation = {
      actorSubject: actor,
      operationId,
      fingerprint: CommandFingerprint.from('["CreateGroup"]'),
      result: {
        kind: 'GroupCreated' as const,
        groupId,
        participantId: ParticipantId.from('participant-94'),
        version: 1,
      },
    };
    const envelope = await codec.seal({
      header: {
        envelopeVersion: 1n,
        algorithmId: 'AES-256-GCM',
        app: 'kakei_app',
        contextName: 'group-management',
        recordKind: 'operation-result',
        groupId: groupId.value,
        logicalRecordId: operationRecordId,
        schemaVersion: 1n,
        aggregateVersion: 1n,
        revisionOrdinal: null,
      },
      plaintext: encodeOperationResultPayload(operation),
    });
    await client.query(
      `INSERT INTO group_operation_result_record (
        logical_record_id, group_id, aggregate_version, envelope_version,
        algorithm_id, schema_version, key_version, ciphertext, nonce,
        authentication_tag, created_at
      ) VALUES ($1, $2, 1, 1, 'AES-256-GCM', 1, $3, $4, $5, $6, now())`,
      [
        operationRecordId,
        groupId.value,
        envelope.header.keyVersion,
        Buffer.from(envelope.ciphertext),
        Buffer.from(envelope.nonce),
        Buffer.from(envelope.authenticationTag),
      ],
    );
    const candidate = (
      await locatorKeys.candidateDigests(
        operationLocatorDigestInput(actor, operationId),
      )
    ).find((entry) => entry.digestKeyVersion === version);
    if (candidate === undefined) {
      throw new Error('Test locator candidate missing');
    }
    await client.query(
      `INSERT INTO group_operation_locator_v2 (
        locator_digest, digest_key_version, command_fingerprint,
        group_id, operation_result_record_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, now())`,
      [
        Buffer.from(candidate.digest),
        candidate.digestKeyVersion,
        Buffer.from('test-fingerprint-digest'),
        groupId.value,
        operationRecordId,
      ],
    );
  };

  beforeAll(async () => {
    await client.connect();
  });

  beforeEach(async () => {
    schemaName = `test_issue_94_${process.pid}_${sequence++}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}`);
    await applySqlMigrations(client, [await migration(1), await migration(2)]);
    keyReads = 0;
    opens = 0;
    keyAvailable = true;
  });

  afterEach(async () => {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  });

  afterAll(async () => {
    await client.end();
  });

  it('missing Group is null; valid protected Group restores Domain state and version', async () => {
    expect(await repository.load(groupId)).toBeNull();
    expect(keyReads).toBe(0);
    await insertGroup();
    const loaded = await repository.load(groupId);
    expect(loaded?.version).toBe(1);
    expect(loaded?.group.id.equals(groupId)).toBe(true);
    expect(loaded?.group.ownerParticipantId?.value).toBe('participant-94');
    expect(keyReads).toBe(1);
  });

  it('locator candidate miss never reads a Group data key or decrypts', async () => {
    await insertGroup();
    keyReads = 0;
    opens = 0;
    expect(await repository.findOperation(actor, operationId)).toEqual({
      kind: 'Missing',
    });
    expect(keyReads).toBe(0);
    expect(opens).toBe(0);
  });

  it.each(['current', 'retired'] as const)(
    '%s candidate hit restores protected operation and Application replays only matching input',
    async (version) => {
      await insertGroup();
      await insertOperation(version);
      keyReads = 0;
      opens = 0;
      const found = await repository.findOperation(actor, operationId);
      expect(found.kind).toBe('Found');
      expect(keyReads).toBe(1);
      expect(opens).toBe(1);

      const readOnlyRepository: GroupRepository = {
        load: repository.load.bind(repository),
        findOperation: repository.findOperation.bind(repository),
        commit() {
          return Promise.reject(new Error('write commit is outside Task #94'));
        },
      };
      const service = new GroupCommandService(readOnlyRepository, {
        nextGroupId: () => groupId,
        nextParticipantId: () => ParticipantId.from('unused-participant'),
        nextInvitationId: () => {
          throw new Error('unused');
        },
        nextCloseIntentId: () => {
          throw new Error('unused');
        },
        now: () => UtcInstant.from(new Date('2026-09-23T00:00:00.000Z')),
      });
      const replay = await service.createGroup({
        actorSubject: actor,
        operationId,
      });
      expect(replay.kind).toBe('GroupCreated');
      expect(replay.groupId.equals(groupId)).toBe(true);
      await expect(
        service.transferGroupOwnership({
          actorSubject: actor,
          operationId,
          groupId,
          targetParticipantId: ParticipantId.from('participant-94'),
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({
        code: 'OPERATION_MISMATCH',
      } satisfies Partial<GroupCommandApplicationError>);
    },
  );

  it('another Actor or operation is Missing before data-key read', async () => {
    await insertGroup();
    await insertOperation();
    keyReads = 0;
    opens = 0;
    expect(
      await repository.findOperation(
        ActorSubject.from('other-actor'),
        operationId,
      ),
    ).toEqual({ kind: 'Missing' });
    expect(
      await repository.findOperation(
        actor,
        OperationId.from('other-operation'),
      ),
    ).toEqual({ kind: 'Missing' });
    expect(keyReads).toBe(0);
    expect(opens).toBe(0);
  });

  it('tampered operation result and unavailable Group key fail closed', async () => {
    await insertGroup();
    await insertOperation();
    keyAvailable = false;
    await expect(
      repository.findOperation(actor, operationId),
    ).rejects.toBeInstanceOf(GroupReadUnavailable);
    keyAvailable = true;
    await client.query(
      `UPDATE group_operation_result_record SET ciphertext = decode('01', 'hex')
       WHERE logical_record_id = $1`,
      [operationRecordId],
    );
    await expect(
      repository.findOperation(actor, operationId),
    ).rejects.toBeInstanceOf(GroupReadUnavailable);
  });

  it('Group key loss, metadata drift, and policy-version mismatch are generic failures', async () => {
    await insertGroup();
    keyAvailable = false;
    await expect(repository.load(groupId)).rejects.toBeInstanceOf(
      GroupReadUnavailable,
    );
    keyAvailable = true;

    await client.query(
      `UPDATE group_aggregate_record SET envelope_version = 2 WHERE group_id = $1`,
      [groupId.value],
    );
    keyReads = 0;
    await expect(repository.load(groupId)).rejects.toBeInstanceOf(
      GroupReadUnavailable,
    );
    expect(keyReads).toBe(0);

    await client.query(
      `UPDATE group_aggregate_record SET envelope_version = 1,
       access_policy_version = 2 WHERE group_id = $1`,
      [groupId.value],
    );
    await expect(repository.load(groupId)).rejects.toBeInstanceOf(
      GroupReadUnavailable,
    );
  });

  it('valid encryption with a different Actor or wrong result version is rejected', async () => {
    await insertGroup();
    await insertOperation();
    const wrongActorEnvelope = await codec.seal({
      header: {
        envelopeVersion: 1n,
        algorithmId: 'AES-256-GCM',
        app: 'kakei_app',
        contextName: 'group-management',
        recordKind: 'operation-result',
        groupId: groupId.value,
        logicalRecordId: operationRecordId,
        schemaVersion: 1n,
        aggregateVersion: 1n,
        revisionOrdinal: null,
      },
      plaintext: encodeOperationResultPayload({
        actorSubject: ActorSubject.from('different-actor'),
        operationId,
        fingerprint: CommandFingerprint.from('["CreateGroup"]'),
        result: {
          kind: 'GroupCreated',
          groupId,
          participantId: ParticipantId.from('participant-94'),
          version: 1,
        },
      }),
    });
    await client.query(
      `UPDATE group_operation_result_record
          SET ciphertext = $2, nonce = $3, authentication_tag = $4
        WHERE logical_record_id = $1`,
      [
        operationRecordId,
        Buffer.from(wrongActorEnvelope.ciphertext),
        Buffer.from(wrongActorEnvelope.nonce),
        Buffer.from(wrongActorEnvelope.authenticationTag),
      ],
    );
    await expect(
      repository.findOperation(actor, operationId),
    ).rejects.toBeInstanceOf(GroupReadUnavailable);

    await client.query(
      `UPDATE group_operation_result_record SET aggregate_version = 2
       WHERE logical_record_id = $1`,
      [operationRecordId],
    );
    await expect(
      repository.findOperation(actor, operationId),
    ).rejects.toBeInstanceOf(GroupReadUnavailable);
  });

  it('tampered Group ciphertext fails closed without exposing a Domain detail', async () => {
    await insertGroup();
    await client.query(
      `UPDATE group_aggregate_record SET ciphertext = decode('01', 'hex') WHERE group_id = $1`,
      [groupId.value],
    );
    await expect(repository.load(groupId)).rejects.toBeInstanceOf(
      GroupReadUnavailable,
    );
  });

  it('locator input keeps Actor and operation identity separate', () => {
    const first = operationLocatorDigestInput(
      ActorSubject.from('a:b'),
      OperationId.from('c'),
    );
    const second = operationLocatorDigestInput(
      ActorSubject.from('a'),
      OperationId.from('b:c'),
    );
    expect(first.canonicalInput).not.toEqual(second.canonicalInput);
  });
});
