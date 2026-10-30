import {
  authenticationObject,
  authenticationUuid,
  parseAuthenticationSecret,
} from '../../../shared/infrastructure/authentication/canonical-authentication.js';
import {
  CommandFingerprint,
  OperationId,
  type StoredOperation,
} from '../../application/group-repository.js';
import { recipientCodeInvitationFingerprint } from '../../application/group-policy-digest.js';
import type { StoredRecipientInvitationOperation } from '../../application/recipient-invitation-repository.js';
import type { RecipientCodeRequestProof } from '../../application/recipient-code-request-proof.js';
import { ActorSubject, GroupId, InvitationId } from '../../domain/group.js';
import {
  decodeOperationResultPayload,
  encodeOperationResultPayload,
} from './group-record-payload.js';

/** Actor内・全Command共通の保護operation。保存形式だけを区別し、別locatorにしない。 */
export type StoredGroupOperation =
  StoredOperation | StoredRecipientInvitationOperation;

const fail = (): never => {
  throw new TypeError('Invalid protected Group operation');
};
const text = (v: unknown): string =>
  typeof v === 'string' && v.trim().length > 0 ? v : fail();
const version = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail();

const isRecipientOperation = (
  operation: StoredGroupOperation,
): operation is StoredRecipientInvitationOperation =>
  !(operation.fingerprint instanceof CommandFingerprint);

/**
 * 既存形式のbyte列を維持し、新actionだけversion2へ符号化する。
 * @param operation 原コードを持たず、検証済みの保存成功計画。
 * @returns 既存Envelope内へ渡すUTF-8 payload。Envelope/AADの版は変更しない。
 * @throws Error 不正な新fingerprint・binding・結果。入力を例外へ含めない。
 */
export const encodeStoredGroupOperation = (
  operation: StoredGroupOperation,
): Uint8Array => {
  if (!isRecipientOperation(operation))
    return encodeOperationResultPayload(operation);
  const fp = operation.fingerprint;
  const canonical = recipientCodeInvitationFingerprint(
    fp.groupId,
    fp.expectedVersion,
    fp.proof,
  );
  if (
    fp.action !== canonical.action ||
    fp.version !== canonical.version ||
    !(fp.canonicalInput instanceof Uint8Array) ||
    !Buffer.from(fp.canonicalInput).equals(
      Buffer.from(canonical.canonicalInput),
    )
  )
    return fail();
  const candidate = operation;
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      payloadVersion: 2,
      actorSubject: candidate.actorSubject.value,
      operationId: candidate.operationId.value,
      fingerprint: {
        action: fp.action,
        version: fp.version,
        groupId: fp.groupId.value,
        expectedVersion: fp.expectedVersion,
        proofKeyVersion: canonical.proof.keyVersion,
        proof: Buffer.from(canonical.proof.bytes).toString('base64url'),
      },
      binding: {
        codeId: candidate.binding.codeId,
        recipientActorId: candidate.binding.recipientActorId,
      },
      result: {
        kind: candidate.result.kind,
        groupId: candidate.result.groupId.value,
        version: candidate.result.version,
        invitationId: candidate.result.invitationId.value,
      },
    }),
  );
  // 永続化する前にも同じstrict decoderで形式と相互bindingを検査する。
  decodeStoredGroupOperation(bytes);
  return bytes;
};

/**
 * 共通namespaceの保護済み本文を旧形式または厳格な新形式へ復元する。
 * @param bytes AEADの期待Header検証に成功した本文。未検証DB行を直接渡さない。
 * @returns 旧保存成功、または保存proof世代と再構築canonicalを持つ新保存成功。
 * @throws Error 未知版/field/用途/世代/32byte表記/結果binding不正。
 */
export const decodeStoredGroupOperation = (
  bytes: Uint8Array,
): StoredGroupOperation => {
  const parsed: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  );
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return fail();
  const payloadVersion: unknown = Object.getOwnPropertyDescriptor(
    parsed,
    'payloadVersion',
  )?.value;
  if (payloadVersion === 1) return decodeOperationResultPayload(bytes);
  const root = authenticationObject(parsed, [
    'payloadVersion',
    'actorSubject',
    'operationId',
    'fingerprint',
    'binding',
    'result',
  ]);
  if (root.payloadVersion !== 2) return fail();
  const fp = authenticationObject(root.fingerprint, [
    'action',
    'version',
    'groupId',
    'expectedVersion',
    'proofKeyVersion',
    'proof',
  ]);
  if (fp.action !== 'CreateInvitationFromRecipientCode' || fp.version !== 1)
    return fail();
  const groupId = GroupId.from(text(fp.groupId));
  const expectedVersion = version(fp.expectedVersion);
  const proof: RecipientCodeRequestProof = {
    purpose: 'gm-recipient-code-request/v1',
    scopeId: 'group-management',
    epoch: null,
    keyVersion: text(fp.proofKeyVersion),
    bytes: parseAuthenticationSecret(
      fp.proof,
    ) as RecipientCodeRequestProof['bytes'],
  };
  const fingerprint = recipientCodeInvitationFingerprint(
    groupId,
    expectedVersion,
    proof,
  );
  const binding = authenticationObject(root.binding, [
    'codeId',
    'recipientActorId',
  ]);
  const result = authenticationObject(root.result, [
    'kind',
    'groupId',
    'version',
    'invitationId',
  ]);
  if (
    result.kind !== 'InvitationCreated' ||
    result.groupId !== groupId.value ||
    version(result.version) !== expectedVersion + 1
  )
    return fail();
  return Object.freeze({
    actorSubject: ActorSubject.from(authenticationUuid(root.actorSubject)),
    operationId: OperationId.from(text(root.operationId)),
    fingerprint,
    binding: Object.freeze({
      codeId: authenticationUuid(binding.codeId),
      recipientActorId: authenticationUuid(binding.recipientActorId),
    }),
    result: Object.freeze({
      kind: 'InvitationCreated',
      groupId,
      version: expectedVersion + 1,
      invitationId: InvitationId.from(text(result.invitationId)),
    }),
  });
};
