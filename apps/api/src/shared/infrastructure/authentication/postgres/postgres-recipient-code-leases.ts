import type { AuthenticationActorState } from '../../../application/authentication/authentication-crypto-keys.js';
import type { AuthenticationDigests } from '../../../application/authentication/authentication-digest-ports.js';
import {
  authenticationLifetime,
  type AuthenticatedActor,
  type AuthenticationClock,
  type Unauthenticated,
  type AuthenticationUnavailable,
} from '../../../application/authentication/authentication-ports.js';
import type {
  AuthenticationRecordCodec,
  AuthenticationSessionRow,
  AuthenticationSessionSecrets,
} from '../../../application/authentication/authentication-record-protection.js';
import type {
  AuthenticationSerializedValue,
  AuthenticationTransactionScope,
} from '../../../application/authentication/authentication-transaction-scope.js';
import type { RecipientCodeCrypto } from '../../../application/authentication/recipient-code-crypto-ports.js';
import { RecipientCodeSecret } from '../../../application/authentication/recipient-code-input.js';
import type {
  RecipientCodeSessionLeasePort,
  RecipientCodeUseCallbacks,
  RecipientCodeUnavailableToActor,
} from '../../../application/authentication/recipient-code-ports.js';
import { recipientCodeState } from '../../../application/authentication/recipient-code-policy.js';
import {
  RecipientCodeUnavailable,
  type RecipientCodeRecord,
} from '../../../application/authentication/recipient-code-record.js';
import { authenticationBytesEqual } from '../authentication-digests.js';
import {
  authenticationObject,
  authenticationText,
  parseAuthenticationSecret,
} from '../canonical-authentication.js';
import { insertAuthenticationAudit } from './authentication-audit.js';
import { authenticationDatabaseInteger } from './authentication-database-values.js';
import { readRecipientCodeKeyState } from './authentication-key-state.js';
import {
  readStoredAuthenticationActor,
  readStoredAuthenticationSession,
  updateAuthenticationRecord,
  type StoredAuthenticationRecord,
} from './authentication-record-rows.js';
import { findAuthenticationCookie } from './authentication-record-selection.js';
import type {
  AuthenticationQueryConnection,
  AuthenticationTransactionLease,
} from './authentication-transaction-scopes.js';
import {
  createAuthenticationTransactions,
  type AuthenticationConnectionPool,
  type AuthenticationTransactionLimits,
} from './authentication-transactions.js';
import {
  findRecipientCode,
  readRecipientCode,
} from './recipient-code-selection.js';
import type { RecipientCodeTransactionScopes } from './recipient-code-transaction-scopes.js';

type Session = StoredAuthenticationRecord<AuthenticationSessionRow>;
type KeyState = Awaited<ReturnType<typeof readRecipientCodeKeyState>>;
type Success<T> = { status: 'authenticated'; value: T };
type Context = {
  connection: AuthenticationQueryConnection;
  lease: AuthenticationTransactionLease;
  state: KeyState;
  actors: Map<string, AuthenticationActorState>;
  session: Session;
  secrets: AuthenticationSessionSecrets;
  caller: AuthenticatedActor;
  hint: RecipientCodeRecord | null;
};
const reject = (): never => {
  throw new RecipientCodeUnavailable();
};
const now = (clock: AuthenticationClock): number =>
  authenticationDatabaseInteger(clock.now(), 0);
const active = (
  session: Session,
  actors: Map<string, AuthenticationActorState>,
  time: number,
): boolean =>
  time >= session.row.createdAt &&
  actors.get(session.row.actorId)?.state === 'active' &&
  session.row.state === 'active' &&
  time < session.row.absoluteExpiresAt &&
  time < session.row.idleExpiresAt;
const asSession = (
  value: Awaited<ReturnType<typeof findAuthenticationCookie>>,
): Session | null => {
  if (value === null) return null;
  if (value.row.recordKind !== 'session') return reject();
  return { row: value.row, envelope: value.envelope };
};
const sameSession = (a: Session, b: Session): boolean =>
  a.row.sessionId === b.row.sessionId &&
  a.row.actorId === b.row.actorId &&
  a.row.epoch === b.row.epoch &&
  a.row.cookieDigestKeyVersion === b.row.cookieDigestKeyVersion &&
  authenticationBytesEqual(a.row.cookieDigest, b.row.cookieDigest) &&
  b.row.version >= a.row.version;
