import type {
  ActorSubject,
  CloseFenceReceipt,
  CloseIntentId,
  CloseUnfenceReceipt,
  Group,
  GroupId,
  InvitationId,
  ParticipantId,
  UtcInstant,
} from '../domain/group.js';

const requireNonEmpty = (value: string, message: string): string => {
  if (value.trim().length === 0) {
    throw new Error(message);
  }

  return value;
};

export class OperationId {
  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  static from(value: string): OperationId {
    return new OperationId(
      requireNonEmpty(value, 'Operation ID must not be empty'),
    );
  }

  equals(other: OperationId): boolean {
    return this.value === other.value;
  }
}

export class CommandFingerprint {
  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  static from(value: string): CommandFingerprint {
    return new CommandFingerprint(
      requireNonEmpty(value, 'Command fingerprint must not be empty'),
    );
  }

  equals(other: CommandFingerprint): boolean {
    return this.value === other.value;
  }
}

export type LoadedGroup = Readonly<{
  group: Group;
  version: number;
}>;

export type MembershipChange =
  | Readonly<{
      kind: 'Joined';
      participantId: ParticipantId;
      at: UtcInstant;
    }>
  | Readonly<{
      kind: 'Left';
      participantId: ParticipantId;
      at: UtcInstant;
    }>;

export type InvitationChange =
  | Readonly<{
      kind: 'Created';
      invitationId: InvitationId;
      targetSubject: ActorSubject;
      issuerParticipantId: ParticipantId;
      createdAt: UtcInstant;
      expiryAt: UtcInstant;
    }>
  | Readonly<{
      kind: 'Cancelled';
      invitationId: InvitationId;
      at: UtcInstant;
    }>
  | Readonly<{
      kind: 'Consumed';
      invitationId: InvitationId;
      participantId: ParticipantId;
      at: UtcInstant;
    }>;

export type GroupCloseChange =
  | Readonly<{
      kind: 'ClosingStarted';
      closeIntentId: CloseIntentId;
      cutoff: UtcInstant;
      startedBy: ActorSubject;
      startedFromVersion: number;
    }>
  | Readonly<{
      kind: 'CloseFenceReceiptRecorded';
      receipt: CloseFenceReceipt;
    }>
  | Readonly<{
      kind: 'ClosingCancellationReserved';
      closeIntentId: CloseIntentId;
    }>
  | Readonly<{
      kind: 'CloseUnfenceReceiptRecorded';
      receipt: CloseUnfenceReceipt;
    }>
  | Readonly<{
      kind: 'GroupArchived';
      closeIntentId: CloseIntentId;
      ownerAtArchiveParticipantId: ParticipantId;
      archivedAt: UtcInstant;
      deleteEligibleAt: UtcInstant;
      archivedFromVersion: number;
      receiptVersions: Readonly<{
        ExpenseRecording: number;
        Settlement: number;
      }>;
    }>
  | Readonly<{
      kind: 'ClosingCancelled';
      closeIntentId: CloseIntentId;
    }>;

export type UnversionedGroupCommandResult =
  | Readonly<{
      kind: 'GroupCreated';
      groupId: GroupId;
      participantId: ParticipantId;
    }>
  | Readonly<{
      kind: 'OwnershipTransferred';
      groupId: GroupId;
      ownerParticipantId: ParticipantId;
    }>
  | Readonly<{
      kind: 'OwnershipTransferNoOp';
      groupId: GroupId;
      ownerParticipantId: ParticipantId;
    }>
  | Readonly<{
      kind: 'ParticipantLeft';
      groupId: GroupId;
      participantId: ParticipantId;
    }>
  | Readonly<{
      kind: 'InvitationCreated';
      groupId: GroupId;
      invitationId: InvitationId;
    }>
  | Readonly<{
      kind: 'InvitationCancelled';
      groupId: GroupId;
      invitationId: InvitationId;
    }>
  | Readonly<{
      kind: 'InvitationAccepted';
      groupId: GroupId;
      invitationId: InvitationId;
      participantId: ParticipantId;
    }>
  | Readonly<{
      kind: 'GroupClosingStarted';
      groupId: GroupId;
      closeIntentId: CloseIntentId;
    }>
  | Readonly<{
      kind: 'GroupCloseFenceReceiptRecorded';
      groupId: GroupId;
      closeIntentId: CloseIntentId;
    }>
  | Readonly<{
      kind: 'GroupClosingCancellationReserved';
      groupId: GroupId;
      closeIntentId: CloseIntentId;
    }>
  | Readonly<{
      kind: 'GroupCloseUnfenceReceiptRecorded';
      groupId: GroupId;
      closeIntentId: CloseIntentId;
    }>
  | Readonly<{
      kind: 'GroupArchived';
      groupId: GroupId;
      closeIntentId: CloseIntentId;
    }>
  | Readonly<{
      kind: 'GroupClosingCancelled';
      groupId: GroupId;
      closeIntentId: CloseIntentId;
    }>;

