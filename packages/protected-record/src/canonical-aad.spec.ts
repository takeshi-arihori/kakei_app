import { describe, expect, it } from 'vitest';

import {
  CanonicalAadViolation,
  decodeCanonicalAad,
  encodeCanonicalAad,
  type ProtectedRecordHeader,
} from './canonical-aad.js';

const goldenHeader: ProtectedRecordHeader = {
  envelopeVersion: 1n,
  algorithmId: 'AES-256-GCM',
  app: 'kakei_app',
  contextName: 'group-management',
  recordKind: 'group',
  groupId: '00000000-0000-4000-8000-000000000001',
  logicalRecordId: '00000000-0000-4000-8000-000000000001',
  schemaVersion: 1n,
  keyVersion: 'test-key-v1',
  aggregateVersion: 1n,
  revisionOrdinal: null,
};

const goldenAadHex =
  '0101000000013102010000000b4145532d3235362d47434d0301000000096b616b65695f61707004010000001067726f75702d6d616e6167656d656e7405010000000567726f757006010000002430303030303030302d303030302d343030302d383030302d30303030303030303030303107010000002430303030303030302d303030302d343030302d383030302d3030303030303030303030310801000000013109010000000b746573742d6b65792d76310a0100000001310b0000000000';

const fromHex = (value: string): Uint8Array =>
  Uint8Array.from(Buffer.from(value, 'hex'));

const mutate = (
  value: Uint8Array,
  change: (bytes: Uint8Array) => Uint8Array = (bytes) => bytes,
): Uint8Array => change(Uint8Array.from(value));

const replaceField = (
  input: Uint8Array,
  targetTag: number,
  presence: 0 | 1,
  payload: Uint8Array,
): Uint8Array => {
  let offset = 0;
  while (offset < input.length) {
    const tag = input[offset];
    const length = Buffer.from(
      input.buffer,
      input.byteOffset + offset + 2,
      4,
    ).readUInt32BE(0);
    const next = offset + 6 + length;
    if (tag === targetTag) {
      const header = Buffer.alloc(6);
      header[0] = targetTag;
      header[1] = presence;
      header.writeUInt32BE(payload.length, 2);
      return Uint8Array.from([
        ...input.subarray(0, offset),
        ...header,
        ...payload,
        ...input.subarray(next),
      ]);
    }
    offset = next;
  }
  throw new Error('test field not found');
};

describe('Canonical protected record AAD', () => {
  it('ADR #55のGolden vectorをVersion付きCanonical TLVへencodeする', () => {
    const encoded = encodeCanonicalAad(goldenHeader);

    expect(Buffer.from(encoded).toString('hex')).toBe(goldenAadHex);
    expect(decodeCanonicalAad(encoded)).toEqual(goldenHeader);
  });

  it('immutable SnapshotはaggregateVersionをabsent、revisionOrdinalをpresentにする', () => {
    const snapshot: ProtectedRecordHeader = {
      ...goldenHeader,
      contextName: 'settlement',
      recordKind: 'snapshot-revision',
      aggregateVersion: null,
      revisionOrdinal: 0n,
    };

    expect(decodeCanonicalAad(encodeCanonicalAad(snapshot))).toEqual(snapshot);
  });

  it.each([
    ['leading zero', { ...goldenHeader, aggregateVersion: '01' }],
    ['negative', { ...goldenHeader, aggregateVersion: '-1' }],
    ['overflow', { ...goldenHeader, aggregateVersion: 1n << 63n }],
    [
      'uppercase UUID',
      {
        ...goldenHeader,
        groupId: 'abcdefab-cdef-4abc-8def-abcdefabcdef'.toUpperCase(),
      },
    ],
    ['noncanonical UUID', { ...goldenHeader, groupId: 'not-a-uuid' }],
    ['empty key version', { ...goldenHeader, keyVersion: '' }],
    ['trimmed key version', { ...goldenHeader, keyVersion: ' key-v1' }],
    ['control key version', { ...goldenHeader, keyVersion: 'key\u0000v1' }],
    ['unknown context', { ...goldenHeader, contextName: 'other' }],
    ['unknown record kind', { ...goldenHeader, recordKind: 'expense' }],
    ['both version selectors', { ...goldenHeader, revisionOrdinal: 1n }],
    [
      'missing version selector',
      { ...goldenHeader, aggregateVersion: null, revisionOrdinal: null },
    ],
  ])('非canonical headerをencodeしない: %s', (_name, header) => {
    expect(() =>
      encodeCanonicalAad(header as unknown as ProtectedRecordHeader),
    ).toThrow(CanonicalAadViolation);
  });

  it.each([
    [
      'unknown tag',
      (bytes: Uint8Array) => {
        bytes[0] = 0x7f;
        return bytes;
      },
    ],
    [
      'duplicate or order violation',
      (bytes: Uint8Array) => {
        bytes[7] = 0x01;
        return bytes;
      },
    ],
    [
      'invalid presence',
      (bytes: Uint8Array) => {
        bytes[1] = 0x02;
        return bytes;
      },
    ],
    [
      'absent non-zero length',
      (bytes: Uint8Array) => {
        bytes[bytes.length - 1] = 0x01;
        return bytes;
      },
    ],
    [
      'length mismatch',
      (bytes: Uint8Array) => {
        bytes[5] = 0x02;
        return bytes;
      },
    ],
    [
      'present empty value',
      (bytes: Uint8Array) => {
        bytes[2] = 0;
        bytes[3] = 0;
        bytes[4] = 0;
        bytes[5] = 0;
        return bytes;
      },
    ],
    ['extra bytes', (bytes: Uint8Array) => Uint8Array.from([...bytes, 0])],
  ])('malformed TLVを拒否する: %s', (_name, modify) => {
    expect(() =>
      decodeCanonicalAad(mutate(fromHex(goldenAadHex), modify)),
    ).toThrow(CanonicalAadViolation);
  });

  it('不正UTF-8を拒否する', () => {
    const encoded = replaceField(
      fromHex(goldenAadHex),
      0x03,
      1,
      Uint8Array.from([0xff]),
    );

    expect(() => decodeCanonicalAad(encoded)).toThrow(CanonicalAadViolation);
  });

  it.each([
    [
      '必須field欠落',
      replaceField(fromHex(goldenAadHex), 0x03, 0, new Uint8Array()),
    ],
    [
      'leading zero',
      replaceField(
        fromHex(goldenAadHex),
        0x0a,
        1,
        new TextEncoder().encode('01'),
      ),
    ],
    [
      'UUID case違反',
      replaceField(
        encodeCanonicalAad({
          ...goldenHeader,
          groupId: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
        }),
        0x06,
        1,
        new TextEncoder().encode('ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF'),
      ),
    ],
    [
      'NUL',
      replaceField(
        fromHex(goldenAadHex),
        0x09,
        1,
        new TextEncoder().encode('test\u0000key'),
      ),
    ],
    [
      '前後空白',
      replaceField(
        fromHex(goldenAadHex),
        0x09,
        1,
        new TextEncoder().encode(' test-key-v1'),
      ),
    ],
  ])('非canonical payloadをdecodeしない: %s', (_name, encoded) => {
    expect(() => decodeCanonicalAad(encoded)).toThrow(CanonicalAadViolation);
  });
});
