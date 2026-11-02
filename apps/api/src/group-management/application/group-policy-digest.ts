import type { RecipientCodeRequestProof } from './recipient-code-request-proof.js';
import type {
  DigestPurpose,
  PurposeSeparatedDigest,
  PurposeSeparatedDigestPort,
} from '../../shared/application/purpose-separated-digest.js';

import {
  GroupId,
  type ActorSubject,
  type ParticipantId,
} from '../domain/group.js';
import type { OperationId } from './group-repository.js';

const textEncoder = new TextEncoder();

export type GroupPolicyDigestPurpose = DigestPurpose;
export type GroupPolicyDigest = PurposeSeparatedDigest;
export type GroupPolicyDigestPort = PurposeSeparatedDigestPort;

export type GroupPolicyDigestInput = Readonly<{
  purpose: GroupPolicyDigestPurpose;
  groupId: string;
  canonicalInput: Uint8Array;
}>;

type CanonicalTlvField = Readonly<{ tag: number; value: string | Uint8Array }>;

const encodeCanonicalTlv = (
  fields: readonly CanonicalTlvField[],
): Uint8Array => {
  const ordered = [...fields].sort((left, right) => left.tag - right.tag);
  if (
    ordered.length === 0 ||
    ordered.some(
      ({ tag, value }, index) =>
        !Number.isInteger(tag) ||
        tag < 1 ||
        tag > 255 ||
        value.length === 0 ||
        (index > 0 && ordered[index - 1]?.tag === tag),
    )
  ) {
    throw new TypeError(
      'Canonical TLV fields must be unique, ordered, and non-empty',
    );
  }

  const encoded = ordered.map(({ tag, value }) => {
    const bytes =
      typeof value === 'string'
        ? textEncoder.encode(value)
        : new Uint8Array(value);
    const field = new Uint8Array(5 + bytes.length);
    field[0] = tag;
    new DataView(field.buffer).setUint32(1, bytes.length, false);
    field.set(bytes, 5);
    return field;
  });
  const length = encoded.reduce((total, field) => total + field.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const field of encoded) {
    result.set(field, offset);
    offset += field.length;
  }
  return result;
};

const digestInput = (
  purpose: GroupPolicyDigestPurpose,
  groupId: string,
  fields: readonly CanonicalTlvField[],
): GroupPolicyDigestInput =>
  Object.freeze({
    purpose,
    groupId,
    canonicalInput: encodeCanonicalTlv(fields),
  });

/**
 * Purpose値は保存Indexの契約の一部。呼出し側はByte列を変更せず、
 * 用途を分離したDigest Portへ渡す必要がある。
 */
export const actorAccessIndexDigestInput = (
  groupId: GroupId,
  actorSubject: ActorSubject,
): GroupPolicyDigestInput =>
  digestInput('group-actor-access-index/v1', groupId.value, [
    { tag: 0x01, value: 'group-access-policy/v1' },
    { tag: 0x02, value: 'actor-access-index' },
    { tag: 0x03, value: actorSubject.value },
  ]);

export const membershipDigestInput = (
  groupId: GroupId,
  participantId: ParticipantId,
): GroupPolicyDigestInput =>
  digestInput('group-membership-index/v1', groupId.value, [
    { tag: 0x01, value: 'group-access-policy/v1' },
    { tag: 0x02, value: 'membership' },
    { tag: 0x04, value: participantId.value },
  ]);

/**
 * CreateGroupはGroupが存在する前に再送結果を検索するため、
 * operation locatorはGroup IDを持たない。鍵の名前空間はContext単位。
 */
export type GroupOperationLocatorDigestInput = Readonly<{
  purpose: 'group-operation-locator/v2';
  canonicalInput: Uint8Array;
}>;

export type GroupOperationLocatorCandidate = Readonly<{
  digest: GroupPolicyDigest;
  digestKeyVersion: string;
}>;

export interface GroupOperationLocatorKeyPort {
  currentDigest(
    input: GroupOperationLocatorDigestInput,
  ): Promise<GroupOperationLocatorCandidate>;

  candidateDigests(
    input: GroupOperationLocatorDigestInput,
  ): Promise<readonly GroupOperationLocatorCandidate[]>;
}

export const operationLocatorDigestInput = (
  actorSubject: ActorSubject,
  operationId: OperationId,
): GroupOperationLocatorDigestInput =>
  Object.freeze({
    purpose: 'group-operation-locator/v2',
    canonicalInput: encodeCanonicalTlv([
      { tag: 0x01, value: 'group-operation-locator/v2' },
      { tag: 0x02, value: 'operation-locator' },
      { tag: 0x03, value: actorSubject.value },
      { tag: 0x05, value: operationId.value },
    ]),
  });

