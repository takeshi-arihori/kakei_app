export type GroupInvariantViolationCode =
  | 'IDENTIFIER_EMPTY'
  | 'UTC_INSTANT_INVALID'
  | 'OWNER_MISSING'
  | 'OWNER_DUPLICATED'
  | 'OWNER_MEMBERSHIP_MISMATCH'
  | 'OWNER_NOT_ACTIVE'
  | 'ACTIVE_PARTICIPANT_COUNT_OUT_OF_RANGE'
  | 'PARTICIPANT_DUPLICATED'
  | 'ACTIVE_SUBJECT_DUPLICATED'
  | 'REJOIN_NOT_DECIDED'
  | 'JOIN_ORDER_INVALID'
  | 'JOIN_ORDER_DUPLICATED'
  | 'LEFT_AT_REQUIRED'
  | 'LEFT_AT_NOT_ALLOWED'
  | 'LEFT_AT_BEFORE_JOINED_AT'
  | 'GROUP_NOT_ACTIVE'
  | 'NOT_CURRENT_OWNER'
  | 'TARGET_PARTICIPANT_NOT_ACTIVE'
  | 'ACTOR_PARTICIPANT_MISMATCH'
  | 'OWNER_MUST_TRANSFER_OR_END'
  | 'ALREADY_LEFT';

export class GroupInvariantViolation extends Error {
  constructor(
    readonly code: GroupInvariantViolationCode,
    message: string,
  ) {
    super(message);
    this.name = 'GroupInvariantViolation';
  }
}

const requireNonEmpty = (value: string): string => {
  if (value.trim().length === 0) {
    throw new GroupInvariantViolation(
      'IDENTIFIER_EMPTY',
      'Group identifiers and actor subjects must not be empty',
    );
  }

  return value;
};

export class GroupId {
  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  static from(value: string): GroupId {
    return new GroupId(requireNonEmpty(value));
  }

  equals(other: GroupId): boolean {
    return this.value === other.value;
  }
}

export class ParticipantId {
  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  static from(value: string): ParticipantId {
    return new ParticipantId(requireNonEmpty(value));
  }

  equals(other: ParticipantId): boolean {
    return this.value === other.value;
  }
}

export class ActorSubject {
  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  static from(value: string): ActorSubject {
    return new ActorSubject(requireNonEmpty(value));
  }

  equals(other: ActorSubject): boolean {
    return this.value === other.value;
  }
}

export class UtcInstant {
  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  static from(value: Date): UtcInstant {
    if (Number.isNaN(value.getTime())) {
      throw new GroupInvariantViolation(
        'UTC_INSTANT_INVALID',
        'UTC instant must be created from a valid date',
      );
    }

    return new UtcInstant(value.toISOString());
  }

  equals(other: UtcInstant): boolean {
    return this.value === other.value;
  }

  isBefore(other: UtcInstant): boolean {
    return this.value < other.value;
  }
}

export type GroupStatus = 'Active' | 'Archived';
export type ParticipantStatus = 'Active' | 'Left';

export type ParticipantSnapshot = Readonly<{
  id: ParticipantId;
  subject: ActorSubject;
  joinedAt: UtcInstant;
  joinOrder: number;
  status: ParticipantStatus;
  leftAt: UtcInstant | null;
}>;

export type GroupSnapshot = Readonly<{
  id: GroupId;
  status: GroupStatus;
  ownerParticipantId: ParticipantId | null;
  participants: readonly ParticipantSnapshot[];
}>;

export type CreateGroupInput = Readonly<{
  id: GroupId;
  initialParticipantId: ParticipantId;
  creatorSubject: ActorSubject;
  createdAt: UtcInstant;
}>;

const freezeParticipant = (
  participant: ParticipantSnapshot,
): ParticipantSnapshot =>
  Object.freeze({
    id: participant.id,
    subject: participant.subject,
    joinedAt: participant.joinedAt,
    joinOrder: participant.joinOrder,
    status: participant.status,
    leftAt: participant.leftAt,
  });

export type TransferOwnershipInput = Readonly<{
  actorSubject: ActorSubject;
  targetParticipantId: ParticipantId;
}>;

export type TransferOwnershipResult = Readonly<{
  group: Group;
  result: 'Transferred' | 'NoOp';
}>;

