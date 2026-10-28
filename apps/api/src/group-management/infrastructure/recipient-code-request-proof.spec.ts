import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { RecipientCodeSecret } from '../../shared/application/authentication/recipient-code-input.js';
import type { RecipientCodeMacKey } from '../../shared/application/authentication/recipient-code-crypto-ports.js';
import type { RecipientCodeMacKeyLifecyclePort } from '../../shared/application/authentication/recipient-code-key-lifecycle.js';
import type {
  RecipientCodeRequestProof,
  RecipientCodeRequestProofKey,
  RecipientCodeRequestProofKeyQuery,
  RecipientCodeRequestProofKeyPort,
} from '../application/recipient-code-request-proof.js';
import { RecipientCodeRequestProofUnavailable } from '../application/recipient-code-request-proof.js';
import {
  createRecipientCodeRequestProof,
  importRecipientCodeRequestProofKey,
} from './recipient-code-request-proof.js';
import vectors from '../../shared/infrastructure/authentication/test/recipient-code-golden-vectors.json' with { type: 'json' };

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const secret = (value = vectors.decodedCodeHex) =>
  RecipientCodeSecret.parse(Buffer.from(value, 'hex').toString('base64url'))!;
const fixture = () => {
  const material = bytes(vectors.keyHex.proof);
  const readKey = vi.fn(async (query: RecipientCodeRequestProofKeyQuery) => {
    await Promise.resolve();
    return {
      status: 'available' as const,
      ...query,
      key: importRecipientCodeRequestProofKey(material),
    };
  });
  const keys = { readKey };
  const onAlert = vi.fn();
  return {
    material,
    keys,
    onAlert,
    proof: createRecipientCodeRequestProof({ keys, onAlert }),
  };
};