const sameCode = (a: RecipientCodeRecord, b: RecipientCodeRecord): boolean =>
  a.codeId === b.codeId &&
  a.recipientActorId === b.recipientActorId &&
  a.epoch === b.epoch &&
  a.lookupKeyVersion === b.lookupKeyVersion &&
  authenticationBytesEqual(a.lookupDigest, b.lookupDigest) &&
  b.recordVersion >= a.recordVersion;

/**
 * Actorを先に固定する専用lease。発行/取消の保存本文や実GM SQLを所有しない。
 * @param options 同一registry/接続、暗号Port、設定可能な上限と後続Writer能力。
 * @returns 管理Actor排他leaseとcaller-only再送→新規複合leaseの内部入口。
 */
export const createPostgresRecipientCodeLeases = (options: {
  /** 唯一のTransaction ownerが取得する接続。 */ readonly pool: AuthenticationConnectionPool;
  /** 同一Scopeの登録・消費証跡registry。 */ readonly scopes: RecipientCodeTransactionScopes;
  /** 既存Session Envelopeの検証とidle更新。 */ readonly codec: AuthenticationRecordCodec;
  /** Actor MAC/Session検索/認証Auditの独立用途。 */ readonly digests: AuthenticationDigests;
  /** lookup/Record MACだけ。GM proofはGM所有のまま。 */ readonly crypto: RecipientCodeCrypto;
  /** 本番運用値を暗黙採用せず、Compositionから正の上限を要求する。 */ readonly limits: Omit<
    AuthenticationTransactionLimits,
    'signal'
  >;
  /**
   * #243の登録認証Writer。同Scopeでコード状態とコードAuditを保存する。今回の正例は合成Writer。
   * @param scope 現在の同じScope。接続所有権は含まない。
   * @param record Lock/MAC/lookup/epochを検証したコード。
   * @param time 全blocking Lock後の消費判断点。
   */
  readonly consume: (
    scope: AuthenticationTransactionScope,
    record: RecipientCodeRecord,
    time: number,
  ) => Promise<void>;
  /**
   * 原因/入力/直接IDなしの固定通知。通知例外も秘密を返さない。
   * @param alert 固定Codeだけの通知。
   */
  readonly onAlert?: (alert: {
    /** 例外やRecord値を含めない分類。 */ readonly code: 'RECIPIENT_CODE_LEASE_UNAVAILABLE';
  }) => void;
}): RecipientCodeSessionLeasePort => {
  const { scopes, codec, digests, crypto } = options;
  const limits = Object.freeze({ ...options.limits });
  const transactions = createAuthenticationTransactions(
    options.pool,
    scopes.scopes,
  );
  const failure = (): AuthenticationUnavailable => {
    try {
      options.onAlert?.(
        Object.freeze({ code: 'RECIPIENT_CODE_LEASE_UNAVAILABLE' }),
      );
    } catch {
      /* 通知から内部値を漏らさない。 */
    }
    return { status: 'unavailable' };
  };
  const execute = async <R>(
    secret: string,
    clock: AuthenticationClock,
    mode: 'manage' | 'replay' | 'create',
    signal: AbortSignal | undefined,
    code: RecipientCodeSecret | undefined,
    callback: (context: Context) => Promise<{
      result: R;
      value: AuthenticationSerializedValue;
      usage: 'inspect' | 'activity';
    }>,
  ): Promise<R | Unauthenticated | AuthenticationUnavailable> => {
    const result = await transactions.run<R | Unauthenticated>(
      async (connection, lease) => {
        const state = await readRecipientCodeKeyState(connection);
        if (mode !== 'manage') await scopes.prepare(lease.scope);
        const hint = asSession(
          await findAuthenticationCookie(
            connection,
            digests,
            state,
            'session',
            secret,
          ),
        );
        const codeHint =
          mode === 'create' && code
            ? await findRecipientCode(
                connection,
                crypto,
                state.codeLookup,
                code,
              )
            : null;
        const ids = [
          ...new Set(
            [hint?.row.actorId, codeHint?.recipientActorId].filter(
              (id): id is string => id !== undefined,
            ),
          ),
        ].sort();
        const actors = new Map<string, AuthenticationActorState>();
        for (const id of ids) {
          const rows = await connection.query(
            `SELECT * FROM authentication.actor WHERE actor_id = $1 ${mode === 'manage' ? 'FOR UPDATE' : 'FOR SHARE'}`,
            [id],
          );
          if (rows.rows.length !== 1) return reject();
          const actor = readStoredAuthenticationActor(rows.rows[0]);
          if (
            actor.row.actorId !== id ||
            !state.actorRead.includes(actor.keyVersion) ||
            !(await digests.verifyActorState({
              row: actor.row,
              keyVersion: actor.keyVersion,
              mac: actor.mac,
            }))
          )
            return reject();
          actors.set(id, actor.row);
        }
        // 再lookupでActor参照が変わっても後付けLockしない。
        const selected = asSession(
          await findAuthenticationCookie(
            connection,
            digests,
            state,
            'session',
            secret,
          ),
        );
        if (
          (hint === null) !== (selected === null) ||
          (hint && selected && !sameSession(hint, selected))
        )
          return reject();
        let session: Session | null = null;
        if (hint) {
          const rows = await connection.query(
            'SELECT * FROM authentication.session_record WHERE session_id = $1 FOR UPDATE',
            [hint.row.sessionId],
          );
          if (rows.rows.length !== 1) return reject();
          session = readStoredAuthenticationSession(rows.rows[0]);
          if (!sameSession(hint, session) || session.row.epoch !== state.epoch)
            return reject();
        }
        const payload = session
          ? authenticationObject(await codec.open(session), ['csrf'])
          : null;
        const secrets = payload
          ? { csrf: authenticationText(payload.csrf) }
          : null;
        if (secrets) parseAuthenticationSecret(secrets.csrf);
        const time = now(clock);
        if (!session || !secrets || !active(session, actors, time)) {
          await insertAuthenticationAudit(connection, digests, state, {
            action: 'activity',
            decision: 'deny',
            reason: 'restart-required',
            now: time,
            subjects: {
              actorId: session?.row.actorId,
              sessionId: session?.row.sessionId,
            },
          });
          return { status: 'unauthenticated' };
        }
        const lockedSession = session;
        scopes.guard(lease.scope, () => {
          if (!active(lockedSession, actors, now(clock))) reject();
        });
        const response = await callback({
          connection,
          lease,
          state,
          actors,
          session,
          secrets,
          hint: codeHint,
          caller: Object.freeze({
            actorSubject: session.row.actorId,
            absoluteExpiresAt: session.row.absoluteExpiresAt,
            csrf: secrets.csrf,
          }),
        });
        lease.seal();
        lease.assertResult(response.value);
        lease.assertCommittable();
        const finalNow = now(clock);
        if (response.usage === 'activity') {
          const updated: AuthenticationSessionRow = {
            ...session.row,
            version: session.row.version + 1,
            idleExpiresAt: Math.min(
              authenticationDatabaseInteger(
                finalNow + authenticationLifetime.idle,
                0,
              ),
              session.row.absoluteExpiresAt,
            ),
          };
          await updateAuthenticationRecord(
            connection,
            updated,
            await codec.seal({ row: updated, secrets }),
            session.row.version,
          );
        }
        await insertAuthenticationAudit(connection, digests, state, {
          action: response.usage === 'activity' ? 'activity' : 'inspect',
          decision: 'allow',
          reason: 'success',
          now: finalNow,
          subjects: {
            actorId: session.row.actorId,
            sessionId: session.row.sessionId,
          },
        });
        return response.result;
      },
      { ...limits, signal },
    );
    return result.status === 'committed' ? result.value : failure();
  };
  return Object.freeze({
    async withActor(sessionSecret, clock, callback, signal) {
      try {
        parseAuthenticationSecret(sessionSecret);
        return await execute(
          sessionSecret,
          clock,
          'manage',
          signal,
          undefined,
          async (ctx) => {
            const value = await callback(ctx.caller, ctx.lease.scope);
            return {
              result: { status: 'authenticated' as const, value },
              value,
              usage: 'activity',
            };
          },
        );
      } catch {
        return failure();
      }
    },
    async use<T extends AuthenticationSerializedValue>(
      sessionSecret: string,
      code: RecipientCodeSecret,
      clock: AuthenticationClock,
      callbacks: RecipientCodeUseCallbacks<T>,
      signal?: AbortSignal,
    ) {
      try {
        parseAuthenticationSecret(sessionSecret);
        const copied = RecipientCodeSecret.parse(
          Buffer.from(
            RecipientCodeSecret.prototype.copyBytes.call(code),
          ).toString('base64url'),
        );
        if (!copied) return reject();
        const replay = callbacks.replay.bind(callbacks);
        const create = callbacks.create.bind(callbacks);
        const preflight = await execute<Success<T> | { status: 'no-replay' }>(
          sessionSecret,
          clock,
          'replay',
          signal,
          undefined,
          async (ctx) => {
            const result = await replay(ctx.caller, ctx.lease.scope);
            if (result.status === 'replayed')
              return {
                result: {
                  status: 'authenticated' as const,
                  value: result.value,
                },
                value: result.value,
                usage: 'inspect' as const,
              };
            if (result.status !== 'no-replay') return reject();
            const value = ctx.lease.scope.serialize({ status: 'no-replay' });
            return {
              result: { status: 'no-replay' as const },
              value,
              usage: 'inspect' as const,
            };
          },
        );
        if (preflight.status !== 'no-replay') return preflight;
        return await execute<Success<T> | RecipientCodeUnavailableToActor>(
          sessionSecret,
          clock,
          'create',
          signal,
          copied,
          async (ctx) => {
            // 並行成功はコード/宛先の現在有効性を要求する前に再照合する。
            const replayed = await replay(ctx.caller, ctx.lease.scope);
            if (replayed.status === 'replayed')
              return {
                result: {
                  status: 'authenticated' as const,
                  value: replayed.value,
                },
                value: replayed.value,
                usage: 'inspect' as const,
              };
            if (replayed.status !== 'no-replay') return reject();
            const selected = await findRecipientCode(
              ctx.connection,
              crypto,
              ctx.state.codeLookup,
              copied,
            );
            if (
              (ctx.hint === null) !== (selected === null) ||
              (ctx.hint && selected && !sameCode(ctx.hint, selected))
            )
              return reject();
            const denied = () => {
              const value = ctx.lease.scope.serialize({
                status: 'unavailable-to-actor',
              });
              return {
                result: { status: 'unavailable-to-actor' as const },
                value,
                usage: 'inspect' as const,
              };
            };
            if (!ctx.hint) return denied();
            const rows = await ctx.connection.query(
              'SELECT * FROM authentication.recipient_code WHERE code_id = $1 FOR UPDATE',
              [ctx.hint.codeId],
            );
            if (!rows.rows.length) return denied();
            if (rows.rows.length !== 1) return reject();
            const record = readRecipientCode(rows.rows[0]);
            if (
              !sameCode(ctx.hint, record) ||
              record.epoch !== ctx.state.epoch ||
              !ctx.actors.has(record.recipientActorId) ||
              !ctx.state.codeMac.includes(record.macKeyVersion) ||
              !(await crypto.verifyRecord(record)) ||
              !(await crypto.verifyLookup({
                secret: copied,
                expected: {
                  purpose: 'auth-recipient-code-lookup/v1',
                  keyVersion: record.lookupKeyVersion,
                  epoch: null,
                  scopeId: 'authentication',
                  bytes: record.lookupDigest,
                },
              }))
            )
              return reject();
            const usable = () =>
              recipientCodeState(record, {
                actorId: record.recipientActorId,
                active:
                  ctx.actors.get(record.recipientActorId)?.state === 'active',
                epoch: ctx.state.epoch,
                now: now(clock),
              }) === 'issued';
            if (!usable()) return denied();
            const guard = () => {
              if (!usable()) reject();
            };
            const bound = scopes.bind(
              ctx.lease.scope,
              record,
              () => options.consume(ctx.lease.scope, record, now(clock)),
              guard,
            );
            const value = await create(
              Object.freeze({
                caller: ctx.caller,
                recipientActorId: record.recipientActorId,
                codeId: record.codeId,
              }),
              bound.handle,
              bound.scope,
            );
            return {
              result: { status: 'authenticated' as const, value },
              value,
              usage: 'activity' as const,
            };
          },
        );
      } catch {
        return failure();
      }
    },
  } satisfies RecipientCodeSessionLeasePort);
};
