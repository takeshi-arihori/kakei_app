import {
  Group,
  type ActorSubject,
  type GroupId,
  type ParticipantId,
  type UtcInstant,
} from '../../domain/group-management/group.js';
import {
  CommandFingerprint,
  type CommitGroupOutcome,
  type CommitGroupRequest,
  type GroupCommandResult,
  type GroupCreatedResult,
  type GroupRepository,
  type OperationId,
  type ParticipantLeftResult,
  type StoredOperation,
  type TransferGroupOwnershipResult,
} from './group-repository.js';

export type GroupCommandApplicationErrorCode =
  | 'CONFLICT'
  | 'GROUP_ALREADY_EXISTS'
  | 'GROUP_NOT_FOUND'
  | 'INVALID_EXPECTED_VERSION'
  | 'OPERATION_MISMATCH'
  | 'UNAVAILABLE';

export class GroupCommandApplicationError extends Error {
  constructor(
    readonly code: GroupCommandApplicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GroupCommandApplicationError';
  }
}

export type GroupCommandDependencies = Readonly<{
  nextGroupId: () => GroupId;
  nextParticipantId: () => ParticipantId;
  now: () => UtcInstant;
}>;

export type CreateGroupCommand = Readonly<{
  actorSubject: ActorSubject;
  operationId: OperationId;
}>;

export type TransferGroupOwnershipCommand = Readonly<{
  actorSubject: ActorSubject;
  operationId: OperationId;
  groupId: GroupId;
  targetParticipantId: ParticipantId;
  expectedVersion: number;
}>;

export type LeaveGroupCommand = Readonly<{
  actorSubject: ActorSubject;
  operationId: OperationId;
  groupId: GroupId;
  participantId: ParticipantId;
  expectedVersion: number;
}>;

export class GroupCommandService {
  constructor(
    private readonly repository: GroupRepository,
    private readonly dependencies: GroupCommandDependencies,
  ) {}

  async createGroup(command: CreateGroupCommand): Promise<GroupCreatedResult> {
    const fingerprint = this.fingerprint(['CreateGroup']);
    const replay = await this.findReplay(command, fingerprint);
    if (replay !== null) {
      return this.expectResultKind(replay, ['GroupCreated']);
    }

    const groupId = this.dependencies.nextGroupId();
    const participantId = this.dependencies.nextParticipantId();
    const createdAt = this.dependencies.now();
    const group = Group.create({
      id: groupId,
      initialParticipantId: participantId,
      creatorSubject: command.actorSubject,
      createdAt,
    });

    const result = await this.commit({
      group,
      expectedVersion: 'Absent',
      stateChanged: true,
      membershipChanges: [
        {
          kind: 'Joined',
          participantId,
          at: createdAt,
        },
      ],
      operation: {
        actorSubject: command.actorSubject,
        operationId: command.operationId,
        fingerprint,
      },
      result: {
        kind: 'GroupCreated',
        groupId,
        participantId,
      },
    });
    return this.expectResultKind(result, ['GroupCreated']);
  }

  async transferGroupOwnership(
    command: TransferGroupOwnershipCommand,
  ): Promise<TransferGroupOwnershipResult> {
    this.assertExpectedVersion(command.expectedVersion);
    const fingerprint = this.fingerprint([
      'TransferGroupOwnership',
      command.groupId.value,
      command.targetParticipantId.value,
      command.expectedVersion,
    ]);
    const replay = await this.findReplay(command, fingerprint);
    if (replay !== null) {
      return this.expectResultKind(replay, [
        'OwnershipTransferred',
        'OwnershipTransferNoOp',
      ]);
    }

    const loaded = await this.loadExpectedVersion(
      command.groupId,
      command.expectedVersion,
    );
    const transfer = loaded.group.transferOwnership({
      actorSubject: command.actorSubject,
      targetParticipantId: command.targetParticipantId,
    });

    const transferred = transfer.result === 'Transferred';
    const result = await this.commit({
      group: transfer.group,
      expectedVersion: loaded.version,
      stateChanged: transferred,
      membershipChanges: [],
      operation: {
        actorSubject: command.actorSubject,
        operationId: command.operationId,
        fingerprint,
      },
      result: transferred
        ? {
            kind: 'OwnershipTransferred',
            groupId: transfer.group.id,
            ownerParticipantId: command.targetParticipantId,
          }
        : {
            kind: 'OwnershipTransferNoOp',
            groupId: transfer.group.id,
            ownerParticipantId: command.targetParticipantId,
          },
    });
    return this.expectResultKind(result, [
      'OwnershipTransferred',
      'OwnershipTransferNoOp',
    ]);
  }

