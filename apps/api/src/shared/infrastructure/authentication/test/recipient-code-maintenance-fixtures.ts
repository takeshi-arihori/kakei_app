import type {
  RecipientCodeMacKeyLifecyclePort,
  RecipientCodeStateKeyAllocationPort,
} from '../../../application/authentication/recipient-code-key-lifecycle.js';
import type {
  RecipientCodeDestructionTicket,
  RecipientCodeInventoryScope,
  RecipientCodeMaintenancePort,
  RecipientCodeScopeCursor,
} from '../../../application/authentication/recipient-code-maintenance-ports.js';

type Lifecycle = 'current' | 'read-only' | 'destroyed';
type Stored = {
  recipientActorId: string;
  expiresAt: number;
  generations: Map<string, Lifecycle>;
  revision: number;
};
type Position = {
  scopes: readonly RecipientCodeInventoryScope[];
  next: number;
  recipientActorId: string | null;
};

const day = 86_400_000;

/**
 * DB Backupとは別に保持するTest-onlyのコード鍵Provider。allocate・全世代closure・ticket・封鎖を持つ。
 * JavaScriptの単一threadで線形化するだけで、実Providerの線形化・耐久性・IAMの証拠にしない。
 * @returns 3つのPortと、各境界で停止させる固定故障点。
 */
