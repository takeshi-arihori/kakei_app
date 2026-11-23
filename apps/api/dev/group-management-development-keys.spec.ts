import { describe, expect, it } from 'vitest';
import type { DigestPurpose } from '../src/shared/application/purpose-separated-digest.js';
import {
  PROTECTED_RECORD_ALGORITHM,
  PROTECTED_RECORD_APP,
  PROTECTED_RECORD_ENVELOPE_VERSION,
} from '../src/shared/infrastructure/protected-record/canonical-aad.js';
import {
  ProtectedRecordUnavailable,
  createProtectedRecordCodec,
} from '../src/shared/infrastructure/protected-record/protected-record-codec.js';
import { createGroupManagementDevelopmentKeys } from './group-management-development-keys.js';

// 大文字化で値が変わるよう英字を含める。
const groupId = '00000000-0000-4000-8000-00000000a313';
const otherGroupId = '00000000-0000-4000-8000-000000000314';
const scope = { contextName: 'group-management' as const, groupId };
const header = {
  envelopeVersion: PROTECTED_RECORD_ENVELOPE_VERSION,
  algorithmId: PROTECTED_RECORD_ALGORITHM,
  app: PROTECTED_RECORD_APP,
  contextName: 'group-management' as const,
  recordKind: 'group' as const,
  groupId,
  logicalRecordId: '00000000-0000-4000-8000-000000000001',
  schemaVersion: 1n,
  aggregateVersion: 1n,
  revisionOrdinal: null,
};
const plaintext = new TextEncoder().encode('{"synthetic":true}');
const input = new Uint8Array([1, 2, 3, 4]);
const allowedPurposes: readonly DigestPurpose[] = [
  'group-actor-access-index/v1',
  'group-membership-index/v1',
  'group-operation-fingerprint/v1',
];
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const allocated = async (
  keys: ReturnType<typeof createGroupManagementDevelopmentKeys>,
  group = groupId,
) => {
  const value = await keys.recordKeys.allocateForSeal({
    ...scope,
    groupId: group,
  });
  if (value.status !== 'allocated') throw new Error('割当が必要');
  return value;
};

