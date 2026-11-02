import { createHmac } from 'node:crypto';
import {
  authenticationKeyVersion,
  authenticationObject,
  encodeAuthenticationTlv,
} from '../../shared/infrastructure/authentication/canonical-authentication.js';
import {
  GroupInvitationAuditUnavailable,
  type GroupInvitationAuditKey,
  type GroupInvitationAuditKeyPort,
  type GroupInvitationAuditProtector,
} from '../application/group-invitation-audit.js';
import { recipientCodeInvitationFingerprint } from '../application/group-policy-digest.js';

const fail = (): never => {
  throw new GroupInvitationAuditUnavailable();
};
const copy32 = (value: unknown): Uint8Array =>
  value instanceof Uint8Array && value.length === 32
    ? new Uint8Array(value)
    : fail();

/**
 * 合意済みのGM Audit用途へ独立鍵をImportし、入力参照を共有しない。
 * @param material 他の用途と独立生成した32-byte値。
 * @returns GM Audit用途だけの鍵。
 * @throws GroupInvitationAuditUnavailable 長さ/型不正。
 */
export const importGroupInvitationAuditKey = (
  material: Uint8Array,
): GroupInvitationAuditKey =>
  Object.freeze({
    purpose: 'gm-security-audit/v1',
    material: copy32(material) as GroupInvitationAuditKey['material'],
  });

/**
 * 既存Canonical TLV部品とNode HMACでGM Auditの独立用途を構成する。
 * @param options GM/Group単位の独立Audit鍵Port。具体Providerは組み立てない。
 * @returns 仮名/要求指紋を作る能力。DB/コード行/Sessionを読まない。
 */
export const createGroupInvitationAuditProtector = (options: {
  /** 90日+関連Backup windowを保持する独立鍵境界。 */ readonly keys: GroupInvitationAuditKeyPort;
}): GroupInvitationAuditProtector => {
  const keys = options.keys;
  return Object.freeze({
    async protect({ operation, accessPolicyVersion }) {
      try {
        if (
          !Number.isSafeInteger(accessPolicyVersion) ||
          accessPolicyVersion < 1
        )
          return fail();
        if (
          operation.fingerprint.action !==
            'CreateInvitationFromRecipientCode' ||
          operation.fingerprint.version !== 1
        )
          return fail();
        const groupId = operation.result.groupId.value;
        const actor = operation.actorSubject.value;
        const resource = operation.result.invitationId.value;
        const operationId = new TextEncoder().encode(
          operation.operationId.value,
        );
        const codeId = operation.binding.codeId;
        const recipient = operation.binding.recipientActorId;
        const fp = recipientCodeInvitationFingerprint(
          operation.fingerprint.groupId,
          operation.fingerprint.expectedVersion,
          operation.fingerprint.proof,
        );
        if (
          operation.result.kind !== 'InvitationCreated' ||
          fp.groupId.value !== groupId ||
          operation.result.version !== fp.expectedVersion + 1 ||
          !Buffer.from(fp.canonicalInput).equals(
            operation.fingerprint.canonicalInput,
          )
        )
          return fail();
        const response: unknown = await keys.readCurrent({ scopeId: groupId });
        const selected = authenticationObject(response, [
          'status',
          'scopeId',
          'keyVersion',
          'key',
        ]);
        if (selected.status !== 'available' || selected.scopeId !== groupId)
          return fail();
        const keyVersion = authenticationKeyVersion(selected.keyVersion);
        if (keyVersion.length > 255) return fail();
        const descriptor = authenticationObject(selected.key, [
          'purpose',
          'material',
        ]);
        if (descriptor.purpose !== 'gm-security-audit/v1') return fail();
        const material = copy32(descriptor.material);
        try {
          const mac = (
            purpose: string,
            values: readonly (string | Uint8Array)[],
          ) =>
            Uint8Array.from(
              createHmac('sha256', material)
                .update(
                  encodeAuthenticationTlv([
                    'kakei_app',
                    'gm-security-audit/v1',
                    purpose,
                    groupId,
                    ...values,
                  ]),
                )
                .digest(),
            );
          const actorPseudonym = mac('actor', [actor]);
          const groupPseudonym = mac('group', [groupId]);
          const resourcePseudonym = mac('invitation', [resource]);
          const requestFingerprint = mac('request-fingerprint', [
            actorPseudonym,
            groupPseudonym,
            resourcePseudonym,
            'CreateInvitationFromRecipientCode',
            String(accessPolicyVersion),
            operationId,
            fp.canonicalInput,
            codeId,
            recipient,
          ]);
          return Object.freeze({
            actorPseudonym,
            groupPseudonym,
            resourcePseudonym,
            requestFingerprint,
            auditKeyVersion: keyVersion,
          });
        } finally {
          material.fill(0);
        }
      } catch {
        return fail();
      }
    },
  } satisfies GroupInvitationAuditProtector);
};
