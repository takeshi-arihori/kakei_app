import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  ActorSubject,
  CloseIntentId,
  Group,
  GroupId,
  GroupInvariantViolation,
  InvitationId,
  ParticipantId,
  UtcInstant,
  type CloseFenceReceipt,
  type CloseUnfenceReceipt,
  type ParticipantSnapshot,
} from '../domain/group.js';
import {
  GroupCommandApplicationError,
  GroupCommandService,
  type GroupCommandDependencies,
} from './group-command-service.js';
import {
  CommandFingerprint,
  OperationId,
  type CommitGroupOutcome,
  type CommitGroupRequest,
  type FindOperationResult,
  type GroupCommandResult,
  type GroupCloseChange,
  type GroupRepository,
  type InvitationChange,
  type LoadedGroup,
  type MembershipChange,
  type StoredOperation,
} from './group-repository.js';

const instant = (value: string): UtcInstant => UtcInstant.from(new Date(value));
const createdAt = instant('2026-09-07T00:00:00.000Z');

describe('Group ID generator', () => {
  it('信頼済み生成口はcanonical lowercase UUIDv4を発行する', () => {
    const nextGroupId: GroupCommandDependencies['nextGroupId'] = () =>
      GroupId.from(randomUUID());
    const id = nextGroupId();
    expect(id.value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(GroupId.from(id.value)).toEqual(id);
  });
});

const activeParticipant = (
  id: string,
  subject: string,
  joinOrder: number,
): ParticipantSnapshot => ({
  id: ParticipantId.from(id),
  subject: ActorSubject.from(subject),
  joinedAt: createdAt,
  joinOrder,
  status: 'Active',
  leftAt: null,
});

const existingGroup = (): Group =>
  Group.restore({
    id: GroupId.from('00000000-0000-4000-8000-000000000001'),
    status: 'Active',
    ownerParticipantId: ParticipantId.from('p-owner'),
    participants: [
      activeParticipant('p-owner', 'owner-subject', 1),
      activeParticipant('p-member', 'member-subject', 2),
      activeParticipant('p-third', 'third-subject', 3),
    ],
    invitations: [],
    accessPolicyVersion: 1,
    closing: null,
    ownerAtArchiveParticipantId: null,
    archivedAt: null,
    deleteEligibleAt: null,
  });

type CommitFault = 'BeforeWriteUnavailable' | 'AfterWriteUnavailable';
type CommitBarrier = Readonly<{
  entered: Promise<void>;
  release: () => void;
}>;

type PendingCommitBarrier = Readonly<{
  signalEntered: () => void;
  released: Promise<void>;
}>;

const versionResult = (
  result: CommitGroupRequest['result'],
  version: number,
): GroupCommandResult => ({ ...result, version });

class InMemoryGroupRepository implements GroupRepository {
  private readonly groups = new Map<string, LoadedGroup>();
  private readonly operationsByActor = new Map<
    string,
    Map<string, StoredOperation>
  >();
  private readonly membershipChanges: MembershipChange[] = [];
  private readonly invitationChanges: InvitationChange[] = [];
  private readonly groupCloseChanges: GroupCloseChange[] = [];
  private readonly closeIntentIds = new Set<string>();
  private nextFault: CommitFault | null = null;
  private nextBarrier: PendingCommitBarrier | null = null;

  seed(group: Group, version: number): void {
    this.groups.set(group.id.value, { group, version });
  }

  failNextCommit(fault: CommitFault): void {
    this.nextFault = fault;
  }

  pauseNextCommit(): CommitBarrier {
    let signalEntered = (): void => undefined;
    let release = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextBarrier = { signalEntered, released };
    return { entered, release };
  }

  async load(groupId: GroupId): Promise<LoadedGroup | null> {
    await Promise.resolve();
    return this.groups.get(groupId.value) ?? null;
  }

  async findOperation(
    actorSubject: ActorSubject,
    operationId: OperationId,
  ): Promise<FindOperationResult> {
    await Promise.resolve();
    const operation = this.operationsByActor
      .get(actorSubject.value)
      ?.get(operationId.value);
    return operation === undefined
      ? { kind: 'Missing' }
      : { kind: 'Found', operation };
  }

  async commit(request: CommitGroupRequest): Promise<CommitGroupOutcome> {
    const actorOperations =
      this.operationsByActor.get(request.operation.actorSubject.value) ??
      new Map<string, StoredOperation>();
    const existingOperation = actorOperations.get(
      request.operation.operationId.value,
    );

    if (existingOperation !== undefined) {
      return existingOperation.fingerprint.equals(request.operation.fingerprint)
        ? { kind: 'Committed', result: existingOperation.result }
        : { kind: 'OperationMismatch' };
    }

    const fault = this.nextFault;
    this.nextFault = null;
    if (fault === 'BeforeWriteUnavailable') {
      return { kind: 'Unavailable' };
    }

    const barrier = this.nextBarrier;
    this.nextBarrier = null;
    if (barrier !== null) {
      barrier.signalEntered();
      await barrier.released;
    }

    const current = this.groups.get(request.group.id.value);
    let version: number;

    const starting = request.groupCloseChanges.find(
      (change) => change.kind === 'ClosingStarted',
    );
    if (
      starting?.kind === 'ClosingStarted' &&
      this.closeIntentIds.has(starting.closeIntentId.value)
    ) {
      return { kind: 'CloseIntentAlreadyExists' };
    }

    if (request.expectedVersion === 'Absent') {
      if (current !== undefined) {
        return { kind: 'AlreadyExists' };
      }
      version = 1;
    } else {
      if (
        current === undefined ||
        current.version !== request.expectedVersion
      ) {
        return { kind: 'Conflict' };
      }
      version = request.stateChanged ? current.version + 1 : current.version;
    }

    const result = versionResult(request.result, version);
    this.groups.set(request.group.id.value, { group: request.group, version });
    this.membershipChanges.push(...request.membershipChanges);
    this.invitationChanges.push(...request.invitationChanges);
    this.groupCloseChanges.push(...request.groupCloseChanges);
    if (starting?.kind === 'ClosingStarted') {
      this.closeIntentIds.add(starting.closeIntentId.value);
    }
    actorOperations.set(request.operation.operationId.value, {
      actorSubject: request.operation.actorSubject,
      operationId: request.operation.operationId,
      fingerprint: request.operation.fingerprint,
      result,
    });
    this.operationsByActor.set(
      request.operation.actorSubject.value,
      actorOperations,
    );

    return fault === 'AfterWriteUnavailable'
      ? { kind: 'Unavailable' }
      : { kind: 'Committed', result };
  }

  groupCount(): number {
    return this.groups.size;
  }

  operationCount(): number {
    return [...this.operationsByActor.values()].reduce(
      (count, operations) => count + operations.size,
      0,
    );
  }

  changes(): readonly MembershipChange[] {
    return [...this.membershipChanges];
  }

  invitationHistory(): readonly InvitationChange[] {
    return [...this.invitationChanges];
  }

  groupCloseHistory(): readonly GroupCloseChange[] {
    return [...this.groupCloseChanges];
  }
}

const dependencies = (): GroupCommandDependencies => ({
  nextGroupId: vi.fn(() =>
    GroupId.from('00000000-0000-4000-8000-000000000008'),
  ),
  nextParticipantId: vi.fn(() => ParticipantId.from('generated-participant')),
  nextInvitationId: vi.fn(() => InvitationId.from('generated-invitation')),
  nextCloseIntentId: vi.fn(() => CloseIntentId.from('generated-close-intent')),
  now: vi.fn(() => createdAt),
});

const expectApplicationError = async (
  action: () => Promise<unknown>,
  code: GroupCommandApplicationError['code'],
): Promise<void> => {
  try {
    await action();
    expect.fail(`Expected ${code}`);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(GroupCommandApplicationError);
    expect((error as GroupCommandApplicationError).code).toBe(code);
  }
};

const expectDomainError = async (
  action: () => Promise<unknown>,
  code: GroupInvariantViolation['code'],
): Promise<void> => {
  try {
    await action();
    expect.fail(`Expected ${code}`);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(GroupInvariantViolation);
    expect((error as GroupInvariantViolation).code).toBe(code);
  }
};

describe('GroupCommandService.createGroup', () => {
  it('非canonicalな生成Group IDはRepositoryへ保存する前に拒否する', async () => {
    const repository = new InMemoryGroupRepository();
    const commit = vi.spyOn(repository, 'commit');
    const injected: GroupCommandDependencies = {
      ...dependencies(),
      nextGroupId: () => GroupId.from('group-a'),
    };
    const service = new GroupCommandService(repository, injected);

    await expectDomainError(
      () =>
        service.createGroup({
          actorSubject: ActorSubject.from('creator-subject'),
          operationId: OperationId.from('operation-1'),
        }),
      'GROUP_ID_INVALID',
    );
    expect(commit).not.toHaveBeenCalled();
    expect(repository.groupCount()).toBe(0);
  });

  it('作成者のGroup状態・参加履歴・operation結果を同時に保存する', async () => {
    const repository = new InMemoryGroupRepository();
    const service = new GroupCommandService(repository, dependencies());

    const result = await service.createGroup({
      actorSubject: ActorSubject.from('creator-subject'),
      operationId: OperationId.from('operation-1'),
    });

    expect(result).toEqual({
      kind: 'GroupCreated',
      groupId: GroupId.from('00000000-0000-4000-8000-000000000008'),
      participantId: ParticipantId.from('generated-participant'),
      version: 1,
    });
    expect(
      (await repository.load(result.groupId))?.group.ownerParticipantId,
    ).toEqual(result.participantId);
    expect(repository.changes()).toEqual([
      {
        kind: 'Joined',
        participantId: result.participantId,
        at: createdAt,
      },
    ]);
    expect(repository.operationCount()).toBe(1);
  });

  it('同じActorとoperationIdの再送で同じ結果を返し追加生成しない', async () => {
    const repository = new InMemoryGroupRepository();
    const injected = dependencies();
    const service = new GroupCommandService(repository, injected);
    const command = {
      actorSubject: ActorSubject.from('creator-subject'),
      operationId: OperationId.from('operation-1'),
    };

    const first = await service.createGroup(command);
    const replay = await service.createGroup(command);

    expect(replay).toEqual(first);
    expect(injected.nextGroupId).toHaveBeenCalledTimes(1);
    expect(injected.nextParticipantId).toHaveBeenCalledTimes(1);
    expect(injected.now).toHaveBeenCalledTimes(1);
    expect(repository.groupCount()).toBe(1);
    expect(repository.changes()).toHaveLength(1);
    expect(repository.operationCount()).toBe(1);
  });

  it('保存前Unavailableでは状態・履歴・operation結果を残さない', async () => {
    const repository = new InMemoryGroupRepository();
    repository.failNextCommit('BeforeWriteUnavailable');
    const service = new GroupCommandService(repository, dependencies());

    await expectApplicationError(
      () =>
        service.createGroup({
          actorSubject: ActorSubject.from('creator-subject'),
          operationId: OperationId.from('operation-1'),
        }),
      'UNAVAILABLE',
    );

    expect(repository.groupCount()).toBe(0);
    expect(repository.changes()).toEqual([]);
    expect(repository.operationCount()).toBe(0);
  });

  it('保存後の応答喪失ではoperationを照合して成功結果を返す', async () => {
    const repository = new InMemoryGroupRepository();
    repository.failNextCommit('AfterWriteUnavailable');
    const service = new GroupCommandService(repository, dependencies());
    const command = {
      actorSubject: ActorSubject.from('creator-subject'),
      operationId: OperationId.from('operation-1'),
    };

    const recovered = await service.createGroup(command);
    const replay = await service.createGroup(command);

    expect(recovered).toEqual(replay);
    expect(recovered.kind).toBe('GroupCreated');
    expect(repository.groupCount()).toBe(1);
    expect(repository.changes()).toHaveLength(1);
    expect(repository.operationCount()).toBe(1);
  });

  it('生成したGroup IDが既存なら作成済みとして拒否してoperationを残さない', async () => {
    const repository = new InMemoryGroupRepository();
    repository.seed(
      Group.create({
        id: GroupId.from('00000000-0000-4000-8000-000000000008'),
        initialParticipantId: ParticipantId.from('existing-participant'),
        creatorSubject: ActorSubject.from('existing-subject'),
        createdAt,
      }),
      1,
    );
    const service = new GroupCommandService(repository, dependencies());

    await expectApplicationError(
      () =>
        service.createGroup({
          actorSubject: ActorSubject.from('creator-subject'),
          operationId: OperationId.from('operation-1'),
        }),
      'GROUP_ALREADY_EXISTS',
    );

    expect(repository.groupCount()).toBe(1);
    expect(repository.changes()).toEqual([]);
    expect(repository.operationCount()).toBe(0);
  });

  it('異なるActorから同じoperationIdの結果を取得できない', async () => {
    const repository = new InMemoryGroupRepository();
    const service = new GroupCommandService(repository, dependencies());
    const operationId = OperationId.from('operation-1');

    await service.createGroup({
      actorSubject: ActorSubject.from('creator-subject'),
      operationId,
    });

    await expect(
      repository.findOperation(
        ActorSubject.from('another-subject'),
        operationId,
      ),
    ).resolves.toEqual({ kind: 'Missing' });
  });

  it('区切り文字を含むActorとoperationIdも別の組として保存する', async () => {
    const repository = new InMemoryGroupRepository();
    const injected: GroupCommandDependencies = {
      nextGroupId: vi
        .fn<() => GroupId>()
        .mockReturnValueOnce(
          GroupId.from('00000000-0000-4000-8000-000000000003'),
        )
        .mockReturnValueOnce(
          GroupId.from('00000000-0000-4000-8000-000000000004'),
        ),
      nextParticipantId: vi
        .fn<() => ParticipantId>()
        .mockReturnValueOnce(ParticipantId.from('participant-one'))
        .mockReturnValueOnce(ParticipantId.from('participant-two')),
      nextInvitationId: vi.fn(() => InvitationId.from('unused-invitation')),
      nextCloseIntentId: vi.fn(() => CloseIntentId.from('unused-close-intent')),
      now: vi.fn(() => createdAt),
    };
    const service = new GroupCommandService(repository, injected);

    const first = await service.createGroup({
      actorSubject: ActorSubject.from('a:b'),
      operationId: OperationId.from('c'),
    });
    await expect(
      repository.findOperation(ActorSubject.from('a'), OperationId.from('b:c')),
    ).resolves.toEqual({ kind: 'Missing' });
    const second = await service.createGroup({
      actorSubject: ActorSubject.from('a'),
      operationId: OperationId.from('b:c'),
    });

    expect(first.groupId).toEqual(
      GroupId.from('00000000-0000-4000-8000-000000000003'),
    );
    expect(second.groupId).toEqual(
      GroupId.from('00000000-0000-4000-8000-000000000004'),
    );
    expect(repository.groupCount()).toBe(2);
    expect(repository.operationCount()).toBe(2);
  });
});

describe('GroupCommandServiceのInvitation Command', () => {
  const invitationCommand = {
    actorSubject: ActorSubject.from('owner-subject'),
    operationId: OperationId.from('invite-1'),
    groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
    targetSubject: ActorSubject.from('invited-subject'),
    expectedVersion: 1,
  };

  const setup = (group = existingGroup(), version = 1) => {
    const repository = new InMemoryGroupRepository();
    repository.seed(group, version);
    const injected = dependencies();
    return {
      repository,
      injected,
      service: new GroupCommandService(repository, injected),
    };
  };

  const withInvitation = (
    id: string,
    target: string,
    source = existingGroup(),
  ): Group =>
    source.inviteParticipant({
      actorSubject: ActorSubject.from('owner-subject'),
      invitationId: InvitationId.from(id),
      targetSubject: ActorSubject.from(target),
      createdAt,
    }).group;

  it('Invitation状態・作成履歴・operation結果を同じ版更新で保存する', async () => {
    const { repository, service } = setup();

    const result = await service.inviteParticipant(invitationCommand);

    expect(result).toEqual({
      kind: 'InvitationCreated',
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      invitationId: InvitationId.from('generated-invitation'),
      version: 2,
    });
    expect(repository.invitationHistory()).toEqual([
      {
        kind: 'Created',
        invitationId: InvitationId.from('generated-invitation'),
        targetSubject: ActorSubject.from('invited-subject'),
        issuerParticipantId: ParticipantId.from('p-owner'),
        createdAt,
        expiryAt: instant('2026-09-14T00:00:00.000Z'),
      },
    ]);
    expect(repository.operationCount()).toBe(1);
  });

  it('同じoperationIdとpayloadの再送はIDや時刻を再生成しない', async () => {
    const { repository, injected, service } = setup();

    const first = await service.inviteParticipant(invitationCommand);
    const replay = await service.inviteParticipant(invitationCommand);

    expect(replay).toEqual(first);
    expect(injected.nextInvitationId).toHaveBeenCalledTimes(1);
    expect(injected.now).toHaveBeenCalledTimes(1);
    expect(repository.invitationHistory()).toHaveLength(1);
    expect(repository.operationCount()).toBe(1);
  });

  it('同じoperationIdでInvitationの宛先を変えた再送を拒否する', async () => {
    const { repository, service } = setup();
    await service.inviteParticipant(invitationCommand);

    await expectApplicationError(
      () =>
        service.inviteParticipant({
          ...invitationCommand,
          targetSubject: ActorSubject.from('different-subject'),
        }),
      'OPERATION_MISMATCH',
    );
    expect(repository.invitationHistory()).toHaveLength(1);
  });

  it('現在Ownerが取消しを状態・履歴・operation結果へ同時に保存する', async () => {
    const pending = withInvitation('invitation-a', 'invited-subject');
    const { repository, service } = setup(pending);

    const result = await service.cancelInvitation({
      actorSubject: ActorSubject.from('owner-subject'),
      operationId: OperationId.from('cancel-1'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      invitationId: InvitationId.from('invitation-a'),
      expectedVersion: 1,
    });

    expect(result).toEqual({
      kind: 'InvitationCancelled',
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      invitationId: InvitationId.from('invitation-a'),
      version: 2,
    });
    expect(repository.invitationHistory()).toEqual([
      {
        kind: 'Cancelled',
        invitationId: InvitationId.from('invitation-a'),
        at: createdAt,
      },
    ]);
  });

  it('受諾時にInvitation消費・Participant追加・両履歴・operation結果を原子的に保存する', async () => {
    const pending = withInvitation('invitation-a', 'invited-subject');
    const { repository, service } = setup(pending);

    const result = await service.acceptInvitation({
      actorSubject: ActorSubject.from('invited-subject'),
      operationId: OperationId.from('accept-1'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      invitationId: InvitationId.from('invitation-a'),
      expectedVersion: 1,
    });

    expect(result).toEqual({
      kind: 'InvitationAccepted',
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      invitationId: InvitationId.from('invitation-a'),
      participantId: ParticipantId.from('generated-participant'),
      version: 2,
    });
    expect(repository.changes()).toEqual([
      {
        kind: 'Joined',
        participantId: ParticipantId.from('generated-participant'),
        at: createdAt,
      },
    ]);
    expect(repository.invitationHistory()).toEqual([
      {
        kind: 'Consumed',
        invitationId: InvitationId.from('invitation-a'),
        participantId: ParticipantId.from('generated-participant'),
        at: createdAt,
      },
    ]);
    const saved = await repository.load(
      GroupId.from('00000000-0000-4000-8000-000000000001'),
    );
    expect(saved?.group.activeParticipantCount).toBe(4);
    expect(saved?.group.invitations[0]?.status).toBe('Consumed');
    expect(repository.operationCount()).toBe(1);
  });

  it('受諾保存後の応答喪失をoperation照合で復旧し二重参加させない', async () => {
    const pending = withInvitation('invitation-a', 'invited-subject');
    const { repository, service } = setup(pending);
    repository.failNextCommit('AfterWriteUnavailable');
    const command = {
      actorSubject: ActorSubject.from('invited-subject'),
      operationId: OperationId.from('accept-1'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      invitationId: InvitationId.from('invitation-a'),
      expectedVersion: 1,
    };

    const recovered = await service.acceptInvitation(command);
    const replay = await service.acceptInvitation(command);

    expect(replay).toEqual(recovered);
    expect(repository.changes()).toHaveLength(1);
    expect(repository.invitationHistory()).toHaveLength(1);
    expect(repository.operationCount()).toBe(1);
  });

  it('受諾保存前UnavailableではGroup・履歴・operationを一切変えない', async () => {
    const pending = withInvitation('invitation-a', 'invited-subject');
    const { repository, service } = setup(pending);
    repository.failNextCommit('BeforeWriteUnavailable');

    await expectApplicationError(
      () =>
        service.acceptInvitation({
          actorSubject: ActorSubject.from('invited-subject'),
          operationId: OperationId.from('accept-1'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          invitationId: InvitationId.from('invitation-a'),
          expectedVersion: 1,
        }),
      'UNAVAILABLE',
    );

    expect(
      (
        await repository.load(
          GroupId.from('00000000-0000-4000-8000-000000000001'),
        )
      )?.group,
    ).toEqual(pending);
    expect(repository.changes()).toEqual([]);
    expect(repository.invitationHistory()).toEqual([]);
    expect(repository.operationCount()).toBe(0);
  });

  it('残り1枠への同時受諾は1件だけCommitし他方をConflictにする', async () => {
    const firstPending = withInvitation('invitation-a', 'first-subject');
    const twoPending = withInvitation(
      'invitation-b',
      'second-subject',
      firstPending,
    );
    const { repository, service } = setup(twoPending);
    const barrier = repository.pauseNextCommit();
    const delayed = service.acceptInvitation({
      actorSubject: ActorSubject.from('first-subject'),
      operationId: OperationId.from('accept-first'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      invitationId: InvitationId.from('invitation-a'),
      expectedVersion: 1,
    });
    await barrier.entered;

    await expect(
      service.acceptInvitation({
        actorSubject: ActorSubject.from('second-subject'),
        operationId: OperationId.from('accept-second'),
        groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
        invitationId: InvitationId.from('invitation-b'),
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ kind: 'InvitationAccepted', version: 2 });
    barrier.release();
    await expectApplicationError(() => delayed, 'CONFLICT');

    const saved = await repository.load(
      GroupId.from('00000000-0000-4000-8000-000000000001'),
    );
    expect(saved?.group.activeParticipantCount).toBe(4);
    expect(repository.changes()).toHaveLength(1);
    expect(repository.invitationHistory()).toHaveLength(1);
    expect(repository.operationCount()).toBe(1);
  });

  it('成功結果は実行Actorだけが取得できる', async () => {
    const pending = withInvitation('invitation-a', 'invited-subject');
    const { repository, service } = setup(pending);
    const operationId = OperationId.from('accept-1');
    await service.acceptInvitation({
      actorSubject: ActorSubject.from('invited-subject'),
      operationId,
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      invitationId: InvitationId.from('invitation-a'),
      expectedVersion: 1,
    });

    await expect(
      repository.findOperation(
        ActorSubject.from('different-subject'),
        operationId,
      ),
    ).resolves.toEqual({ kind: 'Missing' });
  });

  it('InvitationのOwner・宛先Actor認可違反を履歴とoperationへ保存しない', async () => {
    const pending = withInvitation('invitation-a', 'invited-subject');
    const { repository, service } = setup(pending);

    await expectDomainError(
      () =>
        service.cancelInvitation({
          actorSubject: ActorSubject.from('member-subject'),
          operationId: OperationId.from('cancel-1'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          invitationId: InvitationId.from('invitation-a'),
          expectedVersion: 1,
        }),
      'NOT_CURRENT_OWNER',
    );
    await expectDomainError(
      () =>
        service.acceptInvitation({
          actorSubject: ActorSubject.from('different-subject'),
          operationId: OperationId.from('accept-1'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          invitationId: InvitationId.from('invitation-a'),
          expectedVersion: 1,
        }),
      'INVITATION_TARGET_MISMATCH',
    );

    expect(
      (
        await repository.load(
          GroupId.from('00000000-0000-4000-8000-000000000001'),
        )
      )?.group,
    ).toEqual(pending);
    expect(repository.changes()).toEqual([]);
    expect(repository.invitationHistory()).toEqual([]);
    expect(repository.operationCount()).toBe(0);
  });

  it('Invitation Commandの期待版不一致をID・時刻生成前にConflictにする', async () => {
    const { repository, injected, service } = setup();

    await expectApplicationError(
      () =>
        service.inviteParticipant({
          ...invitationCommand,
          expectedVersion: 2,
        }),
      'CONFLICT',
    );

    expect(injected.nextInvitationId).not.toHaveBeenCalled();
    expect(injected.now).not.toHaveBeenCalled();
    expect(repository.invitationHistory()).toEqual([]);
    expect(repository.operationCount()).toBe(0);
  });

  it('Left Actorの再受諾を旧Participantを残した新しいMembershipとして保存する', async () => {
    const previousParticipant: ParticipantSnapshot = {
      ...activeParticipant('p-previous', 'returning-subject', 5),
      status: 'Left',
      leftAt: createdAt,
    };
    const rejoinable = Group.restore({
      id: GroupId.from('00000000-0000-4000-8000-000000000001'),
      status: 'Active',
      ownerParticipantId: ParticipantId.from('p-owner'),
      participants: [
        activeParticipant('p-owner', 'owner-subject', 1),
        activeParticipant('p-member', 'member-subject', 2),
        previousParticipant,
      ],
      invitations: [],
      accessPolicyVersion: 1,
      closing: null,
      ownerAtArchiveParticipantId: null,
      archivedAt: null,
      deleteEligibleAt: null,
    });
    const pending = withInvitation(
      'invitation-return',
      'returning-subject',
      rejoinable,
    );
    const { repository, service } = setup(pending);

    const result = await service.acceptInvitation({
      actorSubject: ActorSubject.from('returning-subject'),
      operationId: OperationId.from('accept-return'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      invitationId: InvitationId.from('invitation-return'),
      expectedVersion: 1,
    });

    const saved = await repository.load(
      GroupId.from('00000000-0000-4000-8000-000000000001'),
    );
    expect(result.participantId).not.toEqual(previousParticipant.id);
    expect(saved?.group.participants).toContainEqual(previousParticipant);
    expect(
      saved?.group.participants.find(({ id }) =>
        id.equals(result.participantId),
      )?.joinOrder,
    ).toBe(6);
    expect(repository.changes()).toEqual([
      { kind: 'Joined', participantId: result.participantId, at: createdAt },
    ]);
  });
});

describe('GroupCommandServiceの更新Command', () => {
  const setup = (): {
    repository: InMemoryGroupRepository;
    service: GroupCommandService;
  } => {
    const repository = new InMemoryGroupRepository();
    repository.seed(existingGroup(), 1);
    return {
      repository,
      service: new GroupCommandService(repository, dependencies()),
    };
  };

  it('Owner譲渡を同じ期待版で保存する', async () => {
    const { repository, service } = setup();

    const result = await service.transferGroupOwnership({
      actorSubject: ActorSubject.from('owner-subject'),
      operationId: OperationId.from('transfer-1'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      targetParticipantId: ParticipantId.from('p-member'),
      expectedVersion: 1,
    });

    expect(result).toEqual({
      kind: 'OwnershipTransferred',
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      ownerParticipantId: ParticipantId.from('p-member'),
      version: 2,
    });
    expect(
      (
        await repository.load(
          GroupId.from('00000000-0000-4000-8000-000000000001'),
        )
      )?.group.ownerParticipantId,
    ).toEqual(ParticipantId.from('p-member'));
    expect(repository.operationCount()).toBe(1);
  });

  it('自己譲渡をNo-opとして版を上げずにoperation結果を記録する', async () => {
    const { repository, service } = setup();
    const command = {
      actorSubject: ActorSubject.from('owner-subject'),
      operationId: OperationId.from('transfer-no-op'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      targetParticipantId: ParticipantId.from('p-owner'),
      expectedVersion: 1,
    };

    const first = await service.transferGroupOwnership(command);
    const replay = await service.transferGroupOwnership(command);

    expect(first).toEqual({
      kind: 'OwnershipTransferNoOp',
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      ownerParticipantId: ParticipantId.from('p-owner'),
      version: 1,
    });
    expect(replay).toEqual(first);
    expect((await repository.load(command.groupId))?.version).toBe(1);
    expect(repository.operationCount()).toBe(1);
  });

  it('譲渡で権限を失った旧Ownerにも同じoperationの成功結果を返す', async () => {
    const { repository, service } = setup();
    const command = {
      actorSubject: ActorSubject.from('owner-subject'),
      operationId: OperationId.from('transfer-1'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      targetParticipantId: ParticipantId.from('p-member'),
      expectedVersion: 1,
    };

    const first = await service.transferGroupOwnership(command);
    const replay = await service.transferGroupOwnership(command);

    expect(replay).toEqual(first);
    expect((await repository.load(command.groupId))?.version).toBe(2);
    expect(repository.operationCount()).toBe(1);
  });

  it('本人脱退を状態・履歴・operation結果へ同時に保存する', async () => {
    const { repository, service } = setup();

    const result = await service.leaveGroup({
      actorSubject: ActorSubject.from('member-subject'),
      operationId: OperationId.from('leave-1'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      participantId: ParticipantId.from('p-member'),
      expectedVersion: 1,
    });

    expect(result).toEqual({
      kind: 'ParticipantLeft',
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      participantId: ParticipantId.from('p-member'),
      version: 2,
    });
    expect(repository.changes()).toEqual([
      {
        kind: 'Left',
        participantId: ParticipantId.from('p-member'),
        at: createdAt,
      },
    ]);
    expect(repository.operationCount()).toBe(1);
  });

  it.each(['transfer-first', 'leave-first'] as const)(
    '譲渡と譲渡先脱退が同じ版を読んだ競合で%sの1操作だけを成立させる',
    async (winner) => {
      const { repository, service } = setup();
      const transfer = () =>
        service.transferGroupOwnership({
          actorSubject: ActorSubject.from('owner-subject'),
          operationId: OperationId.from('transfer-1'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          targetParticipantId: ParticipantId.from('p-member'),
          expectedVersion: 1,
        });
      const leave = () =>
        service.leaveGroup({
          actorSubject: ActorSubject.from('member-subject'),
          operationId: OperationId.from('leave-1'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          participantId: ParticipantId.from('p-member'),
          expectedVersion: 1,
        });

      const barrier = repository.pauseNextCommit();
      const loser = winner === 'transfer-first' ? leave() : transfer();
      await barrier.entered;

      if (winner === 'transfer-first') {
        await expect(transfer()).resolves.toMatchObject({
          kind: 'OwnershipTransferred',
        });
      } else {
        await expect(leave()).resolves.toMatchObject({
          kind: 'ParticipantLeft',
        });
      }
      barrier.release();
      await expectApplicationError(() => loser, 'CONFLICT');

      expect(
        (
          await repository.load(
            GroupId.from('00000000-0000-4000-8000-000000000001'),
          )
        )?.version,
      ).toBe(2);
      expect(repository.operationCount()).toBe(1);

      if (winner === 'transfer-first') {
        await expectDomainError(
          () =>
            service.leaveGroup({
              actorSubject: ActorSubject.from('member-subject'),
              operationId: OperationId.from('leave-2'),
              groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
              participantId: ParticipantId.from('p-member'),
              expectedVersion: 2,
            }),
          'OWNER_MUST_TRANSFER_OR_END',
        );
      } else {
        await expectDomainError(
          () =>
            service.transferGroupOwnership({
              actorSubject: ActorSubject.from('owner-subject'),
              operationId: OperationId.from('transfer-2'),
              groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
              targetParticipantId: ParticipantId.from('p-member'),
              expectedVersion: 2,
            }),
          'TARGET_PARTICIPANT_NOT_ACTIVE',
        );
      }
      expect(repository.operationCount()).toBe(1);
    },
  );

  it('譲渡後の旧Owner権限を最新状態で拒否する', async () => {
    const { repository, service } = setup();
    await service.transferGroupOwnership({
      actorSubject: ActorSubject.from('owner-subject'),
      operationId: OperationId.from('transfer-1'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      targetParticipantId: ParticipantId.from('p-member'),
      expectedVersion: 1,
    });
    const before = await repository.load(
      GroupId.from('00000000-0000-4000-8000-000000000001'),
    );

    await expectDomainError(
      () =>
        service.transferGroupOwnership({
          actorSubject: ActorSubject.from('owner-subject'),
          operationId: OperationId.from('transfer-2'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          targetParticipantId: ParticipantId.from('p-third'),
          expectedVersion: 2,
        }),
      'NOT_CURRENT_OWNER',
    );

    expect(
      await repository.load(
        GroupId.from('00000000-0000-4000-8000-000000000001'),
      ),
    ).toEqual(before);
    expect(repository.operationCount()).toBe(1);
  });

  it('存在しないGroupを拒否してoperationを記録しない', async () => {
    const repository = new InMemoryGroupRepository();
    const service = new GroupCommandService(repository, dependencies());

    await expectApplicationError(
      () =>
        service.transferGroupOwnership({
          actorSubject: ActorSubject.from('owner-subject'),
          operationId: OperationId.from('transfer-1'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000006'),
          targetParticipantId: ParticipantId.from('p-member'),
          expectedVersion: 1,
        }),
      'GROUP_NOT_FOUND',
    );

    expect(repository.operationCount()).toBe(0);
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])(
    '不正な期待版%sをRepositoryへ渡さない',
    async (expectedVersion) => {
      const { repository, service } = setup();

      await expectApplicationError(
        () =>
          service.transferGroupOwnership({
            actorSubject: ActorSubject.from('owner-subject'),
            operationId: OperationId.from('transfer-1'),
            groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
            targetParticipantId: ParticipantId.from('p-member'),
            expectedVersion,
          }),
        'INVALID_EXPECTED_VERSION',
      );

      expect(repository.operationCount()).toBe(0);
      expect(
        (
          await repository.load(
            GroupId.from('00000000-0000-4000-8000-000000000001'),
          )
        )?.version,
      ).toBe(1);
    },
  );

  it('同じoperationIdで異なるpayloadをOperationMismatchとして拒否する', async () => {
    const { repository, service } = setup();
    const operationId = OperationId.from('transfer-1');
    await service.transferGroupOwnership({
      actorSubject: ActorSubject.from('owner-subject'),
      operationId,
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      targetParticipantId: ParticipantId.from('p-member'),
      expectedVersion: 1,
    });

    await expectApplicationError(
      () =>
        service.transferGroupOwnership({
          actorSubject: ActorSubject.from('owner-subject'),
          operationId,
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          targetParticipantId: ParticipantId.from('p-third'),
          expectedVersion: 1,
        }),
      'OPERATION_MISMATCH',
    );
    expect(repository.operationCount()).toBe(1);
  });

  it('他GroupのParticipant ID差替えを拒否して保存しない', async () => {
    const { repository, service } = setup();
    const before = await repository.load(
      GroupId.from('00000000-0000-4000-8000-000000000001'),
    );

    await expectDomainError(
      () =>
        service.transferGroupOwnership({
          actorSubject: ActorSubject.from('owner-subject'),
          operationId: OperationId.from('transfer-1'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          targetParticipantId: ParticipantId.from('another-group-member'),
          expectedVersion: 1,
        }),
      'TARGET_PARTICIPANT_NOT_ACTIVE',
    );
    expect(
      await repository.load(
        GroupId.from('00000000-0000-4000-8000-000000000001'),
      ),
    ).toEqual(before);
    expect(repository.operationCount()).toBe(0);
  });

  it('本人不一致を拒否して保存しない', async () => {
    const { repository, service } = setup();

    await expectDomainError(
      () =>
        service.leaveGroup({
          actorSubject: ActorSubject.from('another-subject'),
          operationId: OperationId.from('leave-1'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          participantId: ParticipantId.from('p-member'),
          expectedVersion: 1,
        }),
      'ACTOR_PARTICIPANT_MISMATCH',
    );
    expect(repository.operationCount()).toBe(0);
    expect(repository.changes()).toEqual([]);
  });

  it('Leftの再脱退を拒否して失敗結果を記録しない', async () => {
    const { repository, service } = setup();
    await service.leaveGroup({
      actorSubject: ActorSubject.from('member-subject'),
      operationId: OperationId.from('leave-1'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      participantId: ParticipantId.from('p-member'),
      expectedVersion: 1,
    });

    await expectDomainError(
      () =>
        service.leaveGroup({
          actorSubject: ActorSubject.from('member-subject'),
          operationId: OperationId.from('leave-2'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          participantId: ParticipantId.from('p-member'),
          expectedVersion: 2,
        }),
      'ALREADY_LEFT',
    );
    expect(repository.operationCount()).toBe(1);
    expect(repository.changes()).toHaveLength(1);
  });
});

const closeFenceReceipt = (
  closeIntentId: CloseIntentId,
  context: CloseFenceReceipt['context'],
  eligible = true,
): CloseFenceReceipt => ({
  kind: 'CloseFenceInstalled',
  groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
  closeIntentId,
  context,
  cutoff: createdAt,
  fenceVersion: 1,
  eligible,
  completedAt: createdAt,
});

const closeUnfenceReceipt = (
  closeIntentId: CloseIntentId,
  context: CloseUnfenceReceipt['context'],
): CloseUnfenceReceipt => ({
  kind: 'CloseFenceRemoved',
  groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
  closeIntentId,
  context,
  cutoff: createdAt,
  fenceVersion: 1,
  completedAt: createdAt,
});

describe('GroupCommandServiceのGroup close Command', () => {
  const setup = () => {
    const repository = new InMemoryGroupRepository();
    repository.seed(existingGroup(), 1);
    const injected = dependencies();
    return {
      repository,
      injected,
      service: new GroupCommandService(repository, injected),
    };
  };

  const start = async (service: GroupCommandService) =>
    service.startGroupClosing({
      actorSubject: ActorSubject.from('owner-subject'),
      operationId: OperationId.from('close-start'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      expectedVersion: 1,
    });

  it('開始状態・一意Intent・履歴・operation結果を同じCASで保存し再送する', async () => {
    const { repository, injected, service } = setup();

    const first = await start(service);
    const replay = await start(service);

    expect(replay).toEqual(first);
    expect(first).toEqual({
      kind: 'GroupClosingStarted',
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      closeIntentId: CloseIntentId.from('generated-close-intent'),
      version: 2,
    });
    expect((await repository.load(first.groupId))?.group.status).toBe(
      'Closing',
    );
    expect(repository.groupCloseHistory()).toEqual([
      {
        kind: 'ClosingStarted',
        closeIntentId: first.closeIntentId,
        cutoff: createdAt,
        startedBy: ActorSubject.from('owner-subject'),
        startedFromVersion: 1,
      },
    ]);
    expect(injected.nextCloseIntentId).toHaveBeenCalledTimes(1);
    expect(injected.now).toHaveBeenCalledTimes(1);
  });

  it('同じcloseIntentIdを別GroupへCommitせず全Group一意性を守る', async () => {
    const { repository, service } = setup();
    await start(service);
    repository.seed(
      Group.create({
        id: GroupId.from('00000000-0000-4000-8000-000000000002'),
        initialParticipantId: ParticipantId.from('owner-b'),
        creatorSubject: ActorSubject.from('owner-b-subject'),
        createdAt,
      }),
      1,
    );

    await expectApplicationError(
      () =>
        service.startGroupClosing({
          actorSubject: ActorSubject.from('owner-b-subject'),
          operationId: OperationId.from('close-start-b'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000002'),
          expectedVersion: 1,
        }),
      'CLOSE_INTENT_ALREADY_EXISTS',
    );
    expect(
      (
        await repository.load(
          GroupId.from('00000000-0000-4000-8000-000000000002'),
        )
      )?.group.status,
    ).toBe('Active');
    expect(repository.groupCloseHistory()).toHaveLength(1);
  });

  it('両Contextの終了可Receipt反映後だけArchiveし不変metadataを履歴へ保存する', async () => {
    const { repository, service } = setup();
    const started = await start(service);
    const expense = closeFenceReceipt(
      started.closeIntentId,
      'ExpenseRecording',
    );
    const settlement = closeFenceReceipt(started.closeIntentId, 'Settlement');

    await service.recordGroupCloseFenceReceipt({
      actorSubject: ActorSubject.from('owner-subject'),
      operationId: OperationId.from('expense-receipt'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      expectedVersion: 2,
      receipt: expense,
    });
    await service.recordGroupCloseFenceReceipt({
      actorSubject: ActorSubject.from('owner-subject'),
      operationId: OperationId.from('settlement-receipt'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      expectedVersion: 3,
      receipt: settlement,
    });
    await expectDomainError(
      () =>
        service.archiveGroup({
          actorSubject: ActorSubject.from('member-subject'),
          operationId: OperationId.from('archive-non-owner'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          closeIntentId: started.closeIntentId,
          expectedVersion: 4,
        }),
      'NOT_CURRENT_OWNER',
    );
    const archived = await service.archiveGroup({
      actorSubject: ActorSubject.from('owner-subject'),
      operationId: OperationId.from('archive'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      closeIntentId: started.closeIntentId,
      expectedVersion: 4,
    });

    expect(archived.version).toBe(5);
    const saved = (
      await repository.load(
        GroupId.from('00000000-0000-4000-8000-000000000001'),
      )
    )?.group;
    expect(saved?.status).toBe('Archived');
    expect(saved?.ownerAtArchiveParticipantId).toEqual(
      ParticipantId.from('p-owner'),
    );
    expect(saved?.archivedAt).toEqual(createdAt);
    expect(saved?.deleteEligibleAt?.value).toBe('2027-09-07T00:00:00.000Z');
    expect(repository.groupCloseHistory().map(({ kind }) => kind)).toEqual([
      'ClosingStarted',
      'CloseFenceReceiptRecorded',
      'CloseFenceReceiptRecorded',
      'GroupArchived',
    ]);
    expect(repository.groupCloseHistory().at(-1)).toMatchObject({
      kind: 'GroupArchived',
      archivedFromVersion: 4,
      receiptVersions: { ExpenseRecording: 1, Settlement: 1 },
    });

    await expectDomainError(
      () =>
        service.archiveGroup({
          actorSubject: ActorSubject.from('owner-subject'),
          operationId: OperationId.from('archive-twice'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          closeIntentId: started.closeIntentId,
          expectedVersion: 5,
        }),
      'CLOSE_STATE_INVALID',
    );
    await expectDomainError(
      () =>
        service.reserveGroupClosingCancellation({
          actorSubject: ActorSubject.from('owner-subject'),
          operationId: OperationId.from('cancel-after-archive'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          closeIntentId: started.closeIntentId,
          expectedVersion: 5,
        }),
      'CLOSE_STATE_INVALID',
    );
    expect(repository.groupCloseHistory()).toHaveLength(4);
    expect(repository.operationCount()).toBe(4);
  });

  it('終了不可ReceiptではArchiveせず履歴とoperation結果を増やさない', async () => {
    const { repository, service } = setup();
    const started = await start(service);
    await service.recordGroupCloseFenceReceipt({
      actorSubject: ActorSubject.from('owner-subject'),
      operationId: OperationId.from('expense-ineligible'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      expectedVersion: 2,
      receipt: closeFenceReceipt(
        started.closeIntentId,
        'ExpenseRecording',
        false,
      ),
    });
    await service.recordGroupCloseFenceReceipt({
      actorSubject: ActorSubject.from('owner-subject'),
      operationId: OperationId.from('settlement-eligible'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      expectedVersion: 3,
      receipt: closeFenceReceipt(started.closeIntentId, 'Settlement'),
    });
    const before = await repository.load(
      GroupId.from('00000000-0000-4000-8000-000000000001'),
    );

    await expectDomainError(
      () =>
        service.archiveGroup({
          actorSubject: ActorSubject.from('owner-subject'),
          operationId: OperationId.from('archive-ineligible'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          closeIntentId: started.closeIntentId,
          expectedVersion: 4,
        }),
      'CLOSE_NOT_ELIGIBLE',
    );
    expect(
      await repository.load(
        GroupId.from('00000000-0000-4000-8000-000000000001'),
      ),
    ).toEqual(before);
    expect(repository.groupCloseHistory()).toHaveLength(3);
    expect(repository.operationCount()).toBe(3);
  });

  it('証拠欠落・終了不可・古いversion・非Ownerを状態と履歴を変えず拒否する', async () => {
    const { repository, service } = setup();
    const started = await start(service);
    const before = (
      await repository.load(
        GroupId.from('00000000-0000-4000-8000-000000000001'),
      )
    )?.group;

    await expectDomainError(
      () =>
        service.archiveGroup({
          actorSubject: ActorSubject.from('owner-subject'),
          operationId: OperationId.from('archive-missing'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          closeIntentId: started.closeIntentId,
          expectedVersion: 2,
        }),
      'CLOSE_RECEIPT_MISSING',
    );
    await expectApplicationError(
      () =>
        service.reserveGroupClosingCancellation({
          actorSubject: ActorSubject.from('owner-subject'),
          operationId: OperationId.from('cancel-stale'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          closeIntentId: started.closeIntentId,
          expectedVersion: 1,
        }),
      'CONFLICT',
    );
    await expectDomainError(
      () =>
        service.reserveGroupClosingCancellation({
          actorSubject: ActorSubject.from('member-subject'),
          operationId: OperationId.from('cancel-non-owner'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          closeIntentId: started.closeIntentId,
          expectedVersion: 2,
        }),
      'NOT_CURRENT_OWNER',
    );

    expect(
      (
        await repository.load(
          GroupId.from('00000000-0000-4000-8000-000000000001'),
        )
      )?.group,
    ).toEqual(before);
    expect(repository.groupCloseHistory()).toHaveLength(1);
    expect(repository.operationCount()).toBe(1);
  });

  it('Cancelingを先にCAS予約し、片Context解除では維持して両解除後だけActiveへ戻す', async () => {
    const { repository, service } = setup();
    const started = await start(service);
    await service.recordGroupCloseFenceReceipt({
      actorSubject: ActorSubject.from('owner-subject'),
      operationId: OperationId.from('expense-fence-before-cancel'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      expectedVersion: 2,
      receipt: closeFenceReceipt(started.closeIntentId, 'ExpenseRecording'),
    });
    await service.recordGroupCloseFenceReceipt({
      actorSubject: ActorSubject.from('owner-subject'),
      operationId: OperationId.from('settlement-fence-before-cancel'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      expectedVersion: 3,
      receipt: closeFenceReceipt(started.closeIntentId, 'Settlement'),
    });
    await service.reserveGroupClosingCancellation({
      actorSubject: ActorSubject.from('owner-subject'),
      operationId: OperationId.from('cancel-reserve'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      closeIntentId: started.closeIntentId,
      expectedVersion: 4,
    });

    await expectApplicationError(
      () =>
        service.archiveGroup({
          actorSubject: ActorSubject.from('owner-subject'),
          operationId: OperationId.from('archive-lost-race'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          closeIntentId: started.closeIntentId,
          expectedVersion: 4,
        }),
      'CONFLICT',
    );

    await service.recordGroupCloseUnfenceReceipt({
      actorSubject: ActorSubject.from('owner-subject'),
      operationId: OperationId.from('expense-unfence'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      expectedVersion: 5,
      receipt: closeUnfenceReceipt(started.closeIntentId, 'ExpenseRecording'),
    });
    await expectDomainError(
      () =>
        service.completeGroupClosingCancellation({
          actorSubject: ActorSubject.from('owner-subject'),
          operationId: OperationId.from('cancel-incomplete'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          closeIntentId: started.closeIntentId,
          expectedVersion: 6,
        }),
      'CLOSE_RECEIPT_MISSING',
    );
    expect(
      (
        await repository.load(
          GroupId.from('00000000-0000-4000-8000-000000000001'),
        )
      )?.group.status,
    ).toBe('Closing');

    await service.recordGroupCloseUnfenceReceipt({
      actorSubject: ActorSubject.from('owner-subject'),
      operationId: OperationId.from('settlement-unfence'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      expectedVersion: 6,
      receipt: closeUnfenceReceipt(started.closeIntentId, 'Settlement'),
    });
    await expectDomainError(
      () =>
        service.completeGroupClosingCancellation({
          actorSubject: ActorSubject.from('member-subject'),
          operationId: OperationId.from('cancel-complete-non-owner'),
          groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
          closeIntentId: started.closeIntentId,
          expectedVersion: 7,
        }),
      'NOT_CURRENT_OWNER',
    );
    repository.failNextCommit('AfterWriteUnavailable');
    const command = {
      actorSubject: ActorSubject.from('owner-subject'),
      operationId: OperationId.from('cancel-complete'),
      groupId: GroupId.from('00000000-0000-4000-8000-000000000001'),
      closeIntentId: started.closeIntentId,
      expectedVersion: 7,
    };
    const recovered = await service.completeGroupClosingCancellation(command);
    const replay = await service.completeGroupClosingCancellation(command);

    expect(replay).toEqual(recovered);
    expect(recovered.version).toBe(8);
    expect(
      (
        await repository.load(
          GroupId.from('00000000-0000-4000-8000-000000000001'),
        )
      )?.group.status,
    ).toBe('Active');
    expect(repository.groupCloseHistory().map(({ kind }) => kind)).toEqual([
      'ClosingStarted',
      'CloseFenceReceiptRecorded',
      'CloseFenceReceiptRecorded',
      'ClosingCancellationReserved',
      'CloseUnfenceReceiptRecorded',
      'CloseUnfenceReceiptRecorded',
      'ClosingCancelled',
    ]);
  });
});

describe('Port値', () => {
  it('空のoperationIdとfingerprintを拒否する', () => {
    expect(() => OperationId.from('')).toThrow(
      'Operation ID must not be empty',
    );
    expect(() => CommandFingerprint.from(' ')).toThrow(
      'Command fingerprint must not be empty',
    );
  });
});
