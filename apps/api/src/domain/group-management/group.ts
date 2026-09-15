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
  | 'ALREADY_LEFT'
  | 'GROUP_CAPACITY_REACHED'
  | 'INVITATION_DUPLICATED'
  | 'INVITATION_NOT_FOUND'
  | 'INVITATION_NOT_PENDING'
  | 'INVITATION_EXPIRED'
  | 'INVITATION_TARGET_MISMATCH'
  | 'INVITATION_EXPIRY_INVALID'
  | 'INVITATION_RESULT_INVALID'
  | 'INVITATION_ISSUER_NOT_FOUND'
  | 'INVITATION_ACTION_BEFORE_CREATED';

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

export class InvitationId {
  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  static from(value: string): InvitationId {
    return new InvitationId(requireNonEmpty(value));
  }

  equals(other: InvitationId): boolean {
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
  private constructor(
    readonly value: string,
    private readonly epochMilliseconds: number,
  ) {
    Object.freeze(this);
  }

  static from(value: Date): UtcInstant {
    if (Number.isNaN(value.getTime())) {
      throw new GroupInvariantViolation(
        'UTC_INSTANT_INVALID',
        'UTC instant must be created from a valid date',
      );
    }

    return new UtcInstant(value.toISOString(), value.getTime());
  }

  equals(other: UtcInstant): boolean {
    return this.value === other.value;
  }

  isBefore(other: UtcInstant): boolean {
    return this.epochMilliseconds < other.epochMilliseconds;
  }

  isAtOrAfter(other: UtcInstant): boolean {
    return this.epochMilliseconds >= other.epochMilliseconds;
  }

  plusDays(days: number): UtcInstant {
    if (!Number.isSafeInteger(days) || days < 0) {
      throw new GroupInvariantViolation(
        'UTC_INSTANT_INVALID',
        'UTC instant days must be a non-negative safe integer',
      );
    }

    return UtcInstant.from(
      new Date(this.epochMilliseconds + days * 24 * 60 * 60 * 1_000),
    );
  }
}

export type GroupStatus = 'Active' | 'Archived';
export type ParticipantStatus = 'Active' | 'Left';
export type InvitationStatus = 'Pending' | 'Consumed' | 'Cancelled' | 'Expired';

export type ParticipantSnapshot = Readonly<{
  id: ParticipantId;
  subject: ActorSubject;
  joinedAt: UtcInstant;
  joinOrder: number;
  status: ParticipantStatus;
  leftAt: UtcInstant | null;
}>;

export type InvitationSnapshot = Readonly<{
  id: InvitationId;
  targetSubject: ActorSubject;
  issuerParticipantId: ParticipantId;
  createdAt: UtcInstant;
  expiryAt: UtcInstant;
  status: InvitationStatus;
  resultingParticipantId: ParticipantId | null;
}>;

export type GroupSnapshot = Readonly<{
  id: GroupId;
  status: GroupStatus;
  ownerParticipantId: ParticipantId | null;
  participants: readonly ParticipantSnapshot[];
  invitations: readonly InvitationSnapshot[];
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

const freezeInvitation = (invitation: InvitationSnapshot): InvitationSnapshot =>
  Object.freeze({
    id: invitation.id,
    targetSubject: invitation.targetSubject,
    issuerParticipantId: invitation.issuerParticipantId,
    createdAt: invitation.createdAt,
    expiryAt: invitation.expiryAt,
    status: invitation.status,
    resultingParticipantId: invitation.resultingParticipantId,
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

export type InviteParticipantInput = Readonly<{
  actorSubject: ActorSubject;
  invitationId: InvitationId;
  targetSubject: ActorSubject;
  createdAt: UtcInstant;
}>;

export type InviteParticipantResult = Readonly<{
  group: Group;
  invitation: InvitationSnapshot;
}>;

export type CancelInvitationInput = Readonly<{
  actorSubject: ActorSubject;
  invitationId: InvitationId;
  cancelledAt: UtcInstant;
}>;

export type CancelInvitationResult = Readonly<{
  group: Group;
  invitation: InvitationSnapshot;
}>;

export type AcceptInvitationInput = Readonly<{
  actorSubject: ActorSubject;
  invitationId: InvitationId;
  participantId: ParticipantId;
  acceptedAt: UtcInstant;
}>;

export type AcceptInvitationResult = Readonly<{
  group: Group;
  invitation: InvitationSnapshot;
  participant: ParticipantSnapshot;
}>;

export class Group {
  private readonly participantStates: readonly ParticipantSnapshot[];
  private readonly invitationStates: readonly InvitationSnapshot[];

  private constructor(
    readonly id: GroupId,
    readonly status: GroupStatus,
    readonly ownerParticipantId: ParticipantId | null,
    participants: readonly ParticipantSnapshot[],
    invitations: readonly InvitationSnapshot[],
  ) {
    this.participantStates = Object.freeze(participants.map(freezeParticipant));
    this.invitationStates = Object.freeze(invitations.map(freezeInvitation));
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
      invitations: [],
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
    Group.assertInvitationInvariants(
      snapshot.invitations,
      snapshot.participants,
    );

    return new Group(
      snapshot.id,
      snapshot.status,
      snapshot.ownerParticipantId,
      snapshot.participants,
      snapshot.invitations,
    );
  }

  get participants(): readonly ParticipantSnapshot[] {
    return this.participantStates;
  }

  get activeParticipantCount(): number {
    return this.participantStates.filter(({ status }) => status === 'Active')
      .length;
  }

  get invitations(): readonly InvitationSnapshot[] {
    return this.invitationStates;
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
      group: new Group(
        this.id,
        this.status,
        target.id,
        this.participantStates,
        this.invitationStates,
      ),
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
        invitations: this.invitationStates,
      }),
      result: 'Left',
    });
  }

