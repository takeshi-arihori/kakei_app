import { randomBytes, randomUUID } from 'node:crypto';
import type { AuthenticationDigests } from '../../../application/authentication/authentication-digest-ports.js';
import type {
  AuthenticationClock,
  AuthenticatedActor,
} from '../../../application/authentication/authentication-ports.js';
import type {
  AuthenticationTransactionScope,
  AuthenticationSerializedValue,
} from '../../../application/authentication/authentication-transaction-scope.js';
import type { RecipientCodeCrypto } from '../../../application/authentication/recipient-code-crypto-ports.js';
import type { RecipientCodeStateKeyAllocationPort } from '../../../application/authentication/recipient-code-key-lifecycle.js';
import { RecipientCodeSecret } from '../../../application/authentication/recipient-code-input.js';
import {
  planRecipientCodeIssue,
  planRecipientCodeRevoke,
  recipientCodeState,
  type RecipientCodeTransition,
} from '../../../application/authentication/recipient-code-policy.js';
import type {
  RecipientCodeSessionPort,
  RecipientCodeSessionLeasePort,
  RecipientCodeIssueResult,
  RecipientCodeInspectResult,
  RecipientCodeRevokeResult,
} from '../../../application/authentication/recipient-code-ports.js';
import {
  RecipientCodeUnavailable,
  type RecipientCodeRecord,
} from '../../../application/authentication/recipient-code-record.js';
import { authenticationUuid } from '../canonical-authentication.js';
import {
  insertAuthenticationAudit,
  type AuthenticationStoreAction,
} from './authentication-audit.js';
import { authenticationDatabaseInteger } from './authentication-database-values.js';
import { readRecipientCodeManagementKeyState } from './authentication-key-state.js';
import type { AuthenticationTransactionParticipants } from './authentication-transaction-scopes.js';
import {
  findRecipientCode,
  readRecipientCode,
} from './recipient-code-selection.js';

type State = Awaited<ReturnType<typeof readRecipientCodeManagementKeyState>>;
type Result =
  | RecipientCodeIssueResult
  | RecipientCodeInspectResult
  | RecipientCodeRevokeResult;
type Context = {
  caller: AuthenticatedActor;
  scope: AuthenticationTransactionScope;
  state: State;
};
const reject = (): never => {
  throw new RecipientCodeUnavailable();
};
const time = (clock: AuthenticationClock) =>
  authenticationDatabaseInteger(clock.now(), 0);

/** コード原値のCSPRNG生成だけを差し替える合成検証用の能力。 */
export interface RecipientCodeEntropy {
  /** @returns 独立した32-byte CSPRNG値。呼出しごとに新しい配列を所有させる。 */
  generate(): Uint8Array;
  /** @returns 秘密値と独立したServer生成UUIDv4。 */
  codeId(): string;
}

/**
 * 有効な本人lease上だけでコード状態と用途別Auditを保存する。自動再発行をしない。
 * @param options 同じregistryの本人lease/query/guard、暗号/監査能力と明示的なRecord鍵発行能力。
 * @returns 発行・取消・最小状態確認だけ。GM消費/HTTP/本番起動は含まない。
 */
