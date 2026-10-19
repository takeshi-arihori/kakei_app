import { describe, expect, it } from 'vitest';

import type {
  AuthenticationDeletionRecord,
  AuthenticationHeadAttestation,
  AuthenticationLedgerEntry,
  AuthenticationLedgerHead,
  AuthenticationLedgerProvider,
  AuthenticationLedgerMacKeys,
} from '../../application/authentication/authentication-maintenance-ports.js';
import { createAuthenticationLedgerEvidence } from './authentication-ledger-evidence.js';

const operationId = '11111111-1111-4111-8111-111111111111';
const record: AuthenticationDeletionRecord = {
  kind: 'actor-deletion',
  operationId,
  actorDigestKeyVersion: 'v1',
  actorDigest: new Uint8Array(32).fill(4),
  preparedAt: 1000,
  version: 1,
  state: 'prepared',
  targetReference: 'opaque-target-ref',
};
const fixture = () => {
  const entries: AuthenticationLedgerEntry[] = [];
  let mismatch = false;
  let staleChallenge = false;
  let corruptMac = false;
  let dropPage = false;
  const head = (): AuthenticationLedgerHead =>
    entries.length === 0
      ? { sequence: 0, hash: '0'.repeat(64) }
      : { sequence: entries.at(-1)!.sequence, hash: entries.at(-1)!.hash };
  const provider: AuthenticationLedgerProvider = {
    latest: (challenge) =>
      Promise.resolve(
        (['checkpoint', 'witness'] as const).map(
          (source): AuthenticationHeadAttestation => ({
            namespace: 'authentication/v1',
            source,
            challenge: staleChallenge ? operationId : challenge,
            head: {
              ...head(),
              hash:
                mismatch && source === 'witness' ? 'f'.repeat(64) : head().hash,
            },
            attestation: new Uint8Array([1]),
          }),
        ),
      ),
    page: (after) =>
      Promise.resolve(
        dropPage
          ? []
          : entries
              .slice(after, after + 128)
              .map((entry) =>
                corruptMac ? { ...entry, mac: new Uint8Array(32) } : entry,
              ),
      ),
    append: (expected, entry) => {
      return Promise.resolve().then(() => {
        if (JSON.stringify(expected) !== JSON.stringify(head()))
          throw new Error('synthetic CAS');
        entries.push(entry);
      });
    },
  };
  const keys: AuthenticationLedgerMacKeys = {
    read: (keyVersion: string) =>
      Promise.resolve({
        purpose: 'auth-deletion-ledger/v1' as const,
        keyVersion,
        lifecycle: 'current' as const,
        material: new Uint8Array(32).fill(9),
      }),
  };
  const evidence = createAuthenticationLedgerEvidence({
    provider,
    keys,
    writeKeyVersion: 'v1',
    attestations: { verifyHead: () => Promise.resolve(true) },
  });
  return {
    evidence,
    entries,
    provider,
    keys,
    mismatch: () => {
      mismatch = true;
    },
    stale: () => {
      staleChallenge = true;
    },
    corrupt: () => {
      corruptMac = true;
    },
    drop: () => {
      dropPage = true;
    },
  };
};

