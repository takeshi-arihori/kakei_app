const MAX_UNSIGNED_INT64 = (1n << 63n) - 1n;
const HEADER_SIZE = 6;
const textEncoder = new TextEncoder();
const strictTextDecoder = new TextDecoder('utf-8', { fatal: true });

/** ADR #55のCanonical Envelope形式Version。 */
export const PROTECTED_RECORD_ENVELOPE_VERSION = 1n;
/** 保存形式で固定する認証付き暗号Algorithm。 */
export const PROTECTED_RECORD_ALGORITHM = 'AES-256-GCM' as const;
/** AADをこのApplicationへ束縛する固定識別子。 */
export const PROTECTED_RECORD_APP = 'kakei_app' as const;

/** Group Managementが所有する保存Recordの用途。AADで相互の差替えを拒否する。 */
export type GroupManagementRecordKind =
  | 'group'
  | 'participant'
  | 'invitation'
  | 'membership-history'
  | 'invitation-history'
  | 'group-close-history'
  | 'operation-result';

/** 暗号化PayloadをContext・Group・Record・Versionへ束縛するAADの事実。 */
export type ProtectedRecordHeader =
  | Readonly<{
      /** Canonical TLVの形式Version。現在は1だけを許可する。 */
      envelopeVersion: bigint;
      /** AADに含める固定Algorithm名。AES-256-GCM以外を拒否する。 */
      algorithmId: typeof PROTECTED_RECORD_ALGORITHM;
      /** このApplicationの固定識別子。他ApplicationのRecordと混同しない。 */
      app: typeof PROTECTED_RECORD_APP;
      /** Data OwnerのContext識別子。Groupと合わせて鍵のScopeを決める。 */
      contextName: 'group-management';
      /** 同Context内のRecord用途。異なる用途の暗号文を差し替えさせない。 */
      recordKind: GroupManagementRecordKind;
      /** 暗号化またはDigestのScopeとなるGroup参照。AADでは小文字Canonical UUIDを要求する。 */
      groupId: string;
      /** この暗号文が属する論理Recordの小文字Canonical UUID。 */
      logicalRecordId: string;
      /** PayloadのSchema Version。AADで保存形式の解釈へ束縛する。 */
      schemaVersion: bigint;
      /** 認証する鍵Version。復号時は期待値と完全一致する鍵を取得する。 */
      keyVersion: string;
      /** 可変Group Recordの版。不変Revisionではnullとし、Revision序数と混同しない。 */
      aggregateVersion: bigint;
      /** 不変Settlement Revisionの序数。可変Group Recordではnullとする。 */
      revisionOrdinal: null;
    }>
  | Readonly<{
      /** Canonical TLVの形式Version。現在は1だけを許可する。 */
      envelopeVersion: bigint;
      /** AADに含める固定Algorithm名。AES-256-GCM以外を拒否する。 */
      algorithmId: typeof PROTECTED_RECORD_ALGORITHM;
      /** このApplicationの固定識別子。他ApplicationのRecordと混同しない。 */
      app: typeof PROTECTED_RECORD_APP;
      /** Data OwnerのContext識別子。Groupと合わせて鍵のScopeを決める。 */
      contextName: 'settlement';
      /** 同Context内のRecord用途。異なる用途の暗号文を差し替えさせない。 */
      recordKind: 'snapshot-revision';
      /** 暗号化またはDigestのScopeとなるGroup参照。AADでは小文字Canonical UUIDを要求する。 */
      groupId: string;
      /** この暗号文が属する論理Recordの小文字Canonical UUID。 */
      logicalRecordId: string;
      /** PayloadのSchema Version。AADで保存形式の解釈へ束縛する。 */
      schemaVersion: bigint;
      /** 認証する鍵Version。復号時は期待値と完全一致する鍵を取得する。 */
      keyVersion: string;
      /** 可変Group Recordの版。不変Revisionではnullとし、Revision序数と混同しない。 */
      aggregateVersion: null;
      /** 不変Settlement Revisionの序数。可変Group Recordではnullとする。 */
      revisionOrdinal: bigint;
    }>;

/** 入力値を含めずCanonical AADの不正種別を表す固定Code。 */
export type CanonicalAadViolationCode =
  | 'STRUCTURE_INVALID'
  | 'TAG_INVALID'
  | 'PRESENCE_INVALID'
  | 'LENGTH_INVALID'
  | 'UTF8_INVALID'
  | 'VALUE_INVALID';

/** Canonical AADの検証失敗。入力値や鍵をErrorへ含めない。 */
export class CanonicalAadViolation extends Error {
  /**
   * 入力値を含まないAAD検証失敗を生成する。
   * @param code 検証で確定した固定違反Code。
   */
  constructor(
    /** 入力値を露出せず、違反種別だけを内部判定へ伝える固定Code。 */
    readonly code: CanonicalAadViolationCode,
  ) {
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
      'group-close-history',
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

/**
 * Headerの事実を検証し、固定順序のCanonical TLVへ符号化する。
 * @param header Record参照・版・鍵Versionを持つAADの事実。
 * @returns 認証に使うCanonical AADのByte列。
 * @throws CanonicalAadViolation Headerの形式・値・範囲が不正な場合。
 */
export const encodeCanonicalAad = (
  header: ProtectedRecordHeader,
): Uint8Array => {
  const canonical = validateAndCreateHeader(toRawHeader(header));
  const raw = toRawHeader(canonical);
  return Buffer.concat(
    fields.map(({ tag, name }) => encodeField(tag, raw[name])),
  );
};

/**
 * Canonical TLVの構造・値を検証してHeaderを復元する。
 * @param aad 保存EnvelopeのAAD Byte列。順序・長さ・UTF-8を検証する。
 * @returns Contextに対応した不変Header。
 * @throws CanonicalAadViolation 非Canonical形式、不正値、余分なByte等を検出した場合。
 */
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
