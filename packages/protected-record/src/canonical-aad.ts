const MAX_UNSIGNED_INT64 = (1n << 63n) - 1n;
const HEADER_SIZE = 6;
const textEncoder = new TextEncoder();
const strictTextDecoder = new TextDecoder('utf-8', { fatal: true });

export const PROTECTED_RECORD_ENVELOPE_VERSION = 1n;
export const PROTECTED_RECORD_ALGORITHM = 'AES-256-GCM' as const;
export const PROTECTED_RECORD_APP = 'kakei_app' as const;

export type GroupManagementRecordKind =
  | 'group'
  | 'participant'
  | 'invitation'
  | 'membership-history'
  | 'invitation-history'
  | 'operation-result';

export type ProtectedRecordHeader =
  | Readonly<{
      envelopeVersion: bigint;
      algorithmId: typeof PROTECTED_RECORD_ALGORITHM;
      app: typeof PROTECTED_RECORD_APP;
      contextName: 'group-management';
      recordKind: GroupManagementRecordKind;
      groupId: string;
      logicalRecordId: string;
      schemaVersion: bigint;
      keyVersion: string;
      aggregateVersion: bigint;
      revisionOrdinal: null;
    }>
  | Readonly<{
      envelopeVersion: bigint;
      algorithmId: typeof PROTECTED_RECORD_ALGORITHM;
      app: typeof PROTECTED_RECORD_APP;
      contextName: 'settlement';
      recordKind: 'snapshot-revision';
      groupId: string;
      logicalRecordId: string;
      schemaVersion: bigint;
      keyVersion: string;
      aggregateVersion: null;
      revisionOrdinal: bigint;
    }>;

export type CanonicalAadViolationCode =
  | 'STRUCTURE_INVALID'
  | 'TAG_INVALID'
  | 'PRESENCE_INVALID'
  | 'LENGTH_INVALID'
  | 'UTF8_INVALID'
  | 'VALUE_INVALID';

export class CanonicalAadViolation extends Error {
  constructor(readonly code: CanonicalAadViolationCode) {
    super('Protected record AAD is not canonical');
    this.name = 'CanonicalAadViolation';
  }
}

type RawHeader = Readonly<{
  envelopeVersion: string | null;
  algorithmId: string | null;
  app: string | null;
  contextName: string | null;
  recordKind: string | null;
  groupId: string | null;
  logicalRecordId: string | null;
  schemaVersion: string | null;
  keyVersion: string | null;
  aggregateVersion: string | null;
  revisionOrdinal: string | null;
}>;

type FieldName = keyof RawHeader;

const fields: readonly Readonly<{ tag: number; name: FieldName }>[] = [
  { tag: 0x01, name: 'envelopeVersion' },
  { tag: 0x02, name: 'algorithmId' },
  { tag: 0x03, name: 'app' },
  { tag: 0x04, name: 'contextName' },
  { tag: 0x05, name: 'recordKind' },
  { tag: 0x06, name: 'groupId' },
  { tag: 0x07, name: 'logicalRecordId' },
  { tag: 0x08, name: 'schemaVersion' },
  { tag: 0x09, name: 'keyVersion' },
  { tag: 0x0a, name: 'aggregateVersion' },
  { tag: 0x0b, name: 'revisionOrdinal' },
];

const fail = (code: CanonicalAadViolationCode): never => {
  throw new CanonicalAadViolation(code);
};

const encodeUnsigned = (value: bigint): string => {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_UNSIGNED_INT64) {
    return fail('VALUE_INVALID');
  }
  return value.toString(10);
};

const decodeUnsigned = (value: string | null): bigint => {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return fail('VALUE_INVALID');
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UNSIGNED_INT64) {
    return fail('VALUE_INVALID');
  }
  return parsed;
};

const validateText = (value: string | null): string => {
  const containsControlCharacter = (text: string): boolean =>
    [...text].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    });
  if (
    value === null ||
    value.length === 0 ||
    value.trim() !== value ||
    containsControlCharacter(value)
  ) {
    return fail('VALUE_INVALID');
  }
  return value;
};

const validateUuid = (value: string | null): string => {
  const text = validateText(value);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text)
  ) {
    return fail('VALUE_INVALID');
  }
  return text;
};

const validateKeyVersion = (value: string | null): string => {
  const text = validateText(value);
  if (!/^[A-Za-z0-9._:-]+$/.test(text)) {
    return fail('VALUE_INVALID');
  }
  return text;
};

