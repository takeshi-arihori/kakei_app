import { randomUUID } from 'node:crypto';

import type { AuthenticationActorState } from '../../../application/authentication/authentication-crypto-keys.js';
import type { AuthenticationDigests } from '../../../application/authentication/authentication-digest-ports.js';
import {
  authenticationLifetime as ttl,
  type AuthenticatedActor,
  type AuthenticatedActorResult,
  type AuthenticationClock,
  type AuthenticationStore,
  type BeginAttemptCommand,
  type BeginAttemptResult,
  type AttemptBinding,
  type CompleteAttemptCommand,
  type CompleteAttemptResult,
  type LogoutResult,
  type ReadAttemptResult,
  type SessionUsage,
} from '../../../application/authentication/authentication-ports.js';
import {
  AuthenticationCryptoUnavailable,
  type AuthenticationAttemptRow,
  type AuthenticationAttemptSecrets,
  type AuthenticationIdentityRow,
  type AuthenticationRecordCodec,
  type AuthenticationSessionRow,
  type AuthenticationSessionSecrets,
} from '../../../application/authentication/authentication-record-protection.js';
import type {
  AuthenticationSerializedValue,
  AuthenticationTransactionScope,
} from '../../../application/authentication/authentication-transaction-scope.js';
import {
  authenticationBytesEqual,
  authenticationSecretsEqual,
} from '../authentication-digests.js';
import {
  authenticationKeyVersion,
  authenticationObject,
  authenticationText,
  authenticationUuid,
  parseAuthenticationSecret,
} from '../canonical-authentication.js';
import {
  insertAuthenticationAudit,
  type AuthenticationAuditSubjects,
  type AuthenticationStoreAction,
  type AuthenticationStoreReason,
} from './authentication-audit.js';
import {
  authenticationDatabaseBytes,
  authenticationDatabaseInteger,
  authenticationDatabaseRow,
} from './authentication-database-values.js';
import {
  readAuthenticationKeyState,
  type AuthenticationStoreKeyState,
} from './authentication-key-state.js';
import {
  insertAuthenticationRecord,
  readStoredAuthenticationActor,
  readStoredAuthenticationAttempt,
  readStoredAuthenticationIdentity,
  readStoredAuthenticationSession,
  updateAuthenticationRecord,
  type StoredAuthenticationRecord,
} from './authentication-record-rows.js';
import {
  AuthenticationMultipleMatches,
  findAuthenticationCookie,
  findAuthenticationIdentity,
  type AuthenticationIdentityHint,
} from './authentication-record-selection.js';
import type {
  AuthenticationQueryConnection,
  AuthenticationTransactionScopes,
} from './authentication-transaction-scopes.js';
import {
  createAuthenticationTransactions,
  type AuthenticationConnectionPool,
  type AuthenticationTransactionOutcome,
} from './authentication-transactions.js';

/** 原因・直接ID・秘密値を含めず監視へ送る固定分類。 */
export interface AuthenticationStoreAlert {
  /** 呼出し対象の技術操作。 */
  readonly operation: AuthenticationStoreAction;
  /** 複数選択とその他の利用不能だけを区別する。 */
  readonly code: 'MULTIPLE_LOOKUP_MATCHES' | 'AUTHENTICATION_STORE_UNAVAILABLE';
}

type Attempt = StoredAuthenticationRecord<AuthenticationAttemptRow>;
type Session = StoredAuthenticationRecord<AuthenticationSessionRow>;
type ActorSet = ReadonlyMap<string, AuthenticationActorState>;

const unavailable = (): never => {
  throw new AuthenticationCryptoUnavailable();
};
const checkedSecret = (value: string): string => {
  parseAuthenticationSecret(value);
  return value;
};
const optionalSecret = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : checkedSecret(value);
const checkedNumber = (value: number, minimum: number): number => {
  if (typeof value !== 'number') return unavailable();
  return authenticationDatabaseInteger(value, minimum);
};
const checkedNow = (clock: AuthenticationClock): number =>
  checkedNumber(clock.now(), 0);
const deadline = (now: number, lifetime: number): number =>
  authenticationDatabaseInteger(now + lifetime, 0);
