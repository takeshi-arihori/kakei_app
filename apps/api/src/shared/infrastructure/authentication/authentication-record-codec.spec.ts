import { createCipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
  createAuthenticationRecordCodec,
  importAuthenticationDataKey,
} from './authentication-record-codec.js';
import {
  authenticationHeader,
  encodeAuthenticationAad,
} from './canonical-authentication.js';
import { encodeAuthenticationPayload } from './authentication-payload.js';
import {
  cases,
  ids,
  SyntheticKeyRegistry,
} from './test/authentication-crypto-fixtures.js';
import type {
  AuthenticationRecordEnvelope,
  AuthenticationRecordHeader,
  AuthenticationRow,
} from '../../application/authentication/authentication-record-protection.js';
import type {
  AuthenticationDataKeyPort,
  AuthenticationKeyScope,
} from '../../application/authentication/authentication-crypto-keys.js';

const scopeFor = (row: AuthenticationRow): AuthenticationKeyScope => ({
  recordKind: row.recordKind,
  keyScopeId:
    row.recordKind === 'google-identity'
      ? row.actorId
      : row.recordKind === 'login-attempt'
        ? row.attemptId
        : row.sessionId,
});
const setup = () => {
  const registry = new SyntheticKeyRegistry();
  const port = registry.provider();
  return {
    registry,
    port,
    codec: createAuthenticationRecordCodec({ keys: port }),
  };
};

