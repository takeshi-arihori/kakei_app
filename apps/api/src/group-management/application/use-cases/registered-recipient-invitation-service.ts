import { RecipientCodeSecret } from '../../../shared/application/authentication/recipient-code-input.js';
import type {
  AuthenticationClock,
  AuthenticatedActor,
  AuthenticatedActorResult,
} from '../../../shared/application/authentication/authentication-ports.js';
import type {
  AuthenticationSerializedValue,
  AuthenticationTransactionScope,
} from '../../../shared/application/authentication/authentication-transaction-scope.js';
import type {
  RecipientCodeSessionPort,
  RecipientCodeUnavailableToActor,
} from '../../../shared/application/authentication/recipient-code-ports.js';
import {
  ActorSubject,
  GroupId,
  UtcInstant,
  type InvitationId,
} from '../../domain/group.js';
import { GroupCommandApplicationError } from '../group-command-service.js';
import {
  CommandFingerprint,
  OperationId,
  type InvitationCreatedResult,
} from '../group-repository.js';
import { recipientCodeInvitationFingerprint } from '../group-policy-digest.js';
import type { RecipientCodeRequestProofPort } from '../recipient-code-request-proof.js';
import type {
  RecipientInvitationRepository,
  StoredRecipientInvitationOperation,
} from '../recipient-invitation-repository.js';

/** Client入力だけ。caller/宛先/Role/codeIdは有効leaseのfactsから得る。 */
export interface CreateInvitationFromRecipientCodeCommand {
  /** 現在有効な本人Session。結果へ保存しない。 */ readonly sessionSecret: string;
  /** 最初のawait前に固定する不変VO。保護operationにも原値を保存しない。 */ readonly code: RecipientCodeSecret;
  /** Clientが指定できる対象Group。認可はscope内のloadとDomainで行う。 */ readonly groupId: GroupId;
  /** 変更前の正のsafe integer。 */ readonly expectedVersion: number;
  /** Actor内・全Command/全Group共通。 */ readonly operationId: OperationId;
}

const mismatch = (): never => {
  throw new GroupCommandApplicationError(
    'OPERATION_MISMATCH',
    'Stored operation does not match the command',
  );
};
const unavailable = (): never => {
  throw new GroupCommandApplicationError(
    'UNAVAILABLE',
    'Recipient invitation unavailable',
  );
};
const snapshot = (
  command: CreateInvitationFromRecipientCodeCommand,
): CreateInvitationFromRecipientCodeCommand => {
  try {
    if (
      !command ||
      typeof command !== 'object' ||
      (Object.getPrototypeOf(command) !== Object.prototype &&
        Object.getPrototypeOf(command) !== null)
    )
      return unavailable();
    const fields = [
      'sessionSecret',
      'code',
      'groupId',
      'expectedVersion',
      'operationId',
    ];
    const keys = Reflect.ownKeys(command);
    if (
      keys.length !== fields.length ||
      keys.some(
        (k) =>
          typeof k !== 'string' ||
          !fields.includes(k) ||
          !Object.getOwnPropertyDescriptor(command, k)?.enumerable ||
          !('value' in Object.getOwnPropertyDescriptor(command, k)!),
      )
    )
      return unavailable();
    if (
      typeof command.sessionSecret !== 'string' ||
      !(command.code instanceof RecipientCodeSecret) ||
      Object.getPrototypeOf(command.code) !== RecipientCodeSecret.prototype ||
      !(command.groupId instanceof GroupId) ||
      !(command.operationId instanceof OperationId)
    )
      return unavailable();
    RecipientCodeSecret.prototype.copyBytes.call(command.code);
    if (
      !Number.isSafeInteger(command.expectedVersion) ||
      command.expectedVersion < 1 ||
      !Number.isSafeInteger(command.expectedVersion + 1)
    )
      throw new GroupCommandApplicationError(
        'INVALID_EXPECTED_VERSION',
        'Expected version must allow one safe increment',
      );
    return Object.freeze({
      sessionSecret: command.sessionSecret,
      code: command.code,
      groupId: GroupId.from(command.groupId.value),
      expectedVersion: command.expectedVersion,
      operationId: OperationId.from(command.operationId.value),
    });
  } catch (error) {
    if (error instanceof GroupCommandApplicationError) throw error;
    return unavailable();
  }
};
const minimal = (result: InvitationCreatedResult) => ({
  kind: 'InvitationCreated',
  groupId: result.groupId.value,
  invitationId: result.invitationId.value,
  version: result.version,
});

