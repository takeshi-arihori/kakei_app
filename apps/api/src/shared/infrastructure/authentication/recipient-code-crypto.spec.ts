import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { RecipientCodeSecret } from '../../application/authentication/recipient-code-input.js';
import type {
  RecipientCodeBytes,
  RecipientCodeRecord,
} from '../../application/authentication/recipient-code-record.js';
import { RecipientCodeUnavailable } from '../../application/authentication/recipient-code-record.js';
import type {
  RecipientCodeMacPurpose,
  RecipientCodeKeyQuery,
} from '../../application/authentication/recipient-code-crypto-ports.js';
import {
  decodeRecipientCodeRecord,
  encodeRecipientCodeRecord,
} from './canonical-recipient-code.js';
import { encodeAuthenticationTlv } from './canonical-authentication.js';
import {
  createRecipientCodeCrypto,
  importRecipientCodeMacKey,
} from './recipient-code-crypto.js';
import vectors from './test/recipient-code-golden-vectors.json' with { type: 'json' };

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const secret = () =>
  RecipientCodeSecret.parse(
    Buffer.from(vectors.decodedCodeHex, 'hex').toString('base64url'),
  )!;
const metadata = () => ({
  ...vectors.row,
  status: 'issued' as const,
  lookupDigest: bytes(vectors.lookupDigestHex) as RecipientCodeBytes<'lookup'>,
});
const row = (): RecipientCodeRecord => ({
  ...metadata(),
  mac: bytes(
    vectors.vectors.issued.hmacHex,
  ) as RecipientCodeBytes<'record-mac'>,
});
const provider = <P extends RecipientCodeMacPurpose>(
  purpose: P,
  keyHex: string,
) => ({
  readKey: vi.fn(async (query: RecipientCodeKeyQuery) => {
    await Promise.resolve();
    return {
      status: 'available' as const,
      ...query,
      key: importRecipientCodeMacKey(purpose, bytes(keyHex)),
    };
  }),
});
const fixture = () => {
  const keys = {
    lookup: provider('auth-recipient-code-lookup/v1', vectors.keyHex.lookup),
    state: provider('auth-recipient-code-state/v1', vectors.keyHex.state),
    audit: provider('auth-audit-recipient-code/v1', vectors.keyHex.audit),
  };
  const onAlert = vi.fn();
  return {
    keys,
    onAlert,
    crypto: createRecipientCodeCrypto({ keys, onAlert }),
  };
};

