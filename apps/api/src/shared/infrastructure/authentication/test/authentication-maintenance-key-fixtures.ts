import { createHash } from 'node:crypto';

import type {
  AuthenticationDataKeyPort,
  AuthenticationKeyScope,
} from '../../../application/authentication/authentication-crypto-keys.js';
import type {
  AuthenticationDestructionTicket,
  AuthenticationKeyDestructionPort,
  AuthenticationVerifiedDestruction,
  AuthenticationActorDeletionCursor,
} from '../../../application/authentication/authentication-maintenance-ports.js';
import type { AuthenticationRetentionWindow } from '../../../application/authentication/authentication-retention-policy.js';
import { authenticationBytesEqual } from '../authentication-digests.js';
import { importAuthenticationDataKey } from '../authentication-record-codec.js';
import { encodeAuthenticationTlv } from '../canonical-authentication.js';

type Version = {
  key: ReturnType<typeof importAuthenticationDataKey>;
  count: bigint;
  mode: 'current' | 'read-only' | 'destroyed';
};
type TicketState = {
  ticket: AuthenticationDestructionTicket;
  scopes: Map<string, AuthenticationKeyScope>;
  complete: boolean;
};

/**
 * DB Backupとは別に保持するTest-onlyの全世代Registry。実Cloud耐障害性の証明ではない。
 * @returns 全世代破棄・Nonce burn・応答喪失を検証する合成Provider。
 */