/** 純粋Group判断と同Scopeの保存/消費Portだけを調整する。実本人性/SQLは注入Adapterの責務。 */
export class RegisteredRecipientInvitationService {
  /**
   * @param options caller-only再送→新規lease、GM参加Port、独立proof、ID/Clockの信頼済み能力。
   */
  constructor(
    private readonly options: {
      /** #236のuse契約。実lease/wiringはこのUse Caseで作らない。 */ readonly sessions: Pick<
        RecipientCodeSessionPort,
        'use'
      >;
      /** 共通operation namespaceとGM保存証跡を所有する。 */ readonly repository: RecipientInvitationRepository;
      /** 保存世代でverifyし、新規時だけcurrentを選ぶ。 */ readonly proof: RecipientCodeRequestProofPort;
      /** 信頼済みCompositionのserver生成ID。Client指定させない。 */ readonly nextInvitationId: () => InvitationId;
      /** 全blocking Lock後のUTC判断点。 */ readonly clock: AuthenticationClock;
    },
  ) {}
  /**
   * @param command Client入力をfactsと区別して同期固定する。原値/Role/Actorを成功結果へ入れない。
   * @returns commit確認後の最小本文、未認証/存在非開示の拒否/結果不明を含む障害。
   * @throws GroupCommandApplicationError 入力形/期待版不正。Callbackの業務拒否/障害はlease ownerへ委譲する。
   */
  async create(
    command: CreateInvitationFromRecipientCodeCommand,
  ): Promise<
    | AuthenticatedActorResult<AuthenticationSerializedValue>
    | RecipientCodeUnavailableToActor
  > {
    const input = snapshot(command);
    const { repository, proof, clock } = this.options;
    const replay = async (
      caller: AuthenticatedActor,
      scope: AuthenticationTransactionScope,
    ) => {
      const actor = ActorSubject.from(caller.actorSubject);
      const saved = await repository.findOperation(
        scope,
        actor,
        input.operationId,
      );
      if (!saved) return { status: 'no-replay' as const };
      if (
        !saved.actorSubject.equals(actor) ||
        !saved.operationId.equals(input.operationId) ||
        saved.fingerprint instanceof CommandFingerprint
      )
        return mismatch();
      const fp = recipientCodeInvitationFingerprint(
        saved.fingerprint.groupId,
        saved.fingerprint.expectedVersion,
        saved.fingerprint.proof,
      );
      if (
        saved.fingerprint.action !== fp.action ||
        saved.fingerprint.version !== 1 ||
        !fp.groupId.equals(input.groupId) ||
        fp.expectedVersion !== input.expectedVersion ||
        !(saved.fingerprint.canonicalInput instanceof Uint8Array) ||
        saved.fingerprint.canonicalInput.length !== fp.canonicalInput.length ||
        !saved.fingerprint.canonicalInput.every(
          (b, i) => b === fp.canonicalInput[i],
        ) ||
        saved.result.kind !== 'InvitationCreated' ||
        !saved.result.groupId.equals(fp.groupId) ||
        saved.result.version !== fp.expectedVersion + 1
      )
        return mismatch();
      const result = { ...saved.result };
      if (!(await proof.verify({ secret: input.code, saved: fp.proof })))
        return mismatch();
      return {
        status: 'replayed' as const,
        value: scope.serialize(minimal(result)),
      };
    };
    return this.options.sessions.use(input.sessionSecret, input.code, clock, {
      replay,
      create: async (facts, handle, scope) => {
        const actor = ActorSubject.from(facts.caller.actorSubject);
        const binding = Object.freeze({
          codeId: facts.codeId,
          recipientActorId: facts.recipientActorId,
        });
        const recipient = ActorSubject.from(binding.recipientActorId);
        const loaded = await repository.loadForInvitation(
          scope,
          input.groupId,
          actor,
        );
        if (!loaded) return unavailable();
        if (
          !loaded.group.id.equals(input.groupId) ||
          loaded.version !== input.expectedVersion
        )
          throw new GroupCommandApplicationError(
            'CONFLICT',
            'Group version changed',
          );
        const now = clock.now();
        if (!Number.isSafeInteger(now) || now < 0) return unavailable();
        const invitationId = this.options.nextInvitationId();
        const createdAt = UtcInstant.from(new Date(now));
        const invited = loaded.group.inviteParticipant({
          actorSubject: actor,
          invitationId,
          targetSubject: recipient,
          createdAt,
        });
        const keyVersion = await repository.currentProofKeyVersion(scope);
        const fp = recipientCodeInvitationFingerprint(
          input.groupId,
          input.expectedVersion,
          await proof.create({ secret: input.code, keyVersion }),
        );
        const result: InvitationCreatedResult = Object.freeze({
          kind: 'InvitationCreated',
          groupId: input.groupId,
          invitationId,
          version: input.expectedVersion + 1,
        });
        const value = scope.serialize(minimal(result));
        const operation: StoredRecipientInvitationOperation = Object.freeze({
          actorSubject: actor,
          operationId: input.operationId,
          fingerprint: fp,
          result,
          binding,
        });
        const evidence = await repository.stage(scope, handle, {
          group: invited.group,
          expectedVersion: input.expectedVersion,
          stateChanged: true,
          membershipChanges: [],
          invitationChanges: [
            {
              kind: 'Created',
              invitationId,
              targetSubject: recipient,
              issuerParticipantId: invited.invitation.issuerParticipantId,
              createdAt,
              expiryAt: invited.invitation.expiryAt,
            },
          ],
          groupCloseChanges: [],
          operation,
          value,
        });
        await scope.consume(handle, evidence);
        return value;
      },
    });
  }
}
