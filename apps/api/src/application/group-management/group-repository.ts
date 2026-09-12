import type {
  ActorSubject,
  Group,
  GroupId,
  ParticipantId,
  UtcInstant,
} from '../../domain/group-management/group.js';

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
  operation: OperationContext;
  result: UnversionedGroupCommandResult;
}>;

export type CommitGroupOutcome =
  | Readonly<{ kind: 'Committed'; result: GroupCommandResult }>
  | Readonly<{ kind: 'Conflict' }>
  | Readonly<{ kind: 'AlreadyExists' }>
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
