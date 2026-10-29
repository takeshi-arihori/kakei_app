import type {
  AuthenticationSerializedValue,
  AuthenticationTransactionScope,
} from '../../../application/authentication/authentication-transaction-scope.js';
import type {
  RecipientCodeCommitEvidence,
  RecipientCodeConsumptionHandle,
  RecipientCodeTransactionScope,
} from '../../../application/authentication/recipient-code-ports.js';
import { RecipientCodeUnavailable } from '../../../application/authentication/recipient-code-record.js';
import { authenticationUuid } from '../canonical-authentication.js';
import type {
  AuthenticationTransactionParticipants,
  AuthenticationTransactionScopes,
  AuthenticationTransactionLease,
} from './authentication-transaction-scopes.js';

/** GMが同じScopeに保存した新規計画。直接IDは内部照合だけに使用する。 */
export interface RecipientCodeCommitBinding {
  /** Lock済みコードと一致する保存計画の参照。 */ readonly codeId: string;
  /** Client指定でなくLock済み宛先と一致する参照。 */ readonly recipientActorId: string;
  /** GM共通namespaceの成功操作。別namespaceを新設しない。 */ readonly operationId: string;
  /** 同Scopeで確定した最小Response。本文が同じでも別handleは拒否する。 */ readonly value: AuthenticationSerializedValue;
}

/** Compositionが実GM Adapterだけへ渡す能力。通常Application Callbackへ公開しない。 */
export interface RecipientCodeGroupParticipant extends AuthenticationTransactionParticipants {
  /**
   * GM保存成功後だけ、その計画とResponseを不透明な証跡へ束縛する。
   * @param scope 同registryの準備済みScope。
   * @param handle 同Scopeの一回だけの消費権。
   * @param binding GM Adapterが保存した計画。SQLの業務意味はGM Adapterが所有する。
   * @returns 通常DTOでは偽造できないObject identityの証跡。
   * @throws RecipientCodeUnavailable 別Scope、計画不一致、未準備、GM書込なし、失敗済み。
   */
  attest(
    scope: AuthenticationTransactionScope,
    handle: RecipientCodeConsumptionHandle,
    binding: RecipientCodeCommitBinding,
  ): RecipientCodeCommitEvidence;
}

/** 共有認証ownerだけが持つ登録と専用leaseの能力。 */
export interface RecipientCodeTransactionScopes {
  /** 同一基礎registryへ専用Scopeを登録するTransaction owner能力。 */ readonly scopes: AuthenticationTransactionScopes;
  /**
   * 最初のlease開始前に一つの信頼済みGM Adapterを登録する。
   * @param registration Actor Lock前にGMが所有するkey-stateを固定する能力。
   * @returns queryと証跡発行だけのGM能力。Transaction制御はない。
   * @throws RecipientCodeUnavailable 二重登録またはlease開始後の登録。
   */
  registerGroupParticipant(registration: {
    /**
     * GMのTable/鍵Stateの意味は共有認証へimportしない。
     * @param scope 同じ接続に束縛された準備段階のScope。
     * @param query queryだけの借用能力。
     */
    readonly prepare: (
      scope: AuthenticationTransactionScope,
      query: AuthenticationTransactionParticipants,
    ) => Promise<void>;
  }): RecipientCodeGroupParticipant;
  /**
   * Actorより前に登録GMの準備を完了する。
   * @param scope このregistryのopen Scope。
   * @throws RecipientCodeUnavailable 未登録、二重準備、SQL障害。
   */
  prepare(scope: AuthenticationTransactionScope): Promise<void>;
  /**
   * Sessionの最終期限検査を登録する。管理/再送でも使用する。
   * @param scope 同じregistryのopen Scope。
   * @param guard serialize前とcommit前の同期検査。失敗後はcommitできない。
   * @throws RecipientCodeUnavailable 偽造/別registry/受付終了後のScope。
   */
  guard(scope: AuthenticationTransactionScope, guard: () => void): void;
  /**
   * 認証ownerが検証済みコードへ一回消費権を束縛する。
   * @param scope 同一TransactionのScope。
   * @param facts Lock/MAC検証済みの最小コード参照。
   * @param consume 登録済み認証Writer。同Scopeで保存/Auditを行い失敗はrollbackする。
   * @param guard 全blocking Lock後/serialize前/commit前の期限検査。
   * @returns Applicationへ渡せる専用Scopeとopaque消費handle。
   * @throws RecipientCodeUnavailable 未準備/二重束縛/不正参照/受付終了。
   */
  bind(
    scope: AuthenticationTransactionScope,
    facts: { readonly codeId: string; readonly recipientActorId: string },
    consume: () => Promise<void>,
    guard: () => void,
  ): {
    /** 本文と消費だけの制限された操作受付。 */ readonly scope: RecipientCodeTransactionScope;
    /** このleaseだけで一度消費できるObject identity。 */ readonly handle: RecipientCodeConsumptionHandle;
  };
}

