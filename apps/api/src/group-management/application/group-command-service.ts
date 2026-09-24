import {
  Group,
  type ActorSubject,
  type CloseFenceReceipt,
  type CloseIntentId,
  type CloseUnfenceReceipt,
  type GroupId,
  type InvitationId,
  type ParticipantId,
  type UtcInstant,
} from '../domain/group.js';
import {
  CommandFingerprint,
  type CommitGroupOutcome,
  type CommitGroupRequest,
  type GroupCommandResult,
  type GroupArchivedResult,
  type GroupCloseFenceReceiptRecordedResult,
  type GroupCloseUnfenceReceiptRecordedResult,
  type GroupClosingCancellationReservedResult,
  type GroupClosingCancelledResult,
  type GroupClosingStartedResult,
  type GroupCreatedResult,
  type GroupRepository,
  type InvitationAcceptedResult,
  type InvitationCancelledResult,
  type InvitationCreatedResult,
  type OperationId,
  type ParticipantLeftResult,
  type StoredOperation,
  type TransferGroupOwnershipResult,
} from './group-repository.js';

export type GroupCommandApplicationErrorCode =
  | 'CLOSE_INTENT_ALREADY_EXISTS'
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
  /** The trusted production callback creates a GroupId from crypto.randomUUID(). */
  nextGroupId: () => GroupId;
  nextParticipantId: () => ParticipantId;
  nextInvitationId: () => InvitationId;
  /** Trusted composition injects CSPRNG UUIDv4 IDs; commands cannot choose an ID. */
  nextCloseIntentId: () => CloseIntentId;
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

export type InviteParticipantCommand = Readonly<{
  actorSubject: ActorSubject;
  operationId: OperationId;
  groupId: GroupId;
  targetSubject: ActorSubject;
  expectedVersion: number;
}>;

export type CancelInvitationCommand = Readonly<{
  actorSubject: ActorSubject;
  operationId: OperationId;
  groupId: GroupId;
  invitationId: InvitationId;
  expectedVersion: number;
}>;

export type AcceptInvitationCommand = Readonly<{
  actorSubject: ActorSubject;
  operationId: OperationId;
  groupId: GroupId;
  invitationId: InvitationId;
  expectedVersion: number;
}>;

export type StartGroupClosingCommand = Readonly<{
  actorSubject: ActorSubject;
  operationId: OperationId;
  groupId: GroupId;
  expectedVersion: number;
}>;

export type RecordGroupCloseFenceReceiptCommand = Readonly<{
  actorSubject: ActorSubject;
  operationId: OperationId;
  groupId: GroupId;
  expectedVersion: number;
  receipt: CloseFenceReceipt;
}>;

export type ArchiveGroupCommand = Readonly<{
  actorSubject: ActorSubject;
  operationId: OperationId;
  groupId: GroupId;
  closeIntentId: CloseIntentId;
  expectedVersion: number;
}>;

export type ReserveGroupClosingCancellationCommand = Readonly<{
  actorSubject: ActorSubject;
  operationId: OperationId;
  groupId: GroupId;
  closeIntentId: CloseIntentId;
  expectedVersion: number;
}>;

export type RecordGroupCloseUnfenceReceiptCommand = Readonly<{
  actorSubject: ActorSubject;
  operationId: OperationId;
  groupId: GroupId;
  expectedVersion: number;
  receipt: CloseUnfenceReceipt;
}>;

