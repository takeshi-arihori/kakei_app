export type GroupInvariantViolationCode =
  | 'IDENTIFIER_EMPTY'
  | 'UTC_INSTANT_INVALID'
  | 'OWNER_MISSING'
  | 'OWNER_DUPLICATED'
  | 'OWNER_MEMBERSHIP_MISMATCH'
  | 'ACTIVE_PARTICIPANT_COUNT_OUT_OF_RANGE'
  | 'PARTICIPANT_DUPLICATED'
  | 'ACTIVE_SUBJECT_DUPLICATED'
  | 'JOIN_ORDER_INVALID'
  | 'JOIN_ORDER_DUPLICATED';

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
}

export type ParticipantSnapshot = Readonly<{
  id: ParticipantId;
  subject: ActorSubject;
  joinedAt: UtcInstant;
  joinOrder: number;
}>;

export type GroupSnapshot = Readonly<{
  id: GroupId;
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
  });

export class Group {
  private readonly participantStates: readonly ParticipantSnapshot[];

  private constructor(
    readonly id: GroupId,
    readonly ownerParticipantId: ParticipantId,
    participants: readonly ParticipantSnapshot[],
  ) {
    this.participantStates = Object.freeze(participants.map(freezeParticipant));
  }

  static create(input: CreateGroupInput): Group {
    return Group.restore({
      id: input.id,
      ownerParticipantId: input.initialParticipantId,
      participants: [
        {
          id: input.initialParticipantId,
          subject: input.creatorSubject,
          joinedAt: input.createdAt,
          joinOrder: 1,
        },
      ],
    });
  }

  static restore(snapshot: GroupSnapshot): Group {
    const participantCount = snapshot.participants.length;

    if (participantCount < 1 || participantCount > 4) {
      throw new GroupInvariantViolation(
        'ACTIVE_PARTICIPANT_COUNT_OUT_OF_RANGE',
        'An active Group must have between one and four Participants',
      );
    }

    if (snapshot.ownerParticipantId === null) {
      throw new GroupInvariantViolation(
        'OWNER_MISSING',
        'An active Group must have one Owner',
      );
    }

    const ownerParticipantId = snapshot.ownerParticipantId;
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

    Group.assertParticipantInvariants(snapshot.participants);

    return new Group(snapshot.id, ownerParticipantId, snapshot.participants);
  }

  get participants(): readonly ParticipantSnapshot[] {
    return this.participantStates;
  }

  get activeParticipantCount(): number {
    return this.participantStates.length;
  }

  toSnapshot(): GroupSnapshot {
    return Object.freeze({
      id: this.id,
      ownerParticipantId: this.ownerParticipantId,
      participants: this.participantStates,
    });
  }

  private static assertParticipantInvariants(
    participants: readonly ParticipantSnapshot[],
  ): void {
    const participantIds = new Set<string>();
    const subjects = new Set<string>();
    const joinOrders = new Set<number>();

    for (const participant of participants) {
      if (participantIds.has(participant.id.value)) {
        throw new GroupInvariantViolation(
          'PARTICIPANT_DUPLICATED',
          'A Participant must occur only once in a Group',
        );
      }
      participantIds.add(participant.id.value);

      if (subjects.has(participant.subject.value)) {
        throw new GroupInvariantViolation(
          'ACTIVE_SUBJECT_DUPLICATED',
          'The same actor must not have duplicate active membership in a Group',
        );
      }
      subjects.add(participant.subject.value);

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
    }
  }
}
