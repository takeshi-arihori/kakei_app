import type {
  AuthenticationLedgerEntry,
  AuthenticationLedgerProvider,
} from '../../../application/authentication/authentication-maintenance-ports.js';
import { createAuthenticationLedgerEvidence } from '../authentication-ledger-evidence.js';

/**
 * 署名運用/耐障害性を主張しないTest-onlyの外部Ledger。
 * @returns DBとは別に保持する合成Ledgerと、実HMAC/chainを使うverifier。
 */
export const syntheticAuthenticationLedger = () => {
  const entries: AuthenticationLedgerEntry[] = [];
  const faults = new Set<string>();
  const events: string[] = [];
  const allowedVersions = new Set(['v1', 'v2']);
  let currentWriteVersion = 'v1';
  let witnessSequence = 0;
  const tick = (event: string) => {
    events.push(event);
    if (faults.has(event)) throw new Error('synthetic ledger fault');
  };
  const head = () => ({
    sequence: entries.length,
    hash: entries.at(-1)?.hash ?? '0'.repeat(64),
  });
  const provider: AuthenticationLedgerProvider = {
    latest: (challenge) =>
      Promise.resolve(
        (['checkpoint', 'witness'] as const).map((source) => ({
          namespace: 'authentication/v1',
          source,
          challenge,
          head:
            source === 'checkpoint'
              ? head()
              : {
                  sequence: witnessSequence,
                  hash: entries[witnessSequence - 1]?.hash ?? '0'.repeat(64),
                },
          attestation: new Uint8Array([7]),
        })),
      ),
    page: (after, fixed) =>
      Promise.resolve(
        entries.slice(after, Math.min(after + 128, fixed.sequence)),
      ),
    append: (expected, entry) => {
      return Promise.resolve().then(() => {
        const phase =
          entry.record.kind === 'actor-deletion'
            ? 'actor-deletion-' + entry.record.state
            : 'recovery';
        tick('before-' + phase + '-checkpoint');
        if (JSON.stringify(expected) !== JSON.stringify(head()))
          throw new Error('synthetic external CAS');
        entries.push(entry);
        tick('after-' + phase + '-checkpoint');
        tick('before-' + phase + '-witness');
        witnessSequence = entries.length;
        tick('after-' + phase + '-witness');
      });
    },
  };
  const createEvidence = (writeKeyVersion = currentWriteVersion) =>
    createAuthenticationLedgerEvidence({
      provider,
      writeKeyVersion,
      keys: {
        read: (keyVersion) => {
          return Promise.resolve().then(() => {
            if (!allowedVersions.has(keyVersion))
              throw new Error('synthetic retired ledger key missing');
            return {
              purpose: 'auth-deletion-ledger/v1',
              keyVersion,
              lifecycle:
                keyVersion === currentWriteVersion ? 'current' : 'read-only',
              material: new Uint8Array(32).fill(keyVersion === 'v1' ? 20 : 21),
            };
          });
        },
      },
      attestations: { verifyHead: () => Promise.resolve(true) },
    });
  return {
    /** 外部Prepared/CompleteをDB Backupとは別に保持する合成列。 */
    entries,
    /** 障害注入をTestだけに限定する合成Provider。 */
    provider,
    /** 実Canonical/HMAC/chainとregistryを使う検証器。 */
    evidence: createEvidence(),
    /** 外部Storeを巻戻さず、Application verifierだけを新しくする。 */
    restartVerifier: createEvidence,
    /** 単側append/応答喪失を止める合成段階。 */
    faults,
    /** 故障が目的の境界まで到達したことを確認する合成履歴。 */
    events,
    /** 必要な旧MAC鍵の欠損を合成注入する。 */
    allowedVersions,
    /**
     * 旧読取を維持したまま新規書込だけ別世代へ切り替える。
     * @param version 外部Registryで利用可能な合成世代。
     */
    rotateMac: (version: string) => {
      if (!allowedVersions.has(version))
        throw new Error('synthetic unknown MAC generation');
      currentWriteVersion = version;
    },
    /** Operator修復を合成する。実Providerの修復運用証明ではない。 */
    repairWitness: () => {
      witnessSequence = entries.length;
    },
  };
};