const asAttempt = (
  value: Awaited<ReturnType<typeof findAuthenticationCookie>>,
): Attempt | null => {
  if (value === null) return null;
  if (value.row.recordKind !== 'login-attempt') return unavailable();
  return { row: value.row, envelope: value.envelope };
};
const asSession = (
  value: Awaited<ReturnType<typeof findAuthenticationCookie>>,
): Session | null => {
  if (value === null) return null;
  if (value.row.recordKind !== 'session') return unavailable();
  return { row: value.row, envelope: value.envelope };
};

const assertSelection = (
  hint: Attempt | Session,
  locked: Attempt | Session,
): void => {
  const before = hint.row;
  const after = locked.row;
  if (
    before.recordKind !== after.recordKind ||
    before.epoch !== after.epoch ||
    before.cookieDigestKeyVersion !== after.cookieDigestKeyVersion ||
    !authenticationBytesEqual(before.cookieDigest, after.cookieDigest) ||
    after.version < before.version
  )
    return unavailable();
  if (
    before.recordKind === 'session' &&
    after.recordKind === 'session' &&
    (before.sessionId !== after.sessionId || before.actorId !== after.actorId)
  )
    return unavailable();
  if (
    before.recordKind === 'login-attempt' &&
    after.recordKind === 'login-attempt' &&
    before.attemptId !== after.attemptId
  )
    return unavailable();
};

/**
 * Accepted A1/A2の5操作を同一接続の原子的保存へ接続する。HTTP／具体Providerは所有しない。
 * @param options 実接続・暗号Portと、同一StoreのScope registry。
 * @returns durable Auditと共通commitを確認した場合だけ成功を返すStore。
 */