  inviteParticipant(input: InviteParticipantInput): InviteParticipantResult {
    this.assertActive();
    const owner = this.currentOwnerFor(input.actorSubject);

    if (this.activeParticipantCount >= 4) {
      throw new GroupInvariantViolation(
        'GROUP_CAPACITY_REACHED',
        'An Invitation cannot be created when the Group has four active Participants',
      );
    }

    if (
      this.participantStates.some(
        ({ subject, status }) =>
          status === 'Active' && subject.equals(input.targetSubject),
      )
    ) {
      throw new GroupInvariantViolation(
        'ACTIVE_SUBJECT_DUPLICATED',
        'An active Participant cannot be invited to the same Group',
      );
    }

    if (this.findInvitation(input.invitationId) !== undefined) {
      throw new GroupInvariantViolation(
        'INVITATION_DUPLICATED',
        'An Invitation ID must be unique within a Group',
      );
    }

    const invitation: InvitationSnapshot = freezeInvitation({
      id: input.invitationId,
      targetSubject: input.targetSubject,
      issuerParticipantId: owner.id,
      createdAt: input.createdAt,
      expiryAt: input.createdAt.plusDays(7),
      status: 'Pending',
      resultingParticipantId: null,
    });
    const group = Group.restore({
      ...this.toSnapshot(),
      invitations: [...this.invitationStates, invitation],
    });

    return Object.freeze({ group, invitation });
  }

  cancelInvitation(input: CancelInvitationInput): CancelInvitationResult {
    this.assertActive();
    this.currentOwnerFor(input.actorSubject);
    const invitation = this.requireInvitation(input.invitationId);
    this.assertInvitationActionTime(invitation, input.cancelledAt);

    if (input.cancelledAt.isAtOrAfter(invitation.expiryAt)) {
      throw new GroupInvariantViolation(
        'INVITATION_EXPIRED',
        'An Invitation cannot be cancelled at or after its expiry time',
      );
    }

    this.assertInvitationPending(invitation);
    const cancelled = freezeInvitation({
      ...invitation,
      status: 'Cancelled',
    });
    const group = Group.restore({
      ...this.toSnapshot(),
      invitations: this.invitationStates.map((current) =>
        current.id.equals(cancelled.id) ? cancelled : current,
      ),
    });

    return Object.freeze({ group, invitation: cancelled });
  }

