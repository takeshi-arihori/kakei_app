import { describe, expect, it, vi } from 'vitest';

import {
  PROTECTED_RECORD_ALGORITHM,
  PROTECTED_RECORD_APP,
  PROTECTED_RECORD_ENVELOPE_VERSION,
  encodeCanonicalAad,
  type ProtectedRecordHeader,
} from './canonical-aad.js';
import {
  ProtectedRecordUnavailable,
  createProtectedRecordCodec,
  importProtectedRecordKey,
  type AlertSignal,
  type ProtectedRecordEnvelope,
  type ProtectedRecordKeyPort,
  type SealKeyAllocation,
} from './protected-record-codec.js';

const groupId = '00000000-0000-4000-8000-000000000001';
const logicalRecordId = '00000000-0000-4000-8000-000000000001';
const otherLogicalRecordId = '00000000-0000-4000-8000-000000000002';
const keyVersion = 'test-key-v1';
const goldenKey = importProtectedRecordKey(
  Uint8Array.from(
    Buffer.from(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      'hex',
    ),
  ),
);
const goldenNonce = Uint8Array.from(
  Buffer.from('000102030405060708090a0b', 'hex'),
);
const plaintext = new TextEncoder().encode(
  '{"groupName":"Example","ownerParticipantId":"participant-1"}',
);

const headerWithoutKeyVersion = {
  envelopeVersion: PROTECTED_RECORD_ENVELOPE_VERSION,
  algorithmId: PROTECTED_RECORD_ALGORITHM,
  app: PROTECTED_RECORD_APP,
  contextName: 'group-management' as const,
  recordKind: 'group' as const,
  groupId,
  logicalRecordId,
  schemaVersion: 1n,
  aggregateVersion: 1n,
  revisionOrdinal: null,
};

const expectedHeader: ProtectedRecordHeader = {
  ...headerWithoutKeyVersion,
  keyVersion,
};

const allocation = (
  overrides: Partial<Extract<SealKeyAllocation, { status: 'allocated' }>> = {},
): Extract<SealKeyAllocation, { status: 'allocated' }> => ({
  status: 'allocated',
  key: goldenKey,
  keyVersion,
  nonce: goldenNonce,
  sealCount: 1n,
  ...overrides,
});

const createPort = (
  sealAllocation: SealKeyAllocation = allocation(),
): ProtectedRecordKeyPort => ({
  allocateForSeal: vi.fn().mockResolvedValue(sealAllocation),
  readKey: vi.fn().mockResolvedValue({
    status: 'available',
    key: goldenKey,
    lifecycle: 'current',
  }),
  requestRotation: vi.fn().mockResolvedValue(undefined),
});

const sealGolden = async (
  port: ProtectedRecordKeyPort = createPort(),
  onAlert?: (signal: AlertSignal) => void,
): Promise<ProtectedRecordEnvelope> =>
  createProtectedRecordCodec({ keyPort: port, onAlert }).seal({
    header: headerWithoutKeyVersion,
    plaintext,
  });

const cloneEnvelope = (
  envelope: ProtectedRecordEnvelope,
): ProtectedRecordEnvelope => ({
  ...envelope,
  header: { ...envelope.header } as ProtectedRecordHeader,
  aad: Uint8Array.from(envelope.aad),
  nonce: Uint8Array.from(envelope.nonce),
  ciphertext: Uint8Array.from(envelope.ciphertext),
  authenticationTag: Uint8Array.from(envelope.authenticationTag),
});

