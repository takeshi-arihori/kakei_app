import { randomUUID } from 'node:crypto';

import type { AuthenticationRestoreFence } from '../../../application/authentication/authentication-maintenance-ports.js';
import type {
  AuthenticationRestoreControl,
  AuthenticationRestorePublication,
} from '../../../application/authentication/authentication-restore-control.js';
import { authenticationBytesEqual } from '../authentication-digests.js';
import type { syntheticAuthenticationLedger } from './authentication-maintenance-ledger-fixtures.js';
import type { syntheticAuthenticationManagedKeys } from './authentication-maintenance-key-fixtures.js';

const purposes = [
  'google-identity-search',
  'login-attempt-cookie',
  'session-cookie',
  'actor-state-mac',
  'audit-actor',
  'audit-attempt',
  'audit-session',
  'deleted-actor',
  'deletion-ledger-mac',
] as const;

/**
 * 外部所有権とepoch/CASのTest-only制御。実Traffic/IAM/failure domainの証明ではない。
 * @param keys DBと独立して保持する合成全世代Registry。
 * @param ledger MAC/chainを実検証する合成外部Ledger。
 * @param actorStateKeyVersion 復旧後のActor MAC世代。旧世代を含めない移行も検証する。
 * @returns 同runの所有fence・公開実体・故障注入だけの合成制御。
 */
export const syntheticAuthenticationRestoreControl = (
  keys: ReturnType<typeof syntheticAuthenticationManagedKeys>,
  ledger: ReturnType<typeof syntheticAuthenticationLedger>,
  actorStateKeyVersion = 'v1',
) => {
  const fence = Object.freeze(
    Object.create(null),
  ) as AuthenticationRestoreFence;
  let owner: string | null = null;
  let closed = false;
  let publication: AuthenticationRestorePublication | null = null;
  let isolation: {
    manifest: string;
    baseVersion: number;
    restoringVersions: Set<number>;
  } | null = null;
  const faults = new Set<string>();
  const events: string[] = [];
  const tick = (name: string) => {
    events.push(name);
    if (faults.has(name)) throw new Error('synthetic control fault');
  };
  const owns = (input: AuthenticationRestoreFence) =>
    input === fence && owner !== null && closed;
  const verifies = (
    input: AuthenticationRestoreFence,
    value: AuthenticationRestorePublication,
  ) =>
    owns(input) &&
    publication !== null &&
    JSON.stringify(value) === JSON.stringify(publication);
  const control: AuthenticationRestoreControl = {
    authorizeIsolation: (input, manifest, current) =>
      Promise.resolve().then(() => {
        if (!owns(input)) throw new Error('synthetic isolation fence');
        const binding = JSON.stringify([
          manifest.createdAt,
          manifest.schemaVersion,
          manifest.keyStateVersion,
          manifest.epoch,
          manifest.checkpoint.sequence,
          manifest.checkpoint.hash,
        ]);
        if (isolation === null) {
          if (
            current.version !== manifest.keyStateVersion ||
            current.epoch !== manifest.epoch ||
            current.status === 'restoring'
          )
            throw new Error('synthetic initial manifest mismatch');
          isolation = {
            manifest: binding,
            baseVersion: current.version,
            restoringVersions: new Set(),
          };
        }
        if (isolation.manifest !== binding)
          throw new Error('synthetic run manifest mismatch');
        const oldBackup =
          current.epoch === manifest.epoch &&
          current.version === isolation.baseVersion &&
          current.status !== 'restoring';
        const resumed =
          current.status === 'restoring' &&
          isolation.restoringVersions.has(current.version) &&
          (current.epoch === manifest.epoch ||
            current.epoch === publication?.epoch);
        const activated =
          current.status === 'active' &&
          publication !== null &&
          current.epoch === publication.epoch &&
          isolation.restoringVersions.has(current.version - 1);
        if (!oldBackup && !resumed && !activated)
          throw new Error('synthetic unknown isolation progress');
        const next =
          current.status === 'restoring'
            ? current.version
            : current.version + 1;
        isolation.restoringVersions.add(next);
        return next;
      }),
    currentPublication: (input) => {
      return Promise.resolve().then(() => {
        if (!owns(input)) throw new Error('synthetic fence');
        return publication;
      });
    },
    close: (runId) => {
      return Promise.resolve().then(() => {
        tick('before-close');
        if (closed && owner !== runId)
          throw new Error('synthetic competing restore');
        if (owner !== null && owner !== runId) {
          publication = null;
          isolation = null;
        }
        owner = runId;
        closed = true;
        tick('after-close');
        return fence;
      });
    },
    verifyClosed: (input) => Promise.resolve(owns(input)),
    publishEpoch: (input, previousEpoch) => {
      return Promise.resolve().then(() => {
        tick('before-publish');
        if (!owns(input)) throw new Error('synthetic fence');
        if (publication === null) {
          const epoch = randomUUID();
          if (epoch === previousEpoch)
            throw new Error('synthetic epoch collision');
          publication = {
            runId: owner!,
            revision: 2,
            epoch,
            generations: purposes.map((purpose) => ({
              purpose,
              keyVersion:
                purpose === 'deletion-ledger-mac'
                  ? ledger.evidence.writeKeyVersion
                  : purpose === 'actor-state-mac'
                    ? actorStateKeyVersion
                    : purpose.includes('cookie')
                      ? 'v2'
                      : 'v1',
              epoch: purpose.includes('cookie') ? epoch : null,
              searchable: true,
              writeRequired: true,
              retiredAt: null,
            })),
          };
        }
        tick('after-publish');
        return publication;
      });
    },
    verifyPublication: (input, value) =>
      Promise.resolve(verifies(input, value)),
    rotateIdentity: (input, scope) => {
      return Promise.resolve().then(() => {
        if (!owns(input) || scope.recordKind !== 'google-identity')
          throw new Error('synthetic fence');
        keys.rotate(scope);
      });
    },
    open: (input, value, expected, digest) => {
      return Promise.resolve().then(() => {
        tick('before-open');
        const last = ledger.entries.at(-1);
        if (
          !verifies(input, value) ||
          last === undefined ||
          last.sequence !== expected.sequence ||
          last.hash !== expected.hash ||
          last.record.kind !== 'recovery' ||
          last.record.operationId !== owner ||
          last.record.epoch !== value.epoch ||
          !authenticationBytesEqual(last.record.evidenceDigest, digest)
        )
          return false;
        closed = false;
        tick('after-open');
        return true;
      });
    },
  };
  return {
    /** 同runの外部所有/fence/epochに対応する合成Port。 */
    control,
    /** 外部制御の各段を止めるTest-only固定分類。 */
    faults,
    /** 秘密値を含まない固定段階の履歴。 */
    events,
    /** @returns 合成Trafficが閉じている場合だけtrue。 */
    isClosed: () => closed,
  };
};