export type LeaveGroupInput = Readonly<{
  actorSubject: ActorSubject;
  participantId: ParticipantId;
  leftAt: UtcInstant;
}>;

export type LeaveGroupResult = Readonly<{
  group: Group;
  result: 'Left';
}>;

export class Group {
  private readonly participantStates: readonly ParticipantSnapshot[];

  private constructor(
    readonly id: GroupId,
    readonly status: GroupStatus,
    readonly ownerParticipantId: ParticipantId | null,
    participants: readonly ParticipantSnapshot[],
  ) {
    this.participantStates = Object.freeze(participants.map(freezeParticipant));
  }

  static create(input: CreateGroupInput): Group {
    return Group.restore({
      id: input.id,
      status: 'Active',
      ownerParticipantId: input.initialParticipantId,
      participants: [
        {
          id: input.initialParticipantId,
          subject: input.creatorSubject,
          joinedAt: input.createdAt,
          joinOrder: 1,
          status: 'Active',
          leftAt: null,
        },
      ],
    });
  }

  static restore(snapshot: GroupSnapshot): Group {
    const activeParticipants = snapshot.participants.filter(
      ({ status }) => status === 'Active',
    );

    if (snapshot.status === 'Active') {
      if (activeParticipants.length < 1 || activeParticipants.length > 4) {
        throw new GroupInvariantViolation(
          'ACTIVE_PARTICIPANT_COUNT_OUT_OF_RANGE',
          'An active Group must have between one and four active Participants',
        );
      }

      const ownerParticipantId = snapshot.ownerParticipantId;
      if (ownerParticipantId === null) {
        throw new GroupInvariantViolation(
          'OWNER_MISSING',
          'An active Group must have one Owner',
        );
      }

      const ownerMatches = snapshot.participants.filter((participant) =>
        participant.id.equals(ownerParticipantId),
      );

      if (ownerMatches.length === 0) {
        throw new GroupInvariantViolation(
          'OWNER_MEMBERSHIP_MISMATCH',
          'The Group Owner must be a Participant of the same Group',
        );
      }

      if (ownerMatches.length > 1) {
        throw new GroupInvariantViolation(
          'OWNER_DUPLICATED',
          'An active Group must not contain duplicate Owner membership',
        );
      }

      if (ownerMatches[0]?.status !== 'Active') {
        throw new GroupInvariantViolation(
          'OWNER_NOT_ACTIVE',
          'The Group Owner must be an active Participant',
        );
      }
    }

    Group.assertParticipantInvariants(snapshot.participants);

    return new Group(
      snapshot.id,
      snapshot.status,
      snapshot.ownerParticipantId,
      snapshot.participants,
    );
  }

  get participants(): readonly ParticipantSnapshot[] {
    return this.participantStates;
  }

  get activeParticipantCount(): number {
    return this.participantStates.filter(({ status }) => status === 'Active')
      .length;
  }

  transferOwnership(input: TransferOwnershipInput): TransferOwnershipResult {
    this.assertActive();

    const ownerParticipantId = this.ownerParticipantId;
    if (ownerParticipantId === null) {
      throw new GroupInvariantViolation(
        'OWNER_MISSING',
        'An active Group must have one Owner',
      );
    }

    const owner = this.participantStates.find(({ id }) =>
      id.equals(ownerParticipantId),
    );

    if (owner === undefined || !owner.subject.equals(input.actorSubject)) {
      throw new GroupInvariantViolation(
        'NOT_CURRENT_OWNER',
        'Only the current Group Owner may transfer ownership',
      );
    }

    const target = this.participantStates.find(({ id }) =>
      id.equals(input.targetParticipantId),
    );

    if (target?.status !== 'Active') {
      throw new GroupInvariantViolation(
        'TARGET_PARTICIPANT_NOT_ACTIVE',
        'Ownership may be transferred only to an active Participant',
      );
    }

    if (target.id.equals(ownerParticipantId)) {
      return Object.freeze({ group: this, result: 'NoOp' });
    }

    return Object.freeze({
      group: new Group(this.id, this.status, target.id, this.participantStates),
      result: 'Transferred',
    });
  }