describe('Protected record codec', () => {
  it('ADR #55のGolden vectorでsealし、current keyでopenする', async () => {
    const port = createPort();
    const alerts: AlertSignal[] = [];
    const codec = createProtectedRecordCodec({
      keyPort: port,
      onAlert: (signal) => alerts.push(signal),
    });

    const envelope = await codec.seal({
      header: headerWithoutKeyVersion,
      plaintext,
    });

    expect(Buffer.from(envelope.aad).toString('hex')).toBe(
      Buffer.from(encodeCanonicalAad(expectedHeader)).toString('hex'),
    );
    expect(Buffer.from(envelope.ciphertext).toString('hex')).toBe(
      '3c20b169aa90b255ec2cf2a98bcb3d15e2bbf7589559735e57108be06f3961c07579cd95dfa07cec3dc05dd7aaf7494a9a3003e42ab7cdae12a60864',
    );
    expect(Buffer.from(envelope.authenticationTag).toString('hex')).toBe(
      '0ae81bdd10551bea4d6e951f71e9963f',
    );
    await expect(codec.open({ expectedHeader, envelope })).resolves.toEqual(
      plaintext,
    );
    expect(alerts).toEqual([]);
  });

  it('NonceをCaller入力にせず、KeyPortからSealごとに割り当てる', async () => {
    const secondNonce = Uint8Array.from(goldenNonce);
    secondNonce[11] = 0x0c;
    const port = createPort();
    vi.mocked(port.allocateForSeal)
      .mockResolvedValueOnce(allocation())
      .mockResolvedValueOnce(allocation({ nonce: secondNonce, sealCount: 2n }));
    const codec = createProtectedRecordCodec({ keyPort: port });

    const first = await codec.seal({
      header: headerWithoutKeyVersion,
      plaintext,
    });
    const second = await codec.seal({
      header: headerWithoutKeyVersion,
      plaintext,
    });

    expect(first.nonce).toEqual(goldenNonce);
    expect(second.nonce).toEqual(secondNonce);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
    expect(port.allocateForSeal).toHaveBeenCalledTimes(2);
  });

  it('2^31回目以降はRotationを要求してsealを継続する', async () => {
    const port = createPort(allocation({ sealCount: 1n << 31n }));
    const codec = createProtectedRecordCodec({ keyPort: port });

    await expect(
      codec.seal({ header: headerWithoutKeyVersion, plaintext }),
    ).resolves.toBeDefined();
    expect(port.requestRotation).toHaveBeenCalledWith({
      contextName: 'group-management',
      groupId,
      keyVersion,
      reason: 'seal-threshold',
    });
  });

  it('Rotation要求の失敗と不正Nonce allocationをfail-closedにする', async () => {
    const rotationFailurePort = createPort(
      allocation({ sealCount: 1n << 31n }),
    );
    vi.mocked(rotationFailurePort.requestRotation).mockRejectedValue(
      new Error('provider unavailable'),
    );
    const rotationAlerts: AlertSignal[] = [];

    await expect(
      createProtectedRecordCodec({
        keyPort: rotationFailurePort,
        onAlert: (signal) => rotationAlerts.push(signal),
      }).seal({ header: headerWithoutKeyVersion, plaintext }),
    ).rejects.toBeInstanceOf(ProtectedRecordUnavailable);
    expect(rotationAlerts).toEqual([
      { operation: 'seal', code: 'ROTATION_REQUEST_FAILED' },
    ]);

    const invalidNoncePort = createPort(
      allocation({ nonce: goldenNonce.subarray(0, 11) }),
    );
    await expect(
      createProtectedRecordCodec({ keyPort: invalidNoncePort }).seal({
        header: headerWithoutKeyVersion,
        plaintext,
      }),
    ).rejects.toBeInstanceOf(ProtectedRecordUnavailable);
    expect(invalidNoncePort.requestRotation).toHaveBeenCalledWith({
      contextName: 'group-management',
      groupId,
      keyVersion,
      reason: 'nonce-invalid',
    });
  });

  it('2^32回到達、counter regression、Key lossではfail-closedでRotationを要求する', async () => {
    const cases: readonly Readonly<{
      allocation: SealKeyAllocation;
      alertCode: AlertSignal['code'];
      reason: string;
    }>[] = [
      {
        allocation: allocation({ sealCount: 1n << 32n }),
        alertCode: 'SEAL_LIMIT_REACHED',
        reason: 'seal-limit',
      },
      {
        allocation: { status: 'counter-regressed', keyVersion },
        alertCode: 'COUNTER_REGRESSION',
        reason: 'counter-regression',
      },
      {
        allocation: { status: 'key-lost', keyVersion },
        alertCode: 'KEY_UNAVAILABLE',
        reason: 'key-loss',
      },
    ];

    for (const testCase of cases) {
      const port = createPort(testCase.allocation);
      const alerts: AlertSignal[] = [];
      const codec = createProtectedRecordCodec({
        keyPort: port,
        onAlert: (signal) => alerts.push(signal),
      });

      await expect(
        codec.seal({ header: headerWithoutKeyVersion, plaintext }),
      ).rejects.toBeInstanceOf(ProtectedRecordUnavailable);
      expect(port.requestRotation).toHaveBeenCalledWith({
        contextName: 'group-management',
        groupId,
        keyVersion,
        reason: testCase.reason,
      });
      expect(alerts).toContainEqual({
        operation: 'seal',
        code: testCase.alertCode,
      });
    }
  });

  it.each(['current', 'retired'] as const)(
    '%s keyをkeyVersion指定でdual readする',
    async (lifecycle) => {
      const envelope = await sealGolden();
      const port = createPort();
      vi.mocked(port.readKey).mockResolvedValue({
        status: 'available',
        key: goldenKey,
        lifecycle,
      });
      const codec = createProtectedRecordCodec({ keyPort: port });

      await expect(codec.open({ expectedHeader, envelope })).resolves.toEqual(
        plaintext,
      );
      expect(port.readKey).toHaveBeenCalledWith({
        contextName: 'group-management',
        groupId,
        keyVersion,
      });
    },
  );

  it('noncanonical AADはKey read／decrypt前にgeneric Unavailableで拒否する', async () => {
    const envelope = cloneEnvelope(await sealGolden());
    envelope.aad[0] = 0x7f;
    const port = createPort();
    const alerts: AlertSignal[] = [];
    const codec = createProtectedRecordCodec({
      keyPort: port,
      onAlert: (signal) => alerts.push(signal),
    });

    await expect(codec.open({ expectedHeader, envelope })).rejects.toEqual(
      new ProtectedRecordUnavailable(),
    );
    expect(port.readKey).not.toHaveBeenCalled();
    expect(alerts).toEqual([{ operation: 'open', code: 'AAD_INVALID' }]);
  });

  it.each([
    [
      'envelope version',
      { ...expectedHeader, envelopeVersion: 2n } as ProtectedRecordHeader,
    ],
    [
      'algorithm',
      {
        ...expectedHeader,
        algorithmId: 'AES-128-GCM',
      } as unknown as ProtectedRecordHeader,
    ],
    [
      'app',
      {
        ...expectedHeader,
        app: 'other_app',
      } as unknown as ProtectedRecordHeader,
    ],
    [
      'context',
      {
        ...expectedHeader,
        contextName: 'settlement',
        recordKind: 'snapshot-revision',
        aggregateVersion: null,
        revisionOrdinal: 1n,
      } as ProtectedRecordHeader,
    ],
    [
      'record kind',
      { ...expectedHeader, recordKind: 'participant' } as ProtectedRecordHeader,
    ],
    [
      'group ID',
      {
        ...expectedHeader,
        groupId: '00000000-0000-4000-8000-000000000002',
      } as ProtectedRecordHeader,
    ],
    [
      'logical record ID',
      {
        ...expectedHeader,
        logicalRecordId: otherLogicalRecordId,
      } as ProtectedRecordHeader,
    ],
    [
      'schema version',
      { ...expectedHeader, schemaVersion: 2n } as ProtectedRecordHeader,
    ],
    [
      'key version',
      { ...expectedHeader, keyVersion: 'test-key-v2' } as ProtectedRecordHeader,
    ],
    [
      'aggregate version',
      { ...expectedHeader, aggregateVersion: 2n } as ProtectedRecordHeader,
    ],
  ])('%s差替えをKey read前に拒否する', async (_name, mismatch) => {
    const envelope = await sealGolden();
    const port = createPort();

    await expect(
      createProtectedRecordCodec({ keyPort: port }).open({
        expectedHeader: mismatch,
        envelope,
      }),
    ).rejects.toBeInstanceOf(ProtectedRecordUnavailable);
    expect(port.readKey).not.toHaveBeenCalled();
  });

  it('Snapshot revisionOrdinal差替えをKey read前に拒否する', async () => {
    const snapshotSealHeader = {
      ...headerWithoutKeyVersion,
      contextName: 'settlement' as const,
      recordKind: 'snapshot-revision' as const,
      aggregateVersion: null,
      revisionOrdinal: 1n,
    };
    const codec = createProtectedRecordCodec({ keyPort: createPort() });
    const envelope = await codec.seal({
      header: snapshotSealHeader,
      plaintext,
    });
    const port = createPort();

    await expect(
      createProtectedRecordCodec({ keyPort: port }).open({
        expectedHeader: {
          ...envelope.header,
          revisionOrdinal: 2n,
        } as ProtectedRecordHeader,
        envelope,
      }),
    ).rejects.toBeInstanceOf(ProtectedRecordUnavailable);
    expect(port.readKey).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'header',
      mutate: (value: ProtectedRecordEnvelope): void => {
        value.header = {
          ...value.header,
          logicalRecordId: otherLogicalRecordId,
        } as ProtectedRecordHeader;
      },
      keyRead: false,
      alertCode: 'HEADER_MISMATCH',
    },
    {
      name: '別row expectation',
      mutate: (): void => undefined,
      expectation: {
        ...expectedHeader,
        logicalRecordId: otherLogicalRecordId,
      } as ProtectedRecordHeader,
      keyRead: false,
      alertCode: 'HEADER_MISMATCH',
    },
    {
      name: 'ciphertext',
      mutate: (value: ProtectedRecordEnvelope): void => {
        value.ciphertext[0] ^= 0xff;
      },
      keyRead: true,
      alertCode: 'AUTHENTICATION_FAILED',
    },
    {
      name: 'tag',
      mutate: (value: ProtectedRecordEnvelope): void => {
        value.authenticationTag[0] ^= 0xff;
      },
      keyRead: true,
      alertCode: 'AUTHENTICATION_FAILED',
    },
    {
      name: 'nonce length',
      mutate: (value: ProtectedRecordEnvelope): void => {
        value.nonce = value.nonce.subarray(0, 11);
      },
      keyRead: false,
      alertCode: 'ENVELOPE_INVALID',
    },
    {
      name: 'tag length',
      mutate: (value: ProtectedRecordEnvelope): void => {
        value.authenticationTag = value.authenticationTag.subarray(0, 15);
      },
      keyRead: false,
      alertCode: 'ENVELOPE_INVALID',
    },
  ])('$nameの差替えを部分復号せず拒否する', async (testCase) => {
    const envelope = cloneEnvelope(await sealGolden());
    testCase.mutate(envelope);
    const port = createPort();
    const alerts: AlertSignal[] = [];
    const codec = createProtectedRecordCodec({
      keyPort: port,
      onAlert: (signal) => alerts.push(signal),
    });

    await expect(
      codec.open({
        expectedHeader: testCase.expectation ?? expectedHeader,
        envelope,
      }),
    ).rejects.toBeInstanceOf(ProtectedRecordUnavailable);
    expect(port.readKey).toHaveBeenCalledTimes(testCase.keyRead ? 1 : 0);
    expect(alerts).toEqual([{ operation: 'open', code: testCase.alertCode }]);
  });

  it('別ContextのAAD差替えをdecrypt前に拒否する', async () => {
    const envelope = cloneEnvelope(await sealGolden());
    const otherContextHeader: ProtectedRecordHeader = {
      ...expectedHeader,
      contextName: 'settlement',
      recordKind: 'snapshot-revision',
      aggregateVersion: null,
      revisionOrdinal: 1n,
    };
    envelope.aad = encodeCanonicalAad(otherContextHeader);
    envelope.header = otherContextHeader;
    const port = createPort();

    await expect(
      createProtectedRecordCodec({ keyPort: port }).open({
        expectedHeader,
        envelope,
      }),
    ).rejects.toBeInstanceOf(ProtectedRecordUnavailable);
    expect(port.readKey).not.toHaveBeenCalled();
  });

  it('Key lossと不正Key長をgeneric Unavailableにし、Alertへ機密値を含めない', async () => {
    const envelope = await sealGolden();
    const cases = [
      { status: 'key-lost' as const },
      {
        status: 'available' as const,
        lifecycle: 'current' as const,
        key: Uint8Array.from([1]) as ReturnType<
          typeof importProtectedRecordKey
        >,
      },
    ];

    for (const readResult of cases) {
      const port = createPort();
      vi.mocked(port.readKey).mockResolvedValue(readResult);
      const alerts: AlertSignal[] = [];
      const codec = createProtectedRecordCodec({
        keyPort: port,
        onAlert: (signal) => alerts.push(signal),
      });

      await expect(
        codec.open({ expectedHeader, envelope }),
      ).rejects.toBeInstanceOf(ProtectedRecordUnavailable);
      expect(alerts).toHaveLength(1);
      expect(Object.keys(alerts[0] ?? {}).sort()).toEqual([
        'code',
        'operation',
      ]);
      expect(JSON.stringify(alerts)).not.toContain(keyVersion);
      expect(JSON.stringify(alerts)).not.toContain(groupId);
      expect(JSON.stringify(alerts)).not.toContain(
        Buffer.from(goldenKey).toString('hex'),
      );
    }
  });
});
