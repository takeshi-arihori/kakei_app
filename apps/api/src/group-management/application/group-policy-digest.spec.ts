import { describe, expect, it } from 'vitest';

import { ActorSubject, GroupId } from '../domain/group.js';
import {
  actorAccessIndexDigestInput,
  actorMembershipIndexDigestInput,
  operationLocatorDigestInput,
} from './group-policy-digest.js';
import { OperationId } from './group-repository.js';

const tlv = (tag: number, value: string): number[] => {
  const bytes = [...new TextEncoder().encode(value)];
  return [
    tag,
    (bytes.length >>> 24) & 0xff,
    (bytes.length >>> 16) & 0xff,
    (bytes.length >>> 8) & 0xff,
    bytes.length & 0xff,
    ...bytes,
  ];
};

describe('Actor単位のGroup索引digest入力（#306 IX-INV-3）', () => {
  it('Context単位の用途で、Actor subjectだけを入力しGroupIdを含めない', () => {
    const input = actorMembershipIndexDigestInput(ActorSubject.from('a:b'));

    expect(input.purpose).toBe('group-actor-membership-index/v1');
    expect(Object.keys(input).sort()).toEqual(['canonicalInput', 'purpose']);
    expect([...input.canonicalInput]).toEqual([
      ...tlv(0x01, 'group-actor-membership-index/v1'),
      ...tlv(0x02, 'actor-membership-index'),
      ...tlv(0x03, 'a:b'),
    ]);
    expect(Object.isFrozen(input)).toBe(true);
  });

  it('同じActorなら同じ入力になり、別Actorや他用途の入力とは一致しない', () => {
    const actor = ActorSubject.from('actor-1');
    const groupA = GroupId.from('00000000-0000-4000-8000-0000000003a1');
    const groupB = GroupId.from('00000000-0000-4000-8000-0000000003b1');
    const membership = actorMembershipIndexDigestInput(actor);

    expect(actorMembershipIndexDigestInput(actor).canonicalInput).toEqual(
      membership.canonicalInput,
    );
    expect(
      actorMembershipIndexDigestInput(ActorSubject.from('actor-2'))
        .canonicalInput,
    ).not.toEqual(membership.canonicalInput);
    for (const other of [
      actorAccessIndexDigestInput(groupA, actor).canonicalInput,
      actorAccessIndexDigestInput(groupB, actor).canonicalInput,
      operationLocatorDigestInput(actor, OperationId.from('op')).canonicalInput,
    ]) {
      expect(other).not.toEqual(membership.canonicalInput);
    }
  });
});