const validateAndCreateHeader = (raw: RawHeader): ProtectedRecordHeader => {
  const envelopeVersion = decodeUnsigned(raw.envelopeVersion);
  if (envelopeVersion !== PROTECTED_RECORD_ENVELOPE_VERSION) {
    return fail('VALUE_INVALID');
  }
  if (validateText(raw.algorithmId) !== PROTECTED_RECORD_ALGORITHM) {
    return fail('VALUE_INVALID');
  }
  if (validateText(raw.app) !== PROTECTED_RECORD_APP) {
    return fail('VALUE_INVALID');
  }

  const contextName = validateText(raw.contextName);
  const recordKind = validateText(raw.recordKind);
  const common = {
    envelopeVersion,
    algorithmId: PROTECTED_RECORD_ALGORITHM,
    app: PROTECTED_RECORD_APP,
    groupId: validateUuid(raw.groupId),
    logicalRecordId: validateUuid(raw.logicalRecordId),
    schemaVersion: decodeUnsigned(raw.schemaVersion),
    keyVersion: validateKeyVersion(raw.keyVersion),
  };

  if (contextName === 'group-management') {
    const allowedKinds: readonly string[] = [
      'group',
      'participant',
      'invitation',
      'membership-history',
      'invitation-history',
      'operation-result',
    ];
    if (!allowedKinds.includes(recordKind) || raw.revisionOrdinal !== null) {
      return fail('VALUE_INVALID');
    }
    return Object.freeze({
      ...common,
      contextName,
      recordKind: recordKind as GroupManagementRecordKind,
      aggregateVersion: decodeUnsigned(raw.aggregateVersion),
      revisionOrdinal: null,
    });
  }

  if (
    contextName === 'settlement' &&
    recordKind === 'snapshot-revision' &&
    raw.aggregateVersion === null
  ) {
    return Object.freeze({
      ...common,
      contextName,
      recordKind,
      aggregateVersion: null,
      revisionOrdinal: decodeUnsigned(raw.revisionOrdinal),
    });
  }

  return fail('VALUE_INVALID');
};

const toRawHeader = (header: ProtectedRecordHeader): RawHeader => ({
  envelopeVersion: encodeUnsigned(header.envelopeVersion),
  algorithmId: header.algorithmId,
  app: header.app,
  contextName: header.contextName,
  recordKind: header.recordKind,
  groupId: header.groupId,
  logicalRecordId: header.logicalRecordId,
  schemaVersion: encodeUnsigned(header.schemaVersion),
  keyVersion: header.keyVersion,
  aggregateVersion:
    header.aggregateVersion === null
      ? null
      : encodeUnsigned(header.aggregateVersion),
  revisionOrdinal:
    header.revisionOrdinal === null
      ? null
      : encodeUnsigned(header.revisionOrdinal),
});

const encodeField = (tag: number, value: string | null): Uint8Array => {
  const payload = value === null ? new Uint8Array() : textEncoder.encode(value);
  if (value !== null && payload.length === 0) {
    return fail('VALUE_INVALID');
  }
  const result = Buffer.alloc(HEADER_SIZE + payload.length);
  result[0] = tag;
  result[1] = value === null ? 0 : 1;
  result.writeUInt32BE(payload.length, 2);
  result.set(payload, HEADER_SIZE);
  return result;
};

export const encodeCanonicalAad = (
  header: ProtectedRecordHeader,
): Uint8Array => {
  const canonical = validateAndCreateHeader(toRawHeader(header));
  const raw = toRawHeader(canonical);
  return Buffer.concat(
    fields.map(({ tag, name }) => encodeField(tag, raw[name])),
  );
};

export const decodeCanonicalAad = (aad: Uint8Array): ProtectedRecordHeader => {
  const raw: Partial<Record<FieldName, string | null>> = {};
  let offset = 0;

  for (const { tag, name } of fields) {
    if (aad.length - offset < HEADER_SIZE) {
      return fail('STRUCTURE_INVALID');
    }
    if (aad[offset] !== tag) {
      return fail('TAG_INVALID');
    }

    const presence = aad[offset + 1];
    if (presence !== 0 && presence !== 1) {
      return fail('PRESENCE_INVALID');
    }
    const length = Buffer.from(
      aad.buffer,
      aad.byteOffset + offset + 2,
      4,
    ).readUInt32BE(0);
    offset += HEADER_SIZE;

    if (presence === 0) {
      if (length !== 0) {
        return fail('LENGTH_INVALID');
      }
      raw[name] = null;
      continue;
    }
    if (length === 0 || length > aad.length - offset) {
      return fail('LENGTH_INVALID');
    }

    try {
      raw[name] = strictTextDecoder.decode(
        aad.subarray(offset, offset + length),
      );
    } catch {
      return fail('UTF8_INVALID');
    }
    offset += length;
  }

  if (offset !== aad.length) {
    return fail('STRUCTURE_INVALID');
  }

  return validateAndCreateHeader(raw as RawHeader);
};
