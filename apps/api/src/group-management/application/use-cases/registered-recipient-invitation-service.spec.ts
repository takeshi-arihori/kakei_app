import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  RegisteredRecipientInvitationService,
  type CreateInvitationFromRecipientCodeCommand,
} from './registered-recipient-invitation-service.js';
import {
  ActorSubject,
  CloseIntentId,
  Group,
  GroupId,
  InvitationId,
  ParticipantId,
  UtcInstant,
} from '../../domain/group.js';
import {
  CommandFingerprint,
  OperationId,
  type StoredOperation,
} from '../group-repository.js';
import type {
  RecipientInvitationCommitPlan,
  RecipientInvitationRepository,
  StoredRecipientInvitationOperation,
} from '../recipient-invitation-repository.js';
import {
  createRecipientCodeRequestProof,
  importRecipientCodeRequestProofKey,
} from '../../infrastructure/recipient-code-request-proof.js';
import type { RecipientCodeRequestProofKeyQuery } from '../recipient-code-request-proof.js';
import { RecipientCodeSecret } from '../../../shared/application/authentication/recipient-code-input.js';
import type {
  AuthenticationSerializedValue,
  AuthenticationTransactionScope,
} from '../../../shared/application/authentication/authentication-transaction-scope.js';
import type {
  RecipientCodeCommitEvidence,
  RecipientCodeConsumptionHandle,
  RecipientCodeSessionPort,
  RecipientCodeTransactionScope,
} from '../../../shared/application/authentication/recipient-code-ports.js';
const owner = '10000000-0000-4000-8000-000000000020';
const recipient = '10000000-0000-4000-8000-000000000030';
const member = '10000000-0000-4000-8000-000000000040';
const stranger = '10000000-0000-4000-8000-000000000050';
const gid = GroupId.from('10000000-0000-4000-8000-000000000001');
const otherGid = GroupId.from('10000000-0000-4000-8000-000000000002');
const epoch = Date.parse('2026-10-30T00:00:00.000Z');
const instant = () => UtcInstant.from(new Date(epoch));
const code = (n = 10) =>
  RecipientCodeSecret.parse(Buffer.alloc(32, n).toString('base64url'))!;