export const createPostgresAuthenticationStore = (options: {
  /** 操作ごとに一つの接続を取得する。pool.queryは使わない。 */
  readonly pool: AuthenticationConnectionPool;
  /** 認証専用のRow binding／AEAD能力。 */
  readonly codec: AuthenticationRecordCodec;
  /** 用途を分離した検索・状態MAC・監査仮名の能力。 */
  readonly digests: AuthenticationDigests;
  /** 参加Repositoryへはparticipantsだけを渡す。 */
  readonly scopes: AuthenticationTransactionScopes;
  /** 固定Codeのみ。通知例外を公開結果へ漏らさない。 */
  readonly onAlert?: (signal: AuthenticationStoreAlert) => void;
}): AuthenticationStore => {
  const { codec, digests } = options;
  const transactions = createAuthenticationTransactions(
    options.pool,
    options.scopes,
  );
  const emit = (
    operation: AuthenticationStoreAction,
    error?: unknown,
  ): void => {
    try {
      options.onAlert?.(
        Object.freeze({
          operation,
          code:
            error instanceof AuthenticationMultipleMatches
              ? 'MULTIPLE_LOOKUP_MATCHES'
              : 'AUTHENTICATION_STORE_UNAVAILABLE',
        }),
      );
    } catch {
      /* 通知障害から元の原因や秘密値を公開しない。 */
    }
  };
  const outcome = <T>(
    action: AuthenticationStoreAction,
    result: AuthenticationTransactionOutcome<T>,
  ): T | { status: 'unavailable' } => {
    if (result.status === 'committed') return result.value;
    emit(action);
    return { status: 'unavailable' };
  };
  const findCookie = async (
    action: AuthenticationStoreAction,
    connection: AuthenticationQueryConnection,
    state: AuthenticationStoreKeyState,
    kind: 'attempt' | 'session',
    secret: string | undefined,
  ) => {
    try {
      return await findAuthenticationCookie(
        connection,
        digests,
        state,
        kind,
        secret,
      );
    } catch (error) {
      if (error instanceof AuthenticationMultipleMatches) emit(action, error);
      throw error;
    }
  };
  const lockActors = async (
    connection: AuthenticationQueryConnection,
    state: AuthenticationStoreKeyState,
    actorIds: readonly (string | undefined)[],
  ): Promise<ActorSet> => {
    const actors = new Map<string, AuthenticationActorState>();
    const sorted = [
      ...new Set(actorIds.filter((id): id is string => id !== undefined)),
    ].sort();
    for (const id of sorted) {
      const result = await connection.query(
        'SELECT * FROM authentication.actor WHERE actor_id = $1 FOR SHARE',
        [id],
      );
      if (result.rows.length !== 1) return unavailable();
      const selected = readStoredAuthenticationActor(result.rows[0]);
      if (
        selected.row.actorId !== id ||
        !state.actorRead.includes(selected.keyVersion) ||
        !(await digests.verifyActorState({
          row: selected.row,
          keyVersion: selected.keyVersion,
          mac: selected.mac,
        }))
      )
        return unavailable();
      actors.set(id, selected.row);
    }
    return actors;
  };
  const lockSession = async (
    connection: AuthenticationQueryConnection,
    hint: Session | null,
  ): Promise<Session | null> => {
    if (hint === null) return null;
    const result = await connection.query(
      'SELECT * FROM authentication.session_record WHERE session_id = $1 FOR UPDATE',
      [hint.row.sessionId],
    );
    if (result.rows.length !== 1) return unavailable();
    const locked = readStoredAuthenticationSession(result.rows[0]);
    assertSelection(hint, locked);
    return locked;
  };
  const lockAttempt = async (
    connection: AuthenticationQueryConnection,
    hint: Attempt | null,
  ): Promise<Attempt | null> => {
    if (hint === null) return null;
    const result = await connection.query(
      'SELECT * FROM authentication.login_attempt WHERE attempt_id = $1 FOR UPDATE',
      [hint.row.attemptId],
    );
    if (result.rows.length !== 1) return unavailable();
    const locked = readStoredAuthenticationAttempt(result.rows[0]);
    assertSelection(hint, locked);
    return locked;
  };
  const openAttempt = async (
    attempt: Attempt | null,
  ): Promise<AuthenticationAttemptSecrets | null> => {
    if (attempt === null) return null;
    const secrets = authenticationObject(await codec.open(attempt), [
      'nonce',
      'csrf',
    ]);
    return {
      nonce: checkedSecret(authenticationText(secrets.nonce)),
      csrf: checkedSecret(authenticationText(secrets.csrf)),
    };
  };
  const openSession = async (
    session: Session | null,
  ): Promise<AuthenticationSessionSecrets | null> => {
    if (session === null) return null;
    const secrets = authenticationObject(await codec.open(session), ['csrf']);
    return { csrf: checkedSecret(authenticationText(secrets.csrf)) };
  };
  const activeSession = (
    session: Session | null,
    actors: ActorSet,
    now: number,
  ): boolean => {
    if (session === null) return false;
    if (now < session.row.createdAt) return unavailable();
    return (
      actors.get(session.row.actorId)?.state === 'active' &&
      session.row.state === 'active' &&
      now < session.row.absoluteExpiresAt &&
      now < session.row.idleExpiresAt
    );
  };
  const readyAttempt = (
    attempt: Attempt | null,
    secrets: AuthenticationAttemptSecrets | null,
    csrf: string,
    now: number,
  ): boolean => {
    if (attempt === null || secrets === null) return false;
    if (now < attempt.row.createdAt) return unavailable();
    return (
      attempt.row.state === 'ready' &&
      now < attempt.row.expiresAt &&
      authenticationSecretsEqual(secrets.csrf, csrf)
    );
  };
  const audit = (
    connection: AuthenticationQueryConnection,
    state: AuthenticationStoreKeyState,
    action: AuthenticationStoreAction,
    decision: 'allow' | 'deny',
    reason: AuthenticationStoreReason,
    now: number,
    subjects: AuthenticationAuditSubjects,
  ): Promise<void> =>
    insertAuthenticationAudit(connection, digests, state, {
      action,
      decision,
      reason,
      now,
      subjects,
    });

  const insertAliases = async (
    connection: AuthenticationQueryConnection,
    state: AuthenticationStoreKeyState,
    row: AuthenticationIdentityRow,
    identity: CompleteAttemptCommand['identity'],
  ): Promise<void> => {
    for (const keyVersion of state.identityWrite) {
      const expected = await digests.identity({ identity, keyVersion });
      const existing = await connection.query(
        'SELECT purpose, digest_key_version, digest FROM authentication.identity_alias WHERE identity_id = $1 AND digest_key_version = $2 FOR UPDATE',
        [row.identityId, keyVersion],
      );
      if (existing.rows.length > 1) return unavailable();
      if (existing.rows.length === 1) {
        const stored = authenticationDatabaseRow(existing.rows[0]);
        if (
          stored.purpose !== 'auth-google-identity/v1' ||
          authenticationKeyVersion(stored.digest_key_version) !== keyVersion ||
          !authenticationBytesEqual(
            authenticationDatabaseBytes(stored.digest, 32),
            expected.bytes,
          )
        )
          return unavailable();
      } else {
        await connection.query(
          "INSERT INTO authentication.identity_alias (purpose, digest_key_version, digest, identity_id) VALUES ('auth-google-identity/v1', $1, $2, $3)",
          [keyVersion, Buffer.from(expected.bytes), row.identityId],
        );
      }
    }
  };

  return Object.freeze({
    async begin(
      command: BeginAttemptCommand,
      clock: AuthenticationClock,
    ): Promise<BeginAttemptResult> {
      try {
        const copy = {
          attemptSecret: checkedSecret(command.attemptSecret),
          nonce: checkedSecret(command.nonce),
          csrf: checkedSecret(command.csrf),
          previousAttemptSecret: optionalSecret(command.previousAttemptSecret),
          currentSessionSecret: optionalSecret(command.currentSessionSecret),
        };
        return outcome(
          'begin',
          await transactions.run<BeginAttemptResult>(async (connection) => {
            const state = await readAuthenticationKeyState(connection);
            const sessionHint = asSession(
              await findCookie(
                'begin',
                connection,
                state,
                'session',
                copy.currentSessionSecret,
              ),
            );
            const previousHint = asAttempt(
              await findCookie(
                'begin',
                connection,
                state,
                'attempt',
                copy.previousAttemptSecret,
              ),
            );
            const actors = await lockActors(connection, state, [
              sessionHint?.row.actorId,
            ]);
            const session = await lockSession(connection, sessionHint);
            const previous = await lockAttempt(connection, previousHint);
            await openSession(session);
            const previousSecrets = await openAttempt(previous);
            const now = checkedNow(clock);
            if (activeSession(session, actors, now)) {
              await audit(
                connection,
                state,
                'begin',
                'deny',
                'already-authenticated',
                now,
                {
                  actorId: session?.row.actorId,
                  sessionId: session?.row.sessionId,
                },
              );
              return { status: 'already-authenticated' };
            }
            // Unique制約は世代内だけ。旧検索世代の同値も衝突として全rollbackする。
            if (
              (await findCookie(
                'begin',
                connection,
                state,
                'attempt',
                copy.attemptSecret,
              )) !== null
            )
              return unavailable();
            if (previous !== null && now < previous.row.createdAt)
              return unavailable();
            if (
              previous !== null &&
              previousSecrets !== null &&
              previous.row.state === 'ready'
            ) {
              const replaced: AuthenticationAttemptRow = {
                ...previous.row,
                version: previous.row.version + 1,
                state: 'replaced',
                terminalAt: now,
              };
              await updateAuthenticationRecord(
                connection,
                replaced,
                await codec.seal({ row: replaced, secrets: previousSecrets }),
                previous.row.version,
              );
            }
            const digest = await digests.attemptCookie({
              secret: copy.attemptSecret,
              epoch: state.epoch,
              keyVersion: state.attemptWrite,
            });
            const row: AuthenticationAttemptRow = {
              recordKind: 'login-attempt',
              attemptId: randomUUID(),
              version: 1,
              epoch: state.epoch,
              createdAt: now,
              expiresAt: deadline(now, ttl.attempt),
              state: 'ready',
              terminalAt: null,
              cookieDigestKeyVersion: digest.keyVersion,
              cookieDigest: digest.bytes,
            };
            await insertAuthenticationRecord(
              connection,
              row,
              await codec.seal({
                row,
                secrets: { nonce: copy.nonce, csrf: copy.csrf },
              }),
            );
            await audit(connection, state, 'begin', 'allow', 'success', now, {
              attemptId: row.attemptId,
            });
            return { status: 'started', expiresAt: row.expiresAt };
          }),
        );
      } catch (error) {
        emit('begin', error);
        return { status: 'unavailable' };
      }
    },

    async readAttempt(
      binding: AttemptBinding,
      clock: AuthenticationClock,
    ): Promise<ReadAttemptResult> {
      try {
        const copy = {
          attemptSecret: checkedSecret(binding.attemptSecret),
          csrf: checkedSecret(binding.csrf),
        };
        return outcome(
          'read-attempt',
          await transactions.run<ReadAttemptResult>(async (connection) => {
            const state = await readAuthenticationKeyState(connection);
            const hint = asAttempt(
              await findCookie(
                'read-attempt',
                connection,
                state,
                'attempt',
                copy.attemptSecret,
              ),
            );
            const attempt = await lockAttempt(connection, hint);
            const secrets = await openAttempt(attempt);
            const now = checkedNow(clock);
            if (
              !readyAttempt(attempt, secrets, copy.csrf, now) ||
              attempt === null ||
              secrets === null
            ) {
              await audit(
                connection,
                state,
                'read-attempt',
                'deny',
                'restart-required',
                now,
                { attemptId: attempt?.row.attemptId },
              );
              return { status: 'restart-required' };
            }
            await audit(
              connection,
              state,
              'read-attempt',
              'allow',
              'success',
              now,
              { attemptId: attempt.row.attemptId },
            );
            return {
              status: 'ready',
              snapshot: Object.freeze({
                recordId: attempt.row.attemptId,
                version: attempt.row.version,
                nonce: secrets.nonce,
                expiresAt: attempt.row.expiresAt,
              }),
            };
          }),
        );
      } catch (error) {
        emit('read-attempt', error);
        return { status: 'unavailable' };
      }
    },

    async complete(
      command: CompleteAttemptCommand,
      clock: AuthenticationClock,
    ): Promise<CompleteAttemptResult> {
      try {
        const copy = {
          attemptSecret: checkedSecret(command.attemptSecret),
          csrf: checkedSecret(command.csrf),
          sessionSecret: checkedSecret(command.sessionSecret),
          sessionCsrf: checkedSecret(command.sessionCsrf),
          currentSessionSecret: optionalSecret(command.currentSessionSecret),
          snapshot: {
            recordId: authenticationUuid(command.snapshot.recordId),
            version: checkedNumber(command.snapshot.version, 1),
            nonce: checkedSecret(command.snapshot.nonce),
            expiresAt: checkedNumber(command.snapshot.expiresAt, 0),
          },
          identity: {
            issuer: command.identity.issuer,
            subject: authenticationText(command.identity.subject),
          },
        };
        if (copy.identity.issuer !== 'https://accounts.google.com')
          return unavailable();
        // Unique敗者だけを新Transactionで再照合する。VerifierとCallbackは再実行しない。
        for (let transaction = 0; transaction < 3; transaction += 1) {
          const result = await transactions.run<CompleteAttemptResult>(
            async (connection) => {
              const state = await readAuthenticationKeyState(connection);
              const sessionHint = asSession(
                await findCookie(
                  'complete',
                  connection,
                  state,
                  'session',
                  copy.currentSessionSecret,
                ),
              );
              const attemptHint = asAttempt(
                await findCookie(
                  'complete',
                  connection,
                  state,
                  'attempt',
                  copy.attemptSecret,
                ),
              );
              let identityHint: AuthenticationIdentityHint | null;
              try {
                identityHint = await findAuthenticationIdentity(
                  connection,
                  digests,
                  state,
                  copy.identity,
                );
              } catch (error) {
                if (error instanceof AuthenticationMultipleMatches)
                  emit('complete', error);
                throw error;
              }
              const actors = await lockActors(connection, state, [
                sessionHint?.row.actorId,
                identityHint?.actorId,
              ]);
              const session = await lockSession(connection, sessionHint);
              const attempt = await lockAttempt(connection, attemptHint);
              let selectedIdentity: StoredAuthenticationRecord<AuthenticationIdentityRow> | null =
                null;
              if (identityHint !== null) {
                const locked = await connection.query(
                  'SELECT * FROM authentication.google_identity WHERE identity_id = $1 FOR UPDATE',
                  [identityHint.identityId],
                );
                if (locked.rows.length !== 1) return unavailable();
                selectedIdentity = readStoredAuthenticationIdentity(
                  locked.rows[0],
                );
                const currentHint = await findAuthenticationIdentity(
                  connection,
                  digests,
                  state,
                  copy.identity,
                );
                if (
                  selectedIdentity.row.actorId !== identityHint.actorId ||
                  selectedIdentity.row.identityId !== identityHint.identityId ||
                  currentHint?.identityId !== identityHint.identityId ||
                  currentHint.actorId !== identityHint.actorId
                )
                  return unavailable();
              }
              await openSession(session);
              const secrets = await openAttempt(attempt);
              const now = checkedNow(clock);
              if (activeSession(session, actors, now)) {
                await audit(
                  connection,
                  state,
                  'complete',
                  'deny',
                  'already-authenticated',
                  now,
                  {
                    actorId: session?.row.actorId,
                    sessionId: session?.row.sessionId,
                    attemptId: attempt?.row.attemptId,
                  },
                );
                return { status: 'already-authenticated' };
              }
              if (
                attempt === null ||
                secrets === null ||
                !readyAttempt(attempt, secrets, copy.csrf, now) ||
                attempt.row.attemptId !== copy.snapshot.recordId ||
                attempt.row.version !== copy.snapshot.version ||
                attempt.row.expiresAt !== copy.snapshot.expiresAt ||
                !authenticationSecretsEqual(
                  secrets.nonce,
                  copy.snapshot.nonce,
                ) ||
                (identityHint !== null &&
                  actors.get(identityHint.actorId)?.state !== 'active')
              ) {
                await audit(
                  connection,
                  state,
                  'complete',
                  'deny',
                  'restart-required',
                  now,
                  {
                    actorId: identityHint?.actorId,
                    attemptId: attempt?.row.attemptId,
                  },
                );
                return { status: 'restart-required' };
              }
              if (
                (await findCookie(
                  'complete',
                  connection,
                  state,
                  'session',
                  copy.sessionSecret,
                )) !== null
              )
                return unavailable();
              let identityRow: AuthenticationIdentityRow;
              if (selectedIdentity !== null && identityHint !== null) {
                const verified = authenticationObject(
                  await codec.open(selectedIdentity),
                  ['issuer', 'subject'],
                );
                if (
                  verified.issuer !== copy.identity.issuer ||
                  verified.subject !== copy.identity.subject
                )
                  return unavailable();
                // hitしたAliasも、復号した本人性から再導出したDigestと比較する。
                const checked = await findAuthenticationIdentity(
                  connection,
                  digests,
                  state,
                  copy.identity,
                );
                if (
                  checked?.identityId !== selectedIdentity.row.identityId ||
                  checked.actorId !== selectedIdentity.row.actorId
                )
                  return unavailable();
                identityRow = selectedIdentity.row;
              } else {
                const actor: AuthenticationActorState = {
                  actorId: randomUUID(),
                  version: 1,
                  state: 'active',
                  createdAt: now,
                  disabledAt: null,
                };
                const mac = await digests.actorState({
                  row: actor,
                  keyVersion: state.actorWrite,
                });
                await connection.query(
                  "INSERT INTO authentication.actor (actor_id, state, version, created_at_ms, disabled_at_ms, control_key_version, state_mac) VALUES ($1, 'active', 1, $2, NULL, $3, $4)",
                  [actor.actorId, now, mac.keyVersion, Buffer.from(mac.bytes)],
                );
                identityRow = {
                  recordKind: 'google-identity',
                  identityId: randomUUID(),
                  actorId: actor.actorId,
                  version: 1,
                };
                await insertAuthenticationRecord(
                  connection,
                  identityRow,
                  await codec.seal({
                    row: identityRow,
                    secrets: copy.identity,
                  }),
                );
              }
              await insertAliases(
                connection,
                state,
                identityRow,
                copy.identity,
              );
              const cookie = await digests.sessionCookie({
                secret: copy.sessionSecret,
                epoch: state.epoch,
                keyVersion: state.sessionWrite,
              });
              const row: AuthenticationSessionRow = {
                recordKind: 'session',
                sessionId: randomUUID(),
                actorId: identityRow.actorId,
                version: 1,
                epoch: state.epoch,
                createdAt: now,
                absoluteExpiresAt: deadline(now, ttl.absolute),
                idleExpiresAt: deadline(now, ttl.idle),
                state: 'active',
                terminalAt: null,
                cookieDigestKeyVersion: cookie.keyVersion,
                cookieDigest: cookie.bytes,
              };
              await insertAuthenticationRecord(
                connection,
                row,
                await codec.seal({ row, secrets: { csrf: copy.sessionCsrf } }),
              );
              const consumed: AuthenticationAttemptRow = {
                ...attempt.row,
                version: attempt.row.version + 1,
                state: 'consumed',
                terminalAt: now,
              };
              await updateAuthenticationRecord(
                connection,
                consumed,
                await codec.seal({ row: consumed, secrets }),
                attempt.row.version,
              );
              await audit(
                connection,
                state,
                'complete',
                'allow',
                'success',
                now,
                {
                  actorId: row.actorId,
                  attemptId: attempt.row.attemptId,
                  sessionId: row.sessionId,
                },
              );
              return {
                status: 'authenticated',
                absoluteExpiresAt: row.absoluteExpiresAt,
              };
            },
          );
          if (result.status !== 'identity-conflict')
            return outcome('complete', result);
        }
        emit('complete');
        return { status: 'unavailable' };
      } catch (error) {
        emit('complete', error);
        return { status: 'unavailable' };
      }
    },

    async withSession<T extends AuthenticationSerializedValue>(
      sessionSecret: string,
      usage: SessionUsage,
      clock: AuthenticationClock,
      callback: (
        actor: AuthenticatedActor,
        scope: AuthenticationTransactionScope,
      ) => Promise<T>,
    ): Promise<AuthenticatedActorResult<T>> {
      const action = usage === 'activity' ? 'activity' : 'inspect';
      try {
        const secret = checkedSecret(sessionSecret);
        if (usage !== 'inspect' && usage !== 'activity') return unavailable();
        return outcome(
          action,
          await transactions.run<AuthenticatedActorResult<T>>(
            async (connection, lease) => {
              const state = await readAuthenticationKeyState(connection);
              const hint = asSession(
                await findCookie(action, connection, state, 'session', secret),
              );
              const actors = await lockActors(connection, state, [
                hint?.row.actorId,
              ]);
              const session = await lockSession(connection, hint);
              const secrets = await openSession(session);
              const now = checkedNow(clock);
              if (
                session === null ||
                secrets === null ||
                !activeSession(session, actors, now)
              ) {
                await audit(
                  connection,
                  state,
                  action,
                  'deny',
                  'restart-required',
                  now,
                  {
                    actorId: session?.row.actorId,
                    sessionId: session?.row.sessionId,
                  },
                );
                return { status: 'unauthenticated' };
              }
              const value = await callback(
                Object.freeze({
                  actorSubject: session.row.actorId,
                  absoluteExpiresAt: session.row.absoluteExpiresAt,
                  csrf: secrets.csrf,
                }),
                lease.scope,
              );
              // 受付だけを止める。ここでは接続・Actor／Session Lockを解放しない。
              lease.seal();
              lease.assertResult(value);
              lease.assertCommittable();
              if (usage === 'activity') {
                const updated: AuthenticationSessionRow = {
                  ...session.row,
                  version: session.row.version + 1,
                  idleExpiresAt: Math.min(
                    deadline(now, ttl.idle),
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
              await audit(connection, state, action, 'allow', 'success', now, {
                actorId: session.row.actorId,
                sessionId: session.row.sessionId,
              });
              return { status: 'authenticated', value };
            },
          ),
        );
      } catch (error) {
        emit(action, error);
        return { status: 'unavailable' };
      }
    },

    async revoke(
      sessionSecret: string,
      clock: AuthenticationClock,
    ): Promise<LogoutResult> {
      try {
        const secret = checkedSecret(sessionSecret);
        return outcome(
          'logout',
          await transactions.run<LogoutResult>(async (connection) => {
            const state = await readAuthenticationKeyState(connection);
            const hint = asSession(
              await findCookie('logout', connection, state, 'session', secret),
            );
            const actors = await lockActors(connection, state, [
              hint?.row.actorId,
            ]);
            const session = await lockSession(connection, hint);
            const secrets = await openSession(session);
            const now = checkedNow(clock);
            if (
              session !== null &&
              secrets !== null &&
              activeSession(session, actors, now)
            ) {
              const revoked: AuthenticationSessionRow = {
                ...session.row,
                version: session.row.version + 1,
                state: 'revoked',
                terminalAt: now,
              };
              await updateAuthenticationRecord(
                connection,
                revoked,
                await codec.seal({ row: revoked, secrets }),
                session.row.version,
              );
            }
            await audit(connection, state, 'logout', 'allow', 'success', now, {
              actorId: session?.row.actorId,
              sessionId: session?.row.sessionId,
            });
            return { status: 'logged-out' };
          }),
        );
      } catch (error) {
        emit('logout', error);
        return { status: 'unavailable' };
      }
    },
  });
};