type Task = { observed: boolean; settled: boolean; promise: Promise<unknown> };
type Frame = {
  phase: 'open' | 'sealed' | 'closed';
  failed: boolean;
  prepared: boolean;
  preparing: boolean;
  tasks: Task[];
  guards: (() => void)[];
  writes: number;
  lease: AuthenticationTransactionLease;
  scope: RecipientCodeTransactionScope;
  binding?: {
    codeId: string;
    recipientActorId: string;
    handle: RecipientCodeConsumptionHandle;
    consume: () => Promise<void>;
    started: boolean;
    attested: boolean;
    consumed: boolean;
    operationId?: string;
    value?: AuthenticationSerializedValue;
  };
};
const reject = (): never => {
  throw new RecipientCodeUnavailable();
};

// thenableでawait/thenによる受領も追跡する。完了が早い未await操作をseal時に見逃さない。
const track = <T>(frame: Frame, start: () => Promise<T>): Promise<T> => {
  const task: Task = {
    observed: false,
    settled: false,
    promise: Promise.resolve(),
  };
  const promise = Promise.resolve().then(start);
  task.promise = promise;
  frame.tasks.push(task);
  void promise.then(
    () => {
      task.settled = true;
    },
    () => {
      task.settled = true;
      frame.failed = true;
    },
  );
  const observed = () => {
    task.observed = true;
  };
  const wrap = <U>(current: Promise<U>): Promise<U> => ({
    then(onfulfilled, onrejected) {
      if (typeof onfulfilled === 'function') observed();
      return wrap(current.then(onfulfilled, onrejected));
    },
    catch(onrejected) {
      return wrap(current.catch(onrejected));
    },
    finally(onfinally) {
      return wrap(current.finally(onfinally));
    },
    [Symbol.toStringTag]: 'Promise',
  });
  return wrap(promise);
};

/**
 * 消費・登録GM証跡・返却本文を同じ非公開registryで結ぶ。GMのSQL意味は所有しない。
 * @param base 通常認証とも共有する基礎Scope registry。
 * @returns 認証ownerと登録GMの能力を分離した専用registry。
 */