describe('招待コード専用のCanonical TLVとHMAC', () => {
  it('Recordごとに独立鍵を取得し、他RecordのMACを転用しない', async () => {
    const f = fixture();
    const otherId = '10000000-0000-4000-8000-000000000004';
    const materials = new Map([
      [vectors.row.codeId, bytes(vectors.keyHex.state)],
      [otherId, new Uint8Array(32).fill(200)],
    ]);
    f.keys.state.readKey.mockImplementation(async (query) => {
      await Promise.resolve();
      return {
        status: 'available',
        ...query,
        key: importRecipientCodeMacKey(
          'auth-recipient-code-state/v1',
          materials.get(query.scopeId)!,
        ),
      };
    });
    const other = { ...metadata(), codeId: otherId };
    const first = await f.crypto.recordMac(metadata());
    const second = await f.crypto.recordMac(other);
    expect(first.scopeId).toBe(vectors.row.codeId);
    expect(second.scopeId).toBe(otherId);
    expect(first.bytes).not.toEqual(second.bytes);
    expect(materials.get(first.scopeId)).not.toEqual(
      materials.get(second.scopeId),
    );
    expect(await f.crypto.verifyRecord({ ...other, mac: second.bytes })).toBe(
      true,
    );
    await expect(
      f.crypto.verifyRecord({ ...other, mac: first.bytes }),
    ).rejects.toEqual(new RecipientCodeUnavailable());
  });
  it('独立Python参照のlookup/MAC/Audit vectorに一致する', async () => {
    const f = fixture();
    const lookup = await f.crypto.lookup({
      secret: secret(),
      keyVersion: 'lookup-1',
    });
    expect(Buffer.from(lookup.bytes).toString('hex')).toBe(
      vectors.vectors.lookup.hmacHex,
    );
    expect(
      Buffer.from(encodeRecipientCodeRecord(metadata())).toString('hex'),
    ).toBe(vectors.vectors.issued.tlvHex);
    expect(
      decodeRecipientCodeRecord(bytes(vectors.vectors.issued.tlvHex)),
    ).toEqual(metadata());
    expect(
      Buffer.from((await f.crypto.recordMac(metadata())).bytes).toString('hex'),
    ).toBe(vectors.vectors.issued.hmacHex);
    expect(await f.crypto.verifyRecord(row())).toBe(true);
    const terminal = {
      ...metadata(),
      ...vectors.terminalRow,
      status: 'consumed' as const,
    };
    expect(
      Buffer.from(encodeRecipientCodeRecord(terminal)).toString('hex'),
    ).toBe(vectors.vectors.consumed.tlvHex);
    expect(
      Buffer.from((await f.crypto.recordMac(terminal)).bytes).toString('hex'),
    ).toBe(vectors.vectors.consumed.hmacHex);
    const audit = await f.crypto.audit({
      codeId: row().codeId,
      keyVersion: 'audit-1',
    });
    expect(Buffer.from(audit.bytes).toString('hex')).toBe(
      vectors.vectors.audit.hmacHex,
    );
    expect(f.keys.state.readKey).toHaveBeenCalledWith({
      keyVersion: 'state-1',
      epoch: null,
      scopeId: row().codeId,
    });
    expect(f.keys.lookup.readKey).toHaveBeenCalledWith({
      keyVersion: 'lookup-1',
      epoch: null,
      scopeId: 'authentication',
    });
  });

  it.each([
    ['codeId', '10000000-0000-4000-8000-000000000004'],
    ['recipientActorId', '10000000-0000-4000-8000-000000000004'],
    ['recordVersion', 2],
    ['epoch', '10000000-0000-4000-8000-000000000004'],
    ['lookupKeyVersion', 'lookup-2'],
    ['lookupDigest', new Uint8Array(32)],
    ['macKeyVersion', 'state-2'],
    ['mac', new Uint8Array(32)],
  ])('%sの差替えを認証しない', async (name, value) => {
    await expect(
      fixture().crypto.verifyRecord({ ...row(), [name]: value }),
    ).rejects.toBeInstanceOf(RecipientCodeUnavailable);
  });

  it('有効形式の日時/終端状態への差替えも拒否する', async () => {
    const f = fixture();
    await expect(
      f.crypto.verifyRecord({
        ...row(),
        createdAt: row().createdAt + 1,
        expiresAt: row().expiresAt + 1,
      }),
    ).rejects.toBeInstanceOf(RecipientCodeUnavailable);
    await expect(
      f.crypto.verifyRecord({
        ...row(),
        status: 'revoked',
        terminalAt: row().createdAt,
      }),
    ).rejects.toBeInstanceOf(RecipientCodeUnavailable);
  });

  it('用途違いの鍵と値は型として交換できない', async () => {
    const a = importRecipientCodeMacKey(
      'auth-recipient-code-lookup/v1',
      new Uint8Array(32),
    );
    const b = importRecipientCodeMacKey(
      'auth-recipient-code-state/v1',
      new Uint8Array(32),
    );
    expectTypeOf(a).not.toEqualTypeOf(b);
    const f = fixture();
    const lookup = await f.crypto.lookup({
      secret: secret(),
      keyVersion: 'lookup-1',
    });
    const audit = await f.crypto.audit({
      codeId: row().codeId,
      keyVersion: 'audit-1',
    });
    expectTypeOf(lookup).not.toEqualTypeOf(audit);
    await expect(
      f.crypto.verifyLookup({
        secret: secret(),
        expected: audit as unknown as typeof lookup,
      }),
    ).rejects.toBeInstanceOf(RecipientCodeUnavailable);
  });

  it.each([
    { recordVersion: 0 },
    { recordVersion: 1.5 },
    { recordVersion: Number.MAX_SAFE_INTEGER + 1 },
    { createdAt: -0, expiresAt: 600_000 },
    { createdAt: -1 },
    { expiresAt: vectors.row.expiresAt + 1 },
    { status: 'expired' },
    { terminalAt: 1 },
    { status: 'consumed', terminalAt: null },
    { status: 'consumed', terminalAt: vectors.row.createdAt - 1 },
    { lookupDigest: new Uint8Array(31) },
    { lookupDigest: new Uint8Array(33) },
    { codeId: vectors.row.codeId.toUpperCase().replace('a', 'A') + ' ' },
    { recipientActorId: 'invalid' },
    { epoch: 'invalid' },
    { lookupKeyVersion: ' lookup-1' },
    { lookupKeyVersion: '鍵' },
    { macKeyVersion: 'x'.repeat(256) },
    { macKeyVersion: 'state\n1' },
    { extra: 'forbidden' },
  ])('不正Metadataを鍵取得前に拒否する: %j', async (patch) => {
    const f = fixture();
    await expect(
      f.crypto.recordMac({ ...metadata(), ...patch } as ReturnType<
        typeof metadata
      >),
    ).rejects.toBeInstanceOf(RecipientCodeUnavailable);
    expect(f.keys.state.readKey).not.toHaveBeenCalled();
  });

  it('未知field/欠落/accessor/不正prototypeを拒否する', async () => {
    const f = fixture();
    const missing = { ...metadata() } as Partial<ReturnType<typeof metadata>>;
    delete missing.epoch;
    const accessor = Object.defineProperty({ ...metadata() }, 'codeId', {
      get: () => {
        throw new Error('secret');
      },
    });
    const inherited: unknown = Object.assign(
      Object.create({ secret: true }) as object,
      metadata(),
    );
    for (const input of [missing, accessor, inherited]) {
      await expect(
        f.crypto.recordMac(input as ReturnType<typeof metadata>),
      ).rejects.toMatchObject({ message: 'Recipient code unavailable' });
    }
    expect(f.keys.state.readKey).not.toHaveBeenCalled();
  });

  it.each([
    'status',
    'keyVersion',
    'epoch',
    'scopeId',
    'purpose',
    'material',
    'extra',
  ])('Provider返却%sの不整合を汎用失敗にする', async (field) => {
    const f = fixture();
    f.keys.lookup.readKey.mockImplementation(async (q) => {
      await Promise.resolve();
      const key = importRecipientCodeMacKey(
        'auth-recipient-code-lookup/v1',
        bytes(vectors.keyHex.lookup),
      );
      const response = { status: 'available', ...q, key };
      const bad: unknown =
        field === 'purpose'
          ? {
              ...response,
              key: { ...key, purpose: 'auth-recipient-code-state/v1' },
            }
          : field === 'material'
            ? { ...response, key: { ...key, material: new Uint8Array(31) } }
            : {
                ...response,
                [field]: field === 'epoch' ? vectors.row.epoch : 'wrong',
              };
      return bad as Awaited<ReturnType<typeof f.keys.lookup.readKey>>;
    });
    await expect(
      f.crypto.lookup({ secret: secret(), keyVersion: 'lookup-1' }),
    ).rejects.toMatchObject({ message: 'Recipient code unavailable' });
    expect(f.onAlert).toHaveBeenCalledExactlyOnceWith({
      operation: 'lookup',
      code: 'RECIPIENT_CODE_CRYPTO_UNAVAILABLE',
    });
  });

  it.each(['unavailable', 'destroyed', 'exception'])(
    '鍵の%sを秘密なしの同じ失敗へ変換する',
    async (status) => {
      const f = fixture();
      f.keys.state.readKey.mockImplementation(async () => {
        await Promise.resolve();
        if (status === 'exception') throw new Error('provider-secret');
        return { status } as unknown as Awaited<
          ReturnType<typeof f.keys.state.readKey>
        >;
      });
      await expect(f.crypto.recordMac(metadata())).rejects.toEqual(
        new RecipientCodeUnavailable(),
      );
      expect(f.onAlert).toHaveBeenCalledExactlyOnceWith({
        operation: 'record-mac',
        code: 'RECIPIENT_CODE_CRYPTO_UNAVAILABLE',
      });
    },
  );

  it('状態MACの別codeId Scope/世代/epoch/用途を受理しない', async () => {
    for (const patch of [
      { scopeId: vectors.row.recipientActorId },
      { keyVersion: 'old' },
      { epoch: vectors.row.epoch },
      {
        key: importRecipientCodeMacKey(
          'auth-audit-recipient-code/v1',
          bytes(vectors.keyHex.audit),
        ),
      },
    ]) {
      const f = fixture();
      f.keys.state.readKey.mockImplementation(async (q) => {
        await Promise.resolve();
        return {
          status: 'available',
          ...q,
          key: importRecipientCodeMacKey(
            'auth-recipient-code-state/v1',
            bytes(vectors.keyHex.state),
          ),
          ...patch,
        } as Awaited<ReturnType<typeof f.keys.state.readKey>>;
      });
      await expect(f.crypto.verifyRecord(row())).rejects.toEqual(
        new RecipientCodeUnavailable(),
      );
    }
  });

  it('Auditも独立用途/Scopeを検証する', async () => {
    const f = fixture();
    f.keys.audit.readKey.mockImplementation(async (q) => {
      await Promise.resolve();
      return {
        status: 'available',
        ...q,
        scopeId: vectors.row.codeId,
        key: importRecipientCodeMacKey(
          'auth-audit-recipient-code/v1',
          bytes(vectors.keyHex.audit),
        ),
      };
    });
    await expect(
      f.crypto.audit({ codeId: row().codeId, keyVersion: 'audit-1' }),
    ).rejects.toEqual(new RecipientCodeUnavailable());
  });

  it('通知例外で元の汎用失敗を置換しない', async () => {
    const f = fixture();
    f.keys.lookup.readKey.mockRejectedValue(new Error('provider-secret'));
    const crypto = createRecipientCodeCrypto({
      keys: f.keys,
      onAlert: () => {
        throw new Error('alert-secret');
      },
    });
    await expect(
      crypto.lookup({ secret: secret(), keyVersion: 'lookup-1' }),
    ).rejects.toEqual(new RecipientCodeUnavailable());
  });

  it('鍵取得待ちの間にCallerが行/byte列を変更しても選択時の状態を検証する', async () => {
    const f = fixture();
    const original = row();
    let release!: (
      value: Awaited<ReturnType<typeof f.keys.state.readKey>>,
    ) => void;
    f.keys.state.readKey.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const result = f.crypto.verifyRecord(original);
    original.lookupDigest.fill(99);
    original.mac.fill(99);
    Object.assign(original, {
      codeId: vectors.row.recipientActorId,
      macKeyVersion: 'other',
    });
    release({
      status: 'available',
      keyVersion: 'state-1',
      epoch: null,
      scopeId: vectors.row.codeId,
      key: importRecipientCodeMacKey(
        'auth-recipient-code-state/v1',
        bytes(vectors.keyHex.state),
      ),
    });
    expect(await result).toBe(true);
  });

  it('lookupの保存Descriptor/byte列をawait前Copyし、不一致だけfalseを返す', async () => {
    const f = fixture();
    const expected = await f.crypto.lookup({
      secret: secret(),
      keyVersion: 'lookup-1',
    });
    const mutable = { ...expected };
    let release!: (
      value: Awaited<ReturnType<typeof f.keys.lookup.readKey>>,
    ) => void;
    f.keys.lookup.readKey.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const verification = f.crypto.verifyLookup({
      secret: secret(),
      expected: mutable,
    });
    mutable.bytes.fill(0);
    mutable.keyVersion = 'different';
    release({
      status: 'available',
      keyVersion: 'lookup-1',
      epoch: null,
      scopeId: 'authentication',
      key: importRecipientCodeMacKey(
        'auth-recipient-code-lookup/v1',
        bytes(vectors.keyHex.lookup),
      ),
    });
    expect(await verification).toBe(true);
    f.keys.lookup.readKey.mockImplementation(async (query) => {
      await Promise.resolve();
      return {
        status: 'available',
        ...query,
        key: importRecipientCodeMacKey(
          'auth-recipient-code-lookup/v1',
          bytes(vectors.keyHex.lookup),
        ),
      };
    });
    expect(
      await f.crypto.verifyLookup({
        secret: secret(),
        expected: {
          ...expected,
          bytes: new Uint8Array(32) as typeof expected.bytes,
        },
      }),
    ).toBe(false);
    for (const length of [0, 31, 33])
      await expect(
        f.crypto.verifyLookup({
          secret: secret(),
          expected: {
            ...expected,
            bytes: new Uint8Array(length) as typeof expected.bytes,
          },
        }),
      ).rejects.toEqual(new RecipientCodeUnavailable());
  });

  it('鍵のImportとHMAC処理がProviderの元Bufferを共有/zero化しない', async () => {
    const material = bytes(vectors.keyHex.lookup);
    const key = importRecipientCodeMacKey(
      'auth-recipient-code-lookup/v1',
      material,
    );
    material.fill(0);
    expect(Buffer.from(key.material).toString('hex')).toBe(
      vectors.keyHex.lookup,
    );
    const f = fixture();
    f.keys.lookup.readKey.mockImplementation(async (q) => {
      await Promise.resolve();
      return {
        status: 'available',
        ...q,
        key,
      };
    });
    const output = await f.crypto.lookup({
      secret: secret(),
      keyVersion: 'lookup-1',
    });
    expect(Buffer.from(key.material).toString('hex')).toBe(
      vectors.keyHex.lookup,
    );
    key.material.fill(0);
    expect(Buffer.from(output.bytes).toString('hex')).toBe(
      vectors.vectors.lookup.hmacHex,
    );
    for (const length of [0, 31, 33])
      expect(() =>
        importRecipientCodeMacKey(
          'auth-recipient-code-state/v1',
          new Uint8Array(length),
        ),
      ).toThrow(RecipientCodeUnavailable);
  });

  it('不正な秘密入力をProviderへ渡さない', async () => {
    const f = fixture();
    for (const input of [
      null,
      undefined,
      'raw-secret',
      {},
      new Uint8Array(32),
    ]) {
      await expect(
        f.crypto.lookup({
          secret: input as RecipientCodeSecret,
          keyVersion: 'lookup-1',
        }),
      ).rejects.toEqual(new RecipientCodeUnavailable());
    }
    expect(f.keys.lookup.readKey).not.toHaveBeenCalled();
  });
});

