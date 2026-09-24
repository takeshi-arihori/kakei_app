import type {
  DigestPurpose,
  PurposeSeparatedDigest,
  PurposeSeparatedDigestPort,
} from '@kakei/protected-record';

import type { ActorSubject, GroupId, ParticipantId } from '../domain/group.js';
import type { OperationId } from './group-repository.js';

const textEncoder = new TextEncoder();

export type GroupPolicyDigestPurpose = DigestPurpose;
export type GroupPolicyDigest = PurposeSeparatedDigest;
export type GroupPolicyDigestPort = PurposeSeparatedDigestPort;

export type GroupPolicyDigestInput = Readonly<{
  purpose: GroupPolicyDigestPurpose;
  groupId: string;
  canonicalInput: Uint8Array;
}>;

type CanonicalTlvField = Readonly<{ tag: number; value: string }>;

const encodeCanonicalTlv = (
  fields: readonly CanonicalTlvField[],
): Uint8Array => {
  const ordered = [...fields].sort((left, right) => left.tag - right.tag);
  if (
    ordered.length === 0 ||
    ordered.some(
      ({ tag, value }, index) =>
        !Number.isInteger(tag) ||
        tag < 1 ||
        tag > 255 ||
        value.length === 0 ||
        (index > 0 && ordered[index - 1]?.tag === tag),
    )
  ) {
    throw new TypeError(
      'Canonical TLV fields must be unique, ordered, and non-empty',
    );
  }

  const encoded = ordered.map(({ tag, value }) => {
    const bytes = textEncoder.encode(value);
    const field = new Uint8Array(5 + bytes.length);
    field[0] = tag;
    new DataView(field.buffer).setUint32(1, bytes.length, false);
    field.set(bytes, 5);
    return field;
  });
  const length = encoded.reduce((total, field) => total + field.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const field of encoded) {
    result.set(field, offset);
    offset += field.length;
  }
  return result;
};

const digestInput = (
  purpose: GroupPolicyDigestPurpose,
  groupId: string,
  fields: readonly CanonicalTlvField[],
): GroupPolicyDigestInput =>
  Object.freeze({
    purpose,
    groupId,
    canonicalInput: encodeCanonicalTlv(fields),
  });

/**
 * Purpose values are part of the persisted-index contract. Callers must pass
 * the bytes unchanged to the purpose-separated digest port.
 */
export const actorAccessIndexDigestInput = (
  groupId: GroupId,
  actorSubject: ActorSubject,
): GroupPolicyDigestInput =>
  digestInput('group-actor-access-index/v1', groupId.value, [
    { tag: 0x01, value: 'group-access-policy/v1' },
    { tag: 0x02, value: 'actor-access-index' },
    { tag: 0x03, value: actorSubject.value },
  ]);

export const membershipDigestInput = (
  groupId: GroupId,
  participantId: ParticipantId,
): GroupPolicyDigestInput =>
  digestInput('group-membership-index/v1', groupId.value, [
    { tag: 0x01, value: 'group-access-policy/v1' },
    { tag: 0x02, value: 'membership' },
    { tag: 0x04, value: participantId.value },
  ]);

/**
 * Operation locators deliberately have no Group ID: CreateGroup needs the
 * replay lookup before a Group exists. Their key namespace is context-only.
 */
export type GroupOperationLocatorDigestInput = Readonly<{
  purpose: 'group-operation-locator/v2';
  canonicalInput: Uint8Array;
}>;

export type GroupOperationLocatorCandidate = Readonly<{
  digest: GroupPolicyDigest;
  digestKeyVersion: string;
}>;

export interface GroupOperationLocatorKeyPort {
  currentDigest(
    input: GroupOperationLocatorDigestInput,
  ): Promise<GroupOperationLocatorCandidate>;

  candidateDigests(
    input: GroupOperationLocatorDigestInput,
  ): Promise<readonly GroupOperationLocatorCandidate[]>;
}

export const operationLocatorDigestInput = (
  actorSubject: ActorSubject,
  operationId: OperationId,
): GroupOperationLocatorDigestInput =>
  Object.freeze({
    purpose: 'group-operation-locator/v2',
    canonicalInput: encodeCanonicalTlv([
      { tag: 0x01, value: 'group-operation-locator/v2' },
      { tag: 0x02, value: 'operation-locator' },
      { tag: 0x03, value: actorSubject.value },
      { tag: 0x05, value: operationId.value },
    ]),
  });

export const operationFingerprintDigestInput = (
  groupId: GroupId,
  commandKind: string,
  commandSemantic: string,
): GroupPolicyDigestInput =>
  digestInput('group-operation-fingerprint/v1', groupId.value, [
    { tag: 0x01, value: 'group-access-policy/v1' },
    { tag: 0x02, value: 'operation-fingerprint' },
    { tag: 0x06, value: commandKind },
    { tag: 0x07, value: commandSemantic },
  ]);