export const createRecipientCodeTransactionScopes = (
  base: AuthenticationTransactionScopes,
): RecipientCodeTransactionScopes => {
  const frames = new WeakMap<AuthenticationTransactionScope, Frame>();
  const evidence = new WeakMap<
    RecipientCodeCommitEvidence,
    {
      frame: Frame;
      handle: RecipientCodeConsumptionHandle;
      value: AuthenticationSerializedValue;
      operationId: string;
    }
  >();
  let registration:
    | Parameters<RecipientCodeTransactionScopes['registerGroupParticipant']>[0]
    | undefined;
  let opened = false;
  const openFrame = (scope: AuthenticationTransactionScope): Frame => {
    const frame = frames.get(scope);
    if (!frame || frame.phase !== 'open') {
      if (frame) frame.failed = true;
      return reject();
    }
    return frame;
  };
  const check = <T>(frame: Frame, action: () => T): T => {
    try {
      return action();
    } catch {
      frame.failed = true;
      return reject();
    }
  };
  const query: AuthenticationTransactionParticipants = Object.freeze({
    query(scope, sql, values) {
      let frame: Frame;
      try {
        frame = openFrame(scope);
      } catch {
        return Promise.reject(new RecipientCodeUnavailable());
      }
      return track(frame, async () => {
        openFrame(scope);
        const result = await base.participants.query(scope, sql, values);
        if (!frame.preparing && /^\s*(INSERT|UPDATE|DELETE)\s/i.test(sql))
          frame.writes += 1;
        return result;
      });
    },
  } satisfies AuthenticationTransactionParticipants);
  return Object.freeze({
    scopes: Object.freeze({
      participants: query,
      open(connection) {
        opened = true;
        const frame = {} as Frame;
        Object.assign(frame, {
          phase: 'open',
          failed: false,
          prepared: false,
          preparing: false,
          tasks: [],
          guards: [],
          writes: 0,
        });
        const lease = base.open(connection, {
          decorate(scope) {
            const extended = Object.freeze(
              Object.assign(Object.create(null) as object, {
                serialize(value: unknown) {
                  return check(frame, () => scope.serialize(value));
                },
                consume(
                  handle: RecipientCodeConsumptionHandle,
                  witness: RecipientCodeCommitEvidence,
                ): Promise<void> {
                  try {
                    openFrame(frame.scope);
                    check(frame, () => {
                      const binding = frame.binding;
                      const proof = evidence.get(witness);
                      if (
                        !binding ||
                        binding.handle !== handle ||
                        binding.started ||
                        !proof ||
                        proof.frame !== frame ||
                        proof.handle !== handle ||
                        frame.failed
                      )
                        return reject();
                      binding.started = true;
                      binding.operationId = proof.operationId;
                      binding.value = proof.value;
                      evidence.delete(witness);
                    });
                    return track(frame, async () => {
                      openFrame(frame.scope);
                      for (const guard of frame.guards) guard();
                      await frame.binding!.consume();
                      frame.binding!.consumed = true;
                    });
                  } catch {
                    frame.failed = true;
                    return Promise.reject(new RecipientCodeUnavailable());
                  }
                },
              }),
            ) as RecipientCodeTransactionScope;
            frame.scope = extended;
            frames.set(extended, frame);
            return extended;
          },
          beforeSerialize() {
            check(frame, () => {
              for (const guard of frame.guards) guard();
            });
          },
          seal() {
            if (frame.tasks.some((t) => !t.observed || !t.settled))
              frame.failed = true;
            frame.phase = 'sealed';
          },
          assertResult(value) {
            check(frame, () => {
              if (frame.binding && frame.binding.value !== value) reject();
            });
          },
          assertCommittable() {
            check(frame, () => {
              if (
                frame.failed ||
                frame.phase !== 'sealed' ||
                frame.tasks.some((t) => !t.observed || !t.settled) ||
                (frame.binding &&
                  (!frame.binding.consumed || !frame.binding.operationId))
              )
                reject();
              for (const guard of frame.guards) guard();
            });
          },
          async drain() {
            await Promise.allSettled(frame.tasks.map((t) => t.promise));
          },
          close() {
            frame.phase = 'closed';
          },
        });
        frame.lease = lease;
        return lease;
      },
    } satisfies AuthenticationTransactionScopes),
    registerGroupParticipant(value) {
      if (opened || registration) return reject();
      registration = Object.freeze({ prepare: value.prepare });
      return Object.freeze({
        ...query,
        attest(scope, handle, binding) {
          const frame = openFrame(scope);
          return check(frame, () => {
            const bound = frame.binding;
            if (
              !frame.prepared ||
              frame.failed ||
              !bound ||
              bound.handle !== handle ||
              bound.started ||
              bound.attested ||
              frame.writes === 0 ||
              frame.tasks.some((t) => !t.observed || !t.settled) ||
              bound.codeId !== binding.codeId ||
              bound.recipientActorId !== binding.recipientActorId ||
              !frame.lease.ownsResult(binding.value)
            )
              return reject();
            if (
              typeof binding.operationId !== 'string' ||
              binding.operationId.trim().length === 0
            )
              return reject();
            const operationId = binding.operationId;
            bound.attested = true;
            const witness = Object.freeze(
              Object.create(null) as object,
            ) as RecipientCodeCommitEvidence;
            evidence.set(witness, {
              frame,
              handle,
              value: binding.value,
              operationId,
            });
            return witness;
          });
        },
      } satisfies RecipientCodeGroupParticipant);
    },
    async prepare(scope) {
      const frame = openFrame(scope);
      if (!registration || frame.preparing || frame.prepared) {
        frame.failed = true;
        return reject();
      }
      frame.preparing = true;
      try {
        await registration.prepare(scope, query);
        if (frame.tasks.some((t) => !t.observed || !t.settled)) return reject();
        frame.prepared = true;
      } catch {
        frame.failed = true;
        return reject();
      } finally {
        frame.preparing = false;
      }
    },
    guard(scope, guard) {
      openFrame(scope).guards.push(guard);
    },
    bind(scope, facts, consume, guard) {
      const frame = openFrame(scope);
      return check(frame, () => {
        if (!frame.prepared || frame.binding) return reject();
        const handle = Object.freeze(
          Object.create(null) as object,
        ) as RecipientCodeConsumptionHandle;
        frame.binding = {
          codeId: authenticationUuid(facts.codeId),
          recipientActorId: authenticationUuid(facts.recipientActorId),
          handle,
          consume,
          started: false,
          attested: false,
          consumed: false,
        };
        frame.guards.push(guard);
        return Object.freeze({ scope: frame.scope, handle });
      });
    },
  } satisfies RecipientCodeTransactionScopes);
};