const initial = () => {
  const group = Group.create({
    id: gid,
    initialParticipantId: ParticipantId.from('p-owner'),
    creatorSubject: ActorSubject.from(owner),
    createdAt: instant(),
  });
  return Group.restore({
    ...group.toSnapshot(),
    participants: [
      ...group.toSnapshot().participants,
      {
        id: ParticipantId.from('p-member'),
        subject: ActorSubject.from(member),
        joinedAt: instant(),
        joinOrder: 2,
        status: 'Active',
        leftAt: null,
      },
    ],
  });
};
const setup = () => {
  let group = initial(),
    version = 7,
    caller = owner,
    target = recipient,
    authenticated = true,
    available = true,
    current = 'v1',
    loss: 'before' | 'after' | null = null;
  let now = epoch + 1000,
    committedConsumes = 0;
  const errors: unknown[] = [];
  let factsUsed: {
    caller: { actorSubject: string; csrf: string; absoluteExpiresAt: number };
    recipientActorId: string;
    codeId: string;
  } | null = null;
  const records = new Map<
    string,
    StoredOperation | StoredRecipientInvitationOperation
  >();
  const serialized: string[] = [];
  const scopes: AuthenticationTransactionScope[] = [];
  const useCalls = vi.fn(),
    consume = vi.fn(),
    serialize = vi.fn((value: unknown) => JSON.stringify(value));
  const nextInvitationId = vi.fn(() => InvitationId.from(randomUUID()));
  const keyRead = vi.fn((query: RecipientCodeRequestProofKeyQuery) =>
    Promise.resolve(
      query.keyVersion === 'v1' || query.keyVersion === 'v2'
        ? {
            ...query,
            status: 'available' as const,
            key: importRecipientCodeRequestProofKey(
              Buffer.alloc(32, query.keyVersion === 'v1' ? 11 : 22),
            ),
          }
        : { status: 'unavailable' as const },
    ),
  );
  const proof = {
    ...createRecipientCodeRequestProof({ keys: { readKey: keyRead } }),
  };
  let between: () => Promise<void> = () => Promise.resolve();
  let active: AuthenticationTransactionScope | null = null;
  let pending: RecipientInvitationCommitPlan | null = null;
  let consumed = false;
  const values = new WeakMap<object, AuthenticationTransactionScope>();
  const evidence = {} as RecipientCodeCommitEvidence;
  const handle = {} as RecipientCodeConsumptionHandle;
  const makeScope = () => {
    const scope = {
      serialize: (value: unknown) => {
        const body = serialize(value);
        serialized.push(body);
        const result = Object.freeze({ body }) as AuthenticationSerializedValue;
        values.set(result, scope);
        return result;
      },
      consume: (
        actual: RecipientCodeConsumptionHandle,
        receipt: RecipientCodeCommitEvidence,
      ) => {
        consume(actual, receipt);
        if (
          actual !== handle ||
          receipt !== evidence ||
          !pending ||
          active !== scope ||
          values.get(pending.value) !== scope
        )
          throw new Error('合成: 同Scope保存計画がない');
        consumed = true;
        return Promise.resolve();
      },
    } as unknown as RecipientCodeTransactionScope;
    scopes.push(scope);
    return scope;
  };
  const repository = {
    findOperation: vi.fn<RecipientInvitationRepository['findOperation']>(
      (_scope, actor, op) =>
        Promise.resolve(records.get(`${actor.value}/${op.value}`) ?? null),
    ),
    currentProofKeyVersion: vi.fn<
      RecipientInvitationRepository['currentProofKeyVersion']
    >(() => Promise.resolve(current)),
    loadForInvitation: vi.fn<
      RecipientInvitationRepository['loadForInvitation']
    >((_scope, id, actor) =>
      Promise.resolve(
        id.equals(group.id) &&
          group
            .toSnapshot()
            .participants.some(
              (p) => p.status === 'Active' && p.subject.equals(actor),
            )
          ? { group, version }
          : null,
      ),
    ),
    stage: vi.fn<RecipientInvitationRepository['stage']>(
      (scope, _handle, plan) => {
        if (scope !== active) throw new Error('合成: 別Scope');
        pending = plan;
        return Promise.resolve(evidence);
      },
    ),
  };
  const use: RecipientCodeSessionPort['use'] = async (
    secret,
    input,
    clock,
    callbacks,
  ) => {
    useCalls(secret, input, clock);
    if (!authenticated) return { status: 'unauthenticated' };
    const who = Object.freeze({
      actorSubject: caller,
      csrf: 'synthetic-csrf',
      absoluteExpiresAt: epoch + 999999,
    });
    pending = null;
    consumed = false;
    try {
      const first = await callbacks.replay(who, makeScope());
      if (first.status === 'replayed')
        return { status: 'authenticated', value: first.value };
      await between();
      active = makeScope();
      const second = await callbacks.replay(who, active);
      if (second.status === 'replayed')
        return { status: 'authenticated', value: second.value };
      if (!available) return { status: 'unavailable-to-actor' };
      factsUsed = {
        caller: who,
        recipientActorId: target,
        codeId: '10000000-0000-4000-8000-000000000060',
      };
      const value = await callbacks.create(
        factsUsed,
        handle,
        active as RecipientCodeTransactionScope,
      );
      const plan = pending as RecipientInvitationCommitPlan | null;
      if (
        !plan ||
        !consumed ||
        value !== plan.value ||
        values.get(value) !== active
      )
        throw new Error('合成: 不完全計画');
      if (loss !== 'before') {
        records.set(
          `${plan.operation.actorSubject.value}/${plan.operation.operationId.value}`,
          plan.operation,
        );
        group = plan.group;
        version++;
        committedConsumes++;
      }
      return loss
        ? { status: 'unavailable' }
        : { status: 'authenticated', value };
    } catch (error) {
      errors.push(error);
      return { status: 'unavailable' };
    }
  };
  const service = new RegisteredRecipientInvitationService({
    sessions: { use },
    repository,
    proof,
    nextInvitationId,
    clock: { now: () => now },
  });
  const command = (): CreateInvitationFromRecipientCodeCommand => ({
    sessionSecret: Buffer.alloc(32, 33).toString('base64url'),
    code: code(),
    groupId: gid,
    expectedVersion: version,
    operationId: OperationId.from('operation-1'),
  });
  return {
    service,
    repository,
    proof,
    keyRead,
    records,
    serialized,
    errors,
    useCalls,
    consume,
    serialize,
    nextInvitationId,
    scopes,
    command,
    handle,
    evidence,
    get group() {
      return group;
    },
    set group(value: Group) {
      group = value;
    },
    get version() {
      return version;
    },
    set version(value: number) {
      version = value;
    },
    set caller(value: string) {
      caller = value;
    },
    set target(value: string) {
      target = value;
    },
    set authenticated(value: boolean) {
      authenticated = value;
    },
    set available(value: boolean) {
      available = value;
    },
    set current(value: string) {
      current = value;
    },
    set loss(value: 'before' | 'after' | null) {
      loss = value;
    },
    set between(value: () => Promise<void>) {
      between = value;
    },
    set now(value: number) {
      now = value;
    },
    get committedConsumes() {
      return committedConsumes;
    },
    get factsUsed() {
      return factsUsed;
    },
    get pending() {
      return pending;
    },
  };
};
const body = (
  result: Awaited<ReturnType<RegisteredRecipientInvitationService['create']>>,
) => {
  if (result.status !== 'authenticated') throw new Error('合成: 成功なし');
  return JSON.parse(result.value.body) as Record<string, unknown>;
};

