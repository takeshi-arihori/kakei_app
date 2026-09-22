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

export const operationLocatorDigestInput = (
  groupId: GroupId,
  actorSubject: ActorSubject,
  operationId: OperationId,
): GroupPolicyDigestInput =>
  digestInput('group-operation-locator/v1', groupId.value, [
    { tag: 0x01, value: 'group-access-policy/v1' },
    { tag: 0x02, value: 'operation-locator' },
    { tag: 0x03, value: actorSubject.value },
    { tag: 0x05, value: operationId.value },
  ]);

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

export type GroupAccessMembership = Readonly<{
  participantId: ParticipantId;
  actorSubject: ActorSubject;
  status: 'Active' | 'Left';
}>;

export type FixedGroupAccessPolicy = Readonly<{
  groupId: GroupId;
  groupVersion: number;
  accessPolicyVersion: number;
  status: 'Active' | 'Closing' | 'Archived';
  ownerParticipantId: ParticipantId | null;
  ownerAtArchiveParticipantId: ParticipantId | null;
  memberships: readonly GroupAccessMembership[];
}>;

export type SnapshotInvolvement = Readonly<{
  requesterParticipantId: ParticipantId | null;
  requiredApproverParticipantIds: readonly ParticipantId[];
  paymentPayerParticipantId: ParticipantId | null;
  paymentPayeeParticipantId: ParticipantId | null;
  expensePayerParticipantId: ParticipantId | null;
  allocationParticipantIds: readonly ParticipantId[];
}>;

const hasId = (
  participantId: ParticipantId,
  candidates: readonly (ParticipantId | null)[],
): boolean => candidates.some((candidate) => candidate?.equals(participantId));

/** Evaluates every membership separately so a rejoined actor cannot inherit an old ID's access. */
export const canReadSnapshot = (
  policy: FixedGroupAccessPolicy,
  actorSubject: ActorSubject,
  involvement: SnapshotInvolvement,
): boolean => {
  const memberships = policy.memberships.filter(({ actorSubject: subject }) =>
    subject.equals(actorSubject),
  );
  if (memberships.length === 0) {
    return false;
  }

  if (policy.status === 'Archived') {
    const ownerAtArchiveParticipantId = policy.ownerAtArchiveParticipantId;
    return (
      ownerAtArchiveParticipantId !== null &&
      memberships.some(({ participantId }) =>
        participantId.equals(ownerAtArchiveParticipantId),
      )
    );
  }

  return memberships.some((membership) => {
    const ownerParticipantId = policy.ownerParticipantId;
    if (
      membership.status === 'Active' &&
      ownerParticipantId !== null &&
      membership.participantId.equals(ownerParticipantId)
    ) {
      return true;
    }
    if (membership.status === 'Active') {
      return hasId(membership.participantId, [
        involvement.requesterParticipantId,
        ...involvement.requiredApproverParticipantIds,
        involvement.paymentPayerParticipantId,
        involvement.paymentPayeeParticipantId,
        involvement.expensePayerParticipantId,
        ...involvement.allocationParticipantIds,
      ]);
    }
    return hasId(membership.participantId, [
      ...involvement.requiredApproverParticipantIds,
      involvement.paymentPayerParticipantId,
      involvement.paymentPayeeParticipantId,
    ]);
  });
};

export const permitsNewBusinessOrAccessMutation = (
  policy: FixedGroupAccessPolicy,
): boolean => policy.status === 'Active';

export type SnapshotReadCallbackResult<T> =
  | Readonly<{
      kind: 'Allowed';
      value: T;
      involvement: SnapshotInvolvement;
    }>
  | Readonly<{ kind: 'Denied' }>;

export type SnapshotReadResult<T> =
  Readonly<{ kind: 'Allowed'; value: T }> | Readonly<{ kind: 'Unavailable' }>;

export type FixedSnapshotReadAccess = Readonly<{
  groupVersion: number;
  accessPolicyVersion: number;
  /** The port rechecks the callback's declared involvement before releasing a payload. */
  canReadSnapshot: (involvement: SnapshotInvolvement) => boolean;
}>;

export type ExclusiveMutationResult<T> = Readonly<{
  value: T;
  nextGroupVersion: number;
  nextAccessPolicyVersion: number;
}>;

export type ExpectedGroupAccessPolicyVersion = Readonly<{
  groupId: GroupId;
  groupVersion: number;
  accessPolicyVersion: number;
}>;

/**
 * Public Group Management boundary. Implementations keep reads within one
 * fixed policy version and serialize access-affecting mutations in ascending
 * Group ID order. SQL locking and durable storage belong to #42.
 */
export interface GroupAccessPolicyPort {
  withSnapshotRead<T>(input: {
    groupId: GroupId;
    actorSubject: ActorSubject;
    callback: (
      access: FixedSnapshotReadAccess,
    ) => Promise<SnapshotReadCallbackResult<T>>;
  }): Promise<SnapshotReadResult<T>>;

  withExclusiveMutation<T>(input: {
    expectedPolicies: readonly ExpectedGroupAccessPolicyVersion[];
    callback: (
      policies: readonly FixedGroupAccessPolicy[],
    ) => Promise<ExclusiveMutationResult<T>>;
  }): Promise<SnapshotReadResult<T>>;
}

export type OperationReplayRecord<T> = Readonly<{
  fingerprint: GroupPolicyDigest;
  result: T;
}>;

export type OperationReplayLookup<T> =
  | Readonly<{ kind: 'Missing' }>
  | Readonly<{ kind: 'Found'; record: OperationReplayRecord<T> }>;

/** Durable storage is #42; this port keeps locator lookup independent of its adapter. */
export interface GroupOperationReplayPort<T> {
  findOperation(input: {
    locator: GroupPolicyDigest;
  }): Promise<OperationReplayLookup<T>>;
}

export type OperationReplayResolution<T> =
  | Readonly<{ kind: 'Replay'; result: T }>
  | Readonly<{ kind: 'Execute' }>
  | Readonly<{ kind: 'Mismatch'; alert: 'OperationFingerprintMismatch' }>;

export const resolveOperationReplay = <T>(
  lookup: OperationReplayLookup<T>,
  requestedFingerprint: GroupPolicyDigest,
): OperationReplayResolution<T> => {
  if (lookup.kind === 'Missing') {
    return Object.freeze({ kind: 'Execute' });
  }
  if (
    lookup.record.fingerprint.length !== requestedFingerprint.length ||
    lookup.record.fingerprint.some(
      (byte, index) => byte !== requestedFingerprint[index],
    )
  ) {
    return Object.freeze({
      kind: 'Mismatch',
      alert: 'OperationFingerprintMismatch',
    });
  }
  return Object.freeze({ kind: 'Replay', result: lookup.record.result });
};