export type CompleteGroupClosingCancellationCommand = Readonly<{
  actorSubject: ActorSubject;
  operationId: OperationId;
  groupId: GroupId;
  closeIntentId: CloseIntentId;
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
      invitationChanges: [],
      groupCloseChanges: [],
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
      invitationChanges: [],
      groupCloseChanges: [],
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
      invitationChanges: [],
      groupCloseChanges: [],
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

  async inviteParticipant(
    command: InviteParticipantCommand,
  ): Promise<InvitationCreatedResult> {
    this.assertExpectedVersion(command.expectedVersion);
    const fingerprint = this.fingerprint([
      'InviteParticipant',
      command.groupId.value,
      command.targetSubject.value,
      command.expectedVersion,
    ]);
    const replay = await this.findReplay(command, fingerprint);
    if (replay !== null) {
      return this.expectResultKind(replay, ['InvitationCreated']);
    }

    const loaded = await this.loadExpectedVersion(
      command.groupId,
      command.expectedVersion,
    );
    const invitationId = this.dependencies.nextInvitationId();
    const createdAt = this.dependencies.now();
    const invited = loaded.group.inviteParticipant({
      actorSubject: command.actorSubject,
      invitationId,
      targetSubject: command.targetSubject,
      createdAt,
    });

    const result = await this.commit({
      group: invited.group,
      expectedVersion: loaded.version,
      stateChanged: true,
      membershipChanges: [],
      invitationChanges: [
        {
          kind: 'Created',
          invitationId,
          targetSubject: command.targetSubject,
          issuerParticipantId: invited.invitation.issuerParticipantId,
          createdAt,
          expiryAt: invited.invitation.expiryAt,
        },
      ],
      groupCloseChanges: [],
      operation: {
        actorSubject: command.actorSubject,
        operationId: command.operationId,
        fingerprint,
      },
      result: {
        kind: 'InvitationCreated',
        groupId: invited.group.id,
        invitationId,
      },
    });
    return this.expectResultKind(result, ['InvitationCreated']);
  }

  async cancelInvitation(
    command: CancelInvitationCommand,
  ): Promise<InvitationCancelledResult> {
    this.assertExpectedVersion(command.expectedVersion);
    const fingerprint = this.fingerprint([
      'CancelInvitation',
      command.groupId.value,
      command.invitationId.value,
      command.expectedVersion,
    ]);
    const replay = await this.findReplay(command, fingerprint);
    if (replay !== null) {
      return this.expectResultKind(replay, ['InvitationCancelled']);
    }

    const loaded = await this.loadExpectedVersion(
      command.groupId,
      command.expectedVersion,
    );
    const cancelledAt = this.dependencies.now();
    const cancelled = loaded.group.cancelInvitation({
      actorSubject: command.actorSubject,
      invitationId: command.invitationId,
      cancelledAt,
    });

    const result = await this.commit({
      group: cancelled.group,
      expectedVersion: loaded.version,
      stateChanged: true,
      membershipChanges: [],
      invitationChanges: [
        {
          kind: 'Cancelled',
          invitationId: command.invitationId,
          at: cancelledAt,
        },
      ],
      groupCloseChanges: [],
      operation: {
        actorSubject: command.actorSubject,
        operationId: command.operationId,
        fingerprint,
      },
      result: {
        kind: 'InvitationCancelled',
        groupId: cancelled.group.id,
        invitationId: command.invitationId,
      },
    });
    return this.expectResultKind(result, ['InvitationCancelled']);
  }

  async acceptInvitation(
    command: AcceptInvitationCommand,
  ): Promise<InvitationAcceptedResult> {
    this.assertExpectedVersion(command.expectedVersion);
    const fingerprint = this.fingerprint([
      'AcceptInvitation',
      command.groupId.value,
      command.invitationId.value,
      command.expectedVersion,
    ]);
    const replay = await this.findReplay(command, fingerprint);
    if (replay !== null) {
      return this.expectResultKind(replay, ['InvitationAccepted']);
    }

    const loaded = await this.loadExpectedVersion(
      command.groupId,
      command.expectedVersion,
    );
    const participantId = this.dependencies.nextParticipantId();
    const acceptedAt = this.dependencies.now();
    const accepted = loaded.group.acceptInvitation({
      actorSubject: command.actorSubject,
      invitationId: command.invitationId,
      participantId,
      acceptedAt,
    });

    const result = await this.commit({
      group: accepted.group,
      expectedVersion: loaded.version,
      stateChanged: true,
      membershipChanges: [
        {
          kind: 'Joined',
          participantId,
          at: acceptedAt,
        },
      ],
      invitationChanges: [
        {
          kind: 'Consumed',
          invitationId: command.invitationId,
          participantId,
          at: acceptedAt,
        },
      ],
      groupCloseChanges: [],
      operation: {
        actorSubject: command.actorSubject,
        operationId: command.operationId,
        fingerprint,
      },
      result: {
        kind: 'InvitationAccepted',
        groupId: accepted.group.id,
        invitationId: command.invitationId,
        participantId,
      },
    });
    return this.expectResultKind(result, ['InvitationAccepted']);
  }

  async startGroupClosing(
    command: StartGroupClosingCommand,
  ): Promise<GroupClosingStartedResult> {
    this.assertExpectedVersion(command.expectedVersion);
    const fingerprint = this.fingerprint([
      'StartGroupClosing',
      command.groupId.value,
      command.expectedVersion,
    ]);
    const replay = await this.findReplay(command, fingerprint);
    if (replay !== null) {
      return this.expectResultKind(replay, ['GroupClosingStarted']);
    }

    const loaded = await this.loadExpectedVersion(
      command.groupId,
      command.expectedVersion,
    );
    const closeIntentId = this.dependencies.nextCloseIntentId();
    const cutoff = this.dependencies.now();
    const closing = loaded.group.startClosing({
      actorSubject: command.actorSubject,
      closeIntentId,
      cutoff,
    });
    const result = await this.commit({
      group: closing.group,
      expectedVersion: loaded.version,
      stateChanged: true,
      membershipChanges: [],
      invitationChanges: [],
      groupCloseChanges: [
        {
          kind: 'ClosingStarted',
          closeIntentId,
          cutoff,
          startedBy: command.actorSubject,
          startedFromVersion: loaded.version,
        },
      ],
      operation: {
        actorSubject: command.actorSubject,
        operationId: command.operationId,
        fingerprint,
      },
      result: {
        kind: 'GroupClosingStarted',
        groupId: command.groupId,
        closeIntentId,
      },
    });
    return this.expectResultKind(result, ['GroupClosingStarted']);
  }

  async recordGroupCloseFenceReceipt(
    command: RecordGroupCloseFenceReceiptCommand,
  ): Promise<GroupCloseFenceReceiptRecordedResult> {
    this.assertExpectedVersion(command.expectedVersion);
    const { receipt } = command;
    const fingerprint = this.fingerprint([
      'RecordGroupCloseFenceReceipt',
      command.groupId.value,
      command.expectedVersion,
      ...this.fenceReceiptFingerprint(receipt),
    ]);
    const replay = await this.findReplay(command, fingerprint);
    if (replay !== null) {
      return this.expectResultKind(replay, ['GroupCloseFenceReceiptRecorded']);
    }

    const loaded = await this.loadExpectedVersion(
      command.groupId,
      command.expectedVersion,
    );
    const recorded = loaded.group.recordCloseFenceReceipt(receipt);
    const changed = recorded.group !== loaded.group;
    const result = await this.commit({
      group: recorded.group,
      expectedVersion: loaded.version,
      stateChanged: changed,
      membershipChanges: [],
      invitationChanges: [],
      groupCloseChanges: changed
        ? [{ kind: 'CloseFenceReceiptRecorded', receipt }]
        : [],
      operation: {
        actorSubject: command.actorSubject,
        operationId: command.operationId,
        fingerprint,
      },
      result: {
        kind: 'GroupCloseFenceReceiptRecorded',
        groupId: command.groupId,
        closeIntentId: receipt.closeIntentId,
      },
    });
    return this.expectResultKind(result, ['GroupCloseFenceReceiptRecorded']);
  }

  async archiveGroup(
    command: ArchiveGroupCommand,
  ): Promise<GroupArchivedResult> {
    this.assertExpectedVersion(command.expectedVersion);
    const fingerprint = this.fingerprint([
      'ArchiveGroup',
      command.groupId.value,
      command.closeIntentId.value,
      command.expectedVersion,
    ]);
    const replay = await this.findReplay(command, fingerprint);
    if (replay !== null) {
      return this.expectResultKind(replay, ['GroupArchived']);
    }

    const loaded = await this.loadExpectedVersion(
      command.groupId,
      command.expectedVersion,
    );
    const archivedAt = this.dependencies.now();
    const receipts = new Map(
      loaded.group.closing?.fenceReceipts.map((receipt) => [
        receipt.context,
        receipt,
      ]) ?? [],
    );
    const archived = loaded.group.archive({
      actorSubject: command.actorSubject,
      closeIntentId: command.closeIntentId,
      archivedAt,
    });
    const ownerAtArchiveParticipantId =
      archived.group.ownerAtArchiveParticipantId;
    const deleteEligibleAt = archived.group.deleteEligibleAt;
    if (ownerAtArchiveParticipantId === null || deleteEligibleAt === null) {
      throw new GroupCommandApplicationError(
        'UNAVAILABLE',
        'The archived Group did not produce immutable archive metadata',
      );
    }
    const expenseReceipt = receipts.get('ExpenseRecording');
    const settlementReceipt = receipts.get('Settlement');
    if (expenseReceipt === undefined || settlementReceipt === undefined) {
      throw new GroupCommandApplicationError(
        'UNAVAILABLE',
        'The archived Group did not provide both Context Receipt versions',
      );
    }
    const result = await this.commit({
      group: archived.group,
      expectedVersion: loaded.version,
      stateChanged: true,
      membershipChanges: [],
      invitationChanges: [],
      groupCloseChanges: [
        {
          kind: 'GroupArchived',
          closeIntentId: command.closeIntentId,
          ownerAtArchiveParticipantId,
          archivedAt,
          deleteEligibleAt,
          archivedFromVersion: loaded.version,
          receiptVersions: {
            ExpenseRecording: expenseReceipt.fenceVersion,
            Settlement: settlementReceipt.fenceVersion,
          },
        },
      ],
      operation: {
        actorSubject: command.actorSubject,
        operationId: command.operationId,
        fingerprint,
      },
      result: {
        kind: 'GroupArchived',
        groupId: command.groupId,
        closeIntentId: command.closeIntentId,
      },
    });
    return this.expectResultKind(result, ['GroupArchived']);
  }

  async reserveGroupClosingCancellation(
    command: ReserveGroupClosingCancellationCommand,
  ): Promise<GroupClosingCancellationReservedResult> {
    this.assertExpectedVersion(command.expectedVersion);
    const fingerprint = this.fingerprint([
      'ReserveGroupClosingCancellation',
      command.groupId.value,
      command.closeIntentId.value,
      command.expectedVersion,
    ]);
    const replay = await this.findReplay(command, fingerprint);
    if (replay !== null) {
      return this.expectResultKind(replay, [
        'GroupClosingCancellationReserved',
      ]);
    }

    const loaded = await this.loadExpectedVersion(
      command.groupId,
      command.expectedVersion,
    );
    const reserved = loaded.group.reserveClosingCancellation({
      actorSubject: command.actorSubject,
      closeIntentId: command.closeIntentId,
    });
    const result = await this.commit({
      group: reserved.group,
      expectedVersion: loaded.version,
      stateChanged: true,
      membershipChanges: [],
      invitationChanges: [],
      groupCloseChanges: [
        {
          kind: 'ClosingCancellationReserved',
          closeIntentId: command.closeIntentId,
        },
      ],
      operation: {
        actorSubject: command.actorSubject,
        operationId: command.operationId,
        fingerprint,
      },
      result: {
        kind: 'GroupClosingCancellationReserved',
        groupId: command.groupId,
        closeIntentId: command.closeIntentId,
      },
    });
    return this.expectResultKind(result, ['GroupClosingCancellationReserved']);
  }

  async recordGroupCloseUnfenceReceipt(
    command: RecordGroupCloseUnfenceReceiptCommand,
  ): Promise<GroupCloseUnfenceReceiptRecordedResult> {
    this.assertExpectedVersion(command.expectedVersion);
    const { receipt } = command;
    const fingerprint = this.fingerprint([
      'RecordGroupCloseUnfenceReceipt',
      command.groupId.value,
      command.expectedVersion,
      ...this.unfenceReceiptFingerprint(receipt),
    ]);
    const replay = await this.findReplay(command, fingerprint);
    if (replay !== null) {
      return this.expectResultKind(replay, [
        'GroupCloseUnfenceReceiptRecorded',
      ]);
    }

    const loaded = await this.loadExpectedVersion(
      command.groupId,
      command.expectedVersion,
    );
    const recorded = loaded.group.recordCloseUnfenceReceipt(receipt);
    const changed = recorded.group !== loaded.group;
    const result = await this.commit({
      group: recorded.group,
      expectedVersion: loaded.version,
      stateChanged: changed,
      membershipChanges: [],
      invitationChanges: [],
      groupCloseChanges: changed
        ? [{ kind: 'CloseUnfenceReceiptRecorded', receipt }]
        : [],
      operation: {
        actorSubject: command.actorSubject,
        operationId: command.operationId,
        fingerprint,
      },
      result: {
        kind: 'GroupCloseUnfenceReceiptRecorded',
        groupId: command.groupId,
        closeIntentId: receipt.closeIntentId,
      },
    });
    return this.expectResultKind(result, ['GroupCloseUnfenceReceiptRecorded']);
  }

  async completeGroupClosingCancellation(
    command: CompleteGroupClosingCancellationCommand,
  ): Promise<GroupClosingCancelledResult> {
    this.assertExpectedVersion(command.expectedVersion);
    const fingerprint = this.fingerprint([
      'CompleteGroupClosingCancellation',
      command.groupId.value,
      command.closeIntentId.value,
      command.expectedVersion,
    ]);
    const replay = await this.findReplay(command, fingerprint);
    if (replay !== null) {
      return this.expectResultKind(replay, ['GroupClosingCancelled']);
    }

    const loaded = await this.loadExpectedVersion(
      command.groupId,
      command.expectedVersion,
    );
    const cancelled = loaded.group.completeClosingCancellation({
      actorSubject: command.actorSubject,
      closeIntentId: command.closeIntentId,
    });
    const result = await this.commit({
      group: cancelled.group,
      expectedVersion: loaded.version,
      stateChanged: true,
      membershipChanges: [],
      invitationChanges: [],
      groupCloseChanges: [
        { kind: 'ClosingCancelled', closeIntentId: command.closeIntentId },
      ],
      operation: {
        actorSubject: command.actorSubject,
        operationId: command.operationId,
        fingerprint,
      },
      result: {
        kind: 'GroupClosingCancelled',
        groupId: command.groupId,
        closeIntentId: command.closeIntentId,
      },
    });
    return this.expectResultKind(result, ['GroupClosingCancelled']);
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
      case 'CloseIntentAlreadyExists':
        return new GroupCommandApplicationError(
          'CLOSE_INTENT_ALREADY_EXISTS',
          'The generated close Intent ID already exists',
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

  private fenceReceiptFingerprint(
    receipt: CloseFenceReceipt,
  ): readonly (string | number)[] {
    return [
      receipt.groupId.value,
      receipt.closeIntentId.value,
      receipt.context,
      receipt.cutoff.value,
      receipt.fenceVersion,
      receipt.eligible ? 'eligible' : 'ineligible',
      receipt.completedAt.value,
    ];
  }

  private unfenceReceiptFingerprint(
    receipt: CloseUnfenceReceipt,
  ): readonly (string | number)[] {
    return [
      receipt.groupId.value,
      receipt.closeIntentId.value,
      receipt.context,
      receipt.cutoff.value,
      receipt.fenceVersion,
      receipt.completedAt.value,
    ];
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
