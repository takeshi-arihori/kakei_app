import {
  CommandFingerprint,
  OperationId,
  type GroupCommandResult,
  type StoredOperation,
} from '../../application/group-repository.js';
import {
  ActorSubject,
  CloseIntentId,
  Group,
  GroupId,
  InvitationId,
  ParticipantId,
  UtcInstant,
  type GroupCloseContext,
  type GroupStatus,
  type InvitationStatus,
  type ParticipantStatus,
} from '../../domain/group.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const object = (
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid protected payload');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new TypeError('Invalid protected payload');
  }
  return record;
};

const string = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('Invalid protected payload');
  }
  return value;
};

const nullable = <T>(
  value: unknown,
  decode: (value: unknown) => T,
): T | null => (value === null ? null : decode(value));

const integer = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError('Invalid protected payload');
  }
  return value as number;
};

const boolean = (value: unknown): boolean => {
  if (typeof value !== 'boolean') {
    throw new TypeError('Invalid protected payload');
  }
  return value;
};

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T => {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError('Invalid protected payload');
  }
  return value as T;
};

const array = <T>(value: unknown, decode: (value: unknown) => T): T[] => {
  if (!Array.isArray(value)) {
    throw new TypeError('Invalid protected payload');
  }
  return value.map(decode);
};

const instant = (value: unknown): UtcInstant => {
  const text = string(value);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(text)) {
    throw new TypeError('Invalid protected payload');
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== text) {
    throw new TypeError('Invalid protected payload');
  }
  return UtcInstant.from(date);
};

const parse = (bytes: Uint8Array): unknown =>
  JSON.parse(decoder.decode(bytes)) as unknown;

export const encodeGroupRecordPayload = (group: Group): Uint8Array =>
  encoder.encode(
    JSON.stringify({
      payloadVersion: 1,
      id: group.id.value,
      status: group.status,
      ownerParticipantId: group.ownerParticipantId?.value ?? null,
      participants: group.participants.map((item) => ({
        id: item.id.value,
        subject: item.subject.value,
        joinedAt: item.joinedAt.value,
        joinOrder: item.joinOrder,
        status: item.status,
        leftAt: item.leftAt?.value ?? null,
      })),
      invitations: group.invitations.map((item) => ({
        id: item.id.value,
        targetSubject: item.targetSubject.value,
        issuerParticipantId: item.issuerParticipantId.value,
        createdAt: item.createdAt.value,
        expiryAt: item.expiryAt.value,
        status: item.status,
        resultingParticipantId: item.resultingParticipantId?.value ?? null,
      })),
      accessPolicyVersion: group.accessPolicyVersion,
      closing:
        group.closing === null
          ? null
          : {
              closeIntentId: group.closing.closeIntentId.value,
              cutoff: group.closing.cutoff.value,
              phase: group.closing.phase,
              fenceReceipts: group.closing.fenceReceipts.map((receipt) => ({
                kind: receipt.kind,
                groupId: receipt.groupId.value,
                closeIntentId: receipt.closeIntentId.value,
                context: receipt.context,
                cutoff: receipt.cutoff.value,
                fenceVersion: receipt.fenceVersion,
                completedAt: receipt.completedAt.value,
                eligible: receipt.eligible,
              })),
              unfenceReceipts: group.closing.unfenceReceipts.map((receipt) => ({
                kind: receipt.kind,
                groupId: receipt.groupId.value,
                closeIntentId: receipt.closeIntentId.value,
                context: receipt.context,
                cutoff: receipt.cutoff.value,
                fenceVersion: receipt.fenceVersion,
                completedAt: receipt.completedAt.value,
              })),
            },
      ownerAtArchiveParticipantId:
        group.ownerAtArchiveParticipantId?.value ?? null,
      archivedAt: group.archivedAt?.value ?? null,
      deleteEligibleAt: group.deleteEligibleAt?.value ?? null,
    }),
  );