  acceptInvitation(input: AcceptInvitationInput): AcceptInvitationResult {
    this.assertActive();
    const invitation = this.requireInvitation(input.invitationId);
    this.assertInvitationActionTime(invitation, input.acceptedAt);

    if (!invitation.targetSubject.equals(input.actorSubject)) {
      throw new GroupInvariantViolation(
        'INVITATION_TARGET_MISMATCH',
        'Only the actor targeted by an Invitation may accept it',
      );
    }

    if (input.acceptedAt.isAtOrAfter(invitation.expiryAt)) {
      throw new GroupInvariantViolation(
        'INVITATION_EXPIRED',
        'An Invitation cannot be accepted at or after its expiry time',
      );
    }

    this.assertInvitationPending(invitation);

    if (this.activeParticipantCount >= 4) {
      throw new GroupInvariantViolation(
        'GROUP_CAPACITY_REACHED',
        'An Invitation cannot be accepted when the Group has four active Participants',
      );
    }

    if (
      this.participantStates.some(
        ({ subject, status }) =>
          status === 'Active' && subject.equals(input.actorSubject),
      )
    ) {
      throw new GroupInvariantViolation(
        'ACTIVE_SUBJECT_DUPLICATED',
        'The invited actor already has an active membership in the Group',
      );
    }

    if (
      this.participantStates.some(({ id }) => id.equals(input.participantId))
    ) {
      throw new GroupInvariantViolation(
        'PARTICIPANT_DUPLICATED',
        'A new membership must use a new Participant ID',
      );
    }

    const previousJoinOrder = this.participantStates.reduce(
      (maximum, participant) => Math.max(maximum, participant.joinOrder),
      0,
    );
    const joinOrder = previousJoinOrder + 1;
    if (!Number.isSafeInteger(joinOrder)) {
      throw new GroupInvariantViolation(
        'JOIN_ORDER_INVALID',
        'Participant join order must remain a safe integer',
      );
    }

    const participant = freezeParticipant({
      id: input.participantId,
      subject: input.actorSubject,
      joinedAt: input.acceptedAt,
      joinOrder,
      status: 'Active',
      leftAt: null,
    });
    const consumed = freezeInvitation({
      ...invitation,
      status: 'Consumed',
      resultingParticipantId: participant.id,
    });
    const group = Group.restore({
      ...this.toSnapshot(),
      participants: [...this.participantStates, participant],
      invitations: this.invitationStates.map((current) =>
        current.id.equals(consumed.id) ? consumed : current,
      ),
    });

    return Object.freeze({ group, invitation: consumed, participant });
  }

  toSnapshot(): GroupSnapshot {
    return Object.freeze({
      id: this.id,
      status: this.status,
      ownerParticipantId: this.ownerParticipantId,
      participants: this.participantStates,
      invitations: this.invitationStates,
    });
  }

