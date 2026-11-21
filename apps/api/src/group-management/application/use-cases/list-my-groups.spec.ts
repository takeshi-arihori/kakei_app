import { describe, expect, it, vi } from 'vitest';

import {
  ActorSubject,
  CloseIntentId,
  Group,
  GroupId,
  ParticipantId,
  UtcInstant,
  type GroupClosePhase,
  type ParticipantSnapshot,
} from '../../domain/group.js';
import type {
  MyGroupCandidateReadResult,
  MyGroupListIntegrityAlertPort,
  MyGroupListReadPort,
} from '../my-group-list-read-port.js';
import {
  MY_GROUP_LIST_LIMIT,
  MyGroupListApplicationError,
  MyGroupQueryService,
} from './list-my-groups.js';

const me = ActorSubject.from('actor-me');
const other = ActorSubject.from('actor-other');
const third = ActorSubject.from('actor-third');

const at = (iso: string) => UtcInstant.from(new Date(iso));
const groupIdOf = (n: number) =>
  GroupId.from(`00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`);

const participant = (
  id: string,
  subject: ActorSubject,
  joinOrder: number,
  joinedAt: string,
  leftAt: string | null = null,
): ParticipantSnapshot => ({
  id: ParticipantId.from(id),
  subject,
  joinOrder,
  joinedAt: at(joinedAt),
  status: leftAt === null ? 'Active' : 'Left',
  leftAt: leftAt === null ? null : at(leftAt),
});

const activeGroup = (
  id: GroupId,
  participants: readonly ParticipantSnapshot[],
  ownerId: string,
): Group =>
  Group.restore({
    id,
    status: 'Active',
    ownerParticipantId: ParticipantId.from(ownerId),
    participants,
    invitations: [],
    accessPolicyVersion: 1,
    closing: null,
    ownerAtArchiveParticipantId: null,
    archivedAt: null,
    deleteEligibleAt: null,
  });

const closingGroup = (id: GroupId, phase: GroupClosePhase): Group =>
  Group.restore({
    id,
    status: 'Closing',
    ownerParticipantId: ParticipantId.from('p-1'),
    participants: [participant('p-1', me, 1, '2026-11-01T00:00:00.000Z')],
    invitations: [],
    accessPolicyVersion: 2,
    closing: {
      closeIntentId: CloseIntentId.from('11111111-1111-4111-8111-111111111111'),
      cutoff: at('2026-11-10T00:00:00.000Z'),
      phase,
      fenceReceipts: [],
      unfenceReceipts: [],
    },
    ownerAtArchiveParticipantId: null,
    archivedAt: null,
    deleteEligibleAt: null,
  });

const archivedAt = at('2026-11-15T00:00:00.000Z');
const archivedGroup = (id: GroupId, archiveOwnerSubject: ActorSubject) =>
  Group.restore({
    id,
    status: 'Archived',
    ownerParticipantId: null,
    participants: [
      participant('p-1', archiveOwnerSubject, 1, '2026-11-01T00:00:00.000Z'),
      participant(
        'p-2',
        archiveOwnerSubject.equals(me) ? other : me,
        2,
        '2026-11-02T00:00:00.000Z',
      ),
    ],
    invitations: [],
    accessPolicyVersion: 3,
    closing: null,
    ownerAtArchiveParticipantId: ParticipantId.from('p-1'),
    archivedAt,
    deleteEligibleAt: archivedAt.plusCalendarYearInTokyo(),
  });

const ownedBy = (id: GroupId, createdAt: string) =>
  activeGroup(id, [participant('p-1', me, 1, createdAt)], 'p-1');

const setup = (
  result:
    MyGroupCandidateReadResult | (() => Promise<MyGroupCandidateReadResult>),
) => {
  const readCandidates = vi.fn<MyGroupListReadPort['readCandidates']>(
    typeof result === 'function' ? result : () => Promise.resolve(result),
  );
  const reportDeniedIndexHit = vi.fn<
    MyGroupListIntegrityAlertPort['reportDeniedIndexHit']
  >(() => Promise.resolve());
  const service = new MyGroupQueryService(
    { readCandidates },
    { reportDeniedIndexHit },
  );
  return { service, readCandidates, reportDeniedIndexHit };
};

