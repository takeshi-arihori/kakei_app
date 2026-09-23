import type { ProtectedRecordCodec } from '@kakei/protected-record';
import type { Client, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  Group,
  GroupId,
  ParticipantId,
  ActorSubject,
  UtcInstant,
} from '../../domain/group.js';
import {
  CommandFingerprint,
  OperationId,
  type CommitGroupRequest,
} from '../../application/group-repository.js';
import { PostgresGroupStateWriter } from './group-state-writer.js';

const createRequest = (
  stateChanged: boolean,
  expectedVersion: number | 'Absent' = 3,
): CommitGroupRequest => {
  const groupId = GroupId.from('0194a8aa-3d44-7cc1-8ea0-2c76e48131aa');
  const actor = ActorSubject.from('actor:writer-test');
  const participantId = ParticipantId.from(
    '0194a8aa-3d44-7cc1-8ea0-2c76e48131ab',
  );
  const now = UtcInstant.from(new Date('2026-09-23T02:00:00.000Z'));
  const group = Group.create({
    id: groupId,
    creatorSubject: actor,
    initialParticipantId: participantId,
    createdAt: now,
  });
  return {
    group,
    expectedVersion,
    stateChanged,
    membershipChanges: [],
    invitationChanges: [],
    groupCloseChanges: [],
    operation: {
      actorSubject: actor,
      operationId: OperationId.from('operation:writer-test'),
      fingerprint: CommandFingerprint.from('fingerprint:writer-test'),
    },
    result: {
      kind: 'OwnershipTransferNoOp',
      groupId,
      ownerParticipantId: participantId,
    },
  };
};

const databaseFor = (
  implementation: (
    sql: string,
    values?: readonly unknown[],
  ) => Promise<QueryResult<QueryResultRow>>,
): Pick<Client, 'query'> =>
  ({ query: vi.fn(implementation) }) as unknown as Pick<Client, 'query'>;

const queryResult = (rows: QueryResultRow[]): QueryResult<QueryResultRow> => ({
  command: 'SELECT',
  rowCount: rows.length,
  oid: 0,
  fields: [],
  rows,
});

describe('PostgresGroupStateWriter', () => {
  it('checks a no-op commit under a row lock without rewriting protected state', async () => {
    const database = databaseFor((sql) => {
      expect(sql).toContain('FOR UPDATE');
      return Promise.resolve(queryResult([{ aggregate_version: '3' }]));
    });
    const codec = { seal: vi.fn() } as unknown as Pick<
      ProtectedRecordCodec,
      'seal'
    >;
    const writer = new PostgresGroupStateWriter({
      codec,
      accessIndexDigests: { digest: vi.fn() },
      now: () => new Date('2026-09-23T02:00:00.000Z'),
      nextRecordId: () => '0194a8aa-3d44-7cc1-8ea0-2c76e48131ac',
    });

    await expect(
      writer.persist(database, createRequest(false)),
    ).resolves.toEqual({
      kind: 'Committed',
      version: 3,
    });
    expect(database.query).toHaveBeenCalledTimes(1);
    expect(codec.seal).not.toHaveBeenCalled();
  });

  it('returns conflict before sealing when the locked version is stale', async () => {
    const database = databaseFor(() =>
      Promise.resolve(queryResult([{ aggregate_version: '4' }])),
    );
    const codec = { seal: vi.fn() } as unknown as Pick<
      ProtectedRecordCodec,
      'seal'
    >;
    const writer = new PostgresGroupStateWriter({
      codec,
      accessIndexDigests: { digest: vi.fn() },
      now: () => new Date('2026-09-23T02:00:00.000Z'),
      nextRecordId: () => '0194a8aa-3d44-7cc1-8ea0-2c76e48131ad',
    });

    await expect(
      writer.persist(database, createRequest(true)),
    ).resolves.toEqual({
      kind: 'Conflict',
    });
    expect(database.query).toHaveBeenCalledTimes(1);
    expect(codec.seal).not.toHaveBeenCalled();
  });

  it('rejects no-op requests that contain history mutations', async () => {
    const database = databaseFor(() => Promise.resolve(queryResult([])));
    const writer = new PostgresGroupStateWriter({
      codec: { seal: vi.fn() },
      accessIndexDigests: { digest: vi.fn() },
      now: () => new Date('2026-09-23T02:00:00.000Z'),
      nextRecordId: () => '0194a8aa-3d44-7cc1-8ea0-2c76e48131ae',
    });
    const request = createRequest(false);
    const participant = request.group.participants.at(0);
    if (participant === undefined) {
      throw new Error('Expected the test Group to have one Participant');
    }
    const invalid = {
      ...request,
      membershipChanges: [
        {
          kind: 'Joined' as const,
          participantId: participant.id,
          at: UtcInstant.from(new Date('2026-09-23T02:00:00.000Z')),
        },
      ],
    };

    await expect(writer.persist(database, invalid)).resolves.toEqual({
      kind: 'Unavailable',
    });
    expect(database.query).not.toHaveBeenCalled();
  });
});