export type GroupCommandResult =
  | Readonly<{
      kind: 'GroupCreated';
      groupId: GroupId;
      participantId: ParticipantId;
      version: number;
    }>
  | Readonly<{
      kind: 'OwnershipTransferred';
      groupId: GroupId;
      ownerParticipantId: ParticipantId;
      version: number;
    }>
  | Readonly<{
      kind: 'OwnershipTransferNoOp';
      groupId: GroupId;
      ownerParticipantId: ParticipantId;
      version: number;
    }>
  | Readonly<{
      kind: 'ParticipantLeft';
      groupId: GroupId;
      participantId: ParticipantId;
      version: number;
    }>
  | Readonly<{
      kind: 'InvitationCreated';
      groupId: GroupId;
      invitationId: InvitationId;
      version: number;
    }>
  | Readonly<{
      kind: 'InvitationCancelled';
      groupId: GroupId;
      invitationId: InvitationId;
      version: number;
    }>
  | Readonly<{
      kind: 'InvitationAccepted';
      groupId: GroupId;
      invitationId: InvitationId;
      participantId: ParticipantId;
      version: number;
    }>
  | Readonly<{
      kind: 'GroupClosingStarted';
      groupId: GroupId;
      closeIntentId: CloseIntentId;
      version: number;
    }>
  | Readonly<{
      kind: 'GroupCloseFenceReceiptRecorded';
      groupId: GroupId;
      closeIntentId: CloseIntentId;
      version: number;
    }>
  | Readonly<{
      kind: 'GroupClosingCancellationReserved';
      groupId: GroupId;
      closeIntentId: CloseIntentId;
      version: number;
    }>
  | Readonly<{
      kind: 'GroupCloseUnfenceReceiptRecorded';
      groupId: GroupId;
      closeIntentId: CloseIntentId;
      version: number;
    }>
  | Readonly<{
      kind: 'GroupArchived';
      groupId: GroupId;
      closeIntentId: CloseIntentId;
      version: number;
    }>
  | Readonly<{
      kind: 'GroupClosingCancelled';
      groupId: GroupId;
      closeIntentId: CloseIntentId;
      version: number;
    }>;

export type GroupCreatedResult = Extract<
  GroupCommandResult,
  { kind: 'GroupCreated' }
>;

export type TransferGroupOwnershipResult = Extract<
  GroupCommandResult,
  { kind: 'OwnershipTransferred' | 'OwnershipTransferNoOp' }
>;

export type ParticipantLeftResult = Extract<
  GroupCommandResult,
  { kind: 'ParticipantLeft' }
>;

export type InvitationCreatedResult = Extract<
  GroupCommandResult,
  { kind: 'InvitationCreated' }
>;

export type InvitationCancelledResult = Extract<
  GroupCommandResult,
  { kind: 'InvitationCancelled' }
>;

export type InvitationAcceptedResult = Extract<
  GroupCommandResult,
  { kind: 'InvitationAccepted' }
>;

export type GroupClosingStartedResult = Extract<
  GroupCommandResult,
  { kind: 'GroupClosingStarted' }
>;
export type GroupCloseFenceReceiptRecordedResult = Extract<
  GroupCommandResult,
  { kind: 'GroupCloseFenceReceiptRecorded' }
>;
export type GroupClosingCancellationReservedResult = Extract<
  GroupCommandResult,
  { kind: 'GroupClosingCancellationReserved' }
>;
export type GroupCloseUnfenceReceiptRecordedResult = Extract<
  GroupCommandResult,
  { kind: 'GroupCloseUnfenceReceiptRecorded' }
>;
export type GroupArchivedResult = Extract<
  GroupCommandResult,
  { kind: 'GroupArchived' }
>;
export type GroupClosingCancelledResult = Extract<
  GroupCommandResult,
  { kind: 'GroupClosingCancelled' }
>;

export type OperationContext = Readonly<{
  actorSubject: ActorSubject;
  operationId: OperationId;
  fingerprint: CommandFingerprint;
}>;

export type StoredOperation = Readonly<
  OperationContext & {
    result: GroupCommandResult;
  }
>;

export type CommitGroupRequest = Readonly<{
  group: Group;
  expectedVersion: number | 'Absent';
  stateChanged: boolean;
  membershipChanges: readonly MembershipChange[];
  invitationChanges: readonly InvitationChange[];
  groupCloseChanges: readonly GroupCloseChange[];
  operation: OperationContext;
  result: UnversionedGroupCommandResult;
}>;

export type CommitGroupOutcome =
  | Readonly<{ kind: 'Committed'; result: GroupCommandResult }>
  | Readonly<{ kind: 'Conflict' }>
  | Readonly<{ kind: 'AlreadyExists' }>
  | Readonly<{ kind: 'CloseIntentAlreadyExists' }>
  | Readonly<{ kind: 'OperationMismatch' }>
  | Readonly<{ kind: 'Unavailable' }>;

export type FindOperationResult =
  | Readonly<{ kind: 'Found'; operation: StoredOperation }>
  | Readonly<{ kind: 'Missing' }>;

export interface GroupRepository {
  load(groupId: GroupId): Promise<LoadedGroup | null>;

  findOperation(
    actorSubject: ActorSubject,
    operationId: OperationId,
  ): Promise<FindOperationResult>;

  commit(request: CommitGroupRequest): Promise<CommitGroupOutcome>;
}