export const operationFingerprintDigestInput = (
  groupId: GroupId,
  commandKind: string,
  commandSemantic: string,
): GroupPolicyDigestInput =>
  digestInput('group-operation-fingerprint/v1', groupId.value, [
    { tag: 0x01, value: 'group-access-policy/v1' },
    { tag: 0x02, value: 'operation-fingerprint' },
    { tag: 0x06, value: commandKind },
    { tag: 0x07, value: commandSemantic },
  ]);

/** 新actionの保護fingerprint。旧CommandFingerprint文字列へ原コードを流さない。 */
export interface RecipientCodeInvitationFingerprint {
  /** 既存InviteParticipantと別actionで束縛する。 */ readonly action: 'CreateInvitationFromRecipientCode';
  /** canonical形式を将来変更する場合は別versionにする。 */ readonly version: 1;
  /** Actor内の他Group操作とのID衝突もMismatchにする。 */ readonly groupId: GroupId;
  /** 再送では現在版を要求せず、元の要求版を照合する。 */ readonly expectedVersion: number;
  /** 保存世代の独立proof。原コード/検索Digestではない。 */ readonly proof: RecipientCodeRequestProof;
  /** tag順・big-endian lengthのGM canonical TLV。独立Copyであり完全消去は保証しない。 */ readonly canonicalInput: Uint8Array;
}

/**
 * GMの既存TLV規則で新操作の内容を束縛し、入力proofのbyte列を独立Copyする。
 * @param groupId 正規化済みの操作対象。再送時は保存値へ照合する。
 * @param expectedVersion 1を加算可能な正のsafe integer。
 * @param proof GM独立用途の保存世代/32byte証明。未知field/accessorも拒否する。
 * @returns 原コードを含まないaction/version/Group/版/proof世代/値の固定fingerprint。
 * @throws TypeError 入力形/用途/世代/長さ/版不正。例外へ入力を含めない。
 */
export const recipientCodeInvitationFingerprint = (
  groupId: GroupId,
  expectedVersion: number,
  proof: RecipientCodeRequestProof,
): RecipientCodeInvitationFingerprint => {
  const fail = (): never => {
    throw new TypeError('Invalid recipient invitation fingerprint');
  };
  if (
    !(groupId instanceof GroupId) ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1 ||
    !Number.isSafeInteger(expectedVersion + 1) ||
    !proof ||
    typeof proof !== 'object' ||
    (Object.getPrototypeOf(proof) !== Object.prototype &&
      Object.getPrototypeOf(proof) !== null)
  )
    return fail();
  const keys = Reflect.ownKeys(proof);
  const names = ['purpose', 'keyVersion', 'epoch', 'scopeId', 'bytes'];
  if (
    keys.length !== names.length ||
    keys.some(
      (k) =>
        typeof k !== 'string' ||
        !names.includes(k) ||
        !Object.getOwnPropertyDescriptor(proof, k)?.enumerable ||
        !('value' in Object.getOwnPropertyDescriptor(proof, k)!),
    )
  )
    return fail();
  if (
    proof.purpose !== 'gm-recipient-code-request/v1' ||
    proof.scopeId !== 'group-management' ||
    proof.epoch !== null ||
    typeof proof.keyVersion !== 'string' ||
    proof.keyVersion.length > 255 ||
    !/^[A-Za-z0-9._:-]+$/.test(proof.keyVersion) ||
    !(proof.bytes instanceof Uint8Array) ||
    proof.bytes.length !== 32
  )
    return fail();
  const saved: RecipientCodeRequestProof = Object.freeze({
    purpose: proof.purpose,
    keyVersion: proof.keyVersion,
    epoch: null,
    scopeId: 'group-management',
    bytes: new Uint8Array(proof.bytes) as RecipientCodeRequestProof['bytes'],
  });
  const group = GroupId.from(groupId.value);
  return Object.freeze({
    action: 'CreateInvitationFromRecipientCode',
    version: 1,
    groupId: group,
    expectedVersion,
    proof: saved,
    canonicalInput: encodeCanonicalTlv([
      { tag: 1, value: 'group-recipient-invitation-fingerprint/v1' },
      { tag: 2, value: 'CreateInvitationFromRecipientCode' },
      { tag: 3, value: group.value },
      { tag: 4, value: String(expectedVersion) },
      { tag: 5, value: saved.keyVersion },
      { tag: 6, value: saved.bytes },
    ]),
  });
};