export const decodeGroupRecordPayload = (bytes: Uint8Array): Group => {
  const root = object(parse(bytes), [
    'payloadVersion',
    'id',
    'status',
    'ownerParticipantId',
    'participants',
    'invitations',
    'accessPolicyVersion',
    'closing',
    'ownerAtArchiveParticipantId',
    'archivedAt',
    'deleteEligibleAt',
  ]);
  if (root.payloadVersion !== 1) {
    throw new TypeError('Invalid protected payload');
  }
  const closing = nullable(root.closing, (value) => {
    const item = object(value, [
      'closeIntentId',
      'cutoff',
      'phase',
      'fenceReceipts',
      'unfenceReceipts',
    ]);
    const receiptBase = (value: unknown, keys: readonly string[]) => {
      const receipt = object(value, keys);
      return {
        groupId: GroupId.from(string(receipt.groupId)),
        closeIntentId: CloseIntentId.from(string(receipt.closeIntentId)),
        context: oneOf<GroupCloseContext>(receipt.context, [
          'ExpenseRecording',
          'Settlement',
        ]),
        cutoff: instant(receipt.cutoff),
        fenceVersion: integer(receipt.fenceVersion),
        completedAt: instant(receipt.completedAt),
      };
    };
    return {
      closeIntentId: CloseIntentId.from(string(item.closeIntentId)),
      cutoff: instant(item.cutoff),
      phase: oneOf(item.phase, ['Fencing', 'Canceling'] as const),
      fenceReceipts: array(item.fenceReceipts, (value) => {
        const receipt = object(value, [
          'kind',
          'groupId',
          'closeIntentId',
          'context',
          'cutoff',
          'fenceVersion',
          'completedAt',
          'eligible',
        ]);
        if (receipt.kind !== 'CloseFenceInstalled') {
          throw new TypeError('Invalid protected payload');
        }
        return {
          ...receiptBase(value, Object.keys(receipt)),
          kind: 'CloseFenceInstalled' as const,
          eligible: boolean(receipt.eligible),
        };
      }),
      unfenceReceipts: array(item.unfenceReceipts, (value) => {
        const receipt = object(value, [
          'kind',
          'groupId',
          'closeIntentId',
          'context',
          'cutoff',
          'fenceVersion',
          'completedAt',
        ]);
        if (receipt.kind !== 'CloseFenceRemoved') {
          throw new TypeError('Invalid protected payload');
        }
        return {
          ...receiptBase(value, Object.keys(receipt)),
          kind: 'CloseFenceRemoved' as const,
        };
      }),
    };
  });
  return Group.restore({
    id: GroupId.from(string(root.id)),
    status: oneOf<GroupStatus>(root.status, ['Active', 'Closing', 'Archived']),
    ownerParticipantId: nullable(root.ownerParticipantId, (value) =>
      ParticipantId.from(string(value)),
    ),
    participants: array(root.participants, (value) => {
      const item = object(value, [
        'id',
        'subject',
        'joinedAt',
        'joinOrder',
        'status',
        'leftAt',
      ]);
      return {
        id: ParticipantId.from(string(item.id)),
        subject: ActorSubject.from(string(item.subject)),
        joinedAt: instant(item.joinedAt),
        joinOrder: integer(item.joinOrder),
        status: oneOf<ParticipantStatus>(item.status, ['Active', 'Left']),
        leftAt: nullable(item.leftAt, instant),
      };
    }),
    invitations: array(root.invitations, (value) => {
      const item = object(value, [
        'id',
        'targetSubject',
        'issuerParticipantId',
        'createdAt',
        'expiryAt',
        'status',
        'resultingParticipantId',
      ]);
      return {
        id: InvitationId.from(string(item.id)),
        targetSubject: ActorSubject.from(string(item.targetSubject)),
        issuerParticipantId: ParticipantId.from(
          string(item.issuerParticipantId),
        ),
        createdAt: instant(item.createdAt),
        expiryAt: instant(item.expiryAt),
        status: oneOf<InvitationStatus>(item.status, [
          'Pending',
          'Consumed',
          'Cancelled',
          'Expired',
        ]),
        resultingParticipantId: nullable(item.resultingParticipantId, (entry) =>
          ParticipantId.from(string(entry)),
        ),
      };
    }),
    accessPolicyVersion: integer(root.accessPolicyVersion),
    closing,
    ownerAtArchiveParticipantId: nullable(
      root.ownerAtArchiveParticipantId,
      (value) => ParticipantId.from(string(value)),
    ),
    archivedAt: nullable(root.archivedAt, instant),
    deleteEligibleAt: nullable(root.deleteEligibleAt, instant),
  });
};

