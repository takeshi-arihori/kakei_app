import type { QueryResult } from 'pg';

import type {
  AuthenticationSerializedValue,
  AuthenticationTransactionScope,
} from '../../../application/authentication/authentication-transaction-scope.js';

/** 同一Transactionの所有者から借用するquery能力。接続releaseは含めない。 */
export interface AuthenticationQueryConnection {
  /**
   * 所有者が開始したTransactionへSQLを送る。
   * @param sql 固定SQL。外部入力を連結しない。
   * @param values Parameter値。SQLと分離する。
   * @returns PostgreSQLの結果。障害は所有者がrollbackへ変換する。
   * @throws 接続またはSQL障害。
   */
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
}

/** Repositoryが認証leaseへ参加する能力。Transaction制御・接続解放は提供しない。 */
export interface AuthenticationTransactionParticipants {
  /**
   * open中の同一Scopeに束縛された接続だけで単一DMLを実行する。
   * @param scope Callbackから渡された実体。偽造・別registry・終了後は拒否する。
   * @param sql SELECT／INSERT／UPDATE／DELETEの単一文。SELECTのINTO語・コメント・文区切りは許可しない。
   * @param values SQLへbindする値。
   * @returns 同一接続のSQL結果。
   * @throws Scope・SQL不正、またはDB障害。open中の失敗はcommit不可として記録する。
   */
  query(
    scope: AuthenticationTransactionScope,
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult>;
}

/** Storeだけが所有するlease能力。参加Repositoryへ渡さない。 */
export interface AuthenticationTransactionLease {
  /** Callbackへ渡せる、本文確定だけの制限された能力。 */
  readonly scope: AuthenticationTransactionScope;
  /** Callback直後に受付を停止する。DB lockと接続は保持したまま。 */
  seal(): void;
  /**
   * sealed中にCallback結果の所有Scopeと発行済みObject identityを確認する。
   * @param value Callbackから戻った未信頼の値。
   * @throws 偽造・他Scopeの値、またはsealed以外の状態。
   */
  assertResult(value: unknown): void;
  /** @throws 未完了query・受付中の失敗、またはsealed以外ならcommitを拒否する。 */
  assertCommittable(): void;
  /** 所有者がrollbackする前に開始済みqueryの収束を待つ。 */
  drain(): Promise<void>;
  /** commit／rollbackのOutcome確定後に終了する。DBの接続解放は所有者が行う。 */
  close(): void;
}

/** Scope所有者と参加者の能力を分離する、Store単位のregistry。 */
export interface AuthenticationTransactionScopes {
  /** Repositoryへ渡してよいquery限定の能力。 */
  readonly participants: AuthenticationTransactionParticipants;
  /**
   * Storeが既に開始したTransactionへ新しいScopeを束縛する。
   * @param connection Store所有の同一Transaction接続。
   * @returns Store専用のlease。ScopeだけをCallbackへ渡す。
   */
  open(
    connection: AuthenticationQueryConnection,
  ): AuthenticationTransactionLease;
}

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type Frame = {
  phase: 'open' | 'sealed' | 'closed';
  failed: boolean;
  connection: AuthenticationQueryConnection;
  pending: Set<Promise<QueryResult>>;
};

const rejected = (): Error => new Error('authentication-scope-unavailable');

// descriptorからCopyするためgetterやtoJSONを呼ばず、Copy先のprototypeにも依存しない。
const copyJson = (value: unknown, ancestors: Set<object>): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || ancestors.has(value))
    throw rejected();
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    throw rejected();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || key === 'toJSON'))
    throw rejected();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  ancestors.add(value);
  try {
    if (array) {
      const length: unknown = descriptors.length?.value;
      if (typeof length !== 'number' || keys.length !== length + 1)
        throw rejected();
      const copy: JsonValue[] = [];
      Object.setPrototypeOf(copy, null);
      for (let index = 0; index < length; index += 1) {
        const property = descriptors[String(index)];
        if (!property || !('value' in property) || !property.enumerable)
          throw rejected();
        copy[index] = copyJson(property.value, ancestors);
      }
      return copy;
    }
    const copy = Object.create(null) as { [key: string]: JsonValue };
    for (const key of keys) {
      if (typeof key !== 'string') throw rejected();
      const property = descriptors[key];
      if (!property || !('value' in property) || !property.enumerable)
        throw rejected();
      copy[key] = copyJson(property.value, ancestors);
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
};

const requireOpen = (frame: Frame | undefined): Frame => {
  if (!frame || frame.phase !== 'open') throw rejected();
  return frame;
};

/**
 * Object identityと受付状態を非公開WeakMapへ保持する。外から終了・commit能力を得られない。
 * @returns Store所有能力とquery限定参加能力を分けたregistry。
 */
export const createAuthenticationTransactionScopes =
  (): AuthenticationTransactionScopes => {
    const frames = new WeakMap<AuthenticationTransactionScope, Frame>();
    const handles = new WeakMap<object, Frame>();
    const participants: AuthenticationTransactionParticipants = Object.freeze({
      query(
        scope: AuthenticationTransactionScope,
        sql: string,
        values?: readonly unknown[],
      ): Promise<QueryResult> {
        let frame: Frame;
        try {
          frame = requireOpen(frames.get(scope));
        } catch {
          return Promise.reject(rejected());
        }
        try {
          // 参加能力は意図的に単一DMLへ制限する。Transaction所有権をSQL経由でも公開しない。
          if (
            typeof sql !== 'string' ||
            !/^\s*(SELECT|INSERT|UPDATE|DELETE)\s/i.test(sql) ||
            /;|--|\/\*/.test(sql) ||
            (/^\s*SELECT\s/i.test(sql) && /\bINTO\b/i.test(sql))
          )
            throw rejected();
          const operation = frame.connection.query(
            sql,
            values === undefined ? undefined : [...values],
          );
          frame.pending.add(operation);
          void operation.then(
            () => {
              frame.pending.delete(operation);
            },
            () => {
              frame.failed = true;
              frame.pending.delete(operation);
            },
          );
          return operation;
        } catch {
          frame.failed = true;
          return Promise.reject(rejected());
        }
      },
    });
    return Object.freeze({
      participants,
      open(
        connection: AuthenticationQueryConnection,
      ): AuthenticationTransactionLease {
        const frame: Frame = {
          connection,
          phase: 'open',
          failed: false,
          pending: new Set(),
        };
        const scope = Object.freeze(
          Object.assign(Object.create(null) as object, {
            serialize(value: unknown): AuthenticationSerializedValue {
              requireOpen(frame);
              try {
                const body = JSON.stringify(copyJson(value, new Set()));
                const handle = Object.freeze(
                  Object.assign(Object.create(null) as object, { body }),
                );
                handles.set(handle, frame);
                // Brandは公開propertyにせず、検証済みhandleの実体はWeakMapだけが証明する。
                return handle as AuthenticationSerializedValue;
              } catch {
                frame.failed = true;
                throw rejected();
              }
            },
          }),
        ) as AuthenticationTransactionScope;
        frames.set(scope, frame);
        return Object.freeze({
          scope,
          seal(): void {
            if (frame.phase === 'sealed') return;
            requireOpen(frame);
            if (frame.pending.size !== 0) frame.failed = true;
            frame.phase = 'sealed';
          },
          assertResult(value: unknown): void {
            if (
              frame.phase !== 'sealed' ||
              typeof value !== 'object' ||
              value === null ||
              handles.get(value) !== frame
            )
              throw rejected();
          },
          assertCommittable(): void {
            if (
              frame.phase !== 'sealed' ||
              frame.failed ||
              frame.pending.size !== 0
            )
              throw rejected();
          },
          async drain(): Promise<void> {
            await Promise.allSettled([...frame.pending]);
          },
          close(): void {
            frame.phase = 'closed';
          },
        });
      },
    });
  };