describe('コードMACの厳格Canonical decoder', () => {
  const chunks = () => {
    const data = Buffer.from(vectors.vectors.issued.tlvHex, 'hex');
    const result: Buffer[] = [];
    for (let offset = 0; offset < data.length;) {
      const size = 6 + data.readUInt32BE(offset + 2);
      result.push(data.subarray(offset, offset + size));
      offset += size;
    }
    return result;
  };
  it.each([
    'missing',
    'extra',
    'duplicate',
    'order',
    'tag',
    'presence',
    'length',
    'truncated',
    'utf8',
    'binary-length',
    'absent-text',
  ])('不正な%sを拒否する', (kind) => {
    const fields = chunks().map((c) => Buffer.from(c));
    if (kind === 'missing') fields.pop();
    if (kind === 'extra') fields.push(Buffer.from([14, 1, 0, 0, 0, 1, 65]));
    if (kind === 'duplicate') fields.splice(1, 0, fields[0]);
    if (kind === 'order') [fields[0], fields[1]] = [fields[1], fields[0]];
    if (kind === 'tag') fields[0][0] = 2;
    if (kind === 'presence') fields[0][1] = 2;
    if (kind === 'length') fields[0].writeUInt32BE(0xffffffff, 2);
    if (kind === 'truncated') fields[12] = fields[12].subarray(0, 6);
    if (kind === 'utf8') fields[0][6] = 255;
    if (kind === 'binary-length')
      fields[7] = Buffer.from([8, 1, 0, 0, 0, 1, 65]);
    if (kind === 'absent-text') fields[0] = Buffer.from([1, 0, 0, 0, 0, 0]);
    expect(() => decodeRecipientCodeRecord(Buffer.concat(fields))).toThrow(
      RecipientCodeUnavailable,
    );
  });
  it.each(['01', '+1', '-0', '1.0', '1e0', '9007199254740992'])(
    '非正規の整数%sを拒否する',
    (value) => {
      const fields = chunks();
      const replacement = Buffer.from(encodeAuthenticationTlv([value]));
      replacement[0] = 5;
      fields[4] = replacement;
      expect(() => decodeRecipientCodeRecord(Buffer.concat(fields))).toThrow(
        RecipientCodeUnavailable,
      );
    },
  );
});