describe('認証専用Envelope', () => {
  it('Pythonの独立TLV／JSON参照とNode AES primitiveで固定した全kindのvectorを維持する', async () => {
    const vectors = JSON.parse(
      readFileSync(
        new URL('./test/authentication-golden-vectors.json', import.meta.url),
        'utf8',
      ),
    ) as {
      recordKind: string;
      keyHex: string;
      nonceHex: string;
      aadHex: string;
      payloadHex: string;
      ciphertextHex: string;
      tagHex: string;
    }[];
    for (const vector of vectors) {
      const sample = cases.find(
        ({ row }) => row.recordKind === vector.recordKind,
      )!;
      const scope = scopeFor(sample.row);
      const key = importAuthenticationDataKey(
        Buffer.from(vector.keyHex, 'hex'),
      );
      const keys: AuthenticationDataKeyPort = {
        allocateForSeal: () =>
          Promise.resolve({
            status: 'allocated',
            scope,
            lifecycle: 'current',
            key,
            keyVersion: 'golden-1',
            nonce: Buffer.from(vector.nonceHex, 'hex'),
            sealCount: 1n,
          }),
        readKey: () =>
          Promise.resolve({
            status: 'available',
            scope,
            lifecycle: 'current',
            key,
            keyVersion: 'golden-1',
          }),
        requestRotation: () => Promise.resolve(),
      };
      const codec = createAuthenticationRecordCodec({ keys });
      const envelope = await codec.seal(sample);
      expect(
        Buffer.from(
          encodeAuthenticationAad(envelope.header, sample.row),
        ).toString('hex'),
      ).toBe(vector.aadHex);
      expect(
        Buffer.from(
          encodeAuthenticationPayload(sample.row, sample.secrets),
        ).toString('hex'),
      ).toBe(vector.payloadHex);
      expect(Buffer.from(envelope.ciphertext).toString('hex')).toBe(
        vector.ciphertextHex,
      );
      expect(Buffer.from(envelope.authenticationTag).toString('hex')).toBe(
        vector.tagHex,
      );
      await expect(codec.open({ row: sample.row, envelope })).resolves.toEqual(
        sample.secrets,
      );
    }
  });
  it.each(cases)(
    '$row.recordKindを全Metadataとともに保護する',
    async ({ row, secrets }) => {
      const { codec } = setup();
      const envelope = await codec.seal({ row, secrets });
      expect(Object.keys(envelope).sort()).toEqual([
        'authenticationTag',
        'ciphertext',
        'header',
        'nonce',
      ]);
      expect(envelope.header).toEqual(authenticationHeader(row, 'key-1'));
      expect(envelope.nonce.length).toBe(12);
      expect(envelope.authenticationTag.length).toBe(16);
      await expect(codec.open({ row, envelope })).resolves.toEqual(secrets);
    },
  );

  it('Headerの全Field差替え・追加・欠落を拒否する', async () => {
    const { codec } = setup();
    const sample = cases[0];
    const envelope = await codec.seal(sample);
    for (const key of Object.keys(envelope.header)) {
      const value = envelope.header[key as keyof AuthenticationRecordHeader];
      const changed = {
        ...envelope.header,
        [key]: typeof value === 'number' ? value + 1 : 'other',
      };
      await expect(
        codec.open({
          row: sample.row,
          envelope: {
            ...envelope,
            header: changed,
          },
        }),
      ).rejects.toThrow('Authentication crypto unavailable');
      const missing = { ...envelope.header } as Record<string, unknown>;
      delete missing[key];
      await expect(
        codec.open({
          row: sample.row,
          envelope: {
            ...envelope,
            header: missing as unknown as AuthenticationRecordHeader,
          },
        }),
      ).rejects.toThrow();
    }
    await expect(
      codec.open({
        row: sample.row,
        envelope: {
          ...envelope,
          header: { ...envelope.header, groupId: ids.actor },
        } as AuthenticationRecordEnvelope,
      }),
    ).rejects.toThrow();
  });

  it.each(cases)(
    '$row.recordKindの全Row Field差替えを拒否する',
    async (sample) => {
      const { codec } = setup();
      const envelope = await codec.seal(sample);
      for (const [key, value] of Object.entries(sample.row)) {
        const changed =
          value instanceof Uint8Array
            ? new Uint8Array(32).fill(30)
            : value === null
              ? 1
              : typeof value === 'number'
                ? value + 1
                : value === 'google-identity'
                  ? 'session'
                  : value === 'login-attempt'
                    ? 'session'
                    : value === 'session'
                      ? 'login-attempt'
                      : key.toLowerCase().includes('id') || key === 'epoch'
                        ? ids.other
                        : 'other';
        const row = { ...sample.row, [key]: changed };
        await expect(codec.open({ row, envelope })).rejects.toThrow(
          'Authentication crypto unavailable',
        );
      }
    },
  );

  it.each(['nonce', 'ciphertext', 'authenticationTag'] as const)(
    '%sの各byte改ざんを拒否する',
    async (field) => {
      const { codec } = setup();
      const sample = cases[0];
      const envelope = await codec.seal(sample);
      for (let index = 0; index < envelope[field].length; index++) {
        const bytes = Uint8Array.from(envelope[field]);
        bytes[index] ^= 1;
        await expect(
          codec.open({
            row: sample.row,
            envelope: { ...envelope, [field]: bytes },
          }),
        ).rejects.toThrow('Authentication crypto unavailable');
      }
    },
  );

  it('正しいTagを持つ不正Payloadも全Field検証で拒否する', async () => {
    const { registry, codec } = setup();
    const sample = cases[0];
    const valid = await codec.seal(sample);
    const payload = new TextDecoder().decode(
      encodeAuthenticationPayload(sample.row, sample.secrets),
    );
    for (const text of [
      payload.replace('"version":1', '"version":2'),
      payload.replace('"subject":', '"subject":"x","subject":'),
      payload.replace('"payloadVersion":1', '"payloadVersion":2'),
      payload.replace('"row":', '"profile":"forbidden","row":'),
    ]) {
      const nonce = Buffer.alloc(12, 99);
      const cipher = createCipheriv(
        'aes-256-gcm',
        registry.state(scopeFor(sample.row)).key,
        nonce,
        { authTagLength: 16 },
      );
      cipher.setAAD(encodeAuthenticationAad(valid.header, sample.row));
      const ciphertext = Buffer.concat([
        cipher.update(text, 'utf8'),
        cipher.final(),
      ]);
      await expect(
        codec.open({
          row: sample.row,
          envelope: {
            ...valid,
            nonce,
            ciphertext,
            authenticationTag: cipher.getAuthTag(),
          },
        }),
      ).rejects.toThrow('Authentication crypto unavailable');
    }
  });

  it('別kind／scopeを混同せず、IdentityはActor別、他はRecord別の独立DEKを使う', async () => {
    const { registry, codec } = setup();
    for (const sample of cases) await codec.seal(sample);
    const material = cases.map(({ row }) =>
      Buffer.from(registry.state(scopeFor(row)).key).toString('hex'),
    );
    expect(new Set(material).size).toBe(3);
    const other = {
      row: { ...cases[0].row, actorId: ids.other } as AuthenticationRow,
      secrets: cases[0].secrets,
    };
    await codec.seal(other);
    expect(registry.state(scopeFor(other.row)).key).not.toEqual(
      registry.state(scopeFor(cases[0].row)).key,
    );
  });

  it('Unknown／Destroyed Key、Provider throwと読取Scope不一致は情報を漏らさない', async () => {
    const { registry, port, codec } = setup();
    const sample = cases[0];
    const envelope = await codec.seal(sample);
    registry.state(scopeFor(sample.row)).mode = 'destroyed';
    await expect(codec.open({ row: sample.row, envelope })).rejects.toThrow(
      'Authentication crypto unavailable',
    );
    for (const readKey of [
      () => Promise.resolve({ status: 'unavailable' as const }),
      () => Promise.reject(new Error('synthetic secret provider detail')),
    ]) {
      await expect(
        createAuthenticationRecordCodec({ keys: { ...port, readKey } }).open({
          row: sample.row,
          envelope,
        }),
      ).rejects.toThrow('Authentication crypto unavailable');
    }
  });

  it('Nonce割当は外側rollbackとProvider instance再生成でもburnする', async () => {
    const { registry, codec } = setup();
    const sample = cases[0];
    const abandoned = await codec.seal(sample); // DB rollbackで保存されないCiphertext。
    const next = await createAuthenticationRecordCodec({
      keys: registry.provider(),
    }).seal(sample);
    expect(next.nonce).not.toEqual(abandoned.nonce);
    const parallel = await Promise.all(
      Array.from({ length: 24 }, () => codec.seal(sample)),
    );
    expect(
      new Set(parallel.map((value) => Buffer.from(value.nonce).toString('hex')))
        .size,
    ).toBe(24);
  });

  it.each([
    [(1n << 31n) - 1n, false, true],
    [1n << 31n, true, true],
    [(1n << 32n) - 1n, true, true],
    [1n << 32n, true, false],
  ] as const)(
    'Seal count %sでRotationと上限拒否を守る',
    async (count, rotate, allowed) => {
      const { registry, codec } = setup();
      registry.state(scopeFor(cases[0].row)).count = count - 1n;
      const operation = codec.seal(cases[0]);
      if (allowed) await expect(operation).resolves.toBeDefined();
      else
        await expect(operation).rejects.toThrow(
          'Authentication crypto unavailable',
        );
      expect(registry.rotations.length > 0).toBe(rotate);
    },
  );

  it.each(['regressed', 'lost'] as const)(
    'Counter %sを封鎖し、新独立世代へ切替えるまで旧KeyでSealしない',
    async (failure) => {
      const { registry, codec } = setup();
      const sample = cases[0];
      const scope = scopeFor(sample.row);
      const old = await codec.seal(sample);
      registry.state(scope)[failure] = true;
      await expect(codec.seal(sample)).rejects.toThrow(
        'Authentication crypto unavailable',
      );
      expect(registry.state(scope).mode).toBe('read-only');
      registry.state(scope)[failure] = false;
      await expect(codec.seal(sample)).rejects.toThrow();
      registry.rotate(scope);
      const current = await codec.seal(sample);
      expect(current.header.keyVersion).not.toBe(old.header.keyVersion);
      await expect(
        codec.open({ row: sample.row, envelope: old }),
      ).resolves.toEqual(sample.secrets);
    },
  );

  it('不正Nonce・旧書込世代・不正鍵長・Counter・ScopeのProvider割当を拒否する', async () => {
    const { registry, port } = setup();
    const scope = scopeFor(cases[0].row);
    const valid = await port.allocateForSeal(scope);
    if (valid.status !== 'allocated') throw new Error('合成割当の失敗');
    for (const patch of [
      { nonce: new Uint8Array(11) },
      { lifecycle: 'read-only' },
      { key: new Uint8Array(31) },
      { sealCount: 0n },
      { sealCount: -1n },
      { scope: { ...scope, keyScopeId: ids.other } },
    ]) {
      const keys: AuthenticationDataKeyPort = {
        ...port,
        allocateForSeal: vi.fn().mockResolvedValue({ ...valid, ...patch }),
      };
      await expect(
        createAuthenticationRecordCodec({ keys }).seal(cases[0]),
      ).rejects.toThrow('Authentication crypto unavailable');
    }
    expect(registry.state(scope).count).toBe(1n);
  });

  it('DEKを32-byteでCopyし、元Bufferの変更を受けない', () => {
    const source = new Uint8Array(32).fill(1);
    const imported = importAuthenticationDataKey(source);
    source.fill(2);
    expect(imported).toEqual(new Uint8Array(32).fill(1));
    expect(() => importAuthenticationDataKey(new Uint8Array(31))).toThrow();
  });

  it('不正Nonce割当は旧世代へのRotationを要求する', async () => {
    const { port } = setup();
    const valid = await port.allocateForSeal(scopeFor(cases[0].row));
    if (valid.status !== 'allocated') throw new Error('合成割当の失敗');
    const requestRotation = vi.fn().mockResolvedValue(undefined);
    const keys = {
      ...port,
      requestRotation,
      allocateForSeal: vi
        .fn()
        .mockResolvedValue({ ...valid, nonce: new Uint8Array(11) }),
    };
    await expect(
      createAuthenticationRecordCodec({ keys }).seal(cases[0]),
    ).rejects.toThrow();
    expect(requestRotation).toHaveBeenCalledWith({
      scope: valid.scope,
      keyVersion: valid.keyVersion,
      reason: 'allocation-invalid',
    });
  });

  it('Sealのawait中のRow／秘密値変更は検証済みCopyを差し替えない', async () => {
    const { port } = setup();
    const sample = structuredClone(cases[1]);
    const original = structuredClone(sample);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const keys = {
      ...port,
      allocateForSeal: async (scope: AuthenticationKeyScope) => {
        await waiting;
        return port.allocateForSeal(scope);
      },
    };
    const codec = createAuthenticationRecordCodec({ keys });
    const pending = codec.seal(sample);
    if (
      sample.row.recordKind !== 'login-attempt' ||
      !('nonce' in sample.secrets)
    )
      throw new Error('合成試行');
    sample.row.cookieDigest.fill(99);
    Object.assign(sample.row, { version: 2, epoch: ids.other });
    Object.assign(sample.secrets, {
      nonce: Buffer.alloc(32, 99).toString('base64url'),
    });
    release();
    const envelope = await pending;
    await expect(codec.open({ row: original.row, envelope })).resolves.toEqual(
      original.secrets,
    );
  });

  it('Openのawait中のEnvelope／Row変更は認証対象を差し替えない', async () => {
    const { port, codec } = setup();
    const sample = structuredClone(cases[2]);
    const envelope = await codec.seal(sample);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const keys = {
      ...port,
      readKey: async (
        input: Parameters<AuthenticationDataKeyPort['readKey']>[0],
      ) => {
        await waiting;
        return port.readKey(input);
      },
    };
    const pending = createAuthenticationRecordCodec({ keys }).open({
      row: sample.row,
      envelope,
    });
    envelope.nonce.fill(99);
    envelope.ciphertext.fill(99);
    envelope.authenticationTag.fill(99);
    Object.assign(envelope.header, { keyVersion: 'other' });
    Object.assign(sample.row, { version: 2, epoch: ids.other });
    release();
    await expect(pending).resolves.toEqual(sample.secrets);
  });

  it('Rotation await中にProvider Bufferが変わっても割当済みCopyを使う', async () => {
    const { port } = setup();
    const allocation = await port.allocateForSeal(scopeFor(cases[0].row));
    if (allocation.status !== 'allocated') throw new Error('合成割当');
    const originalKey = importAuthenticationDataKey(allocation.key);
    const originalNonce = Uint8Array.from(allocation.nonce);
    const keys: AuthenticationDataKeyPort = {
      ...port,
      allocateForSeal: () =>
        Promise.resolve({ ...allocation, sealCount: 1n << 31n }),
      requestRotation: () => {
        allocation.key.fill(99);
        allocation.nonce.fill(99);
        return Promise.resolve();
      },
      readKey: () =>
        Promise.resolve({
          status: 'available',
          keyVersion: allocation.keyVersion,
          scope: allocation.scope,
          lifecycle: 'current',
          key: originalKey,
        }),
    };
    const codec = createAuthenticationRecordCodec({ keys });
    const envelope = await codec.seal(cases[0]);
    expect(envelope.nonce).toEqual(originalNonce);
    await expect(codec.open({ row: cases[0].row, envelope })).resolves.toEqual(
      cases[0].secrets,
    );
  });

  it('Provider／Rotation／Alert障害で例外・ID・秘密値を公開しない', async () => {
    const { port } = setup();
    const onAlert = vi.fn().mockImplementation(() => {
      throw new Error('synthetic alert detail');
    });
    const requestRotation = () =>
      Promise.reject(new Error('synthetic secret rotation detail'));
    const valid = await port.allocateForSeal(scopeFor(cases[0].row));
    if (valid.status !== 'allocated') throw new Error('合成割当');
    for (const allocateForSeal of [
      () => Promise.reject(new Error('synthetic secret provider detail')),
      () => Promise.resolve({ ...valid, sealCount: 1n << 31n }),
    ]) {
      await expect(
        createAuthenticationRecordCodec({
          keys: { ...port, allocateForSeal, requestRotation },
          onAlert,
        }).seal(cases[0]),
      ).rejects.toThrow('Authentication crypto unavailable');
    }
    expect(onAlert.mock.calls.flat()).toEqual([
      { operation: 'seal', code: 'KEY_UNAVAILABLE' },
      { operation: 'seal', code: 'ROTATION_FAILED' },
    ]);
  });

  it('行の形式不正とCaller指定NonceはProviderを呼ぶ前に拒否する', async () => {
    const { port } = setup();
    const allocateForSeal = vi.fn((scope: AuthenticationKeyScope) =>
      port.allocateForSeal(scope),
    );
    const codec = createAuthenticationRecordCodec({
      keys: { ...port, allocateForSeal },
    });
    await expect(
      codec.seal({ ...cases[0], nonce: new Uint8Array(12) } as Parameters<
        typeof codec.seal
      >[0]),
    ).rejects.toThrow();
    await expect(
      codec.seal({ ...cases[0], row: { ...cases[0].row, version: 0 } }),
    ).rejects.toThrow();
    expect(allocateForSeal).not.toHaveBeenCalled();
  });

  it('読取ProviderのScope／世代／Lifecycle／鍵長不一致を拒否する', async () => {
    const { port, codec } = setup();
    const envelope = await codec.seal(cases[0]);
    const valid = await port.readKey({
      scope: scopeFor(cases[0].row),
      keyVersion: envelope.header.keyVersion,
    });
    if (valid.status !== 'available') throw new Error('合成鍵読取');
    for (const patch of [
      { scope: { ...valid.scope, keyScopeId: ids.other } },
      { keyVersion: 'unknown' },
      { lifecycle: 'destroyed' },
      { key: new Uint8Array(31) },
    ]) {
      const keys: AuthenticationDataKeyPort = {
        ...port,
        readKey: vi.fn().mockResolvedValue({ ...valid, ...patch }),
      };
      await expect(
        createAuthenticationRecordCodec({ keys }).open({
          row: cases[0].row,
          envelope,
        }),
      ).rejects.toThrow('Authentication crypto unavailable');
    }
  });

  it('形式が有効な状態・期限・epochの変更もAADで拒否する', async () => {
    const { codec } = setup();
    for (const sample of cases.slice(1)) {
      const envelope = await codec.seal(sample);
      const rows =
        sample.row.recordKind === 'login-attempt'
          ? [
              { ...sample.row, state: 'consumed' as const, terminalAt: 1 },
              { ...sample.row, createdAt: 1, expiresAt: 300_001 },
              { ...sample.row, epoch: ids.other },
            ]
          : sample.row.recordKind === 'session'
            ? [
                { ...sample.row, state: 'revoked' as const, terminalAt: 1 },
                { ...sample.row, idleExpiresAt: 86_400_001 },
                { ...sample.row, absoluteExpiresAt: 604_799_999 },
                { ...sample.row, epoch: ids.other },
              ]
            : [];
      for (const row of rows)
        await expect(codec.open({ row, envelope })).rejects.toThrow(
          'Authentication crypto unavailable',
        );
    }
  });
});