  async leaveGroup(command: LeaveGroupCommand): Promise<ParticipantLeftResult> {
    this.assertExpectedVersion(command.expectedVersion);
    const fingerprint = this.fingerprint([
      'LeaveGroup',
      command.groupId.value,
      command.participantId.value,
      command.expectedVersion,
    ]);
    const replay = await this.findReplay(command, fingerprint);
    if (replay !== null) {
      return this.expectResultKind(replay, ['ParticipantLeft']);
    }

    const loaded = await this.loadExpectedVersion(
      command.groupId,
      command.expectedVersion,
    );
    const leftAt = this.dependencies.now();
    const leave = loaded.group.leave({
      actorSubject: command.actorSubject,
      participantId: command.participantId,
      leftAt,
    });

    const result = await this.commit({
      group: leave.group,
      expectedVersion: loaded.version,
      stateChanged: true,
      membershipChanges: [
        {
          kind: 'Left',
          participantId: command.participantId,
          at: leftAt,
        },
      ],
      operation: {
        actorSubject: command.actorSubject,
        operationId: command.operationId,
        fingerprint,
      },
      result: {
        kind: 'ParticipantLeft',
        groupId: leave.group.id,
        participantId: command.participantId,
      },
    });
    return this.expectResultKind(result, ['ParticipantLeft']);
  }

  private async findReplay(
    command: Readonly<{
      actorSubject: ActorSubject;
      operationId: OperationId;
    }>,
    fingerprint: CommandFingerprint,
  ): Promise<GroupCommandResult | null> {
    const found = await this.repository.findOperation(
      command.actorSubject,
      command.operationId,
    );
    if (found.kind === 'Missing') {
      return null;
    }

    return this.matchStoredOperation(found.operation, fingerprint);
  }

  private matchStoredOperation(
    operation: StoredOperation,
    fingerprint: CommandFingerprint,
  ): GroupCommandResult {
    if (!operation.fingerprint.equals(fingerprint)) {
      throw new GroupCommandApplicationError(
        'OPERATION_MISMATCH',
        'The operation ID was already used for a different command',
      );
    }

    return operation.result;
  }

  private async loadExpectedVersion(groupId: GroupId, expectedVersion: number) {
    const loaded = await this.repository.load(groupId);
    if (loaded === null) {
      throw new GroupCommandApplicationError(
        'GROUP_NOT_FOUND',
        'The Group was not found',
      );
    }

    if (loaded.version !== expectedVersion) {
      throw new GroupCommandApplicationError(
        'CONFLICT',
        'The Group has changed since the command was prepared',
      );
    }

    return loaded;
  }

  private async commit(
    request: CommitGroupRequest,
  ): Promise<GroupCommandResult> {
    const outcome = await this.repository.commit(request);
    if (outcome.kind === 'Committed') {
      return outcome.result;
    }

    if (outcome.kind === 'Unavailable') {
      return this.recoverUnavailable(request);
    }

    throw this.toCommitError(outcome);
  }

  private async recoverUnavailable(
    request: CommitGroupRequest,
  ): Promise<GroupCommandResult> {
    const found = await this.repository.findOperation(
      request.operation.actorSubject,
      request.operation.operationId,
    );
    if (found.kind === 'Found') {
      return this.matchStoredOperation(
        found.operation,
        request.operation.fingerprint,
      );
    }

    throw new GroupCommandApplicationError(
      'UNAVAILABLE',
      'The repository is unavailable and the commit result is unknown',
    );
  }

  private toCommitError(
    outcome: Exclude<CommitGroupOutcome, { kind: 'Committed' | 'Unavailable' }>,
  ): GroupCommandApplicationError {
    switch (outcome.kind) {
      case 'Conflict':
        return new GroupCommandApplicationError(
          'CONFLICT',
          'The Group changed before the command could be committed',
        );
      case 'AlreadyExists':
        return new GroupCommandApplicationError(
          'GROUP_ALREADY_EXISTS',
          'The generated Group ID already exists',
        );
      case 'OperationMismatch':
        return new GroupCommandApplicationError(
          'OPERATION_MISMATCH',
          'The operation ID was already used for a different command',
        );
    }
  }

  private assertExpectedVersion(expectedVersion: number): void {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new GroupCommandApplicationError(
        'INVALID_EXPECTED_VERSION',
        'The expected Group version must be a positive safe integer',
      );
    }
  }

  private fingerprint(parts: readonly (string | number)[]): CommandFingerprint {
    return CommandFingerprint.from(JSON.stringify(parts));
  }

  private expectResultKind<Kind extends GroupCommandResult['kind']>(
    result: GroupCommandResult,
    expectedKinds: readonly Kind[],
  ): Extract<GroupCommandResult, { kind: Kind }> {
    if (!expectedKinds.includes(result.kind as Kind)) {
      throw new GroupCommandApplicationError(
        'OPERATION_MISMATCH',
        'The stored operation result belongs to a different command',
      );
    }

    return result as Extract<GroupCommandResult, { kind: Kind }>;
  }
}