export const createPostgresRecipientCodeStore = (options: {
  /** 本人Actor排他とidle非更新読取。Actorを外部入力させない。 */
  readonly leases: Pick<
    RecipientCodeSessionLeasePort,
    'withActor' | 'inspectActor'
  >;
  /** leaseと同じregistry。接続/Transaction制御を借用しない。 */
  readonly participants: AuthenticationTransactionParticipants;
  /** 同registryで最終期限をserialize/commit前に確認する。 */
  readonly guard: (
    scope: AuthenticationTransactionScope,
    check: () => void,
  ) => void;
  /** lookup/Record MAC/コード仮名の独立用途。 */
  readonly crypto: RecipientCodeCrypto;
  /** Actor監査仮名の既存用途。 */
  readonly digests: AuthenticationDigests;
  /** 読取Portが未知codeIdの鍵を暗黙生成することを認めない。 */
  readonly stateKeys: RecipientCodeStateKeyAllocationPort;
  /** 省略時はNodeのrandomBytes(32)/randomUUID。合成値を本番保証しない。 */
  readonly entropy?: RecipientCodeEntropy;
  /** 原因/直接ID/秘密を含まない通知。通知例外も結果へ露出しない。 */
  readonly onAlert?: (alert: {
    /** 固定分類。 */ readonly code: 'RECIPIENT_CODE_STORE_UNAVAILABLE';
  }) => void;
}): Pick<RecipientCodeSessionPort, 'issue' | 'revoke' | 'inspect'> => {
  const entropy = options.entropy ?? {
    generate: () => randomBytes(32),
    codeId: randomUUID,
  };
  const query = (scope: AuthenticationTransactionScope) => ({
    query: (sql: string, values?: unknown[]) =>
      options.participants.query(scope, sql, values),
  });
  const facts = (ctx: Context, now: number) => ({
    actorId: ctx.caller.actorSubject,
    active: true,
    epoch: ctx.state.epoch,
    now,
  });
  const validate = async (
    ctx: Context,
    row: RecipientCodeRecord,
  ): Promise<void> => {
    if (
      row.recipientActorId !== ctx.caller.actorSubject ||
      row.epoch !== ctx.state.epoch ||
      !ctx.state.codeLookup.includes(row.lookupKeyVersion) ||
      !ctx.state.codeMac.includes(row.macKeyVersion) ||
      !(await options.crypto.verifyRecord(row))
    )
      reject();
  };
  const allocate = async (
    codeId: string,
    keyVersion: string,
    expiresAt: number,
    requireNew = true,
  ) => {
    const answer = await options.stateKeys.allocate({
      codeId,
      keyVersion,
      expiresAt,
    });
    if (
      answer.status !== 'allocated' ||
      answer.codeId !== codeId ||
      answer.keyVersion !== keyVersion ||
      answer.expiresAt !== expiresAt ||
      typeof answer.created !== 'boolean' ||
      (requireNew && !answer.created)
    )
      reject();
  };
  const audit = async (
    ctx: Context,
    action: AuthenticationStoreAction,
    decision: 'allow' | 'deny',
    now: number,
    codeId?: string,
  ) => {
    const code =
      codeId === undefined
        ? undefined
        : await options.crypto.audit({
            codeId,
            keyVersion: ctx.state.auditVersion,
          });
    await insertAuthenticationAudit(
      query(ctx.scope),
      options.digests,
      ctx.state,
      {
        action,
        decision,
        reason: decision === 'allow' ? 'success' : 'restart-required',
        now,
        subjects: { actorId: ctx.caller.actorSubject },
        code,
      },
    );
  };
  const transition = async (
    ctx: Context,
    previous: RecipientCodeRecord,
    plan: RecipientCodeTransition,
  ) => {
    if (previous.macKeyVersion !== ctx.state.codeMacWrite)
      await allocate(
        previous.codeId,
        ctx.state.codeMacWrite,
        previous.expiresAt,
        false,
      );
    const { mac: ignored, ...fields } = previous;
    void ignored;
    const updated = {
      ...fields,
      recordVersion: plan.recordVersion,
      status: plan.status,
      terminalAt: plan.terminalAt,
      macKeyVersion: ctx.state.codeMacWrite,
    };
    const mac = await options.crypto.recordMac(updated);
    const result = await query(ctx.scope).query(
      "UPDATE authentication.recipient_code SET record_version=$1,state=$2,terminal_at_ms=$3,mac_key_version=$4,state_mac=$5 WHERE code_id=$6 AND recipient_actor_id=$7 AND record_version=$8 AND state='issued' RETURNING code_id",
      [
        updated.recordVersion,
        updated.status,
        updated.terminalAt,
        updated.macKeyVersion,
        Buffer.from(mac.bytes),
        previous.codeId,
        ctx.caller.actorSubject,
        plan.expectedRecordVersion,
      ],
    );
    if (result.rows.length !== 1) reject();
  };
  const failure = () => {
    try {
      options.onAlert?.(
        Object.freeze({ code: 'RECIPIENT_CODE_STORE_UNAVAILABLE' }),
      );
    } catch {
      /* 詳細を返さない。 */
    }
    return { status: 'unavailable' as const };
  };
  // 業務処理を再試行せず、rollback/結果不明後に本人の固定拒否Auditだけを独立保存する。
  const rejectionAudit = async (
    secret: string,
    clock: AuthenticationClock,
    action: AuthenticationStoreAction,
  ) => {
    try {
      await options.leases.inspectActor(
        secret,
        clock,
        async (caller, scope) => {
          const state = await readRecipientCodeManagementKeyState(query(scope));
          await audit({ caller, scope, state }, action, 'deny', time(clock));
          return scope.serialize(null);
        },
      );
    } catch {
      /* Audit障害もunavailable。元例外を通知しない。 */
    }
  };
  const run = async <R extends Result>(
    secret: string,
    clock: AuthenticationClock,
    action: AuthenticationStoreAction,
    inspect: boolean,
    operation: (ctx: Context) => Promise<{ result: R; body: unknown }>,
  ): Promise<R | { status: 'unauthenticated' } | { status: 'unavailable' }> => {
    let candidate: R | undefined;
    try {
      const lease = inspect
        ? options.leases.inspectActor.bind(options.leases)
        : options.leases.withActor.bind(options.leases);
      const outcome = await lease(
        secret,
        clock,
        async (caller, scope): Promise<AuthenticationSerializedValue> => {
          const state = await readRecipientCodeManagementKeyState(query(scope));
          const value = await operation({ caller, scope, state });
          candidate = value.result;
          return scope.serialize(value.body);
        },
      );
      if (outcome.status === 'authenticated' && candidate) return candidate;
      candidate = undefined;
      if (outcome.status === 'unauthenticated') return outcome;
    } catch {
      candidate = undefined;
    }
    await rejectionAudit(secret, clock, action);
    return failure();
  };
  return Object.freeze({
    issue: (secret, clock) =>
      run<RecipientCodeIssueResult>(
        secret,
        clock,
        'recipient-code-issue',
        false,
        async (ctx) => {
          const rows = await query(ctx.scope).query(
            "SELECT * FROM authentication.recipient_code WHERE recipient_actor_id=$1 AND state='issued' ORDER BY code_id FOR UPDATE",
            [ctx.caller.actorSubject],
          );
          if (rows.rows.length > 1) reject();
          const previous = rows.rows.length
            ? readRecipientCode(rows.rows[0])
            : null;
          if (previous) await validate(ctx, previous);
          const codeId = authenticationUuid(entropy.codeId());
          const generated = entropy.generate();
          if (!(generated instanceof Uint8Array) || generated.length !== 32)
            reject();
          let code: RecipientCodeSecret | null;
          try {
            code = RecipientCodeSecret.parse(
              Buffer.from(generated).toString('base64url'),
            );
          } finally {
            generated.fill(0);
          }
          if (!code) return reject();
          if (
            await findRecipientCode(
              query(ctx.scope),
              options.crypto,
              ctx.state.codeLookup,
              code,
            )
          )
            reject();
          const lookup = await options.crypto.lookup({
            secret: code,
            keyVersion: ctx.state.codeLookupWrite,
          });
          // 全blocking Lock/検索後に発行判断点を固定する。
          const plan = planRecipientCodeIssue(
            previous,
            facts(ctx, time(clock)),
          );
          if (plan.status !== 'planned') return reject();
          options.guard(ctx.scope, () => {
            const current = time(clock);
            if (current < plan.createdAt || current >= plan.expiresAt) reject();
          });
          await allocate(codeId, ctx.state.codeMacWrite, plan.expiresAt);
          const fields = {
            codeId,
            recipientActorId: ctx.caller.actorSubject,
            recordVersion: 1,
            epoch: ctx.state.epoch,
            createdAt: plan.createdAt,
            expiresAt: plan.expiresAt,
            status: 'issued' as const,
            terminalAt: null,
            lookupKeyVersion: ctx.state.codeLookupWrite,
            lookupDigest: lookup.bytes,
            macKeyVersion: ctx.state.codeMacWrite,
          };
          const mac = await options.crypto.recordMac(fields);
          if (previous && plan.replaced)
            await transition(ctx, previous, plan.replaced);
          await query(ctx.scope).query(
            "INSERT INTO authentication.recipient_code(code_id,recipient_actor_id,record_version,epoch,created_at_ms,expires_at_ms,state,terminal_at_ms,lookup_key_version,lookup_digest,mac_key_version,state_mac) VALUES($1,$2,1,$3,$4,$5,'issued',NULL,$6,$7,$8,$9)",
            [
              codeId,
              ctx.caller.actorSubject,
              fields.epoch,
              fields.createdAt,
              fields.expiresAt,
              fields.lookupKeyVersion,
              Buffer.from(fields.lookupDigest),
              fields.macKeyVersion,
              Buffer.from(mac.bytes),
            ],
          );
          await audit(
            ctx,
            'recipient-code-issue',
            'allow',
            plan.createdAt,
            codeId,
          );
          return {
            result: {
              status: 'issued',
              code,
              codeId,
              expiresAt: plan.expiresAt,
            },
            body: { status: 'issued', codeId, expiresAt: plan.expiresAt },
          };
        },
      ),
    revoke: (secret, inputId, clock) =>
      run<RecipientCodeRevokeResult>(
        secret,
        clock,
        'recipient-code-revoke',
        false,
        async (ctx) => {
          const codeId = authenticationUuid(inputId);
          const selected = await query(ctx.scope).query(
            'SELECT * FROM authentication.recipient_code WHERE code_id=$1 AND recipient_actor_id=$2 FOR UPDATE',
            [codeId, ctx.caller.actorSubject],
          );
          if (selected.rows.length > 1) reject();
          const row = selected.rows.length
            ? readRecipientCode(selected.rows[0])
            : null;
          if (row) await validate(ctx, row);
          const now = time(clock);
          const plan = planRecipientCodeRevoke(row, facts(ctx, now));
          if (plan.status === 'unavailable-to-actor') return reject();
          if (row && plan.status === 'revoked') {
            options.guard(ctx.scope, () => {
              const current = time(clock);
              if (current < now || current >= row.expiresAt) reject();
            });
            await transition(ctx, row, plan.transition);
          }
          await audit(ctx, 'recipient-code-revoke', 'allow', now, row?.codeId);
          const result = { status: plan.status };
          return { result, body: result };
        },
      ),
    inspect: (secret, clock) =>
      run<RecipientCodeInspectResult>(
        secret,
        clock,
        'recipient-code-inspect',
        true,
        async (ctx) => {
          const selected = await query(ctx.scope).query(
            'SELECT * FROM authentication.recipient_code WHERE recipient_actor_id=$1 ORDER BY code_id FOR SHARE',
            [ctx.caller.actorSubject],
          );
          const rows = selected.rows.map(readRecipientCode);
          if (rows.filter((row) => row.status === 'issued').length > 1)
            reject();
          const row = rows.sort(
            (a, b) =>
              Number(b.status === 'issued') - Number(a.status === 'issued') ||
              b.createdAt - a.createdAt ||
              b.codeId.localeCompare(a.codeId),
          )[0];
          if (row) await validate(ctx, row);
          const now = time(clock);
          const state = row ? recipientCodeState(row, facts(ctx, now)) : null;
          if (state === 'unavailable-to-actor') return reject();
          if (row && state === 'issued')
            options.guard(ctx.scope, () => {
              const current = time(clock);
              if (current < now || current >= row.expiresAt) reject();
            });
          await audit(ctx, 'recipient-code-inspect', 'allow', now, row?.codeId);
          const result: RecipientCodeInspectResult =
            row && state
              ? {
                  status: 'found',
                  code: { codeId: row.codeId, state, expiresAt: row.expiresAt },
                }
              : { status: 'no-code' };
          return { result, body: result };
        },
      ),
  });
};
