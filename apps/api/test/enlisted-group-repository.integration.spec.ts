import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, Pool, type PoolClient } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import {
  createProtectedRecordCodec,
  encodeCanonicalAad,
  importProtectedRecordKey,
  importPurposeSeparatedDigest,
} from '../src/shared/infrastructure/protected-record/index.js';
import { createAuthenticationTransactionScopes } from '../src/shared/infrastructure/authentication/postgres/authentication-transaction-scopes.js';
import { createRecipientCodeTransactionScopes } from '../src/shared/infrastructure/authentication/postgres/recipient-code-transaction-scopes.js';
import type {
  AuthenticationSerializedValue,
  AuthenticationTransactionScope,
} from '../src/shared/application/authentication/authentication-transaction-scope.js';
import type { RecipientCodeTransactionScopes } from '../src/shared/infrastructure/authentication/postgres/recipient-code-transaction-scopes.js';
import { RecipientCodeSecret } from '../src/shared/application/authentication/recipient-code-input.js';
import {
  ActorSubject,
  GroupId,
  Group,
  ParticipantId,
  InvitationId,
  UtcInstant,
} from '../src/group-management/domain/group.js';
import {
  CommandFingerprint,
  OperationId,
  type CommitGroupRequest,
} from '../src/group-management/application/group-repository.js';
import type { RecipientInvitationCommitPlan } from '../src/group-management/application/recipient-invitation-repository.js';
import type {
  GroupPolicyDigestPort,
  GroupOperationLocatorKeyPort,
} from '../src/group-management/application/group-access-policy.js';
import { GroupCommandService } from '../src/group-management/application/group-command-service.js';
import { recipientCodeInvitationFingerprint } from '../src/group-management/application/group-policy-digest.js';
import { PostgresGroupRepository } from '../src/group-management/infrastructure/postgres/group-repository.js';
import { PostgresGroupStateWriter } from '../src/group-management/infrastructure/postgres/group-state-writer.js';
import { createEnlistedGroupRepository } from '../src/group-management/infrastructure/postgres/enlisted-group-repository.js';
import {
  createRecipientCodeRequestProof,
  importRecipientCodeRequestProofKey,
} from '../src/group-management/infrastructure/recipient-code-request-proof.js';
import {
  createGroupInvitationAuditProtector,
  importGroupInvitationAuditKey,
} from '../src/group-management/infrastructure/group-invitation-audit.js';
import { PostgresGroupInvitationAuditWriter } from '../src/group-management/infrastructure/postgres/group-invitation-audit-writer.js';
import { applySqlMigrations } from '../src/group-management/infrastructure/postgres/sql-migration.js';

const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kakei:kakei_local_password@localhost:5432/kakei_test';
const ownerActor = ActorSubject.from('10000000-0000-4000-8000-000000000020');
const recipientActorId = '10000000-0000-4000-8000-000000000010';
const codeId = '10000000-0000-4000-8000-000000000030';
const groupId = GroupId.from('10000000-0000-4000-8000-000000000242');
const epoch = Date.parse('2026-10-30T00:00:00.000Z');
const code = () =>
  RecipientCodeSecret.parse(Buffer.alloc(32, 66).toString('base64url'))!;
type Bound = ReturnType<RecipientCodeTransactionScopes['bind']>;

