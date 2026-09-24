import { describe, expect, it } from 'vitest';

import {
  ActorSubject as PublicActorSubject,
  CloseIntentId as PublicCloseIntentId,
  GroupId as PublicGroupId,
  GroupInvariantViolation as PublicGroupInvariantViolation,
  InvitationId as PublicInvitationId,
  ParticipantId as PublicParticipantId,
  UtcInstant as PublicUtcInstant,
} from './group.js';
import { GroupInvariantViolation } from './group-invariant-violation.js';
import {
  ActorSubject,
  CloseIntentId,
  GroupId,
  InvitationId,
  ParticipantId,
  UtcInstant,
} from './group-value-objects.js';

describe('Group domain primitives public contract', () => {
  it('group.tsから既存と同じValue Object / Invariant Errorを公開する', () => {
    expect(PublicGroupInvariantViolation).toBe(GroupInvariantViolation);
    expect(PublicGroupId).toBe(GroupId);
    expect(PublicParticipantId).toBe(ParticipantId);
    expect(PublicInvitationId).toBe(InvitationId);
    expect(PublicCloseIntentId).toBe(CloseIntentId);
    expect(PublicActorSubject).toBe(ActorSubject);
    expect(PublicUtcInstant).toBe(UtcInstant);
  });

  it('分離後もValue Objectのvalidation contractを維持する', () => {
    expect(() => ParticipantId.from('   ')).toThrowError(
      expect.objectContaining({ code: 'IDENTIFIER_EMPTY' }),
    );
    expect(() =>
      GroupId.from('00000000-0000-4000-8000-000000000001'),
    ).not.toThrow();
    expect(() =>
      CloseIntentId.from('00000000-0000-4000-8000-000000000001'),
    ).not.toThrow();
    expect(UtcInstant.from(new Date('2026-09-25T00:00:00.000Z')).value).toBe(
      '2026-09-25T00:00:00.000Z',
    );
  });
});