  private static assertParticipantInvariants(
    participants: readonly ParticipantSnapshot[],
  ): void {
    const participantIds = new Set<string>();
    const activeSubjects = new Set<string>();
    const joinOrders = new Set<number>();

    for (const participant of participants) {
      if (participantIds.has(participant.id.value)) {
        throw new GroupInvariantViolation(
          'PARTICIPANT_DUPLICATED',
          'A Participant must occur only once in a Group',
        );
      }
      participantIds.add(participant.id.value);

      if (
        participant.status === 'Active' &&
        activeSubjects.has(participant.subject.value)
      ) {
        throw new GroupInvariantViolation(
          'ACTIVE_SUBJECT_DUPLICATED',
          'The same actor must not have duplicate active membership in a Group',
        );
      }
      if (participant.status === 'Active') {
        activeSubjects.add(participant.subject.value);
      }

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

  private static assertInvitationInvariants(
    invitations: readonly InvitationSnapshot[],
    participants: readonly ParticipantSnapshot[],
  ): void {
    const invitationIds = new Set<string>();

    for (const invitation of invitations) {
      if (invitationIds.has(invitation.id.value)) {
        throw new GroupInvariantViolation(
          'INVITATION_DUPLICATED',
          'An Invitation ID must be unique within a Group',
        );
      }
      invitationIds.add(invitation.id.value);

      if (!invitation.expiryAt.equals(invitation.createdAt.plusDays(7))) {
        throw new GroupInvariantViolation(
          'INVITATION_EXPIRY_INVALID',
          'An Invitation expiry time must be exactly seven days after creation',
        );
      }

      const issuer = participants.find(({ id }) =>
        id.equals(invitation.issuerParticipantId),
      );
      const issuerWasActiveAtCreation =
        issuer !== undefined &&
        !invitation.createdAt.isBefore(issuer.joinedAt) &&
        (issuer.leftAt === null ||
          invitation.createdAt.isBefore(issuer.leftAt));
      if (!issuerWasActiveAtCreation) {
        throw new GroupInvariantViolation(
          'INVITATION_ISSUER_NOT_FOUND',
          'An Invitation issuer must be active in the Group at creation time',
        );
      }

      const hasResult = invitation.resultingParticipantId !== null;
      if ((invitation.status === 'Consumed') !== hasResult) {
        throw new GroupInvariantViolation(
          'INVITATION_RESULT_INVALID',
          'Only a consumed Invitation must identify its resulting Participant',
        );
      }

      const resultingParticipantId = invitation.resultingParticipantId;
      if (resultingParticipantId !== null) {
        const resultParticipant = participants.find(({ id }) =>
          id.equals(resultingParticipantId),
        );
        const resultMatchesInvitation =
          resultParticipant !== undefined &&
          resultParticipant.subject.equals(invitation.targetSubject) &&
          !resultParticipant.joinedAt.isBefore(invitation.createdAt) &&
          resultParticipant.joinedAt.isBefore(invitation.expiryAt);
        if (!resultMatchesInvitation) {
          throw new GroupInvariantViolation(
            'INVITATION_RESULT_INVALID',
            'A consumed Invitation must identify its target Participant joined during its validity',
          );
        }
      }
    }
  }

  private currentOwnerFor(actorSubject: ActorSubject): ParticipantSnapshot {
    const ownerParticipantId = this.ownerParticipantId;
    const owner =
      ownerParticipantId === null
        ? undefined
        : this.participantStates.find(({ id }) =>
            id.equals(ownerParticipantId),
          );

    if (owner === undefined) {
      throw new GroupInvariantViolation(
        'OWNER_MISSING',
        'An active Group must have one Owner',
      );
    }

    if (!owner.subject.equals(actorSubject)) {
      throw new GroupInvariantViolation(
        'NOT_CURRENT_OWNER',
        'Only the current Group Owner may perform this action',
      );
    }

    return owner;
  }

  private findInvitation(
    invitationId: InvitationId,
  ): InvitationSnapshot | undefined {
    return this.invitationStates.find(({ id }) => id.equals(invitationId));
  }

  private requireInvitation(invitationId: InvitationId): InvitationSnapshot {
    const invitation = this.findInvitation(invitationId);
    if (invitation === undefined) {
      throw new GroupInvariantViolation(
        'INVITATION_NOT_FOUND',
        'The Invitation was not found in this Group',
      );
    }

    return invitation;
  }

  private assertInvitationPending(invitation: InvitationSnapshot): void {
    if (invitation.status !== 'Pending') {
      throw new GroupInvariantViolation(
        'INVITATION_NOT_PENDING',
        'Only a pending Invitation may be changed',
      );
    }
  }

  private assertInvitationActionTime(
    invitation: InvitationSnapshot,
    actionAt: UtcInstant,
  ): void {
    if (actionAt.isBefore(invitation.createdAt)) {
      throw new GroupInvariantViolation(
        'INVITATION_ACTION_BEFORE_CREATED',
        'An Invitation cannot be changed before its creation time',
      );
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