export const syntheticRecipientCodeManagedKeys = () => {
  const scopes = new Map<string, Stored>();
  const blocked = new Set<string>();
  const tickets = new Map<string, RecipientCodeDestructionTicket>();
  const evidence = new Map<
    string,
    { codeId: string; operationId: string; inventoryRevision: string }
  >();
  const cursors = new WeakMap<RecipientCodeScopeCursor, Position>();
  const faults = new Set<string>();
  const tick = (point: string) => {
    if (faults.has(point)) throw new Error('synthetic provider fault');
  };
  const revisionOf = (codeId: string, stored: Stored) =>
    codeId + '/revision-' + String(stored.revision);
  const copy = (
    ticket: RecipientCodeDestructionTicket,
  ): RecipientCodeDestructionTicket => ({
    ...ticket,
    adoptingOperationIds: [...ticket.adoptingOperationIds],
    window: { ...ticket.window },
  });
  const latest = (
    ticket: RecipientCodeDestructionTicket,
  ): RecipientCodeDestructionTicket => {
    const current = tickets.get(ticket.codeId);
    if (current === undefined || current.version !== ticket.version)
      throw new Error('synthetic ticket version mismatch');
    return current;
  };
  const closureValid = (closure: {
    codeId: string;
    operationId: string;
    inventoryRevision: string;
    evidenceReference: string;
  }) => {
    const entry = evidence.get(closure.evidenceReference);
    const stored = scopes.get(closure.codeId);
    return (
      entry !== undefined &&
      stored !== undefined &&
      entry.codeId === closure.codeId &&
      entry.operationId === closure.operationId &&
      entry.inventoryRevision === closure.inventoryRevision &&
      [...stored.generations.values()].every((mode) => mode === 'destroyed')
    );
  };
  const allocation: RecipientCodeStateKeyAllocationPort = {
    allocate: (input) =>
      Promise.resolve().then(() => {
        tick('before-allocate');
        const stored = scopes.get(input.codeId);
        if (
          blocked.has(input.recipientActorId) ||
          tickets.has(input.codeId) ||
          (stored !== undefined &&
            (stored.recipientActorId !== input.recipientActorId ||
              stored.expiresAt !== input.expiresAt))
        )
          return { status: 'unavailable' as const };
        const target = stored ?? {
          recipientActorId: input.recipientActorId,
          expiresAt: input.expiresAt,
          generations: new Map<string, Lifecycle>(),
          revision: 0,
        };
        const created = !target.generations.has(input.keyVersion);
        if (created) {
          for (const [version, mode] of target.generations)
            if (mode === 'current')
              target.generations.set(version, 'read-only');
          target.generations.set(input.keyVersion, 'current');
          target.revision += 1;
          scopes.set(input.codeId, target);
        }
        tick('after-allocate');
        return { status: 'allocated' as const, created, ...input };
      }),
  };
  const lifecycle: RecipientCodeMacKeyLifecyclePort = {
    inventory: (codeId) =>
      Promise.resolve().then(() => {
        tick('inventory');
        const stored = scopes.get(codeId);
        if (stored === undefined) throw new Error('synthetic unknown scope');
        return {
          codeId,
          inventoryRevision: revisionOf(codeId, stored),
          generations: [...stored.generations].map(([keyVersion, mode]) => ({
            keyVersion,
            lifecycle: mode,
          })),
        };
      }),
    closeAllGenerations: (input) =>
      Promise.resolve().then(() => {
        tick('before-close');
        const stored = scopes.get(input.codeId);
        const ticket = tickets.get(input.codeId);
        if (
          stored === undefined ||
          ticket === undefined ||
          ticket.operationId !== input.operationId ||
          ticket.inventoryRevision !== input.inventoryRevision ||
          ticket.window.deadline !== input.deadlineAt
        )
          throw new Error('synthetic closure binding mismatch');
        for (const version of stored.generations.keys()) {
          stored.generations.set(version, 'destroyed');
          // 1世代だけ破棄した混在状態で止め、部分世代を再現する。
          tick('after-destroy-generation');
        }
        const evidenceReference = 'evidence/' + input.codeId;
        evidence.set(evidenceReference, {
          codeId: input.codeId,
          operationId: input.operationId,
          inventoryRevision: input.inventoryRevision,
        });
        tick('after-close');
        return {
          codeId: input.codeId,
          operationId: input.operationId,
          inventoryRevision: input.inventoryRevision,
          evidenceReference,
        };
      }),
    verifyClosure: (closure) =>
      Promise.resolve().then(() => {
        tick('verify-closure');
        return closureValid(closure);
      }),
  };
  const maintenance: RecipientCodeMaintenancePort = {
    blockActor: (recipientActorId) =>
      Promise.resolve().then(() => {
        tick('block-actor');
        blocked.add(recipientActorId);
        return { status: 'blocked' as const, recipientActorId };
      }),
    scopePage: ({ cursor, limit, recipientActorId }) =>
      Promise.resolve().then(() => {
        tick('scope-page');
        if (faults.has('scope-page-unavailable'))
          return { status: 'unavailable' as const };
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
          throw new Error('synthetic page limit');
        const position: Position | undefined =
          cursor === null
            ? {
                scopes: [...scopes]
                  .filter(
                    ([, stored]) =>
                      recipientActorId === null ||
                      stored.recipientActorId === recipientActorId,
                  )
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([codeId, stored]) => ({
                    codeId,
                    recipientActorId: stored.recipientActorId,
                    expiresAt: stored.expiresAt,
                    inventoryRevision: revisionOf(codeId, stored),
                  })),
                next: 0,
                recipientActorId,
              }
            : cursors.get(cursor);
        if (
          position === undefined ||
          position.recipientActorId !== recipientActorId
        )
          throw new Error('synthetic cursor mismatch');
        const end = position.next + limit;
        const page = position.scopes.slice(position.next, end);
        let nextCursor: RecipientCodeScopeCursor | null = null;
        if (end < position.scopes.length) {
          nextCursor = Object.freeze(
            Object.create(null),
          ) as RecipientCodeScopeCursor;
          cursors.set(nextCursor, { ...position, next: end });
        }
        return {
          status: 'snapshot' as const,
          scopes: page,
          total: position.scopes.length,
          nextCursor,
        };
      }),
    prepare: ({ scope, operationId, window, expected }) =>
      Promise.resolve().then(() => {
        tick('before-prepare');
        const stored = scopes.get(scope.codeId);
        const current = tickets.get(scope.codeId) ?? null;
        if (
          stored === undefined ||
          stored.recipientActorId !== scope.recipientActorId ||
          window.dueAt > stored.expiresAt ||
          current?.version !== expected?.version
        )
          throw new Error('synthetic ticket mismatch');
        let answer: RecipientCodeDestructionTicket;
        if (current === null) {
          answer = {
            codeId: scope.codeId,
            operationId,
            adoptingOperationIds: [],
            version: 1,
            inventoryRevision: revisionOf(scope.codeId, stored),
            window: { ...window },
            state: 'pending',
          };
        } else {
          const adopts =
            current.operationId !== operationId &&
            !current.adoptingOperationIds.includes(operationId);
          const dueAt =
            current.state === 'pending'
              ? Math.min(current.window.dueAt, window.dueAt)
              : current.window.dueAt;
          const changed = adopts || dueAt !== current.window.dueAt;
          answer = {
            ...current,
            adoptingOperationIds: adopts
              ? [...current.adoptingOperationIds, operationId]
              : current.adoptingOperationIds,
            version: current.version + (changed ? 1 : 0),
            window: { dueAt, deadline: dueAt + day },
          };
        }
        tickets.set(scope.codeId, answer);
        tick('after-prepare');
        let status: 'created' | 'resumed' | 'adopted' | 'satisfied';
        if (current === null) status = 'created';
        else if (current.state === 'complete') status = 'satisfied';
        else
          status = current.operationId === operationId ? 'resumed' : 'adopted';
        return { status, ticket: copy(answer) };
      }),
    find: (codeId) =>
      Promise.resolve().then(() => {
        tick('find');
        const ticket = tickets.get(codeId);
        return ticket === undefined ? null : copy(ticket);
      }),
    pending: (limit) =>
      Promise.resolve().then(() => {
        tick('pending');
        return [...tickets.values()]
          .filter((ticket) => ticket.state === 'pending')
          .sort((a, b) => a.window.dueAt - b.window.dueAt)
          .slice(0, limit)
          .map(copy);
      }),
    byOperation: (operationId) =>
      Promise.resolve().then(() => {
        tick('by-operation');
        return [...tickets.values()]
          .filter(
            (ticket) =>
              ticket.operationId === operationId ||
              ticket.adoptingOperationIds.includes(operationId),
          )
          .map(copy);
      }),
    scopes: (ticket) =>
      Promise.resolve().then(() => {
        tick('scopes');
        const { codeId } = latest(ticket);
        return [
          { codeId, recipientActorId: scopes.get(codeId)!.recipientActorId },
        ];
      }),
    complete: ({ ticket, closure }) =>
      Promise.resolve().then(() => {
        tick('before-complete');
        const current = latest(ticket);
        if (
          current.state !== 'pending' ||
          closure.codeId !== current.codeId ||
          closure.operationId !== current.operationId ||
          closure.inventoryRevision !== current.inventoryRevision ||
          !closureValid(closure)
        )
          throw new Error('synthetic closure mismatch');
        const answer: RecipientCodeDestructionTicket = {
          ...current,
          version: current.version + 1,
          state: 'complete',
        };
        tickets.set(current.codeId, answer);
        tick('after-complete');
        return copy(answer);
      }),
  };
  return {
    /** Store／Writerが使う明示発行Port。DB rollbackで巻き戻らない。 */
    allocation,
    /** 全世代inventoryとclosureのPort。 */
    lifecycle,
    /** ticket・列挙・封鎖の保守Port。 */
    maintenance,
    /** 各境界で停止させるTest-onlyの固定故障点。 */
    faults,
  };
};