export const syntheticAuthenticationManagedKeys = () => {
  const all = new Map<string, Map<string, Version>>();
  const closed = new Set<string>();
  const tickets = new Map<string, TicketState>();
  const proofs = new WeakMap<
    AuthenticationVerifiedDestruction,
    AuthenticationDestructionTicket
  >();
  const cursors = new WeakMap<
    AuthenticationActorDeletionCursor,
    { snapshot: string; after: string }
  >();
  const faults = new Set<string>();
  const events: string[] = [];
  let sequence = 0;
  const name = (scope: AuthenticationKeyScope) =>
    scope.recordKind + '/' + scope.keyScopeId;
  const tick = (event: string) => {
    events.push(event);
    if (faults.has(event)) throw new Error('synthetic provider fault');
  };
  const rotate = (scope: AuthenticationKeyScope) => {
    tick('before-rotate');
    const id = name(scope);
    if (closed.has(id)) throw new Error('synthetic permanent seal fence');
    const versions = all.get(id) ?? new Map<string, Version>();
    for (const value of versions.values())
      if (value.mode === 'current') value.mode = 'read-only';
    versions.set('dek-' + String(versions.size + 1), {
      key: importAuthenticationDataKey(
        createHash('sha256')
          .update('synthetic-key-' + String(++sequence))
          .digest(),
      ),
      count: 0n,
      mode: 'current',
    });
    all.set(id, versions);
    tick('after-rotate');
  };
  const current = (scope: AuthenticationKeyScope) => {
    const id = name(scope);
    if (!all.has(id)) rotate(scope);
    return [...all.get(id)!.entries()].at(-1)!;
  };
  const copy = (
    ticket: AuthenticationDestructionTicket,
  ): AuthenticationDestructionTicket => ({
    ...ticket,
    inventoryDigest: Uint8Array.from(ticket.inventoryDigest),
    window: { ...ticket.window },
  });
  const matches = (
    a: AuthenticationDestructionTicket,
    b: AuthenticationDestructionTicket,
  ) =>
    a.operationId === b.operationId &&
    a.reference === b.reference &&
    a.version === b.version &&
    authenticationBytesEqual(a.inventoryDigest, b.inventoryDigest) &&
    a.window.dueAt === b.window.dueAt &&
    a.window.deadline === b.window.deadline;
  const inventoryDigest = (targets: Map<string, AuthenticationKeyScope>) =>
    createHash('sha256')
      .update(
        encodeAuthenticationTlv([
          'synthetic-all-versions/v1',
          ...[...targets.keys()]
            .sort()
            .flatMap((id) => [id, ...[...(all.get(id)?.keys() ?? [])].sort()]),
        ]),
      )
      .digest();
  const refresh = (state: TicketState) => {
    const digest = inventoryDigest(state.scopes);
    if (!authenticationBytesEqual(digest, state.ticket.inventoryDigest)) {
      state.ticket = {
        ...state.ticket,
        version: state.ticket.version + 1,
        inventoryDigest: digest,
      };
      state.complete = false;
    }
    return state;
  };
  const owned = (ticket: AuthenticationDestructionTicket) => {
    const state = tickets.get(ticket.operationId);
    if (state === undefined || !matches(refresh(state).ticket, ticket))
      throw new Error('synthetic ticket mismatch');
    return state;
  };
  const provider: AuthenticationDataKeyPort = {
    allocateForSeal: (scope) => {
      return Promise.resolve().then(() => {
        tick('before-allocate');
        if (closed.has(name(scope)))
          return { status: 'seal-disabled', keyVersion: 'destroyed' };
        const [keyVersion, value] = current(scope);
        if (value.mode !== 'current')
          return { status: 'seal-disabled', keyVersion };
        const count = ++value.count;
        const nonce = Buffer.alloc(12);
        nonce.writeBigUInt64BE(count, 4);
        tick('after-allocate');
        return {
          status: 'allocated',
          scope: { ...scope },
          lifecycle: 'current',
          key: value.key,
          keyVersion,
          nonce,
          sealCount: count,
        };
      });
    },
    readKey: ({ scope, keyVersion }) => {
      return Promise.resolve().then(() => {
        tick('read-key');
        const value = all.get(name(scope))?.get(keyVersion);
        if (
          closed.has(name(scope)) ||
          value === undefined ||
          value.mode === 'destroyed'
        )
          return { status: 'unavailable' };
        return {
          status: 'available',
          scope: { ...scope },
          keyVersion,
          lifecycle: value.mode,
          key: value.key,
        };
      });
    },
    requestRotation: ({ scope, keyVersion }) => {
      return Promise.resolve().then(() => {
        const value = all.get(name(scope))?.get(keyVersion);
        if (value?.mode === 'current') value.mode = 'read-only';
      });
    },
  };
  const keys: AuthenticationKeyDestructionPort = {
    pendingActorDeletionPage: (cursor, limit) =>
      Promise.resolve().then(() => {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
          throw new Error('synthetic page limit');
        const pending = [...tickets.values()]
          .map(refresh)
          .filter(
            (state) =>
              !state.complete &&
              [...state.scopes.values()].some(
                (scope) => scope.recordKind === 'google-identity',
              ),
          )
          .sort((a, b) =>
            a.ticket.operationId.localeCompare(b.ticket.operationId),
          );
        const hash = createHash('sha256');
        for (const { ticket } of pending)
          hash.update(
            encodeAuthenticationTlv([
              ticket.operationId,
              ticket.reference,
              String(ticket.version),
              ticket.inventoryDigest,
              String(ticket.window.dueAt),
              String(ticket.window.deadline),
            ]),
          );
        const snapshot = hash.digest('hex');
        let after: string | null = null;
        if (cursor !== null) {
          const position = cursors.get(cursor);
          if (position === undefined || position.snapshot !== snapshot)
            throw new Error('synthetic inventory cursor mismatch');
          after = position.after;
        }
        const start =
          after === null
            ? 0
            : pending.findIndex((state) => state.ticket.operationId === after) +
              1;
        if (after !== null && start === 0)
          throw new Error('synthetic missing cursor position');
        const selected = pending
          .slice(start, start + limit)
          .map((state) => copy(state.ticket));
        let nextCursor: AuthenticationActorDeletionCursor | null = null;
        if (start + selected.length < pending.length) {
          nextCursor = Object.freeze(
            Object.create(null),
          ) as AuthenticationActorDeletionCursor;
          cursors.set(nextCursor, {
            snapshot,
            after: selected.at(-1)!.operationId,
          });
        }
        return { tickets: selected, nextCursor };
      }),
    find: (operationId, reference) => {
      return Promise.resolve().then(() => {
        const state = tickets.get(operationId);
        return state?.ticket.reference === reference
          ? copy(refresh(state).ticket)
          : null;
      });
    },
    prepare: (operationId, scopes, window: AuthenticationRetentionWindow) => {
      return Promise.resolve().then(() => {
        tick('before-prepare');
        const previous = tickets.get(operationId);
        if (
          previous !== undefined &&
          (previous.ticket.window.dueAt !== window.dueAt ||
            previous.ticket.window.deadline !== window.deadline)
        )
          throw new Error('synthetic deadline mismatch');
        const targets = new Map(previous?.scopes ?? []);
        for (const scope of scopes) targets.set(name(scope), { ...scope });
        const digest = inventoryDigest(targets);
        const changed =
          previous === undefined ||
          !authenticationBytesEqual(previous.ticket.inventoryDigest, digest);
        const ticket = {
          operationId,
          reference: 'scope-' + operationId,
          version:
            previous === undefined
              ? 1
              : previous.ticket.version + (changed ? 1 : 0),
          inventoryDigest: digest,
          window: { ...window },
        };
        tickets.set(operationId, {
          ticket,
          scopes: targets,
          complete: !changed && previous?.complete === true,
        });
        tick('after-prepare');
        return copy(ticket);
      });
    },
    pendingCredentials: (limit) =>
      Promise.resolve(
        [...tickets.values()]
          .map(refresh)
          .filter(
            (state) =>
              !state.complete &&
              [...state.scopes.values()].every(
                (scope) => scope.recordKind !== 'google-identity',
              ),
          )
          .sort((a, b) => a.ticket.window.dueAt - b.ticket.window.dueAt)
          .slice(0, limit)
          .map((state) => copy(state.ticket)),
      ),
    pendingActorDeletions: (limit, selector) =>
      Promise.resolve(
        [...tickets.values()]
          .map(refresh)
          .filter(
            (state) =>
              !state.complete &&
              (selector?.operationId === undefined ||
                state.ticket.operationId === selector.operationId) &&
              (selector?.actorId === undefined ||
                [...state.scopes.values()].some(
                  (scope) =>
                    scope.recordKind === 'google-identity' &&
                    scope.keyScopeId === selector.actorId,
                )) &&
              [...state.scopes.values()].some(
                (scope) => scope.recordKind === 'google-identity',
              ),
          )
          .sort((a, b) => a.ticket.window.dueAt - b.ticket.window.dueAt)
          .slice(0, limit)
          .map((state) => copy(state.ticket)),
      ),
    scopes: (ticket) =>
      Promise.resolve(
        [...owned(ticket).scopes.values()].map((scope) => ({ ...scope })),
      ),
    destroy: (ticket) => {
      return Promise.resolve().then(() => {
        tick('before-destroy');
        const state = owned(ticket);
        for (const id of state.scopes.keys()) {
          closed.add(id);
          for (const value of all.get(id)?.values() ?? []) {
            tick('before-destroy-version');
            value.mode = 'destroyed';
            tick('after-destroy-version');
          }
        }
        const proof = Object.freeze(
          Object.create(null),
        ) as AuthenticationVerifiedDestruction;
        proofs.set(proof, copy(ticket));
        tick('after-destroy');
        return proof;
      });
    },
    verify: (proof, ticket) => {
      return Promise.resolve().then(() => {
        tick('before-verify-destroyed');
        const snapshot = proofs.get(proof);
        const state = owned(ticket);
        const valid =
          snapshot !== undefined &&
          matches(snapshot, ticket) &&
          [...state.scopes.keys()].every(
            (id) =>
              closed.has(id) &&
              [...(all.get(id)?.values() ?? [])].every(
                (version) => version.mode === 'destroyed',
              ),
          );
        if (valid) state.complete = true;
        tick('after-verify-destroyed');
        return valid;
      });
    },
  };
  return {
    /** Codecが使用する全世代/Nonceの合成Provider。 */
    provider,
    /** durableなticketと全世代破棄の合成Port。 */
    keys,
    /**
     * 保持Identityの新世代化。旧KeyのSealを拒否する。
     * @param scope 合成認証scope。恒久封鎖済みなら拒否する。
     * @throws 合成Providerの故障または破棄済みscope。
     */
    rotate,
    /** 各境界で停止させるTest-onlyの固定故障点。 */
    faults,
    /** Testだけが確認する固定分類の呼出し履歴。 */
    events,
    /**
     * Materialを公開せず、全世代とNonce burn/破棄状態を検査する。
     * @param scope 合成認証scope。
     * @returns DB rollback/restoreで戻らない世代状態。
     */
    inventory: (scope: AuthenticationKeyScope) =>
      [...(all.get(name(scope))?.entries() ?? [])].map(([version, value]) => ({
        version,
        count: value.count,
        mode: value.mode,
      })),
  };
};
