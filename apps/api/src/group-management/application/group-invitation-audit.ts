import type { StoredRecipientInvitationOperation } from './recipient-invitation-repository.js';

declare const auditKeyBrand: unique symbol;
/** Group DEK/locator/proof/認証Auditとは独立したGM Audit鍵。 */
export interface GroupInvitationAuditKey {
  /** 他用途の鍵Descriptorを拒否する固定用途。 */ readonly purpose: 'gm-security-audit/v1';
  /** Group削除で破棄せず、90日と関連Backup35日まで保持する独立256-bit値。 */ readonly material: Uint8Array & {
    /** 他用途の32-byte値との型上の混同を拒否する。 */ readonly [auditKeyBrand]: true;
  };
}
/** 独立ProviderのGM/Group別Audit鍵読取。具体Provider/破棄能力を提供しない。 */
export interface GroupInvitationAuditKeyPort {
  /**
   * @param input Group単位の独立Audit Namespace。Group DEKではない。
   * @returns 現行独立鍵と完全なDescriptor、または利用不能。
   * @throws Error Provider障害。利用者へ元例外を公開しない。
   */
  readCurrent(input: {
    /** 仮名のScope。DB Auditへ直接保存しない。 */ readonly scopeId: string;
  }): Promise<
    | {
        /** Descriptor全体の検証対象。 */ readonly status: 'available';
        /** 要求Scopeと完全一致する。 */ readonly scopeId: string;
        /** 90日/Backup保持の世代識別。 */ readonly keyVersion: string;
        /** GM専用の独立鍵。 */ readonly key: GroupInvitationAuditKey;
      }
    | {
        /** 鍵不在/破棄/障害を詳細非開示にする。 */ readonly status: 'unavailable';
      }
  >;
}
/** 平文Auditへ許可する用途別仮名と要求指紋だけ。直接ID/proof/codeを含まない。 */
export interface GroupInvitationAuditProtection {
  /** Group単位・Actor用途の32-byte仮名。 */ readonly actorPseudonym: Uint8Array;
  /** Group用途の32-byte仮名。 */ readonly groupPseudonym: Uint8Array;
  /** Invitation用途の32-byte仮名。 */ readonly resourcePseudonym: Uint8Array;
  /** Actor/Group/Resource/action/版/要求semanticを束縛する独立32-byte値。 */ readonly requestFingerprint: Uint8Array;
  /** 仮名と指紋を作ったAudit鍵世代。 */ readonly auditKeyVersion: string;
}
/** GM Auditの用途分離だけを所有し、Transactionや業務判断を持たない。 */
export interface GroupInvitationAuditProtector {
  /**
   * @param input 保存成功計画と固定Policy版。await前に必要事実をCopyする。
   * @returns 直接IDを含まない独立したAudit値。
   * @throws GroupInvitationAuditUnavailable 入力/用途/鍵障害。
   */
  protect(input: {
    /** 原コードなしの保存操作。 */ readonly operation: StoredRecipientInvitationOperation;
    /** 当該保存で固定したPolicy版。 */ readonly accessPolicyVersion: number;
  }): Promise<GroupInvitationAuditProtection>;
}
/** 原例外/入力/秘密値を保持しない固定Audit障害。 */
export class GroupInvitationAuditUnavailable extends Error {
  /** 原因をcauseへ保持しない固定Errorを作る。 */
  constructor() {
    super('Group invitation audit unavailable');
    this.name = 'GroupInvitationAuditUnavailable';
  }
}