describe('コードからのInvitation Application契約（本人性/SQL/atomicityはfake）', () => {
  it('Client Actor/Role/target申告はleaseやGroupへ渡さない', async () => {
    for (const field of [
      'actorSubject',
      'role',
      'targetSubject',
      'recipientActorId',
      'codeId',
    ]) {
      const f = setup();
      await expect(
        f.service.create({ ...f.command(), [field]: 'untrusted' }),
      ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      expect(f.useCalls).not.toHaveBeenCalled();
    }
  });
  it('アクセサ/prototype/不正VOは最初のawait前に拒否する', async () => {
    const f = setup();
    const get = vi.fn(() => gid);
    const accessor = { ...f.command() };
    Object.defineProperty(accessor, 'groupId', { get, enumerable: true });
    for (const input of [
      accessor,
      Object.assign(Object.create({}), f.command()),
      { ...f.command(), groupId: { value: gid.value } },
      { ...f.command(), code: { copyBytes: () => new Uint8Array(32) } },
    ])
      await expect(f.service.create(input as never)).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      });
    expect(get).not.toHaveBeenCalled();
    expect(f.useCalls).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    '期待版%sは副作用なしで拒否する',
    async (n) => {
      const f = setup();
      await expect(
        f.service.create({ ...f.command(), expectedVersion: n }),
      ).rejects.toMatchObject({ code: 'INVALID_EXPECTED_VERSION' });
      expect(f.useCalls).not.toHaveBeenCalled();
    },
  );
  it('本人/コードfactsから7日Pending計画を作り、Participantを追加しない', async () => {
    const f = setup();
    const result = await f.service.create(f.command());
    const response = body(result);
    expect(response).toEqual({
      kind: 'InvitationCreated',
      groupId: gid.value,
      invitationId: f.pending?.operation.result.invitationId.value,
      version: 8,
    });
    expect(f.repository.findOperation).toHaveBeenCalledTimes(2);
    expect(f.scopes[0]).not.toBe(f.scopes[1]);
    expect(f.pending?.value).toBe(
      result.status === 'authenticated' ? result.value : null,
    );
    expect(f.pending?.membershipChanges).toEqual([]);
    expect(f.group.activeParticipantCount).toBe(2);
    const invitation = f.group.toSnapshot().invitations[0];
    expect(invitation.targetSubject.value).toBe(recipient);
    expect(invitation.status).toBe('Pending');
    expect(invitation.expiryAt).toEqual(invitation.createdAt.plusDays(7));
    expect(f.pending?.operation.binding).toEqual({
      codeId: '10000000-0000-4000-8000-000000000060',
      recipientActorId: recipient,
    });
    expect(f.consume).toHaveBeenCalledExactlyOnceWith(f.handle, f.evidence);
    expect(f.committedConsumes).toBe(1);
    const raw = Buffer.from(f.command().code.copyBytes()).toString('base64url');
    expect(
      f.serialized.every(
        (s) =>
          !s.includes(raw) &&
          !s.includes(recipient) &&
          !s.includes('000000000060'),
      ),
    ).toBe(true);
    expect(JSON.stringify(f.pending)).not.toContain(raw);
    expect(f.pending?.operation.fingerprint).not.toBeInstanceOf(
      CommandFingerprint,
    );
  });
  it('最初のawait後のClient入力変更を処理内容へ反映しない', async () => {
    const f = setup();
    const command = { ...f.command() };
    f.between = () => {
      command.groupId = otherGid;
      command.expectedVersion = 99;
      command.operationId = OperationId.from('changed');
      command.code = code(99);
      return Promise.resolve();
    };
    expect(body(await f.service.create(command)).groupId).toBe(gid.value);
    expect(f.pending?.operation.operationId.value).toBe('operation-1');
    expect(f.pending?.operation.fingerprint.expectedVersion).toBe(7);
    expect(
      await f.proof.verify({
        secret: code(),
        saved: f.pending!.operation.fingerprint.proof,
      }),
    ).toBe(true);
  });
  it.each([
    'owner',
    'self',
    'duplicate',
    'full',
    'closing',
    'version',
    'missing',
  ] as const)(
    '%s拒否はGroup/code/成功operationを変更しない',
    async (scenario) => {
      const f = setup();
      if (scenario === 'owner') f.caller = member;
      if (scenario === 'self') f.target = owner;
      if (scenario === 'duplicate') f.target = member;
      if (scenario === 'full') {
        const snapshot = f.group.toSnapshot();
        f.group = Group.restore({
          ...snapshot,
          participants: [
            ...snapshot.participants,
            ...[stranger, recipient].map((subject, i) => ({
              id: ParticipantId.from(`p-${i}`),
              subject: ActorSubject.from(subject),
              joinedAt: instant(),
              joinOrder: i + 3,
              status: 'Active' as const,
              leftAt: null,
            })),
          ],
        });
      }
      if (scenario === 'full')
        f.target = '10000000-0000-4000-8000-000000000070';
      if (scenario === 'closing')
        f.group = f.group.startClosing({
          actorSubject: ActorSubject.from(owner),
          closeIntentId: CloseIntentId.from(randomUUID()),
          cutoff: instant(),
        }).group;
      const before = f.group.toSnapshot();
      const command = {
        ...f.command(),
        ...(scenario === 'version' ? { expectedVersion: 6 } : {}),
        ...(scenario === 'missing' ? { groupId: otherGid } : {}),
      };
      expect(await f.service.create(command)).toEqual({
        status: 'unavailable',
      });
      expect(f.group.toSnapshot()).toEqual(before);
      expect(f.records.size).toBe(0);
      expect(f.repository.stage).not.toHaveBeenCalled();
      expect(f.consume).not.toHaveBeenCalled();
      expect(f.committedConsumes).toBe(0);
    },
  );
  it('無効Session/コードはfake leaseの拒否を保ちGroupを読まない', async () => {
    for (const mode of ['session', 'code']) {
      const f = setup();
      if (mode === 'session') f.authenticated = false;
      else f.available = false;
      expect(await f.service.create(f.command())).toEqual({
        status: mode === 'session' ? 'unauthenticated' : 'unavailable-to-actor',
      });
      expect(f.repository.loadForInvitation).not.toHaveBeenCalled();
      expect(f.consume).not.toHaveBeenCalled();
    }
  });
  it('保存proof世代だけで再送し、現在Owner/宛先/code/current鍵に依存しない', async () => {
    const f = setup();
    const command = f.command();
    const first = await f.service.create(command);
    f.group = f.group.transferOwnership({
      actorSubject: ActorSubject.from(owner),
      targetParticipantId: ParticipantId.from('p-member'),
    }).group;
    f.available = false;
    f.target = stranger;
    f.current = 'unavailable';
    vi.mocked(f.repository.loadForInvitation).mockClear();
    vi.mocked(f.repository.currentProofKeyVersion).mockClear();
    f.consume.mockClear();
    expect(await f.service.create(command)).toEqual(first);
    expect(f.repository.loadForInvitation).not.toHaveBeenCalled();
    expect(f.repository.currentProofKeyVersion).not.toHaveBeenCalled();
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.committedConsumes).toBe(1);
  });
  it.each([
    'group',
    'version',
    'code',
    'legacy',
    'actor',
    'operation',
    'canonical',
    'result',
  ] as const)('%s不一致は同operationを別成功として保存しない', async (kind) => {
    const f = setup();
    const command = f.command();
    await f.service.create(command);
    const saved = f.pending!.operation;
    const requested = { ...command };
    if (kind === 'group') requested.groupId = otherGid;
    if (kind === 'version') requested.expectedVersion = 8;
    if (kind === 'code') requested.code = code(11);
    if (kind === 'legacy')
      f.records.set(`${owner}/operation-1`, {
        actorSubject: saved.actorSubject,
        operationId: saved.operationId,
        fingerprint: CommandFingerprint.from('legacy-command'),
        result: saved.result,
      });
    if (kind === 'actor')
      f.records.set(`${owner}/operation-1`, {
        ...saved,
        actorSubject: ActorSubject.from(stranger),
      });
    if (kind === 'operation')
      f.records.set(`${owner}/operation-1`, {
        ...saved,
        operationId: OperationId.from('other'),
      });
    if (kind === 'canonical') {
      const input = new Uint8Array(saved.fingerprint.canonicalInput);
      input[0] ^= 1;
      f.records.set(`${owner}/operation-1`, {
        ...saved,
        fingerprint: { ...saved.fingerprint, canonicalInput: input },
      });
    }
    if (kind === 'result')
      f.records.set(`${owner}/operation-1`, {
        ...saved,
        result: { ...saved.result, version: 99 },
      });
    vi.mocked(f.repository.stage).mockClear();
    f.consume.mockClear();
    const before = f.group.toSnapshot();
    expect(await f.service.create(requested)).toEqual({
      status: 'unavailable',
    });
    expect(f.errors.at(-1)).toMatchObject({ code: 'OPERATION_MISMATCH' });
    expect(f.repository.stage).not.toHaveBeenCalled();
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.group.toSnapshot()).toEqual(before);
  });
  it('別Actorの同operationから元Actorの成功を再送しない', async () => {
    const f = setup();
    const command = f.command();
    await f.service.create(command);
    f.caller = member;
    f.available = false;
    expect(await f.service.create(command)).toEqual({
      status: 'unavailable-to-actor',
    });
    expect(f.committedConsumes).toBe(1);
  });
  it('preflight後に成立した並行成功は新規leaseの再照会で返す', async () => {
    const seeded = setup();
    const command = seeded.command();
    const expected = await seeded.service.create(command);
    const saved = seeded.pending!.operation;
    const f = setup();
    f.available = false;
    f.between = () => {
      f.records.set(`${owner}/operation-1`, saved);
      return Promise.resolve();
    };
    expect(await f.service.create(command)).toEqual(expected);
    expect(f.repository.findOperation).toHaveBeenCalledTimes(2);
    expect(f.repository.loadForInvitation).not.toHaveBeenCalled();
    expect(f.consume).not.toHaveBeenCalled();
  });
  it.each(['before', 'after'] as const)(
    '%s commit応答不明を自動再実行せず、明示再送だけ処理する（fake）',
    async (loss) => {
      const f = setup();
      const command = f.command();
      f.loss = loss;
      expect(await f.service.create(command)).toEqual({
        status: 'unavailable',
      });
      expect(f.repository.stage).toHaveBeenCalledTimes(1);
      expect(f.committedConsumes).toBe(loss === 'after' ? 1 : 0);
      f.loss = null;
      expect((await f.service.create(command)).status).toBe('authenticated');
      expect(f.repository.stage).toHaveBeenCalledTimes(
        loss === 'after' ? 1 : 2,
      );
      expect(f.committedConsumes).toBe(1);
    },
  );
  it.each([
    'load',
    'current',
    'proof',
    'stage',
    'serialize',
    'consume',
  ] as const)('%s障害ではfake commitを成立させない', async (fault) => {
    const f = setup();
    const before = f.group.toSnapshot();
    const error = new Error('synthetic private provider details');
    if (fault === 'load')
      vi.mocked(f.repository.loadForInvitation).mockRejectedValueOnce(error);
    if (fault === 'current')
      vi.mocked(f.repository.currentProofKeyVersion).mockRejectedValueOnce(
        error,
      );
    if (fault === 'proof')
      vi.spyOn(f.proof, 'create').mockRejectedValueOnce(error);
    if (fault === 'stage')
      vi.mocked(f.repository.stage).mockRejectedValueOnce(error);
    if (fault === 'serialize')
      f.serialize.mockImplementationOnce(() => {
        throw error;
      });
    if (fault === 'consume')
      f.consume.mockImplementationOnce(() => {
        throw error;
      });
    expect(await f.service.create(f.command())).toEqual({
      status: 'unavailable',
    });
    expect(f.group.toSnapshot()).toEqual(before);
    expect(f.records.size).toBe(0);
    expect(f.committedConsumes).toBe(0);
  });
  it.each([NaN, -1, Infinity, Number.MAX_SAFE_INTEGER])(
    'Clock%s不正を保存/消費前に拒否する',
    async (now) => {
      const f = setup();
      f.now = now;
      expect(await f.service.create(f.command())).toEqual({
        status: 'unavailable',
      });
      expect(f.repository.stage).not.toHaveBeenCalled();
      expect(f.consume).not.toHaveBeenCalled();
    },
  );
  it('保存proof鍵の障害でも既存成功を改変/再作成しない', async () => {
    const f = setup();
    const command = f.command();
    await f.service.create(command);
    vi.spyOn(f.proof, 'verify').mockRejectedValueOnce(
      new Error('synthetic key outage'),
    );
    vi.mocked(f.repository.stage).mockClear();
    expect(await f.service.create(command)).toEqual({ status: 'unavailable' });
    expect(f.repository.stage).not.toHaveBeenCalled();
    expect(f.committedConsumes).toBe(1);
  });
  it('Pendingは枠を予約せず、Owner譲渡後も残り、本人受諾時だけ新Participantを追加する', async () => {
    const f = setup();
    await f.service.create(f.command());
    f.target = stranger;
    const second = {
      ...f.command(),
      operationId: OperationId.from('operation-2'),
    };
    await f.service.create(second);
    expect(f.group.activeParticipantCount).toBe(2);
    expect(f.group.toSnapshot().invitations).toHaveLength(2);
    const invited = f.group.toSnapshot().invitations[0];
    f.group = f.group.transferOwnership({
      actorSubject: ActorSubject.from(owner),
      targetParticipantId: ParticipantId.from('p-member'),
    }).group;
    expect(f.group.toSnapshot().invitations[0].status).toBe('Pending');
    expect(() =>
      f.group.acceptInvitation({
        actorSubject: ActorSubject.from(stranger),
        invitationId: invited.id,
        participantId: ParticipantId.from('wrong'),
        acceptedAt: UtcInstant.from(new Date(epoch + 2000)),
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'INVITATION_TARGET_MISMATCH' }),
    );
    const accepted = f.group.acceptInvitation({
      actorSubject: ActorSubject.from(recipient),
      invitationId: invited.id,
      participantId: ParticipantId.from('p-new'),
      acceptedAt: UtcInstant.from(new Date(epoch + 2000)),
    });
    expect(accepted.group.activeParticipantCount).toBe(3);
  });
  it('Left宛先を再招待し、本人受諾で旧Participant IDを再利用しない', async () => {
    const f = setup();
    const snap = f.group.toSnapshot();
    f.group = Group.restore({
      ...snap,
      participants: [
        ...snap.participants,
        {
          id: ParticipantId.from('p-old'),
          subject: ActorSubject.from(recipient),
          joinedAt: instant(),
          joinOrder: 3,
          status: 'Left',
          leftAt: instant(),
        },
      ],
    });
    await f.service.create(f.command());
    const invitation = f.group.toSnapshot().invitations[0];
    const accepted = f.group.acceptInvitation({
      actorSubject: ActorSubject.from(recipient),
      invitationId: invitation.id,
      participantId: ParticipantId.from('p-returned'),
      acceptedAt: UtcInstant.from(new Date(epoch + 2000)),
    });
    expect(
      accepted.group
        .toSnapshot()
        .participants.find((p) => p.id.value === 'p-old')?.status,
    ).toBe('Left');
    expect(
      accepted.group
        .toSnapshot()
        .participants.find((p) => p.id.value === 'p-returned')?.status,
    ).toBe('Active');
  });
  it('秘密値VOの派生prototypeでleaseとproofの入力を分岐させない', async () => {
    const f = setup();
    function Alternate() {}
    Alternate.prototype = Object.create(
      RecipientCodeSecret.prototype,
    ) as object;
    Object.defineProperty(Alternate.prototype, 'copyBytes', {
      value: () => new Uint8Array(32).fill(99),
    });
    const derived = Reflect.construct(
      RecipientCodeSecret,
      [Buffer.alloc(32, 10).toString('base64url')],
      Alternate,
    ) as RecipientCodeSecret;
    await expect(
      f.service.create({ ...f.command(), code: derived }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.useCalls).not.toHaveBeenCalled();
  });
  it('proof待機中に外部の保存結果が変わってもsnapshotした最小結果を返す', async () => {
    const f = setup();
    const command = f.command();
    const first = await f.service.create(command);
    const saved = f.pending!.operation;
    const mutable = { ...saved.result };
    f.records.set(`${owner}/operation-1`, { ...saved, result: mutable });
    const verify = f.proof.verify.bind(f.proof);
    vi.spyOn(f.proof, 'verify').mockImplementationOnce(async (input) => {
      mutable.version = 99;
      await Promise.resolve();
      return verify(input);
    });
    expect(await f.service.create(command)).toEqual(first);
  });
  it('await中のfacts/loaded wrapper変更でも認証時の宛先/code/版を一貫して固定する', async () => {
    const f = setup();
    const loaded = { group: f.group, version: 7 };
    f.repository.loadForInvitation.mockResolvedValueOnce(loaded);
    const create = f.proof.create.bind(f.proof);
    vi.spyOn(f.proof, 'create').mockImplementationOnce(async (input) => {
      f.factsUsed!.recipientActorId = stranger;
      f.factsUsed!.codeId = 'changed';
      loaded.version = 99;
      return create(input);
    });
    const result = await f.service.create(f.command());
    expect(body(result).version).toBe(8);
    expect(f.pending?.expectedVersion).toBe(7);
    expect(f.pending?.operation.binding).toEqual({
      codeId: '10000000-0000-4000-8000-000000000060',
      recipientActorId: recipient,
    });
  });
});
