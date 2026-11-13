import { describe, expect, it } from 'vitest';

import type {
  AuthenticationConsistencyBinding,
  AuthenticationConsistencyEvidence,
  AuthenticationConsistencyEvidenceHandle,
} from '../../application/authentication/authentication-consistency-evidence.js';
import { AuthenticationCryptoUnavailable } from '../../application/authentication/authentication-record-protection.js';
import {
  createAuthenticationConsistencyEvidenceRegistry,
  createAuthenticationRestoreEvidenceDigest,
  type AuthenticationConsistencyEvidenceSource,
} from './authentication-consistency-evidence.js';

const runId = '11111111-1111-4111-8111-111111111111';
const otherRunId = '55555555-5555-4555-8555-555555555555';
const recoveryPointId = '44444444-4444-4444-8444-444444444444';
const otherRecoveryPointId = '66666666-6666-4666-8666-666666666666';
const binding: AuthenticationConsistencyBinding = {
  runId,
  recoveryPointId,
  head: { sequence: 3, hash: 'a'.repeat(64) },
};
const evidence = (
  overrides: Partial<
    Record<keyof AuthenticationConsistencyEvidence, unknown>
  > = {},
) =>
  ({
    recoveryPointId,
    contexts: ['group-management'],
    consistencyDigest: new Uint8Array(32).fill(7),
    ...overrides,
  }) as AuthenticationConsistencyEvidence;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('Restoreのevidence digest書式', () => {
  const digest = createAuthenticationRestoreEvidenceDigest();
  const fingerprint = new Uint8Array(32).fill(9);

  // 独立実装（Python hashlib／struct）で算出した固定値。
  it.each([
    [
      'v6（コード不参加・証跡なし）',
      { fingerprint, codeClosure: null, consistency: null },
      '8ea7b7301c1cd21bc1d744b1bd4f7d597480eaca478f570e3825af31caf6eda6',
    ],
    [
      '証跡あり・コード不参加',
      { fingerprint, codeClosure: null, consistency: evidence() },
      '60f0d34639d25771257251f428b60801685feafeecdd6beba9678788d7bb5e04',
    ],
    [
      '証跡あり・コード参加・Context名は昇順へ並べ替える',
      {
        fingerprint,
        codeClosure: new Uint8Array(32).fill(5),
        consistency: evidence({
          contexts: ['settlement', 'group-management'],
        }),
      },
      'a005b4d12ac645b061e45cbe90b1725057ab213d7abc3c79593f6f28b6286542',
    ],
  ] as const)('%sのgolden vectorに一致する', (_name, input, expected) => {
    expect(hex(digest.digest(input))).toBe(expected);
  });

  it('fingerprintだけでなく証跡とコード参加の有無で値が変わる', () => {
    const base = hex(
      digest.digest({ fingerprint, codeClosure: null, consistency: null }),
    );
    expect(
      hex(
        digest.digest({
          fingerprint,
          codeClosure: null,
          consistency: evidence({
            consistencyDigest: new Uint8Array(32).fill(8),
          }),
        }),
      ),
    ).not.toBe(
      hex(
        digest.digest({
          fingerprint,
          codeClosure: null,
          consistency: evidence(),
        }),
      ),
    );
    expect(
      hex(
        digest.digest({
          fingerprint,
          codeClosure: null,
          consistency: evidence({ recoveryPointId: otherRecoveryPointId }),
        }),
      ),
    ).not.toBe(
      hex(
        digest.digest({
          fingerprint,
          codeClosure: null,
          consistency: evidence(),
        }),
      ),
    );
    expect(base).not.toBe(
      hex(
        digest.digest({
          fingerprint,
          codeClosure: new Uint8Array(32),
          consistency: null,
        }),
      ),
    );
  });

  it.each([
    ['短いfingerprint', { fingerprint: new Uint8Array(31) }],
    ['短いcode closure', { codeClosure: new Uint8Array(31) }],
    [
      '短いconsistencyDigest',
      { consistency: evidence({ consistencyDigest: new Uint8Array(31) }) },
    ],
    [
      'UUIDv4でない復旧点',
      { consistency: evidence({ recoveryPointId: 'not-a-uuid' }) },
    ],
    ['空のContext集合', { consistency: evidence({ contexts: [] }) }],
    [
      '重複したContext名',
      {
        consistency: evidence({
          contexts: ['group-management', 'group-management'],
        }),
      },
    ],
    ['不正なContext名', { consistency: evidence({ contexts: ['GM'] }) }],
  ])('%sを拒否する', (_name, override) => {
    expect(() =>
      digest.digest({
        fingerprint,
        codeClosure: null,
        consistency: null,
        ...override,
      }),
    ).toThrow(AuthenticationCryptoUnavailable);
  });
});