describe('開発用Group鍵Providerの許可Listとprocess境界', () => {
  it('同一Groupの並行割当でNonceを重複させず単調に割り当て、Group間でDEKを分ける', async () => {
    const keys = createGroupManagementDevelopmentKeys();
    const values = await Promise.all(
      Array.from({ length: 20 }, () => keys.recordKeys.allocateForSeal(scope)),
    );
    const allocations = values.map((v) => {
      if (v.status !== 'allocated') throw new Error('割当が必要');
      return v;
    });
    expect(new Set(allocations.map((v) => hex(v.nonce))).size).toBe(20);
    expect(allocations.map((v) => v.sealCount)).toEqual(
      Array.from({ length: 20 }, (_, n) => BigInt(n + 1)),
    );
    expect(allocations.every((v) => v.nonce.length === 12)).toBe(true);
    expect(allocations.every((v) => v.keyVersion === keys.keyVersion)).toBe(
      true,
    );
    expect(new Set(allocations.map((v) => hex(v.key))).size).toBe(1);
    const other = await allocated(keys, otherGroupId);
    expect(other.sealCount).toBe(1n);
    expect(hex(other.key)).not.toBe(hex(allocations[0].key));
  });

  it('許可外のContextと非Canonical Group IDを拒否し、拒否後もCounterを戻さない', async () => {
    const keys = createGroupManagementDevelopmentKeys();
    expect((await allocated(keys)).sealCount).toBe(1n);
    await expect(
      keys.recordKeys.allocateForSeal({
        contextName: 'settlement',
        groupId,
      }),
    ).rejects.toThrow();
    await expect(
      keys.recordKeys.allocateForSeal({
        ...scope,
        groupId: groupId.toUpperCase(),
      }),
    ).rejects.toThrow();
    await expect(
      keys.recordKeys.readKey({
        contextName: 'settlement',
        groupId,
        keyVersion: keys.keyVersion,
      }),
    ).rejects.toThrow();
    expect((await allocated(keys)).sealCount).toBe(2n);
  });

  it('実Codecで往復でき、別Provider・旧keyVersionでは開封しない。返却鍵の変更は元鍵へ波及しない', async () => {
    const keys = createGroupManagementDevelopmentKeys();
    const codec = createProtectedRecordCodec({ keyPort: keys.recordKeys });
    const envelope = await codec.seal({ header, plaintext });
    expect(envelope.header.keyVersion).toBe(keys.keyVersion);
    const opened = await codec.open({
      expectedHeader: envelope.header,
      envelope,
    });
    expect(Buffer.from(opened).equals(Buffer.from(plaintext))).toBe(true);

    const leaked = await allocated(keys);
    leaked.key.fill(0);
    expect(
      Buffer.from(
        await codec.open({ expectedHeader: envelope.header, envelope }),
      ).equals(Buffer.from(plaintext)),
    ).toBe(true);

    const other = createGroupManagementDevelopmentKeys();
    expect(other.keyVersion).not.toBe(keys.keyVersion);
    await expect(
      createProtectedRecordCodec({ keyPort: other.recordKeys }).open({
        expectedHeader: envelope.header,
        envelope,
      }),
    ).rejects.toBeInstanceOf(ProtectedRecordUnavailable);
    expect(
      await keys.recordKeys.readKey({ ...scope, keyVersion: 'old-version' }),
    ).toEqual({ status: 'key-lost' });
    expect(
      await keys.recordKeys.readKey({
        ...scope,
        groupId: otherGroupId,
        keyVersion: keys.keyVersion,
      }),
    ).toEqual({ status: 'key-lost' });
  });

  it('許可Listの3用途は用途・Group・Provider生成ごとに別Digestとなり、許可外の用途を拒否する', async () => {
    const keys = createGroupManagementDevelopmentKeys();
    const digests: string[] = [];
    for (const purpose of allowedPurposes) {
      const value = await keys.policyDigests.digest({
        purpose,
        groupId,
        canonicalInput: input,
      });
      expect(value.digestKeyVersion).toBe(keys.keyVersion);
      expect(value.digest.length).toBe(32);
      digests.push(hex(value.digest));
      const again = await keys.policyDigests.digest({
        purpose,
        groupId,
        canonicalInput: input,
      });
      expect(hex(again.digest)).toBe(hex(value.digest));
      digests.push(
        hex(
          (
            await keys.policyDigests.digest({
              purpose,
              groupId: otherGroupId,
              canonicalInput: input,
            })
          ).digest,
        ),
      );
    }
    const locator = await keys.locatorKeys.currentDigest({
      purpose: 'group-operation-locator/v2',
      canonicalInput: input,
    });
    digests.push(hex(locator.digest));
    expect(new Set(digests).size).toBe(7);

    const other = createGroupManagementDevelopmentKeys();
    expect(
      hex(
        (
          await other.policyDigests.digest({
            purpose: allowedPurposes[0],
            groupId,
            canonicalInput: input,
          })
        ).digest,
      ),
    ).not.toBe(digests[0]);

    for (const purpose of [
      'group-operation-locator/v2',
      // Context単位の索引鍵はGroup単位HMACの許可Listへ入れない（#306 §1）。
      'group-actor-membership-index/v1',
      'gm-recipient-code-request/v1',
      'settlement-index/v1',
    ])
      await expect(
        keys.policyDigests.digest({
          purpose: purpose as DigestPurpose,
          groupId,
          canonicalInput: input,
        }),
      ).rejects.toThrow();
    await expect(
      keys.policyDigests.digest({
        purpose: allowedPurposes[0],
        groupId: 'not-a-group',
        canonicalInput: input,
      }),
    ).rejects.toThrow();
    await expect(
      keys.policyDigests.digest({
        purpose: allowedPurposes[0],
        groupId,
        canonicalInput: new Uint8Array(),
      }),
    ).rejects.toThrow();
  });

  it('locatorは現行世代だけを返し、locator以外の用途を拒否する', async () => {
    const keys = createGroupManagementDevelopmentKeys();
    const locatorInput = {
      purpose: 'group-operation-locator/v2' as const,
      canonicalInput: input,
    };
    const current = await keys.locatorKeys.currentDigest(locatorInput);
    const candidates = await keys.locatorKeys.candidateDigests(locatorInput);
    expect(current.digestKeyVersion).toBe(keys.keyVersion);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].digestKeyVersion).toBe(keys.keyVersion);
    expect(hex(candidates[0].digest)).toBe(hex(current.digest));
    const wrong = {
      purpose: 'group-actor-access-index/v1',
      canonicalInput: input,
    } as unknown as typeof locatorInput;
    await expect(keys.locatorKeys.currentDigest(wrong)).rejects.toThrow();
    await expect(keys.locatorKeys.candidateDigests(wrong)).rejects.toThrow();
  });

  it('Actor単位Group索引の鍵は専用用途だけを受け、現行世代1件を返し、他用途・別Provider生成とMaterialを共有しない', async () => {
    const keys = createGroupManagementDevelopmentKeys();
    const membershipInput = {
      purpose: 'group-actor-membership-index/v1' as const,
      canonicalInput: input,
    };
    const current =
      await keys.membershipIndexKeys.currentDigest(membershipInput);
    const candidates =
      await keys.membershipIndexKeys.candidateDigests(membershipInput);
    expect(current.digestKeyVersion).toBe(keys.keyVersion);
    expect(current.digest.length).toBe(32);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].digestKeyVersion).toBe(keys.keyVersion);
    expect(hex(candidates[0].digest)).toBe(hex(current.digest));
    expect(
      hex(
        (await keys.membershipIndexKeys.currentDigest(membershipInput)).digest,
      ),
    ).toBe(hex(current.digest));

    // 同じ入力でも、locator・Group単位HMACとは別の鍵で計算される。
    const locator = await keys.locatorKeys.currentDigest({
      purpose: 'group-operation-locator/v2',
      canonicalInput: input,
    });
    expect(hex(locator.digest)).not.toBe(hex(current.digest));
    for (const purpose of allowedPurposes)
      expect(
        hex(
          (
            await keys.policyDigests.digest({
              purpose,
              groupId,
              canonicalInput: input,
            })
          ).digest,
        ),
      ).not.toBe(hex(current.digest));
    const other = createGroupManagementDevelopmentKeys();
    expect(
      hex(
        (await other.membershipIndexKeys.currentDigest(membershipInput)).digest,
      ),
    ).not.toBe(hex(current.digest));

    for (const purpose of [
      'group-operation-locator/v2',
      'group-actor-access-index/v1',
      'group-membership-index/v1',
    ]) {
      const wrong = {
        purpose,
        canonicalInput: input,
      } as unknown as typeof membershipInput;
      await expect(
        keys.membershipIndexKeys.currentDigest(wrong),
      ).rejects.toThrow();
      await expect(
        keys.membershipIndexKeys.candidateDigests(wrong),
      ).rejects.toThrow();
    }
    await expect(
      keys.locatorKeys.currentDigest({
        ...membershipInput,
      } as unknown as Parameters<typeof keys.locatorKeys.currentDigest>[0]),
    ).rejects.toThrow();
    const empty = { ...membershipInput, canonicalInput: new Uint8Array() };
    await expect(
      keys.membershipIndexKeys.currentDigest(empty),
    ).rejects.toThrow();
    await expect(
      keys.membershipIndexKeys.candidateDigests(empty),
    ).rejects.toThrow();
  });

  it('索引鍵の完了前・後にdisposeされた場合は、計算済みの値も返さず以後も拒否する', async () => {
    const keys = createGroupManagementDevelopmentKeys();
    const membershipInput = {
      purpose: 'group-actor-membership-index/v1' as const,
      canonicalInput: input,
    };
    const pending = [
      keys.membershipIndexKeys.currentDigest(membershipInput),
      keys.membershipIndexKeys.candidateDigests(membershipInput),
    ];
    keys.dispose();
    for (const value of pending) await expect(value).rejects.toThrow();
    await expect(
      keys.membershipIndexKeys.currentDigest(membershipInput),
    ).rejects.toThrow();
    await expect(
      keys.membershipIndexKeys.candidateDigests(membershipInput),
    ).rejects.toThrow();
  });

  it('Rotation要求は対象Groupの封印を止めて必ず失敗し、Codecの封印もfail-closedになる', async () => {
    const keys = createGroupManagementDevelopmentKeys();
    const codec = createProtectedRecordCodec({ keyPort: keys.recordKeys });
    const envelope = await codec.seal({ header, plaintext });
    await expect(
      keys.recordKeys.requestRotation({
        ...scope,
        keyVersion: keys.keyVersion,
        reason: 'seal-threshold',
      }),
    ).rejects.toThrow();
    expect((await keys.recordKeys.allocateForSeal(scope)).status).toBe(
      'key-lost',
    );
    await expect(codec.seal({ header, plaintext })).rejects.toBeInstanceOf(
      ProtectedRecordUnavailable,
    );
    expect(
      await keys.recordKeys.readKey({ ...scope, keyVersion: keys.keyVersion }),
    ).toMatchObject({ status: 'available', lifecycle: 'retired' });
    expect(
      Buffer.from(
        await codec.open({ expectedHeader: envelope.header, envelope }),
      ).equals(Buffer.from(plaintext)),
    ).toBe(true);
    expect((await allocated(keys, otherGroupId)).sealCount).toBe(1n);
  });

  it('割当の完了前にdisposeされた場合は、消去済みの鍵を割当済みとして返さない', async () => {
    const keys = createGroupManagementDevelopmentKeys();
    await allocated(keys);
    const pending = keys.recordKeys.allocateForSeal(scope);
    keys.dispose();
    expect(await pending).toEqual({
      status: 'key-lost',
      keyVersion: keys.keyVersion,
    });
  });

  it('Digest・locatorの完了前にdisposeされた場合は、計算済みの値も返さない', async () => {
    const keys = createGroupManagementDevelopmentKeys();
    const locatorInput = {
      purpose: 'group-operation-locator/v2' as const,
      canonicalInput: input,
    };
    const pending = [
      keys.policyDigests.digest({
        purpose: allowedPurposes[0],
        groupId,
        canonicalInput: input,
      }),
      keys.locatorKeys.currentDigest(locatorInput),
      keys.locatorKeys.candidateDigests(locatorInput),
    ];
    keys.dispose();
    for (const value of pending) await expect(value).rejects.toThrow();
  });

  it('dispose後は割当・読取・Digest・locatorを再開せず、既存の暗号文も開封しない', async () => {
    const keys = createGroupManagementDevelopmentKeys();
    const codec = createProtectedRecordCodec({ keyPort: keys.recordKeys });
    const envelope = await codec.seal({ header, plaintext });
    keys.dispose();
    keys.dispose();
    expect(await keys.recordKeys.allocateForSeal(scope)).toEqual({
      status: 'key-lost',
      keyVersion: keys.keyVersion,
    });
    expect(
      await keys.recordKeys.readKey({ ...scope, keyVersion: keys.keyVersion }),
    ).toEqual({ status: 'key-lost' });
    await expect(
      codec.open({ expectedHeader: envelope.header, envelope }),
    ).rejects.toBeInstanceOf(ProtectedRecordUnavailable);
    await expect(
      keys.policyDigests.digest({
        purpose: allowedPurposes[0],
        groupId,
        canonicalInput: input,
      }),
    ).rejects.toThrow();
    await expect(
      keys.locatorKeys.currentDigest({
        purpose: 'group-operation-locator/v2',
        canonicalInput: input,
      }),
    ).rejects.toThrow();
    await expect(
      keys.locatorKeys.candidateDigests({
        purpose: 'group-operation-locator/v2',
        canonicalInput: input,
      }),
    ).rejects.toThrow();
  });
});
