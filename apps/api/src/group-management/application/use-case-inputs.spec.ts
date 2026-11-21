import { describe, expect, it } from 'vitest';

import { ActorSubject } from '../domain/group.js';
import { GroupInvariantViolation } from '../domain/group-invariant-violation.js';
import { OperationId } from './group-repository.js';
import {
  createGroupCommandFrom,
  listMyGroupsQueryFrom,
} from './use-case-inputs.js';

describe('Use Case入力の組立（#312）', () => {
  it('createGroupのCommandを信頼済みActorとoperationIdのVOで組み立てる', () => {
    const command = createGroupCommandFrom({
      actorSubject: 'actor-1',
      operationId: '00000000-0000-4000-8000-000000000001',
    });

    expect(command.actorSubject.equals(ActorSubject.from('actor-1'))).toBe(
      true,
    );
    expect(
      command.operationId.equals(
        OperationId.from('00000000-0000-4000-8000-000000000001'),
      ),
    ).toBe(true);
    expect(Object.keys(command).sort()).toEqual([
      'actorSubject',
      'operationId',
    ]);
    expect(Object.isFrozen(command)).toBe(true);
  });

  it('listMyGroupsのQueryをActorだけで組み立てる', () => {
    const query = listMyGroupsQueryFrom({ actorSubject: 'actor-1' });

    expect(query.actorSubject.equals(ActorSubject.from('actor-1'))).toBe(true);
    expect(Object.keys(query)).toEqual(['actorSubject']);
    expect(Object.isFrozen(query)).toBe(true);
  });

  it('空のActorはDomainの不変条件で拒否する', () => {
    expect(() =>
      createGroupCommandFrom({
        actorSubject: ' ',
        operationId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toThrow(GroupInvariantViolation);
    expect(() => listMyGroupsQueryFrom({ actorSubject: '' })).toThrow(
      GroupInvariantViolation,
    );
  });
});