describe('GM実保存の認証Scope参加（認証owner/コードWriterだけ合成）', () => {
  const admin = new Client({ connectionString: url });
  let pool: Pool, schema: string;
  let codec: ReturnType<typeof createProtectedRecordCodec>;
  let repository: ReturnType<typeof createEnlistedGroupRepository>;
  let standalone: PostgresGroupRepository;
  let scopes: RecipientCodeTransactionScopes;
  let proof: ReturnType<typeof createRecipientCodeRequestProof>;
  let proofMaterials: Map<string, Uint8Array>;
  let proofReads: string[];
  let sqls: string[];
  let opened: AuthenticationTransactionScope | undefined;
  let decrypts: Mock<ReturnType<typeof createProtectedRecordCodec>['open']>;
  let afterState: (() => Promise<void>) | undefined;
  let lastClient: PoolClient | undefined;
  let loseCommitResponse: boolean;
  beforeAll(async () => {
    await admin.connect();
  });
  beforeEach(async () => {
    schema = `gm_enlisted_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    const names = [
      [1, '0001_group_management_storage'],
      [2, '0002_group_locator_v2'],
      [3, '0003_close_intent_registry'],
      [4, '0004_group_management_retention'],
      [10, '0010_recipient_invitation_enlistment'],
    ] as const;
    await applySqlMigrations(
      admin,
      await Promise.all(
        names.map(async ([version, name]) => ({
          version,
          name,
          sql: await readFile(
            new URL(
              `../migrations/group-management/${name}.sql`,
              import.meta.url,
            ),
            'utf8',
          ),
        })),
      ),
    );
    await admin.query(
      "UPDATE group_operation_locator_key_state SET current_key_version = 'locator-v1' WHERE id = 1",
    );
    await admin.query(
      "UPDATE group_recipient_code_proof_key_state SET current_key_version = 'proof-v1' WHERE id = 1",
    );
    await admin.query(
      'CREATE TABLE synthetic_code_consumption (code_id uuid PRIMARY KEY, recipient_actor_id uuid NOT NULL)',
    );
    pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
      max: 4,
    });
    sqls = [];
    opened = undefined;
    afterState = undefined;
    loseCommitResponse = false;
    const groupKeys = new Map<
      string,
      ReturnType<typeof importProtectedRecordKey>
    >();
    let counter = 0n;
    const rawCodec = createProtectedRecordCodec({
      keyPort: {
        allocateForSeal({ groupId }) {
          if (!groupKeys.has(groupId))
            groupKeys.set(groupId, importProtectedRecordKey(randomBytes(32)));
          counter += 1n;
          const nonce = Buffer.alloc(12);
          nonce.writeBigUInt64BE(counter, 4);
          return Promise.resolve({
            status: 'allocated' as const,
            key: groupKeys.get(groupId)!,
            keyVersion: 'group-v1',
            nonce,
            sealCount: counter,
          });
        },
        readKey({ groupId, keyVersion }) {
          return Promise.resolve(
            groupKeys.has(groupId) && keyVersion === 'group-v1'
              ? {
                  status: 'available' as const,
                  lifecycle: 'current' as const,
                  key: groupKeys.get(groupId)!,
                }
              : { status: 'key-lost' as const },
          );
        },
        requestRotation() {
          return Promise.resolve();
        },
      },
    });
    decrypts = vi.fn(rawCodec.open);
    codec = { ...rawCodec, open: decrypts };
    const digestMaterial = randomBytes(32),
      locatorMaterial = randomBytes(32);
    const digests: GroupPolicyDigestPort = {
      digest(input) {
        return Promise.resolve({
          digest: importPurposeSeparatedDigest(
            createHmac('sha256', digestMaterial)
              .update(input.purpose)
              .update(input.groupId)
              .update(input.canonicalInput)
              .digest(),
          ),
          digestKeyVersion: 'index-v1',
        });
      },
    };
    const locatorKeys: GroupOperationLocatorKeyPort = {
      currentDigest(input) {
        return Promise.resolve({
          digest: importPurposeSeparatedDigest(
            createHmac('sha256', locatorMaterial)
              .update(input.canonicalInput)
              .digest(),
          ),
          digestKeyVersion: 'locator-v1',
        });
      },
      async candidateDigests(input) {
        return [await this.currentDigest(input)];
      },
    };
    const stateWriter = new PostgresGroupStateWriter({
      codec,
      accessIndexDigests: digests,
      now: () => new Date(epoch),
    });
    const state = {
      async persist(...args: Parameters<typeof stateWriter.persist>) {
        const result = await stateWriter.persist(...args);
        if (afterState !== undefined && result.kind === 'Committed')
          await afterState();
        return result;
      },
    };
    standalone = new PostgresGroupRepository({
      pool,
      stateWriter: state,
      codec,
      encodeAad: encodeCanonicalAad,
      locatorKeys,
      accessIndexDigests: digests,
      now: () => new Date(epoch),
    });
    proofMaterials = new Map([['proof-v1', randomBytes(32)]]);
    proofReads = [];
    proof = createRecipientCodeRequestProof({
      keys: {
        readKey(query) {
          proofReads.push(query.keyVersion);
          const material = proofMaterials.get(query.keyVersion);
          return Promise.resolve(
            material
              ? {
                  status: 'available' as const,
                  ...query,
                  key: importRecipientCodeRequestProofKey(material),
                }
              : { status: 'unavailable' as const },
          );
        },
      },
    });
    const auditKeys = new Map<string, Uint8Array>();
    const audit = createGroupInvitationAuditProtector({
      keys: {
        readCurrent({ scopeId }) {
          if (!auditKeys.has(scopeId)) auditKeys.set(scopeId, randomBytes(32));
          return Promise.resolve({
            status: 'available' as const,
            scopeId,
            keyVersion: 'audit-v1',
            key: importGroupInvitationAuditKey(auditKeys.get(scopeId)!),
          });
        },
      },
    });
    scopes = createRecipientCodeTransactionScopes(
      createAuthenticationTransactionScopes(),
    );
    repository = createEnlistedGroupRepository({
      registerGroupParticipant: (registration) =>
        scopes.registerGroupParticipant(registration),
      stateWriter: state,
      codec,
      encodeAad: encodeCanonicalAad,
      locatorKeys,
      accessIndexDigests: digests,
      auditWriter: new PostgresGroupInvitationAuditWriter({
        protector: audit,
        now: () => new Date(epoch + 2000),
      }),
    });
  });
  afterEach(async () => {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });
  afterAll(async () => {
    await admin.end();
  });

  const seed = async (id = groupId) => {
    const initialParticipantId = ParticipantId.from(randomUUID());
    const at = UtcInstant.from(new Date(epoch));
    const group = Group.create({
      id,
      creatorSubject: ownerActor,
      initialParticipantId,
      createdAt: at,
    });
    const request: CommitGroupRequest = {
      group,
      expectedVersion: 'Absent',
      stateChanged: true,
      membershipChanges: [
        { kind: 'Joined', participantId: initialParticipantId, at },
      ],
      invitationChanges: [],
      groupCloseChanges: [],
      operation: {
        actorSubject: ownerActor,
        operationId: OperationId.from(`seed-${id.value}`),
        fingerprint: CommandFingerprint.from(`seed-${id.value}`),
      },
      result: {
        kind: 'GroupCreated',
        groupId: id,
        participantId: initialParticipantId,
      },
    };
    expect(await standalone.commit(request)).toMatchObject({
      kind: 'Committed',
      result: { version: 1 },
    });
  };
  // 実#239 registryと実GMを使うが、本人性とコード消費Writer/認証Auditの実証ではない。
  const owner = async (
    work: (
      scope: AuthenticationTransactionScope,
      bound?: Bound,
    ) => Promise<AuthenticationSerializedValue>,
    facts?: { codeId: string; recipientActorId: string },
  ) => {
    const client = await pool.connect();
    lastClient = client;
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '1500ms'");
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    const lease = scopes.scopes.open({
      async query(sql, values) {
        sqls.push(sql);
        return await client.query(sql, values);
      },
    });
    opened = lease.scope;
    let commitSent = false,
      discard = false;
    try {
      await scopes.prepare(lease.scope);
      const bound = facts
        ? scopes.bind(
            lease.scope,
            facts,
            async () => {
              await scopes.scopes.participants.query(
                lease.scope,
                'INSERT INTO synthetic_code_consumption (code_id, recipient_actor_id) VALUES ($1,$2)',
                [facts.codeId, facts.recipientActorId],
              );
            },
            () => {},
          )
        : undefined;
      const value = await work(lease.scope, bound);
      lease.seal();
      lease.assertResult(value);
      lease.assertCommittable();
      commitSent = true;
      await client.query('COMMIT');
      if (loseCommitResponse)
        throw new Error('synthetic commit outcome unknown');
      return value.body;
    } catch (error) {
      discard = commitSent;
      if (!commitSent) {
        lease.seal();
        await lease.drain();
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      lease.close();
      client.release(discard);
    }
  };
  const plan = async (
    scope: AuthenticationTransactionScope,
    operationId = OperationId.from('create-from-code'),
    id = groupId,
    binding = { codeId, recipientActorId },
    actor = ownerActor,
    changeLoaded?: (group: Group) => void,
  ): Promise<RecipientInvitationCommitPlan> => {
    const loaded = await repository.loadForInvitation(scope, id, actor);
    expect(loaded).not.toBeNull();
    changeLoaded?.(loaded!.group);
    const invitationId = InvitationId.from(randomUUID()),
      createdAt = UtcInstant.from(new Date(epoch + 1000));
    const invited = loaded!.group.inviteParticipant({
      actorSubject: actor,
      targetSubject: ActorSubject.from(binding.recipientActorId),
      invitationId,
      createdAt,
    });
    const result = {
      kind: 'InvitationCreated' as const,
      groupId: id,
      invitationId,
      version: loaded!.version + 1,
    };
    const fingerprint = recipientCodeInvitationFingerprint(
      id,
      loaded!.version,
      await proof.create({
        secret: code(),
        keyVersion: await repository.currentProofKeyVersion(scope),
      }),
    );
    const value = scope.serialize({
      kind: result.kind,
      groupId: id.value,
      version: result.version,
      invitationId: invitationId.value,
    });
    return {
      group: invited.group,
      expectedVersion: loaded!.version,
      stateChanged: true,
      membershipChanges: [],
      groupCloseChanges: [],
      invitationChanges: [
        {
          kind: 'Created',
          invitationId,
          targetSubject: invited.invitation.targetSubject,
          issuerParticipantId: invited.invitation.issuerParticipantId,
          createdAt,
          expiryAt: invited.invitation.expiryAt,
        },
      ],
      operation: {
        actorSubject: actor,
        operationId,
        fingerprint,
        result,
        binding,
      },
      value,
    };
  };
  const create = (
    operationId = OperationId.from('create-from-code'),
    id = groupId,
    binding = { codeId, recipientActorId },
  ) =>
    owner(async (scope, bound) => {
      const p = await plan(scope, operationId, id, binding);
      const evidence = await repository.stage(scope, bound!.handle, p);
      await bound!.scope.consume(bound!.handle, evidence);
      return p.value;
    }, binding);
  const counts = async () =>
    (
      await pool.query<{
        version: string;
        invitations: string;
        history: string;
        operations: string;
        locators: string;
        audit: string;
        consumed: string;
      }>(
        `SELECT
    (SELECT aggregate_version::text FROM group_aggregate_record WHERE group_id = $1) AS version,
    (SELECT count(*)::text FROM group_invitation_record) AS invitations,
    (SELECT count(*)::text FROM group_invitation_history_record) AS history,
    (SELECT count(*)::text FROM group_operation_result_record) AS operations,
    (SELECT count(*)::text FROM group_operation_locator_v2) AS locators,
    (SELECT count(*)::text FROM group_recipient_invitation_audit_record) AS audit,
    (SELECT count(*)::text FROM synthetic_code_consumption) AS consumed`,
        [groupId.value],
      )
    ).rows[0];

  it('実GMの状態/Policy/履歴/operation/locator/最小Auditを同scopeへstageする', async () => {
    await seed();
    const body = JSON.parse(await create()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['kind', 'groupId', 'version', 'invitationId'].sort(),
    );
    expect(await counts()).toEqual({
      version: '2',
      invitations: '1',
      history: '1',
      operations: '2',
      locators: '2',
      audit: '1',
      consumed: '1',
    });
    const loaded = await standalone.load(groupId);
    expect(loaded?.group.accessPolicyVersion).toBe(2);
    expect(loaded?.group.invitations[0]?.expiryAt.value).toBe(
      new Date(epoch + 1000 + 7 * 86400000).toISOString(),
    );
    expect(
      await standalone.findOperation(
        ownerActor,
        OperationId.from('create-from-code'),
      ),
    ).toEqual({ kind: 'OperationMismatch' });
    expect(sqls.some((sql) => /authentication\./i.test(sql))).toBe(false);
  });
  it('コード行がなくcurrent proof鍵が利用不能でも保存世代で最小結果を再送する', async () => {
    await seed();
    const original = await create();
    // 本人受諾とOwner譲渡も既存Application/Repositoryで確定し、現在Ownerを失わせる。
    const service = new GroupCommandService(standalone, {
      nextGroupId: () => GroupId.from(randomUUID()),
      nextParticipantId: () => ParticipantId.from(randomUUID()),
      nextInvitationId: () => InvitationId.from(randomUUID()),
      nextCloseIntentId: () => {
        throw new Error('not used');
      },
      now: () => UtcInstant.from(new Date(epoch + 2000)),
    });
    const other = ActorSubject.from('10000000-0000-4000-8000-000000000050');
    const invited = await service.inviteParticipant({
      actorSubject: ownerActor,
      operationId: OperationId.from('invite-next-owner'),
      groupId,
      targetSubject: other,
      expectedVersion: 2,
    });
    const accepted = await service.acceptInvitation({
      actorSubject: other,
      operationId: OperationId.from('accept-next-owner'),
      groupId,
      invitationId: invited.invitationId,
      expectedVersion: 3,
    });
    await service.transferGroupOwnership({
      actorSubject: ownerActor,
      operationId: OperationId.from('transfer-owner'),
      groupId,
      targetParticipantId: accepted.participantId,
      expectedVersion: 4,
    });
    expect((await standalone.load(groupId))?.group.ownerParticipantId).toEqual(
      accepted.participantId,
    );
    await pool.query('DELETE FROM synthetic_code_consumption');
    await pool.query(
      'UPDATE group_recipient_code_proof_key_state SET current_key_version = NULL WHERE id = 1',
    );
    proofReads.length = 0;
    sqls.length = 0;
    decrypts.mockClear();
    const replayed = await owner(async (scope) => {
      const saved = await repository.findOperation(
        scope,
        ownerActor,
        OperationId.from('create-from-code'),
      );
      expect(saved).not.toBeNull();
      if (!saved || saved.fingerprint instanceof CommandFingerprint)
        throw new Error('expected new action');
      expect(
        await proof.verify({ secret: code(), saved: saved.fingerprint.proof }),
      ).toBe(true);
      return scope.serialize({
        kind: saved.result.kind,
        groupId: saved.result.groupId.value,
        version: saved.result.version,
        invitationId:
          'invitationId' in saved.result ? saved.result.invitationId.value : '',
      });
    });
    expect(replayed).toBe(original);
    expect(proofReads).toEqual(['proof-v1']);
    expect(
      sqls.some((sql) =>
        /FROM group_aggregate_record|FROM group_actor_access_index|synthetic_code_consumption|authentication\./i.test(
          sql,
        ),
      ),
    ).toBe(false);
    expect(decrypts).toHaveBeenCalledTimes(1);
  });
  it('非在籍ActorはGroup復号0で拒否し、終了Scopeを再利用できない', async () => {
    await seed();
    decrypts.mockClear();
    await owner(async (scope) => {
      expect(
        await repository.loadForInvitation(
          scope,
          groupId,
          ActorSubject.from(recipientActorId),
        ),
      ).toBeNull();
      return scope.serialize({ status: 'denied' });
    });
    expect(decrypts).not.toHaveBeenCalled();
    await expect(repository.currentProofKeyVersion(opened!)).rejects.toThrow();
  });
  it.each([
    ['group_aggregate_record', 'UPDATE'],
    ['group_invitation_record', 'INSERT'],
    ['group_invitation_history_record', 'INSERT'],
    ['group_operation_result_record', 'INSERT'],
    ['group_operation_locator_v2', 'INSERT'],
    ['group_recipient_invitation_audit_record', 'INSERT'],
  ] as const)(
    '%sの故障で状態/履歴/locator/結果/Audit/合成消費を全rollbackする',
    async (table, event) => {
      await seed();
      await pool.query(
        `CREATE FUNCTION fail_gm_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic GM failure'; END $$`,
      );
      await pool.query(
        `CREATE TRIGGER fail_gm_write BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_gm_write()`,
      );
      await expect(create()).rejects.toThrow();
      expect(await counts()).toEqual({
        version: '1',
        invitations: '0',
        history: '0',
        operations: '1',
        locators: '1',
        audit: '0',
        consumed: '0',
      });
    },
  );

  it.each(['non-owner', 'owner-policy', 'owner-state'] as const)(
    '返却Groupの実行時変更/%sを保存用Rootへ混入させず、証跡化しない',
    async (attack) => {
      await seed();
      const service = new GroupCommandService(standalone, {
        nextGroupId: () => GroupId.from(randomUUID()),
        nextParticipantId: () => ParticipantId.from(randomUUID()),
        nextInvitationId: () => InvitationId.from(randomUUID()),
        nextCloseIntentId: () => {
          throw new Error('not used');
        },
        now: () => UtcInstant.from(new Date(epoch + 1000)),
      });
      const member = ActorSubject.from('10000000-0000-4000-8000-000000000050');
      const invited = await service.inviteParticipant({
        actorSubject: ownerActor,
        operationId: OperationId.from('invite-member'),
        groupId,
        targetSubject: member,
        expectedVersion: 1,
      });
      const accepted = await service.acceptInvitation({
        actorSubject: member,
        operationId: OperationId.from('accept-member'),
        groupId,
        invitationId: invited.invitationId,
        expectedVersion: 2,
      });
      const before = await counts();
      const actor = attack === 'non-owner' ? member : ownerActor;
      await expect(
        owner(
          async (scope, bound) => {
            const p = await plan(
              scope,
              OperationId.from('tampered-loaded-root'),
              groupId,
              { codeId, recipientActorId },
              actor,
              (root) => {
                if (attack === 'non-owner')
                  expect(
                    Reflect.set(
                      root,
                      'ownerParticipantId',
                      accepted.participantId,
                    ),
                  ).toBe(true);
                else if (attack === 'owner-policy')
                  expect(
                    Reflect.set(
                      root,
                      'accessPolicyVersion',
                      root.accessPolicyVersion + 1,
                    ),
                  ).toBe(true);
                else
                  expect(
                    Reflect.set(
                      root,
                      'participantStates',
                      root.participants.map((p) =>
                        p.id.equals(accepted.participantId)
                          ? {
                              ...p,
                              subject: ActorSubject.from(
                                '10000000-0000-4000-8000-000000000051',
                              ),
                            }
                          : p,
                      ),
                    ),
                  ).toBe(true);
              },
            );
            const evidence = await repository.stage(scope, bound!.handle, p);
            await bound!.scope.consume(bound!.handle, evidence);
            return p.value;
          },
          { codeId, recipientActorId },
        ),
      ).rejects.toThrow();
      expect(await counts()).toEqual(before);
      const current = (await standalone.load(groupId))!;
      expect(current.group.ownerParticipantId).not.toEqual(
        accepted.participantId,
      );
      expect(
        current.group.participants.some((p) => p.subject.equals(member)),
      ).toBe(true);
      await owner(async (scope) => {
        expect(
          await repository.findOperation(
            scope,
            actor,
            OperationId.from('tampered-loaded-root'),
          ),
        ).toBeNull();
        return scope.serialize({ checked: true });
      });
    },
  );

  it.each(['root', 'code', 'recipient', 'response', 'foreign-value'] as const)(
    '偽の保存計画/%sから登録GM証跡や部分保存を作れない',
    async (field) => {
      await seed();
      await expect(
        owner(
          async (scope, bound) => {
            let binding = { codeId, recipientActorId };
            if (field === 'code')
              binding = {
                ...binding,
                codeId: '10000000-0000-4000-8000-000000000031',
              };
            if (field === 'recipient')
              binding = {
                ...binding,
                recipientActorId: '10000000-0000-4000-8000-000000000051',
              };
            const p = await plan(
              scope,
              OperationId.from('fake-plan'),
              groupId,
              binding,
            );
            let bad = p;
            if (field === 'root')
              bad = { ...p, group: (await standalone.load(groupId))!.group };
            if (field === 'response')
              bad = {
                ...p,
                value: scope.serialize({
                  kind: 'InvitationCreated',
                  groupId: groupId.value,
                  version: 2,
                  invitationId: p.operation.result.invitationId.value,
                  target: recipientActorId,
                }),
              };
            if (field === 'foreign-value') {
              let foreign: AuthenticationSerializedValue | undefined;
              // 別Scopeが発行した同じ本文のhandleを悪意入力として混ぜる。
              await owner((other) => {
                foreign = other.serialize(JSON.parse(p.value.body) as unknown);
                return Promise.resolve(foreign);
              });
              bad = { ...p, value: foreign! };
            }
            const evidence = await repository.stage(scope, bound!.handle, bad);
            await bound!.scope.consume(bound!.handle, evidence);
            return bad.value;
          },
          { codeId, recipientActorId },
        ),
      ).rejects.toThrow();
      expect(await counts()).toEqual({
        version: '1',
        invitations: '0',
        history: '0',
        operations: '1',
        locators: '1',
        audit: '0',
        consumed: '0',
      });
    },
  );

  it('未await stageと握り潰しSQL失敗から確定成功を返せない', async () => {
    await seed();
    await expect(
      owner(
        async (scope, bound) => {
          const p = await plan(scope);
          void repository.stage(scope, bound!.handle, p).catch(() => {});
          return p.value;
        },
        { codeId, recipientActorId },
      ),
    ).rejects.toThrow();
    expect(await counts()).toEqual({
      version: '1',
      invitations: '0',
      history: '0',
      operations: '1',
      locators: '1',
      audit: '0',
      consumed: '0',
    });
    await pool.query(
      'ALTER TABLE group_operation_locator_v2 RENAME TO hidden_locator',
    );
    await expect(
      owner(async (scope) => {
        try {
          await repository.findOperation(
            scope,
            ownerActor,
            OperationId.from('swallowed-sql'),
          );
        } catch {
          /* 悪意Callbackが握り潰してもregistryの失敗は消えない。 */
        }
        return scope.serialize({ status: 'no-replay' });
      }),
    ).rejects.toThrow();
    await pool.query(
      'ALTER TABLE hidden_locator RENAME TO group_operation_locator_v2',
    );
  });

  it('新旧Commandは同じnamespaceの異actionを相互にMismatchにする', async () => {
    await seed();
    await owner(async (scope) => {
      const saved = await repository.findOperation(
        scope,
        ownerActor,
        OperationId.from(`seed-${groupId.value}`),
      );
      expect(saved?.fingerprint).toBeInstanceOf(CommandFingerprint);
      return scope.serialize({ checked: true });
    });
    await create();
    const service = new GroupCommandService(standalone, {
      nextGroupId: () => GroupId.from(randomUUID()),
      nextParticipantId: () => ParticipantId.from(randomUUID()),
      nextInvitationId: () => InvitationId.from(randomUUID()),
      nextCloseIntentId: () => {
        throw new Error('not used');
      },
      now: () => UtcInstant.from(new Date(epoch + 2000)),
    });
    await expect(
      service.inviteParticipant({
        actorSubject: ownerActor,
        operationId: OperationId.from('create-from-code'),
        groupId,
        targetSubject: ActorSubject.from(
          '10000000-0000-4000-8000-000000000051',
        ),
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_MISMATCH' });
    expect(await counts()).toEqual({
      version: '2',
      invitations: '1',
      history: '1',
      operations: '2',
      locators: '2',
      audit: '1',
      consumed: '1',
    });
  });

  it('同Actor/operationを別Groupから競合してもUnique敗者は全rollbackする', async () => {
    await seed();
    const second = GroupId.from('10000000-0000-4000-8000-000000000243');
    await seed(second);
    let arrived = 0,
      release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    afterState = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await barrier;
    };
    const op = OperationId.from('concurrent-shared-op');
    const results = await Promise.allSettled([
      create(op),
      create(op, second, {
        codeId: '10000000-0000-4000-8000-000000000031',
        recipientActorId,
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    afterState = undefined;
    const c = await counts();
    expect(c).toMatchObject({
      invitations: '1',
      history: '1',
      operations: '3',
      locators: '3',
      audit: '1',
      consumed: '1',
    });
    expect(
      (
        await pool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM group_aggregate_record WHERE aggregate_version = 2',
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it('COMMIT応答喪失は保存成功を否定せず、明示照会で元の結果へ収束する', async () => {
    await seed();
    loseCommitResponse = true;
    await expect(create()).rejects.toThrow('synthetic commit outcome unknown');
    loseCommitResponse = false;
    const replay = await owner(async (scope) => {
      const saved = await repository.findOperation(
        scope,
        ownerActor,
        OperationId.from('create-from-code'),
      );
      expect(saved?.result.version).toBe(2);
      return scope.serialize({ version: saved?.result.version });
    });
    expect(replay).toBe('{"version":2}');
    expect(await counts()).toEqual({
      version: '2',
      invitations: '1',
      history: '1',
      operations: '2',
      locators: '2',
      audit: '1',
      consumed: '1',
    });
  });

  it('proof参照は保護operationだけで数え、Group削除でもAuditをcascadeしない', async () => {
    await seed();
    await create();
    expect(
      await owner(async (scope) =>
        scope.serialize(
          await repository.countProofReferences(scope, 'proof-v1'),
        ),
      ),
    ).toBe('1');
    await pool.query('DELETE FROM group_aggregate_record WHERE group_id = $1', [
      groupId.value,
    ]);
    expect(
      await owner(async (scope) =>
        scope.serialize(
          await repository.countProofReferences(scope, 'proof-v1'),
        ),
      ),
    ).toBe('0');
    expect(
      (
        await pool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM group_recipient_invitation_audit_record',
        )
      ).rows[0]?.count,
    ).toBe(1);
    await owner(async (scope) => {
      expect(
        await repository.findOperation(
          scope,
          ownerActor,
          OperationId.from('create-from-code'),
        ),
      ).toBeNull();
      return scope.serialize({ missing: true });
    });
  });

  it('破損した保護結果を無視してproof参照0件とは判断しない', async () => {
    await seed();
    await create();
    await pool.query(
      'UPDATE group_operation_result_record SET ciphertext = set_byte(ciphertext,0,get_byte(ciphertext,0) # 1) WHERE aggregate_version = 2',
    );
    await expect(
      owner(async (scope) =>
        scope.serialize(
          await repository.countProofReferences(scope, 'proof-v1'),
        ),
      ),
    ).rejects.toThrow();
  });
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const waitForBlock = async (pid: number) => {
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      const observed = await admin.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
        [pid],
      );
      if (observed.rows[0]?.count) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Expected PostgreSQL lock wait was not observed');
  };

  it('成功再送の結果行LockがGroup削除をScope終了まで待機させる', async () => {
    await seed();
    await create();
    const entered = deferred(),
      finish = deferred();
    let pid = 0;
    const reading = owner(async (scope) => {
      const saved = await repository.findOperation(
        scope,
        ownerActor,
        OperationId.from('create-from-code'),
      );
      expect(saved?.result.version).toBe(2);
      pid = (
        await lastClient!.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )
      ).rows[0].pid;
      entered.resolve();
      await finish.promise;
      return scope.serialize({ version: saved!.result.version });
    });
    await entered.promise;
    const deletion = pool.query(
      'DELETE FROM group_aggregate_record WHERE group_id = $1',
      [groupId.value],
    );
    try {
      await waitForBlock(pid);
    } finally {
      finish.resolve();
      await reading.catch(() => {});
      await deletion.catch(() => {});
    }
    expect(await reading).toBe('{"version":2}');
    expect((await deletion).rowCount).toBe(1);
    await owner(async (scope) => {
      expect(
        await repository.findOperation(
          scope,
          ownerActor,
          OperationId.from('create-from-code'),
        ),
      ).toBeNull();
      return scope.serialize({ missing: true });
    });
    expect((await counts()).audit).toBe('1');
  });

  it('Group削除が先行した再送はcommit待機後Missingになり、削除済み結果を復号しない', async () => {
    await seed();
    await create();
    const deleting = await pool.connect();
    await deleting.query('BEGIN');
    const pid = (
      await deleting.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    ).rows[0].pid;
    await deleting.query(
      'DELETE FROM group_aggregate_record WHERE group_id = $1',
      [groupId.value],
    );
    decrypts.mockClear();
    const reading = owner(async (scope) => {
      const saved = await repository.findOperation(
        scope,
        ownerActor,
        OperationId.from('create-from-code'),
      );
      expect(saved).toBeNull();
      return scope.serialize({ missing: true });
    });
    // Lockを外すMutationでも早期拒否を観測し、未処理rejectionを作らない。
    void reading.catch(() => {});
    try {
      await waitForBlock(pid);
      await deleting.query('COMMIT');
      expect(await reading).toBe('{"missing":true}');
      expect(decrypts).not.toHaveBeenCalled();
    } finally {
      await deleting.query('ROLLBACK');
      deleting.release();
      await reading.catch(() => {});
    }
    expect((await counts()).audit).toBe('1');
  });

  it('GM key-state共有LockをActor前の準備からcommitまで保持し、rotationと直列化する', async () => {
    const entered = deferred(),
      finish = deferred();
    let pid = 0;
    const first = owner(async (scope) => {
      const version = await repository.currentProofKeyVersion(scope);
      pid = (
        await lastClient!.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )
      ).rows[0].pid;
      entered.resolve();
      await finish.promise;
      return scope.serialize({ version });
    });
    await entered.promise;
    const locker = new Client({ connectionString: url });
    await locker.connect();
    await locker.query('BEGIN');
    await locker.query(`SET LOCAL search_path TO ${schema}`);
    const rotated = locker.query(
      "UPDATE group_recipient_code_proof_key_state SET current_key_version = 'proof-v2' WHERE id = 1",
    );
    try {
      try {
        await waitForBlock(pid);
        expect(sqls[0]).toContain('group_operation_locator_key_state');
        expect(sqls[1]).toContain('group_recipient_code_proof_key_state');
      } finally {
        finish.resolve();
      }
      expect(await first).toBe('{"version":"proof-v1"}');
      await rotated;
      await locker.query('COMMIT');
    } finally {
      finish.resolve();
      await first.catch(() => {});
      await rotated.catch(() => {});
      await locker.query('ROLLBACK');
      await locker.end();
    }
    expect(
      await owner(async (scope) =>
        scope.serialize({
          version: await repository.currentProofKeyVersion(scope),
        }),
      ),
    ).toBe('{"version":"proof-v2"}');
  });

  it('GM key-stateのLock待機timeoutは新規GM保存なしで全rollbackする', async () => {
    await seed();
    const locker = new Client({ connectionString: url });
    await locker.connect();
    await locker.query('BEGIN');
    await locker.query(`SET LOCAL search_path TO ${schema}`);
    await locker.query(
      'SELECT id FROM group_recipient_code_proof_key_state WHERE id = 1 FOR UPDATE',
    );
    try {
      await expect(create()).rejects.toThrow();
    } finally {
      await locker.query('ROLLBACK');
      await locker.end();
    }
    expect(await counts()).toEqual({
      version: '1',
      invitations: '0',
      history: '0',
      operations: '1',
      locators: '1',
      audit: '0',
      consumed: '0',
    });
  });

  it('認可Group LockとCASで並行する旧Commandを裁定し、敗者に部分履歴を残さない', async () => {
    await seed();
    const baseline = (await standalone.load(groupId))!;
    const otherId = InvitationId.from(randomUUID());
    const changed = baseline.group.inviteParticipant({
      actorSubject: ownerActor,
      targetSubject: ActorSubject.from('10000000-0000-4000-8000-000000000055'),
      invitationId: otherId,
      createdAt: UtcInstant.from(new Date(epoch + 1000)),
    });
    const waitingRequest: CommitGroupRequest = {
      group: changed.group,
      expectedVersion: 1,
      stateChanged: true,
      membershipChanges: [],
      groupCloseChanges: [],
      invitationChanges: [
        {
          kind: 'Created',
          invitationId: otherId,
          targetSubject: changed.invitation.targetSubject,
          issuerParticipantId: changed.invitation.issuerParticipantId,
          createdAt: changed.invitation.createdAt,
          expiryAt: changed.invitation.expiryAt,
        },
      ],
      operation: {
        actorSubject: ownerActor,
        operationId: OperationId.from('concurrent-legacy-command'),
        fingerprint: CommandFingerprint.from('concurrent-legacy-command'),
      },
      result: { kind: 'InvitationCreated', groupId, invitationId: otherId },
    };
    const entered = deferred(),
      finish = deferred();
    let pid = 0;
    const first = owner(
      async (scope, bound) => {
        const p = await plan(scope);
        pid = (
          await lastClient!.query<{ pid: number }>(
            'SELECT pg_backend_pid() AS pid',
          )
        ).rows[0].pid;
        entered.resolve();
        await finish.promise;
        const evidence = await repository.stage(scope, bound!.handle, p);
        await bound!.scope.consume(bound!.handle, evidence);
        return p.value;
      },
      { codeId, recipientActorId },
    );
    await entered.promise;
    const second = standalone.commit(waitingRequest);
    try {
      await waitForBlock(pid);
    } finally {
      finish.resolve();
    }
    await first;
    expect(await second).toEqual({ kind: 'Conflict' });
    expect(await counts()).toEqual({
      version: '2',
      invitations: '1',
      history: '1',
      operations: '2',
      locators: '2',
      audit: '1',
      consumed: '1',
    });
  });

  it('保存待機中の元plan変更が保護operation/履歴/証跡へ混入しない', async () => {
    await seed();
    let original: RecipientInvitationCommitPlan;
    afterState = () => {
      Reflect.set(
        original.operation.binding,
        'codeId',
        '10000000-0000-4000-8000-000000000099',
      );
      original.operation.fingerprint.proof.bytes.fill(2);
      original.operation.fingerprint.canonicalInput.fill(3);
      Reflect.set(original.operation.result, 'version', 999);
      return Promise.resolve();
    };
    await owner(
      async (scope, bound) => {
        original = await plan(scope);
        const evidence = await repository.stage(scope, bound!.handle, original);
        await bound!.scope.consume(bound!.handle, evidence);
        return original.value;
      },
      { codeId, recipientActorId },
    );
    afterState = undefined;
    await owner(async (scope) => {
      const saved = await repository.findOperation(
        scope,
        ownerActor,
        OperationId.from('create-from-code'),
      );
      if (
        !saved ||
        saved.fingerprint instanceof CommandFingerprint ||
        !('binding' in saved)
      )
        throw new Error('expected new action');
      expect(saved.binding.codeId).toBe(codeId);
      expect(saved.result.version).toBe(2);
      expect(
        await proof.verify({ secret: code(), saved: saved.fingerprint.proof }),
      ).toBe(true);
      return scope.serialize({ checked: true });
    });
  });
  it('caller-only Scopeで新規stageと非SQL障害を握り潰しても部分GM保存をcommitできない', async () => {
    await seed();
    await expect(
      owner(async (scope) => {
        const p = await plan(scope);
        afterState = () =>
          Promise.reject(
            new Error('synthetic non-SQL failure after state write'),
          );
        try {
          await repository.stage(scope, {} as Bound['handle'], p);
        } catch {
          /* 誤用Callbackが非SQL障害を握り潰す。 */
        }
        return scope.serialize({ status: 'no-replay' });
      }),
    ).rejects.toThrow();
    afterState = undefined;
    expect(await counts()).toEqual({
      version: '1',
      invitations: '0',
      history: '0',
      operations: '1',
      locators: '1',
      audit: '0',
      consumed: '0',
    });
  });
  it('新規Scopeでも非SQL障害を握り潰して未完成計画をcommitできない', async () => {
    await seed();
    await expect(
      owner(
        async (scope, bound) => {
          const p = await plan(scope);
          afterState = () =>
            Promise.reject(new Error('synthetic non-SQL failure'));
          try {
            await repository.stage(scope, bound!.handle, p);
          } catch {
            /* 未完成計画の失敗を握り潰してもconsume証跡を持てない。 */
          }
          return p.value;
        },
        { codeId, recipientActorId },
      ),
    ).rejects.toThrow();
    afterState = undefined;
    expect(await counts()).toEqual({
      version: '1',
      invitations: '0',
      history: '0',
      operations: '1',
      locators: '1',
      audit: '0',
      consumed: '0',
    });
  });
  it('二度目のstage失敗を握り潰して先行証跡だけを消費してもcommitできない', async () => {
    await seed();
    await expect(
      owner(
        async (scope, bound) => {
          const first = await plan(scope, OperationId.from('first-stage'));
          const witness = await repository.stage(scope, bound!.handle, first);
          const second = await plan(scope, OperationId.from('second-stage'));
          try {
            await repository.stage(scope, bound!.handle, second);
          } catch {
            /* 一回計画の再受付がScopeを失敗済みにする。 */
          }
          await bound!.scope.consume(bound!.handle, witness);
          return first.value;
        },
        { codeId, recipientActorId },
      ),
    ).rejects.toThrow();
    expect(await counts()).toEqual({
      version: '1',
      invitations: '0',
      history: '0',
      operations: '1',
      locators: '1',
      audit: '0',
      consumed: '0',
    });
  });
});