describe('整合証跡のregistry Adapter', () => {
  const fixture = (
    candidates: () => readonly unknown[] = () => [evidence()],
  ) => {
    const calls: AuthenticationConsistencyBinding[] = [];
    const source: AuthenticationConsistencyEvidenceSource = {
      verify: (input) =>
        Promise.resolve().then(() => {
          calls.push(input);
          return candidates() as readonly AuthenticationConsistencyEvidence[];
        }),
    };
    return {
      calls,
      registry: createAuthenticationConsistencyEvidenceRegistry({ source }),
    };
  };

  it('発行したhandleを同じbindingで1回だけ消費し、独立Copyを返す', async () => {
    const original = evidence({ contexts: ['settlement', 'group-management'] });
    const f = fixture(() => [original]);
    const handle = await f.registry.verify(binding);
    expect(f.calls).toEqual([binding]);
    const consumed = f.registry.consume(handle, { ...binding });
    expect(consumed.recoveryPointId).toBe(recoveryPointId);
    expect(consumed.contexts).toEqual(['group-management', 'settlement']);
    expect(hex(consumed.consistencyDigest)).toBe('07'.repeat(32));
    original.consistencyDigest.fill(0);
    expect(hex(consumed.consistencyDigest)).toBe('07'.repeat(32));
    expect(() => f.registry.consume(handle, binding)).toThrow(
      AuthenticationCryptoUnavailable,
    );
  });

  it('偽造handleと別registryのhandleを拒否する', async () => {
    const f = fixture();
    const other = fixture();
    const foreign = await other.registry.verify(binding);
    expect(() =>
      f.registry.consume(
        Object.freeze({}) as AuthenticationConsistencyEvidenceHandle,
        binding,
      ),
    ).toThrow(AuthenticationCryptoUnavailable);
    expect(() => f.registry.consume(foreign, binding)).toThrow(
      AuthenticationCryptoUnavailable,
    );
  });

  it.each([
    ['別run', { ...binding, runId: otherRunId }],
    ['別の復旧点', { ...binding, recoveryPointId: otherRecoveryPointId }],
    ['別sequence', { ...binding, head: { ...binding.head, sequence: 4 } }],
    ['別hash', { ...binding, head: { ...binding.head, hash: 'b'.repeat(64) } }],
  ])('%sのbindingでは消費せず、失効させる', async (_name, wrong) => {
    const f = fixture();
    const handle = await f.registry.verify(binding);
    expect(() => f.registry.consume(handle, wrong)).toThrow(
      AuthenticationCryptoUnavailable,
    );
    expect(() => f.registry.consume(handle, binding)).toThrow(
      AuthenticationCryptoUnavailable,
    );
  });

  it.each([
    ['不正なrun', { ...binding, runId: 'run' }],
    ['不正な復旧点', { ...binding, recoveryPointId: 'point' }],
    [
      '不正なhead',
      { ...binding, head: { sequence: -1, hash: 'a'.repeat(64) } },
    ],
  ])('%sではSourceを呼ばない', async (_name, wrong) => {
    const f = fixture();
    await expect(f.registry.verify(wrong)).rejects.toThrow(
      AuthenticationCryptoUnavailable,
    );
    expect(f.calls).toEqual([]);
  });

  it.each([
    ['一致なし（不足）', () => []],
    ['複数一致', () => [evidence(), evidence()]],
    [
      '別の復旧点の証跡',
      () => [evidence({ recoveryPointId: otherRecoveryPointId })],
    ],
    ['重複Context', () => [evidence({ contexts: ['a-b', 'a-b'] })]],
    ['空のContext', () => [evidence({ contexts: [] })]],
    ['短いdigest', () => [evidence({ consistencyDigest: new Uint8Array(31) })]],
    ['未知Field', () => [{ ...evidence(), verified: true }]],
    ['配列でない応答', () => evidence() as unknown as readonly unknown[]],
  ])('%sは検証済み証跡を発行しない', async (_name, candidates) => {
    const f = fixture(candidates);
    await expect(f.registry.verify(binding)).rejects.toThrow(
      AuthenticationCryptoUnavailable,
    );
  });

  it('Source障害を証跡不足として拒否する', async () => {
    const f = fixture(() => {
      throw new Error('synthetic source failure');
    });
    await expect(f.registry.verify(binding)).rejects.toThrow(
      AuthenticationCryptoUnavailable,
    );
  });
});
