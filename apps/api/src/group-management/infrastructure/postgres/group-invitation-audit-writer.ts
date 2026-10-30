import { randomUUID } from 'node:crypto';
import {
  authenticationKeyVersion,
  authenticationObject,
  authenticationUuid,
} from '../../../shared/infrastructure/authentication/canonical-authentication.js';
import {
  GroupInvitationAuditUnavailable,
  type GroupInvitationAuditProtector,
} from '../../application/group-invitation-audit.js';
import type { StoredRecipientInvitationOperation } from '../../application/recipient-invitation-repository.js';
import type { GroupSqlQuery } from './group-storage-contracts.js';

/** 同一GM借用Scopeへ最小Auditをdurable保存し、成功するまで証跡を許可しない。 */
export class PostgresGroupInvitationAuditWriter {
  /**
   * @param options 独立Audit ProtectorとServer生成の時刻/UUID。Poolを受けない。
   */
  constructor(
    private readonly options: {
      /** 独立鍵/用途/要求semanticの保護境界。 */ readonly protector: GroupInvitationAuditProtector;
      /** UTC保存時刻。 */ readonly now?: () => Date;
      /** operation結果IDとは独立したrequest UUID。 */ readonly nextRequestId?: () => string;
    },
  ) {}

  /**
   * @param query 同一Transactionのquery限定能力。
   * @param operation stage成功した原コードなしの操作。
   * @param accessPolicyVersion 同判断点のPolicy版。
   * @throws GroupInvitationAuditUnavailable SQL/鍵/形式障害。ownerは全rollbackする。
   */
  async write(
    query: GroupSqlQuery,
    operation: StoredRecipientInvitationOperation,
    accessPolicyVersion: number,
  ): Promise<void> {
    try {
      const requestId = authenticationUuid(
        (this.options.nextRequestId ?? randomUUID)(),
      );
      const time = this.options.now?.() ?? new Date();
      if (
        !(time instanceof Date) ||
        Number.isNaN(time.getTime()) ||
        !Number.isSafeInteger(accessPolicyVersion) ||
        accessPolicyVersion < 1
      )
        throw new GroupInvitationAuditUnavailable();
      const occurredAt = new Date(time.getTime());
      const protection: unknown = await this.options.protector.protect({
        operation,
        accessPolicyVersion,
      });
      const p = authenticationObject(protection, [
        'actorPseudonym',
        'groupPseudonym',
        'resourcePseudonym',
        'requestFingerprint',
        'auditKeyVersion',
      ]);
      const bytes = (v: unknown): Buffer => {
        if (!(v instanceof Uint8Array) || v.length !== 32)
          throw new GroupInvitationAuditUnavailable();
        return Buffer.from(v);
      };
      const keyVersion = authenticationKeyVersion(p.auditKeyVersion);
      if (keyVersion.length > 255) throw new GroupInvitationAuditUnavailable();
      await query.query(
        `INSERT INTO group_recipient_invitation_audit_record (request_id, occurred_at, action, decision, reason_code, policy_version, actor_pseudonym, group_pseudonym, resource_pseudonym, request_fingerprint, audit_key_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          requestId,
          occurredAt,
          'CreateInvitationFromRecipientCode',
          'allow',
          'InvitationCreated',
          accessPolicyVersion,
          bytes(p.actorPseudonym),
          bytes(p.groupPseudonym),
          bytes(p.resourcePseudonym),
          bytes(p.requestFingerprint),
          keyVersion,
        ],
      );
    } catch {
      throw new GroupInvitationAuditUnavailable();
    }
  }
}
