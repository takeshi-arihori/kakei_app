import type { ActorSubject, GroupId, ParticipantId } from '../domain/group.js';
import type { CommitGroupRequest } from './group-repository.js';

export {
  actorAccessIndexDigestInput,
  membershipDigestInput,
  operationFingerprintDigestInput,
  operationLocatorDigestInput,
  type GroupOperationLocatorCandidate,
  type GroupOperationLocatorDigestInput,
  type GroupOperationLocatorKeyPort,
  type GroupPolicyDigest,
  type GroupPolicyDigestInput,
  type GroupPolicyDigestPort,
  type GroupPolicyDigestPurpose,
} from './group-policy-digest.js';
export {
  resolveOperationReplay,
  type GroupOperationReplayPort,
  type OperationReplayLookup,
  type OperationReplayRecord,
  type OperationReplayResolution,
} from './group-operation-replay.js';

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
  mutations: readonly CommitGroupRequest[];
}>;

export type ExpectedGroupAccessPolicyVersion = Readonly<{
  groupId: GroupId;
  groupVersion: number;
  accessPolicyVersion: number;
}>;

/**
 * Public Group Management boundary. Implementations keep reads within one
 * fixed policy version and serialize access-affecting mutations in ascending
 * Group ID order. Mutation callbacks are pure calculations over immutable
 * policy snapshots and return readonly Group commit plans; they receive no
 * database handle. PostgreSQL locking and persistence belong to #97.
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