const plainResult = (
  result: GroupCommandResult,
): Record<string, string | number> => {
  const common = {
    kind: result.kind,
    groupId: result.groupId.value,
    version: result.version,
  };
  switch (result.kind) {
    case 'GroupCreated':
    case 'ParticipantLeft':
      return { ...common, participantId: result.participantId.value };
    case 'OwnershipTransferred':
    case 'OwnershipTransferNoOp':
      return { ...common, ownerParticipantId: result.ownerParticipantId.value };
    case 'InvitationCreated':
    case 'InvitationCancelled':
      return { ...common, invitationId: result.invitationId.value };
    case 'InvitationAccepted':
      return {
        ...common,
        invitationId: result.invitationId.value,
        participantId: result.participantId.value,
      };
    default:
      return { ...common, closeIntentId: result.closeIntentId.value };
  }
};

export const encodeOperationResultPayload = (
  operation: StoredOperation,
): Uint8Array =>
  encoder.encode(
    JSON.stringify({
      payloadVersion: 1,
      actorSubject: operation.actorSubject.value,
      operationId: operation.operationId.value,
      fingerprint: operation.fingerprint.value,
      result: plainResult(operation.result),
    }),
  );

const decodeResult = (value: unknown): GroupCommandResult => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid protected payload');
  }
  const kind = string((value as Record<string, unknown>).kind);
  const base = (keys: readonly string[]) => {
    const item = object(value, ['kind', 'groupId', 'version', ...keys]);
    return {
      groupId: GroupId.from(string(item.groupId)),
      version: integer(item.version),
      item,
    };
  };
  switch (kind) {
    case 'GroupCreated': {
      const { groupId, version, item } = base(['participantId']);
      return {
        kind,
        groupId,
        version,
        participantId: ParticipantId.from(string(item.participantId)),
      };
    }
    case 'OwnershipTransferred':
    case 'OwnershipTransferNoOp': {
      const { groupId, version, item } = base(['ownerParticipantId']);
      return {
        kind,
        groupId,
        version,
        ownerParticipantId: ParticipantId.from(string(item.ownerParticipantId)),
      };
    }
    case 'ParticipantLeft': {
      const { groupId, version, item } = base(['participantId']);
      return {
        kind,
        groupId,
        version,
        participantId: ParticipantId.from(string(item.participantId)),
      };
    }
    case 'InvitationCreated':
    case 'InvitationCancelled': {
      const { groupId, version, item } = base(['invitationId']);
      return {
        kind,
        groupId,
        version,
        invitationId: InvitationId.from(string(item.invitationId)),
      };
    }
    case 'InvitationAccepted': {
      const { groupId, version, item } = base([
        'invitationId',
        'participantId',
      ]);
      return {
        kind,
        groupId,
        version,
        invitationId: InvitationId.from(string(item.invitationId)),
        participantId: ParticipantId.from(string(item.participantId)),
      };
    }
    case 'GroupClosingStarted':
    case 'GroupCloseFenceReceiptRecorded':
    case 'GroupClosingCancellationReserved':
    case 'GroupCloseUnfenceReceiptRecorded':
    case 'GroupArchived':
    case 'GroupClosingCancelled': {
      const { groupId, version, item } = base(['closeIntentId']);
      return {
        kind,
        groupId,
        version,
        closeIntentId: CloseIntentId.from(string(item.closeIntentId)),
      };
    }
    default:
      throw new TypeError('Invalid protected payload');
  }
};

export const decodeOperationResultPayload = (
  bytes: Uint8Array,
): StoredOperation => {
  const root = object(parse(bytes), [
    'payloadVersion',
    'actorSubject',
    'operationId',
    'fingerprint',
    'result',
  ]);
  if (root.payloadVersion !== 1) {
    throw new TypeError('Invalid protected payload');
  }
  return {
    actorSubject: ActorSubject.from(string(root.actorSubject)),
    operationId: OperationId.from(string(root.operationId)),
    fingerprint: CommandFingerprint.from(string(root.fingerprint)),
    result: decodeResult(root.result),
  };
};
