import { GroupInvariantViolation } from './group-invariant-violation';

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
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        value,
      )
    ) {
      throw new GroupInvariantViolation(
        'GROUP_ID_INVALID',
        'Group ID must be a lowercase canonical UUID',
      );
    }
    return new GroupId(value);
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

export class CloseIntentId {
  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  static from(value: string): CloseIntentId {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        value,
      )
    ) {
      throw new GroupInvariantViolation(
        'CLOSE_INTENT_ID_INVALID',
        'CloseIntentId must be a lowercase canonical UUIDv4',
      );
    }
    return new CloseIntentId(value);
  }

  equals(other: CloseIntentId): boolean {
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

  plusCalendarYearInTokyo(): UtcInstant {
    const tokyoOffsetMilliseconds = 9 * 60 * 60 * 1_000;
    const local = new Date(this.epochMilliseconds + tokyoOffsetMilliseconds);
    const targetYear = local.getUTCFullYear() + 1;
    const month = local.getUTCMonth();
    const lastDayOfTargetMonth = new Date(
      Date.UTC(targetYear, month + 1, 0),
    ).getUTCDate();
    const day = Math.min(local.getUTCDate(), lastDayOfTargetMonth);
    const targetLocalMilliseconds = Date.UTC(
      targetYear,
      month,
      day,
      local.getUTCHours(),
      local.getUTCMinutes(),
      local.getUTCSeconds(),
      local.getUTCMilliseconds(),
    );

    return UtcInstant.from(
      new Date(targetLocalMilliseconds - tokyoOffsetMilliseconds),
    );
  }
}