  leave(input: LeaveGroupInput): LeaveGroupResult {
    this.assertActive();

    const ownerParticipantId = this.ownerParticipantId;
    if (ownerParticipantId === null) {
      throw new GroupInvariantViolation(
        'OWNER_MISSING',
        'An active Group must have one Owner',
      );
    }

    const participant = this.participantStates.find(({ id }) =>
      id.equals(input.participantId),
    );

    if (
      participant === undefined ||
      !participant.subject.equals(input.actorSubject)
    ) {
      throw new GroupInvariantViolation(
        'ACTOR_PARTICIPANT_MISMATCH',
        'A Participant may leave only their own membership',
      );
    }

    if (participant.status === 'Left') {
      throw new GroupInvariantViolation(
        'ALREADY_LEFT',
        'The Participant has already left the Group',
      );
    }

    if (participant.id.equals(ownerParticipantId)) {
      throw new GroupInvariantViolation(
        'OWNER_MUST_TRANSFER_OR_END',
        'The Group Owner must transfer ownership before leaving',
      );
    }

    if (input.leftAt.isBefore(participant.joinedAt)) {
      throw new GroupInvariantViolation(
        'LEFT_AT_BEFORE_JOINED_AT',
        'A Participant cannot leave before joining',
      );
    }

    const participants = this.participantStates.map((current) =>
      current.id.equals(participant.id)
        ? { ...current, status: 'Left' as const, leftAt: input.leftAt }
        : current,
    );

    return Object.freeze({
      group: Group.restore({
        id: this.id,
        status: this.status,
        ownerParticipantId: this.ownerParticipantId,
        participants,
      }),
      result: 'Left',
    });
  }

  toSnapshot(): GroupSnapshot {
    return Object.freeze({
      id: this.id,
      status: this.status,
      ownerParticipantId: this.ownerParticipantId,
      participants: this.participantStates,
    });
  }

  private static assertParticipantInvariants(
    participants: readonly ParticipantSnapshot[],
  ): void {
    const participantIds = new Set<string>();
    const subjects = new Map<string, ParticipantStatus>();
    const joinOrders = new Set<number>();

    for (const participant of participants) {
      if (participantIds.has(participant.id.value)) {
        throw new GroupInvariantViolation(
          'PARTICIPANT_DUPLICATED',
          'A Participant must occur only once in a Group',
        );
      }
      participantIds.add(participant.id.value);

      const existingStatus = subjects.get(participant.subject.value);
      if (existingStatus !== undefined) {
        const bothActive =
          existingStatus === 'Active' && participant.status === 'Active';
        throw new GroupInvariantViolation(
          bothActive ? 'ACTIVE_SUBJECT_DUPLICATED' : 'REJOIN_NOT_DECIDED',
          bothActive
            ? 'The same actor must not have duplicate active membership in a Group'
            : 'Rejoining the same Group is not decided',
        );
      }
      subjects.set(participant.subject.value, participant.status);

      if (
        !Number.isSafeInteger(participant.joinOrder) ||
        participant.joinOrder < 1
      ) {
        throw new GroupInvariantViolation(
          'JOIN_ORDER_INVALID',
          'Participant join order must be a positive safe integer',
        );
      }

      if (joinOrders.has(participant.joinOrder)) {
        throw new GroupInvariantViolation(
          'JOIN_ORDER_DUPLICATED',
          'Participant join order must be unique within a Group',
        );
      }
      joinOrders.add(participant.joinOrder);

      if (participant.status === 'Active' && participant.leftAt !== null) {
        throw new GroupInvariantViolation(
          'LEFT_AT_NOT_ALLOWED',
          'An active Participant must not have a leave time',
        );
      }

      if (participant.status === 'Left') {
        if (participant.leftAt === null) {
          throw new GroupInvariantViolation(
            'LEFT_AT_REQUIRED',
            'A left Participant must have a leave time',
          );
        }

        if (participant.leftAt.isBefore(participant.joinedAt)) {
          throw new GroupInvariantViolation(
            'LEFT_AT_BEFORE_JOINED_AT',
            'A Participant cannot leave before joining',
          );
        }
      }
    }
  }

  private assertActive(): void {
    if (this.status !== 'Active') {
      throw new GroupInvariantViolation(
        'GROUP_NOT_ACTIVE',
        'The Group is not active',
      );
    }
  }
}
