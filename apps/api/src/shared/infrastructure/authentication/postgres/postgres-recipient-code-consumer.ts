import type { AuthenticatedActor } from '../../../application/authentication/authentication-ports.js';
import type { AuthenticationDigests } from '../../../application/authentication/authentication-digest-ports.js';
import type { AuthenticationTransactionScope } from '../../../application/authentication/authentication-transaction-scope.js';
import type { RecipientCodeCrypto } from '../../../application/authentication/recipient-code-crypto-ports.js';
import type { RecipientCodeStateKeyAllocationPort } from '../../../application/authentication/recipient-code-key-lifecycle.js';
import { planRecipientCodeConsume } from '../../../application/authentication/recipient-code-policy.js';
import {
  RecipientCodeUnavailable,
  snapshotRecipientCodeRecord,
  type RecipientCodeRecord,
} from '../../../application/authentication/recipient-code-record.js';
import { authenticationUuid } from '../canonical-authentication.js';
import { insertAuthenticationAudit } from './authentication-audit.js';
import { readRecipientCodeManagementKeyState } from './authentication-key-state.js';
import type { AuthenticationTransactionParticipants } from './authentication-transaction-scopes.js';
import { writeRecipientCodeTransition } from './recipient-code-transition-writer.js';

/**
 * 登録された認証Writer。GM証跡検証後のregistryからだけ呼び、単独Transactionを開始しない。
 * @param options 同registryのquery、用途別暗号/監査、Record鍵確保能力。
 * @returns 同Scopeで一回ConsumedとコードAuditを保存する内部処理。失敗はRejectし全commitを拒否する。
 */
export const createPostgresRecipientCodeConsumer =
  (options: {
    /** 接続/commit能力を含まない認証参加query。 */ readonly participants: AuthenticationTransactionParticipants;
    /** lookup原値を受けず、既存MAC検証/新MAC/コード仮名だけを使う。 */ readonly crypto: Pick<
      RecipientCodeCrypto,
      'verifyRecord' | 'recordMac' | 'audit'
    >;
    /** 独立用途の認証監査能力。 */ readonly digests: Pick<
      AuthenticationDigests,
      'auditActor' | 'auditAttempt' | 'auditSession'
    >;
    /** 世代切替時に同Recordの鍵を明示確保する。 */ readonly stateKeys: RecipientCodeStateKeyAllocationPort;
  }): ((
    /** 同registryの新規lease。 */ scope: AuthenticationTransactionScope,
    /** leaseがLock/MAC/epoch/宛先activeを検証したRecord。 */ record: RecipientCodeRecord,
    /** 全blocking Lock後の消費判断点。 */ time: number,
    /** 同じSessionから検証したcaller。宛先をcallerへ偽装しない。 */ caller: AuthenticatedActor,
  ) => Promise<void>) =>
  async (scope, record, time, caller) => {
    const previous = snapshotRecipientCodeRecord(record);
    const callerId = authenticationUuid(caller.actorSubject);
    const query = {
      query: (sql: string, values?: unknown[]) =>
        options.participants.query(scope, sql, values),
    };
    const state = await readRecipientCodeManagementKeyState(query);
    if (
      previous.epoch !== state.epoch ||
      !state.codeMac.includes(previous.macKeyVersion) ||
      !state.codeLookup.includes(previous.lookupKeyVersion) ||
      !(await options.crypto.verifyRecord(previous))
    )
      throw new RecipientCodeUnavailable();
    const plan = planRecipientCodeConsume(previous, {
      actorId: previous.recipientActorId,
      active: true,
      epoch: state.epoch,
      now: time,
    });
    if (plan.status !== 'consumed') throw new RecipientCodeUnavailable();
    await writeRecipientCodeTransition({
      connection: query,
      previous,
      plan: plan.transition,
      keyVersion: state.codeMacWrite,
      crypto: options.crypto,
      stateKeys: options.stateKeys,
    });
    await insertAuthenticationAudit(query, options.digests, state, {
      action: 'recipient-code-consume',
      decision: 'allow',
      reason: 'success',
      now: time,
      subjects: { actorId: callerId },
      code: await options.crypto.audit({
        codeId: previous.codeId,
        keyVersion: state.auditVersion,
      }),
    });
  };
