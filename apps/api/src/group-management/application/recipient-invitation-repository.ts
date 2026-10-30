import type {
  AuthenticationSerializedValue,
  AuthenticationTransactionScope,
} from '../../shared/application/authentication/authentication-transaction-scope.js';
import type {
  RecipientCodeCommitEvidence,
  RecipientCodeConsumptionHandle,
} from '../../shared/application/authentication/recipient-code-ports.js';
import type { ActorSubject, Group, GroupId } from '../domain/group.js';
import type {
  InvitationChange,
  InvitationCreatedResult,
  LoadedGroup,
  OperationId,
  StoredOperation,
} from './group-repository.js';
import type { RecipientCodeInvitationFingerprint } from './group-policy-digest.js';

/** 既存の全Command/全Group共通namespaceへ保存するコード操作。別locatorではない。 */
export interface StoredRecipientInvitationOperation {
  /** 新actionをlegacy文字列fingerprintと混同しない。 */ readonly fingerprint: RecipientCodeInvitationFingerprint;
  /** 現在SessionのActorと完全一致を要する。 */ readonly actorSubject: ActorSubject;
  /** Actor内で全Command/全Group共通の操作ID。 */ readonly operationId: OperationId;
  /** 外部へ返せる最小成功結果。現在Group版へ作り直さない。 */ readonly result: InvitationCreatedResult;
  /** 初回の認証済みfactsを保護operation内へ束縛する。Responseへ展開しない。 */ readonly binding: {
    /** 原値と独立した認証済み参照。 */ readonly codeId: string;
    /** 本人Session/コードMACで検証済み宛先。 */ readonly recipientActorId: string;
  };
}

/** GMの新規保存計画。実保存・認証・原子的消費の証拠そのものではない。 */
export interface RecipientInvitationCommitPlan {
  /** Groupの純粋判断を反映した不変Root。 */ readonly group: Group;
  /** 認可付きloadで固定したCAS版。 */ readonly expectedVersion: number;
  /** 新しいPending Invitationの作成は常に変更を伴う。 */ readonly stateChanged: true;
  /** Participant追加は本人受諾時であり、この計画では空。 */ readonly membershipChanges: readonly [];
  /** 7日Pendingを記録する既存の作成履歴。 */ readonly invitationChanges: readonly Extract<
    InvitationChange,
    { kind: 'Created' }
  >[];
  /** Group ClosingをこのCommandで変更しない。 */ readonly groupCloseChanges: readonly [];
  /** 共通namespaceの成功操作。raw codeを含めない。 */ readonly operation: StoredRecipientInvitationOperation;
  /** 同Scopeで固定した本文。attestation/consumeの計画と同じObjectを使う。 */ readonly value: AuthenticationSerializedValue;
}

/** #242のGM-owned参加Adapterが実装する。Pool/Transaction owner能力を持たない。 */
export interface RecipientInvitationRepository {
  /**
   * callerの共通operationを、Group load/現在Owner/宛先/code行に先行して照会する。
   * legacyも同じnamespaceから返し、異action/Group/内容はMismatchとして扱う。
   * @param scope 同じregistryの借用Scope。
   * @param actorSubject 現在有効Sessionのcaller。別Actorの結果を返さない。
   * @param operationId 全Group/Command共通ID。コード用locatorを作らない。
   * @returns 保護検証済みの保存成功または不在。削除済み結果を復元しない。
   * @throws Error 保存/復号/Scope障害。lease ownerがrollback/unavailableにする。
   */
  findOperation(
    scope: AuthenticationTransactionScope,
    actorSubject: ActorSubject,
    operationId: OperationId,
  ): Promise<StoredOperation | StoredRecipientInvitationOperation | null>;
  /**
   * @param scope 先頭でGM key-stateを準備済みの同Scope。
   * @returns 既に固定したcurrent proof世代。後付けLockを取らない。再送では呼ばない。
   * @throws Error 未準備/世代不正/障害。自動retryしない。
   */
  currentProofKeyVersion(
    scope: AuthenticationTransactionScope,
  ): Promise<string>;
  /**
   * @param scope コード検証後の同Scope。Groupより前のActor Lockへ戻らない。
   * @param groupId 操作対象。membership照合後だけ復号・Lockする。
   * @param actorSubject 現在Sessionのcaller。Owner/Active等の純粋RuleはGroupに委譲する。
   * @returns 固定したRoot/版、または不在/権限外を区別しないnull。
   * @throws Error 保存/復号/Scope障害。実decrypt0/Lockは#242で検証する。
   */
  loadForInvitation(
    scope: AuthenticationTransactionScope,
    groupId: GroupId,
    actorSubject: ActorSubject,
  ): Promise<LoadedGroup | null>;
  /**
   * Group/版/履歴/共通operation/GM Auditを同Scopeへ保存後、registryで計画をattestする。
   * @param scope 他接続やstandalone commitへfallbackしない借用Scope。
   * @param handle このleaseの一回消費権。
   * @param plan 証跡へ束縛するcodeId/宛先/operation/確定本文を持つ計画。
   * @returns 同scopeの登録GM Adapterが発行した保存証跡。SQLの完了commitではない。
   * @throws Error Conflict/Mismatch/保存/Audit障害。部分保存を成功として返さない。
   */
  stage(
    scope: AuthenticationTransactionScope,
    handle: RecipientCodeConsumptionHandle,
    plan: RecipientInvitationCommitPlan,
  ): Promise<RecipientCodeCommitEvidence>;
}