describe('認証Ledgerの独立証跡検証', () => {
  it('独立計算したapplication・用途・namespace付きTLV golden vectorと一致する', async () => {
    const f = fixture();
    await f.evidence.append(await f.evidence.latest(), record);
    // Python標準ライブラリのstruct/HMAC/SHA256で別計算。既存Envelope/AADとは別形式。
    expect(Buffer.from(f.entries[0].mac).toString('hex')).toBe(
      '39e3b5bdaf97fd8cf8d7596300ee23a8f9f73309289640aa5ad1c4710a60e1c1',
    );
    expect(f.entries[0].hash).toBe(
      '9597a6afc1d19ce87ef5a4fed169d36910542215f838a77449950fd39dbbe50f',
    );
  });
  it('PreparedとCompleteを専用MACとchainへ束縛して読み直す', async () => {
    const f = fixture();
    const initial = await f.evidence.latest();
    const prepared = await f.evidence.append(initial, record);
    const intent = f.evidence.intent(prepared, operationId)!;
    expect(f.evidence.resolve(intent)).toEqual(record);
    const complete = await f.evidence.append(prepared, {
      ...record,
      state: 'complete',
      version: 2,
    });
    expect(
      f.evidence.resolve(f.evidence.intent(complete, operationId)!),
    ).toEqual({
      ...record,
      state: 'complete',
      version: 2,
    });
    expect(f.entries[1].previousHash).toBe(f.entries[0].hash);
    expect(f.entries[0].mac).toHaveLength(32);
  });
  it.each(['mismatch', 'stale', 'corrupt', 'drop'] as const)(
    '%sの証跡はlatestを許可しない',
    async (fault) => {
      const f = fixture();
      await f.evidence.append(await f.evidence.latest(), record);
      f[fault]();
      await expect(f.evidence.latest()).rejects.toThrow();
    },
  );
  it('CompleteからPreparedへ戻す意思をappendしない', async () => {
    const f = fixture();
    const h1 = await f.evidence.append(await f.evidence.latest(), record);
    const h2 = await f.evidence.append(h1, {
      ...record,
      state: 'complete',
      version: 2,
    });
    await expect(
      f.evidence.append(h2, { ...record, version: 3 }),
    ).rejects.toThrow();
    expect(f.entries).toHaveLength(2);
  });
  it('別仮名に差し替えたCompleteをappendしない', async () => {
    const f = fixture();
    const h1 = await f.evidence.append(await f.evidence.latest(), record);
    await expect(
      f.evidence.append(h1, {
        ...record,
        actorDigest: new Uint8Array(32),
        state: 'complete',
        version: 2,
      }),
    ).rejects.toThrow();
  });
  it('偽造・別registryのheadとintentを信用しない', async () => {
    const f = fixture();
    const head = await f.evidence.append(await f.evidence.latest(), record);
    const foreign = fixture().evidence;
    expect(() => foreign.head(head)).toThrow();
    expect(() =>
      foreign.resolve(f.evidence.intent(head, operationId)!),
    ).toThrow();
    expect(() => f.evidence.head({} as typeof head)).toThrow();
  });
  it('Backup Manifestのsequenceだけでなくchain内hashを確認する', async () => {
    const f = fixture();
    await f.evidence.append(await f.evidence.latest(), record);
    await expect(
      f.evidence.latest({
        createdAt: 1000,
        schemaVersion: 6,
        keyStateVersion: 1,
        epoch: operationId,
        checkpoint: { sequence: 1, hash: 'f'.repeat(64) },
      }),
    ).rejects.toThrow();
  });
  it('Provider attestationの検証失敗をMACだけで補わない', async () => {
    const f = fixture();
    const evidence = createAuthenticationLedgerEvidence({
      provider: f.provider,
      keys: f.keys,
      writeKeyVersion: 'v1',
      attestations: { verifyHead: () => Promise.resolve(false) },
    });
    await expect(evidence.latest()).rejects.toThrow();
  });
  it('退役MAC鍵は旧chain検証を許可しても新規appendには使わない', async () => {
    const f = fixture();
    await f.evidence.append(await f.evidence.latest(), record);
    f.keys.read = (keyVersion) =>
      Promise.resolve({
        purpose: 'auth-deletion-ledger/v1',
        keyVersion,
        lifecycle: 'read-only',
        material: new Uint8Array(32).fill(9),
      });
    const head = await f.evidence.latest();
    await expect(
      f.evidence.append(head, { ...record, state: 'complete', version: 2 }),
    ).rejects.toThrow();
    expect(f.entries).toHaveLength(1);
  });
  it.each(['namespace', 'source', 'extra', 'getter', 'empty-proof'] as const)(
    '%sのProvider応答を拒否する',
    async (fault) => {
      const f = fixture();
      const original = f.provider.latest.bind(f.provider);
      let getterCalls = 0;
      f.provider.latest = async (challenge) => {
        const proofs = [...(await original(challenge))];
        const proof = { ...proofs[0] };
        if (fault === 'namespace')
          Object.assign(proof, { namespace: 'group/v1' });
        if (fault === 'source') Object.assign(proof, { source: 'witness' });
        if (fault === 'extra') Object.assign(proof, { untrusted: true });
        if (fault === 'getter')
          Object.defineProperty(proof, 'head', {
            get: () => {
              getterCalls += 1;
              return { sequence: 0, hash: '0'.repeat(64) };
            },
          });
        if (fault === 'empty-proof') proof.attestation = new Uint8Array();
        proofs[0] = proof;
        return proofs;
      };
      await expect(f.evidence.latest()).rejects.toThrow();
      expect(getterCalls).toBe(0);
    },
  );
  it.each(['sequence', 'previousHash', 'hash', 'extra', 'large-page'] as const)(
    '%sのchainを拒否する',
    async (fault) => {
      const f = fixture();
      await f.evidence.append(await f.evidence.latest(), record);
      f.provider.page = () => {
        return Promise.resolve().then(() => {
          const entry = { ...f.entries[0] };
          if (fault === 'sequence') entry.sequence = 2;
          if (fault === 'previousHash') entry.previousHash = 'f'.repeat(64);
          if (fault === 'hash') entry.hash = 'f'.repeat(64);
          if (fault === 'extra') Object.assign(entry, { untrusted: true });
          return fault === 'large-page'
            ? Array.from({ length: 129 }, () => entry)
            : [entry];
        });
      };
      await expect(f.evidence.latest()).rejects.toThrow();
    },
  );
  it('page取得中にlatestが変化したら古いheadの能力を発行しない', async () => {
    const f = fixture();
    await f.evidence.append(await f.evidence.latest(), record);
    const original = f.provider.latest.bind(f.provider);
    let calls = 0;
    f.provider.latest = async (challenge) => {
      const proofs = await original(challenge);
      calls += 1;
      return calls === 1
        ? proofs
        : proofs.map((proof) => ({
            ...proof,
            head: { sequence: 2, hash: 'e'.repeat(64) },
          }));
    };
    await expect(f.evidence.latest()).rejects.toThrow();
  });
  it('未知MAC鍵と別用途の鍵を拒否しProvider所有materialを消去しない', async () => {
    const f = fixture();
    const material = new Uint8Array(32).fill(9);
    f.keys.read = (keyVersion) =>
      Promise.resolve({
        purpose: 'auth-deletion-ledger/v1',
        keyVersion,
        lifecycle: 'current',
        material,
      });
    await f.evidence.append(await f.evidence.latest(), record);
    expect(material).toEqual(new Uint8Array(32).fill(9));
    f.keys.read = () => {
      return Promise.resolve().then(() => {
        throw new Error('synthetic missing key');
      });
    };
    await expect(f.evidence.latest()).rejects.toThrow();
    f.keys.read = (keyVersion) =>
      Promise.resolve({
        purpose: 'audit/v1' as 'auth-deletion-ledger/v1',
        keyVersion,
        lifecycle: 'current',
        material,
      });
    await expect(f.evidence.latest()).rejects.toThrow();
  });
});
