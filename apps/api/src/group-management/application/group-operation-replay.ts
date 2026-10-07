import type {
  GroupOperationLocatorCandidate,
  GroupPolicyDigest,
} from './group-policy-digest.js';

export type OperationReplayRecord<T> = Readonly<{
  fingerprint: GroupPolicyDigest;
  result: T;
}>;

export type OperationReplayLookup<T> =
  | Readonly<{ kind: 'Missing' }>
  | Readonly<{ kind: 'Found'; record: OperationReplayRecord<T> }>;

/**
 * この候補ベースのPortはGroupRepository.findOperationとは別の契約。
 * Task #94は後者のPostgreSQL読取Adapterを提供する。
 * このPortへの接続は別の結合Taskで扱う。
 */
export interface GroupOperationReplayPort<T> {
  findOperation(input: {
    locatorCandidates: readonly GroupOperationLocatorCandidate[];
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