const read = (groups: readonly Group[]): MyGroupCandidateReadResult => ({
  kind: 'Read',
  groups,
});

const expectUnavailable = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(MyGroupListApplicationError);
  expect((error as MyGroupListApplicationError).code).toBe('UNAVAILABLE');
};

describe('MyGroupQueryService.listMyGroups', () => {
  it('asks the read port for one more candidate than the list limit for the actor', async () => {
    const { service, readCandidates } = setup(read([]));

    await service.listMyGroups({ actorSubject: me });

    expect(MY_GROUP_LIST_LIMIT).toBe(50);
    expect(readCandidates).toHaveBeenCalledTimes(1);
    expect(readCandidates.mock.calls[0]?.[0].actorSubject).toBe(me);
    expect(readCandidates.mock.calls[0]?.[0].limit).toBe(51);
  });

  it('returns an empty list without error when the actor has no Group', async () => {
    const { service, reportDeniedIndexHit } = setup(read([]));

    await expect(service.listMyGroups({ actorSubject: me })).resolves.toEqual({
      items: [],
      hasMore: false,
    });
    expect(reportDeniedIndexHit).not.toHaveBeenCalled();
  });

  it('summarizes an active Group owned by the actor without names, ids of Participants, or invitations', async () => {
    const id = groupIdOf(1);
    const { service } = setup(read([ownedBy(id, '2026-11-01T00:00:00.000Z')]));

    const list = await service.listMyGroups({ actorSubject: me });

    expect(list.hasMore).toBe(false);
    expect(list.items).toHaveLength(1);
    const [summary] = list.items;
    expect(Object.keys(summary ?? {}).sort()).toEqual([
      'activeParticipantCount',
      'createdAt',
      'deleteEligibleAt',
      'groupId',
      'joinedAt',
      'lifecycle',
      'myRole',
    ]);
    expect(summary?.groupId.equals(id)).toBe(true);
    expect(summary?.lifecycle).toBe('Active');
    expect(summary?.myRole).toBe('Owner');
    expect(summary?.activeParticipantCount).toBe(1);
    expect(summary?.createdAt.value).toBe('2026-11-01T00:00:00.000Z');
    expect(summary?.joinedAt.value).toBe('2026-11-01T00:00:00.000Z');
    expect(summary?.deleteEligibleAt).toBeNull();
  });

  it('maps a non-owner Participant with the creation time of join order 1 and its own join time', async () => {
    const group = activeGroup(
      groupIdOf(2),
      [
        participant('p-1', other, 1, '2026-11-01T00:00:00.000Z'),
        participant('p-2', me, 2, '2026-11-03T00:00:00.000Z'),
        participant('p-3', third, 3, '2026-11-04T00:00:00.000Z'),
      ],
      'p-1',
    );
    const { service } = setup(read([group]));

    const [summary] = (await service.listMyGroups({ actorSubject: me })).items;

    expect(summary?.myRole).toBe('Participant');
    expect(summary?.activeParticipantCount).toBe(3);
    expect(summary?.createdAt.value).toBe('2026-11-01T00:00:00.000Z');
    expect(summary?.joinedAt.value).toBe('2026-11-03T00:00:00.000Z');
  });

  it('treats the actor as Owner after an ownership transfer even when join order 1 belongs to someone who left', async () => {
    const group = activeGroup(
      groupIdOf(3),
      [
        participant(
          'p-1',
          other,
          1,
          '2026-11-01T00:00:00.000Z',
          '2026-11-05T00:00:00.000Z',
        ),
        participant('p-2', me, 2, '2026-11-02T00:00:00.000Z'),
      ],
      'p-2',
    );
    const { service } = setup(read([group]));

    const [summary] = (await service.listMyGroups({ actorSubject: me })).items;

    expect(summary?.myRole).toBe('Owner');
    expect(summary?.activeParticipantCount).toBe(1);
    expect(summary?.createdAt.value).toBe('2026-11-01T00:00:00.000Z');
    expect(summary?.joinedAt.value).toBe('2026-11-02T00:00:00.000Z');
  });

  it.each([
    ['Fencing', 'Closing'],
    ['Canceling', 'Canceling'],
  ] as const)(
    'maps a closing Group in phase %s to lifecycle %s',
    async (phase, lifecycle) => {
      const { service } = setup(read([closingGroup(groupIdOf(4), phase)]));

      const [summary] = (await service.listMyGroups({ actorSubject: me }))
        .items;

      expect(summary?.lifecycle).toBe(lifecycle);
      expect(summary?.myRole).toBe('Owner');
      expect(summary?.deleteEligibleAt).toBeNull();
    },
  );

  it('shows an archived Group only to the owner at archive with its delete eligibility', async () => {
    const id = groupIdOf(5);
    const { service } = setup(read([archivedGroup(id, me)]));

    const [summary] = (await service.listMyGroups({ actorSubject: me })).items;

    expect(summary?.lifecycle).toBe('Archived');
    expect(summary?.myRole).toBe('Owner');
    expect(summary?.joinedAt.value).toBe('2026-11-01T00:00:00.000Z');
    expect(
      summary?.deleteEligibleAt?.equals(archivedAt.plusCalendarYearInTokyo()),
    ).toBe(true);
  });

  it('uses the new active Participant for a rejoined actor and ignores the left one', async () => {
    const group = activeGroup(
      groupIdOf(6),
      [
        participant('p-1', other, 1, '2026-11-01T00:00:00.000Z'),
        participant(
          'p-2',
          me,
          2,
          '2026-11-02T00:00:00.000Z',
          '2026-11-03T00:00:00.000Z',
        ),
        participant('p-3', me, 3, '2026-11-06T00:00:00.000Z'),
      ],
      'p-1',
    );
    const { service } = setup(read([group]));

    const [summary] = (await service.listMyGroups({ actorSubject: me })).items;

    expect(summary?.myRole).toBe('Participant');
    expect(summary?.joinedAt.value).toBe('2026-11-06T00:00:00.000Z');
  });

  it.each([
    [
      'the actor only left the Group',
      () =>
        activeGroup(
          groupIdOf(7),
          [
            participant('p-1', other, 1, '2026-11-01T00:00:00.000Z'),
            participant(
              'p-2',
              me,
              2,
              '2026-11-02T00:00:00.000Z',
              '2026-11-03T00:00:00.000Z',
            ),
          ],
          'p-1',
        ),
    ],
    [
      'the actor was never a Participant',
      () =>
        activeGroup(
          groupIdOf(7),
          [participant('p-1', other, 1, '2026-11-01T00:00:00.000Z')],
          'p-1',
        ),
    ],
    [
      'the archived Group belongs to another owner at archive',
      () => archivedGroup(groupIdOf(7), other),
    ],
  ])(
    'excludes a candidate and reports only its Group ID when %s',
    async (_case, build) => {
      const allowed = ownedBy(groupIdOf(8), '2026-11-01T00:00:00.000Z');
      const { service, reportDeniedIndexHit } = setup(read([build(), allowed]));

      const list = await service.listMyGroups({ actorSubject: me });

      expect(list.items.map(({ groupId }) => groupId.value)).toEqual([
        groupIdOf(8).value,
      ]);
      expect(list.hasMore).toBe(false);
      expect(reportDeniedIndexHit).toHaveBeenCalledTimes(1);
      const [alert] = reportDeniedIndexHit.mock.calls[0] ?? [];
      expect(Object.keys(alert ?? {})).toEqual(['groupId']);
      expect(alert?.groupId.equals(groupIdOf(7))).toBe(true);
    },
  );

  it('orders by creation time descending and breaks ties by Group ID ascending', async () => {
    const { service } = setup(
      read([
        ownedBy(groupIdOf(1), '2026-11-01T00:00:00.000Z'),
        ownedBy(groupIdOf(3), '2026-11-03T00:00:00.000Z'),
        ownedBy(groupIdOf(5), '2026-11-02T00:00:00.000Z'),
        ownedBy(groupIdOf(2), '2026-11-03T00:00:00.000Z'),
      ]),
    );

    const list = await service.listMyGroups({ actorSubject: me });

    expect(list.items.map(({ groupId }) => groupId.value)).toEqual([
      groupIdOf(2).value,
      groupIdOf(3).value,
      groupIdOf(5).value,
      groupIdOf(1).value,
    ]);
  });

  const many = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      ownedBy(
        groupIdOf(index + 1),
        new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
      ),
    );

  it('returns exactly 50 Groups without more when only 50 candidates exist', async () => {
    const { service } = setup(read(many(50)));

    const list = await service.listMyGroups({ actorSubject: me });

    expect(list.items).toHaveLength(50);
    expect(list.hasMore).toBe(false);
  });

  it('returns the newest 50 Groups and reports more when a 51st candidate exists', async () => {
    const { service } = setup(read(many(51)));

    const list = await service.listMyGroups({ actorSubject: me });

    expect(list.items).toHaveLength(50);
    expect(list.hasMore).toBe(true);
    expect(list.items[0]?.groupId.equals(groupIdOf(51))).toBe(true);
    expect(list.items.some(({ groupId }) => groupId.equals(groupIdOf(1)))).toBe(
      false,
    );
  });

  it('still reports more when one of 51 candidates is denied', async () => {
    const denied = activeGroup(
      groupIdOf(99),
      [participant('p-1', other, 1, '2026-12-01T00:00:00.000Z')],
      'p-1',
    );
    const { service, reportDeniedIndexHit } = setup(
      read([...many(50), denied]),
    );

    const list = await service.listMyGroups({ actorSubject: me });

    expect(list.items).toHaveLength(50);
    expect(list.hasMore).toBe(true);
    expect(reportDeniedIndexHit).toHaveBeenCalledTimes(1);
  });

  it('fails the whole list when the read port is unavailable', async () => {
    const { service } = setup({ kind: 'Unavailable' });

    await expectUnavailable(service.listMyGroups({ actorSubject: me }));
  });

  it('fails the whole list when the read port throws', async () => {
    const { service } = setup(() => Promise.reject(new Error('lock timeout')));

    await expectUnavailable(service.listMyGroups({ actorSubject: me }));
  });

  it('fails the whole list when the read port returns more candidates than requested', async () => {
    const { service } = setup(read(many(52)));

    await expectUnavailable(service.listMyGroups({ actorSubject: me }));
  });

  it('fails the whole list when the read port returns the same Group twice', async () => {
    const group = ownedBy(groupIdOf(1), '2026-11-01T00:00:00.000Z');
    const { service } = setup(read([group, group]));

    await expectUnavailable(service.listMyGroups({ actorSubject: me }));
  });

  it('fails the whole list instead of omitting a Group whose creation time cannot be derived', async () => {
    const withoutFirstJoin = activeGroup(
      groupIdOf(1),
      [participant('p-2', me, 2, '2026-11-02T00:00:00.000Z')],
      'p-2',
    );
    const { service } = setup(
      read([
        withoutFirstJoin,
        ownedBy(groupIdOf(2), '2026-11-01T00:00:00.000Z'),
      ]),
    );

    await expectUnavailable(service.listMyGroups({ actorSubject: me }));
  });

  it('fails the whole list when reporting a denied candidate fails', async () => {
    const denied = activeGroup(
      groupIdOf(1),
      [participant('p-1', other, 1, '2026-11-01T00:00:00.000Z')],
      'p-1',
    );
    const { service, reportDeniedIndexHit } = setup(read([denied]));
    reportDeniedIndexHit.mockRejectedValueOnce(new Error('sink down'));

    await expectUnavailable(service.listMyGroups({ actorSubject: me }));
  });
});