describe('GM所有の招待コード再送proof', () => {
  it('独立Python参照vectorに一致し、用途/Scope/世代を保持する', async () => {
    const f = fixture();
    const result = await f.proof.create({
      secret: secret(),
      keyVersion: 'proof-1',
    });
    expect(result).toMatchObject({
      purpose: 'gm-recipient-code-request/v1',
      keyVersion: 'proof-1',
      epoch: null,
      scopeId: 'group-management',
    });
    expect(Buffer.from(result.bytes).toString('hex')).toBe(
      vectors.vectors.proof.hmacHex,
    );
    expect(await f.proof.verify({ secret: secret(), saved: result })).toBe(
      true,
    );
    expect(
      await f.proof.verify({ secret: secret('ff'.repeat(32)), saved: result }),
    ).toBe(false);
    expect(f.onAlert).not.toHaveBeenCalled();
    expect(f.keys.readKey).toHaveBeenCalledWith({
      keyVersion: 'proof-1',
      epoch: null,
      scopeId: 'group-management',
    });
  });

  it('現行世代の変更後も保存proofの旧世代で検証し、認証Recordを要求しない', async () => {
    const generations = new Map([
      ['proof-1', bytes(vectors.keyHex.proof)],
      ['proof-2', new Uint8Array(32).fill(200)],
    ]);
    const readKey = vi.fn<RecipientCodeRequestProofKeyPort['readKey']>(
      async (query) => {
        await Promise.resolve();
        const material = generations.get(query.keyVersion);
        return material
          ? {
              status: 'available',
              ...query,
              key: importRecipientCodeRequestProofKey(material),
            }
          : { status: 'unavailable' };
      },
    );
    const proof = createRecipientCodeRequestProof({ keys: { readKey } });
    const saved = await proof.create({
      secret: secret(),
      keyVersion: 'proof-1',
    });
    const current = await proof.create({
      secret: secret(),
      keyVersion: 'proof-2',
    });
    expect(current.bytes).not.toEqual(saved.bytes);
    expect(await proof.verify({ secret: secret(), saved })).toBe(true);
    expect(readKey).toHaveBeenLastCalledWith({
      keyVersion: 'proof-1',
      epoch: null,
      scopeId: 'group-management',
    });
    generations.delete('proof-1');
    await expect(proof.verify({ secret: secret(), saved })).rejects.toEqual(
      new RecipientCodeRequestProofUnavailable(),
    );
  });

  it.each([
    { purpose: 'auth-recipient-code-lookup/v1' },
    { scopeId: vectors.row.codeId },
    { epoch: vectors.row.epoch },
    { keyVersion: '' },
    { keyVersion: '鍵' },
    { keyVersion: 'p'.repeat(256) },
    { bytes: new Uint8Array(31) },
    { bytes: new Uint8Array(33) },
    { unknown: true },
  ])('不正な保存Descriptorは鍵取得前に拒否する: %j', async (patch) => {
    const f = fixture();
    const saved = await f.proof.create({
      secret: secret(),
      keyVersion: 'proof-1',
    });
    f.keys.readKey.mockClear();
    await expect(
      f.proof.verify({
        secret: secret(),
        saved: { ...saved, ...patch } as unknown as RecipientCodeRequestProof,
      }),
    ).rejects.toEqual(new RecipientCodeRequestProofUnavailable());
    expect(f.keys.readKey).not.toHaveBeenCalled();
  });

  it.each([
    'purpose',
    'scopeId',
    'keyVersion',
    'epoch',
    'material',
    'status',
    'extra',
  ])('Provider返却%sの不整合は汎用失敗とする', async (field) => {
    const f = fixture();
    f.keys.readKey.mockImplementation(async (q) => {
      await Promise.resolve();
      const key = importRecipientCodeRequestProofKey(f.material);
      const response = { status: 'available', ...q, key };
      const invalid: unknown =
        field === 'purpose'
          ? {
              ...response,
              key: { ...key, purpose: 'auth-recipient-code-lookup/v1' },
            }
          : field === 'material'
            ? { ...response, key: { ...key, material: new Uint8Array(33) } }
            : { ...response, [field]: 'invalid' };
      return invalid as Awaited<ReturnType<typeof f.keys.readKey>>;
    });
    await expect(
      f.proof.create({ secret: secret(), keyVersion: 'proof-1' }),
    ).rejects.toEqual(new RecipientCodeRequestProofUnavailable());
    expect(f.onAlert).toHaveBeenCalledExactlyOnceWith({
      code: 'RECIPIENT_CODE_REQUEST_PROOF_UNAVAILABLE',
    });
  });

  it('Provider例外と通知例外を公開しない', async () => {
    const f = fixture();
    f.keys.readKey.mockRejectedValue(new Error('provider-secret'));
    const proof = createRecipientCodeRequestProof({
      keys: f.keys,
      onAlert: () => {
        throw new Error('alert-secret');
      },
    });
    await expect(
      proof.create({ secret: secret(), keyVersion: 'proof-1' }),
    ).rejects.toEqual(new RecipientCodeRequestProofUnavailable());
  });

  it('保存proof/入力Descriptorを鍵取得待ちの間の変更から切り離す', async () => {
    const f = fixture();
    const saved = {
      ...(await f.proof.create({ secret: secret(), keyVersion: 'proof-1' })),
    };
    let release!: (r: Awaited<ReturnType<typeof f.keys.readKey>>) => void;
    f.keys.readKey.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const input = { secret: secret(), saved };
    const verification = f.proof.verify(input);
    input.secret = secret('ff'.repeat(32));
    saved.keyVersion = 'proof-2';
    saved.bytes.fill(0);
    release({
      status: 'available',
      keyVersion: 'proof-1',
      epoch: null,
      scopeId: 'group-management',
      key: importRecipientCodeRequestProofKey(f.material),
    });
    expect(await verification).toBe(true);
  });

  it('Importは鍵をCopyし、出力は後のProvider Buffer変更を受けない', async () => {
    const material = bytes(vectors.keyHex.proof);
    const key = importRecipientCodeRequestProofKey(material);
    material.fill(0);
    expect(Buffer.from(key.material).toString('hex')).toBe(
      vectors.keyHex.proof,
    );
    const f = fixture();
    const saved = await f.proof.create({
      secret: secret(),
      keyVersion: 'proof-1',
    });
    f.material.fill(0);
    expect(Buffer.from(saved.bytes).toString('hex')).toBe(
      vectors.vectors.proof.hmacHex,
    );
    for (const length of [0, 31, 33])
      expect(() =>
        importRecipientCodeRequestProofKey(new Uint8Array(length)),
      ).toThrow(RecipientCodeRequestProofUnavailable);
  });

  it('GM鍵/証明は認証鍵と異なるBrandで、読取Portは全世代破棄能力を持たない', () => {
    expectTypeOf<RecipientCodeRequestProofKey>().not.toEqualTypeOf<
      RecipientCodeMacKey<'auth-recipient-code-lookup/v1'>
    >();
    expectTypeOf<RecipientCodeRequestProofKeyPort>().not.toEqualTypeOf<RecipientCodeMacKeyLifecyclePort>();
    // @ts-expect-error GM proof鍵は認証lookup鍵へ代入できない。
    const key: RecipientCodeMacKey<'auth-recipient-code-lookup/v1'> =
      importRecipientCodeRequestProofKey(new Uint8Array(32));
    expect(key.purpose).toBe('gm-recipient-code-request/v1');
    // @ts-expect-error 読取Portへ全世代破棄権限を混在させない。
    const lifecycle: RecipientCodeMacKeyLifecyclePort = fixture().keys;
    expect(lifecycle).not.toHaveProperty('closeAllGenerations');
  });

  it('不正な秘密入力をProviderへ渡さない', async () => {
    const f = fixture();
    for (const value of [null, '', 'raw-secret', new Uint8Array(32)])
      await expect(
        f.proof.create({
          secret: value as unknown as RecipientCodeSecret,
          keyVersion: 'proof-1',
        }),
      ).rejects.toEqual(new RecipientCodeRequestProofUnavailable());
    expect(f.keys.readKey).not.toHaveBeenCalled();
  });
});
