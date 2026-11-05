import { recipientCodeRetentionWindow } from './authentication-retention-policy.js';
import type {
  RecipientCodeMacKeyClosure,
  RecipientCodeMacKeyLifecyclePort,
} from './recipient-code-key-lifecycle.js';
import type {
  RecipientCodeDestructionTicket,
  RecipientCodeInventoryScope,
  RecipientCodeKeyScope,
  RecipientCodeMaintenancePort,
  RecipientCodeScopeCursor,
  RecipientCodeTicketPreparation,
} from './recipient-code-maintenance-ports.js';
import {
  isRecipientCodeUuid,
  RecipientCodeUnavailable,
} from './recipient-code-record.js';

/** 検証済みの固定snapshot一Page。unavailableは固定失敗へ変換済み。 */
export interface GuardedRecipientCodeScopePage {
  /** 同snapshot内で重複しないscope。 */ readonly scopes: readonly RecipientCodeInventoryScope[];
  /** snapshot全体の件数。 */ readonly total: number;
  /** このguardが検証した続き位置。nullは全件を読了した場合だけ。 */ readonly nextCursor: RecipientCodeScopeCursor | null;
}

/**
 * Providerの応答を信頼せず検証する保守入口。偽closure・版不一致・列挙不完全を成功へ通さない。
 * 検証の失敗とProvider障害はどちらも固定のRecipientCodeUnavailableとし、原因を外へ出さない。
 */
export interface GuardedRecipientCodeMaintenance {
  /**
   * Actorの新規allocateを冪等に封鎖する。
   * @param recipientActorId 封鎖するActor UUIDv4。
   * @returns 要求Actorへ束縛した固定Ack。
   * @throws RecipientCodeUnavailable 形式不正、Ack不一致、Provider障害。
   */
  blockActor(
    recipientActorId: string,
  ): ReturnType<RecipientCodeMaintenancePort['blockActor']>;
  /**
   * 固定snapshotの一Pageを、件数・重複・Actor条件を累積して検証する。
   * @param query 続き位置、1〜1000件の上限、任意のActor条件。cursorはこのguardが返したものだけ。
   * @returns 検証済みの一Page。
   * @throws RecipientCodeUnavailable 列挙不完全、未知scope、別条件のcursor、Provider障害。
   */
  scopePage(
    query: Parameters<RecipientCodeMaintenancePort['scopePage']>[0],
  ): Promise<GuardedRecipientCodeScopePage>;
  /**
   * ticketを作成または採用し、expectedから決まる結果と完全に一致することを確認する。
   * @param input scope、要求operation、起算済みwindow、読取時点のticket。
   * @returns 検証済みのCAS結果。
   * @throws RecipientCodeUnavailable 版不一致、窓の延長、所有operationの差替え、Provider障害。
   */
  prepare(
    input: Parameters<RecipientCodeMaintenancePort['prepare']>[0],
  ): Promise<RecipientCodeTicketPreparation>;
  /**
   * codeIdのticketを取得する。
   * @param codeId 対象のUUIDv4。
   * @returns 同じcodeIdのticket。未登録はnull。
   * @throws RecipientCodeUnavailable 形式不正、別codeのticket、Provider障害。
   */
  find(codeId: string): Promise<RecipientCodeDestructionTicket | null>;
  /**
   * 未完了ticketを最早期限の順に取得する。
   * @param limit 1〜1000件。
   * @returns dueAt昇順の未完了ticket。
   * @throws RecipientCodeUnavailable 完了済みの混入、重複、並び順違反、Provider障害。
   */
  pending(limit: number): Promise<readonly RecipientCodeDestructionTicket[]>;
  /**
   * operationが所有または採用した全ticketを取得する。
   * @param operationId 所有または採用したoperation。
   * @returns codeIdごとに1件のticket。
   * @throws RecipientCodeUnavailable 無関係なticket、重複、Provider障害。
   */
  byOperation(
    operationId: string,
  ): Promise<readonly RecipientCodeDestructionTicket[]>;
  /**
   * ticketのscopeを解決する。
   * @param ticket Providerの最新版と一致するticket。
   * @returns ticketのcodeIdに対応する1件のscope。
   * @throws RecipientCodeUnavailable 版不一致、件数違反、別code、Provider障害。
   */
  scopes(
    ticket: RecipientCodeDestructionTicket,
  ): Promise<readonly RecipientCodeKeyScope[]>;
  /**
   * 所有operationへ束縛して全世代を閉じ、closureと全世代の破棄を検証する。冪等に再実行できる。
   * 破棄は不可逆で、guardはClockを持たない。dueAt到達を確認した呼出し側だけが要求する。
   * @param ticket 未完了ticket。採用側の再開でもoperationIdは所有operationを使う。
   * @returns 検証済みのclosure。dueAt到達とDB 0-rowの確認は呼出し側に残る。
   * @throws RecipientCodeUnavailable 全世代版の不一致、偽closure、部分世代、Provider障害。
   */
  close(
    ticket: RecipientCodeDestructionTicket,
  ): Promise<RecipientCodeMacKeyClosure>;
  /**
   * DB 0-rowを確認した呼出し側がticketを完了する。closureは完了直前にも再検証する。
   * @param ticket 未完了の最新版ticket。
   * @param closure 同じ所有operationと全世代版へ束縛したclosure。
   * @returns 版を1つ上げた完了済みticket。
   * @throws RecipientCodeUnavailable 偽closure、版不一致、完了の偽装、Provider障害。
   */
  complete(
    ticket: RecipientCodeDestructionTicket,
    closure: RecipientCodeMacKeyClosure,
  ): Promise<RecipientCodeDestructionTicket>;
}

type Progress = {
  readonly seen: ReadonlySet<string>;
  readonly total: number;
  readonly recipientActorId: string | null;
};

const lifecycles = ['current', 'read-only', 'destroyed'];

const reject = (): never => {
  throw new RecipientCodeUnavailable();
};
const failClosed = async <T>(work: () => Promise<T> | T): Promise<T> => {
  try {
    return await work();
  } catch {
    // Provider例外の本文に入力やIDが含まれ得るので、causeへも残さない。
    throw new RecipientCodeUnavailable();
  }
};
const record = (value: unknown, keys: readonly string[]) => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    return reject();
  return value as Record<string, unknown>;
};
const uuid = (value: unknown): string =>
  isRecipientCodeUuid(value) ? value : reject();
const reference = (value: unknown): string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 255 &&
  value.trim() === value
    ? value
    : reject();
const pageLimit = (limit: unknown): number =>
  Number.isSafeInteger(limit) && Number(limit) >= 1 && Number(limit) <= 1000
    ? Number(limit)
    : reject();
const distinct = (values: readonly string[]) =>
  new Set(values).size === values.length || reject();
const scheduledWindow = (dueAt: number) =>
  recipientCodeRetentionWindow({
    expiresAt: dueAt,
    terminalAt: null,
    actorCutoffAt: null,
  });
const windowOf = (value: unknown) => {
  const { dueAt, deadline } = record(value, ['dueAt', 'deadline']);
  const window = scheduledWindow(dueAt as number);
  return window.deadline === deadline ? window : reject();
};
const ticketOf = (value: unknown): RecipientCodeDestructionTicket => {
  const fields = record(value, [
    'codeId',
    'operationId',
    'adoptingOperationIds',
    'version',
    'inventoryRevision',
    'window',
    'state',
  ]);
  const operationId = uuid(fields.operationId);
  if (!Array.isArray(fields.adoptingOperationIds)) return reject();
  const adopting = fields.adoptingOperationIds.map(uuid);
  distinct([operationId, ...adopting]);
  if (
    !Number.isSafeInteger(fields.version) ||
    Number(fields.version) < 1 ||
    (fields.state !== 'pending' && fields.state !== 'complete')
  )
    return reject();
  return Object.freeze({
    codeId: uuid(fields.codeId),
    operationId,
    adoptingOperationIds: Object.freeze(adopting),
    version: Number(fields.version),
    inventoryRevision: reference(fields.inventoryRevision),
    window: windowOf(fields.window),
    state: fields.state,
  });
};
const sameTicket = (
  a: RecipientCodeDestructionTicket,
  b: RecipientCodeDestructionTicket,
) =>
  a.codeId === b.codeId &&
  a.operationId === b.operationId &&
  [...a.adoptingOperationIds].sort().join() ===
    [...b.adoptingOperationIds].sort().join() &&
  a.version === b.version &&
  a.inventoryRevision === b.inventoryRevision &&
  a.window.dueAt === b.window.dueAt &&
  a.window.deadline === b.window.deadline &&
  a.state === b.state;
const inventoryScopeOf = (value: unknown): RecipientCodeInventoryScope => {
  const fields = record(value, [
    'codeId',
    'recipientActorId',
    'expiresAt',
    'inventoryRevision',
  ]);
  if (!Number.isSafeInteger(fields.expiresAt) || Number(fields.expiresAt) < 0)
    return reject();
  return Object.freeze({
    codeId: uuid(fields.codeId),
    recipientActorId: uuid(fields.recipientActorId),
    expiresAt: Number(fields.expiresAt),
    inventoryRevision: reference(fields.inventoryRevision),
  });
};
const closureOf = (
  value: unknown,
  ticket: RecipientCodeDestructionTicket,
): RecipientCodeMacKeyClosure => {
  const fields = record(value, [
    'codeId',
    'operationId',
    'inventoryRevision',
    'evidenceReference',
  ]);
  // 採用経由の完了でも、closureのoperationIdは常に所有operationとする（ADR D3）。
  if (
    fields.codeId !== ticket.codeId ||
    fields.operationId !== ticket.operationId ||
    fields.inventoryRevision !== ticket.inventoryRevision
  )
    return reject();
  return Object.freeze({
    codeId: ticket.codeId,
    operationId: ticket.operationId,
    inventoryRevision: ticket.inventoryRevision,
    evidenceReference: reference(fields.evidenceReference),
  });
};
const pendingTicketOf = (value: unknown) => {
  const ticket = ticketOf(value);
  return ticket.state === 'pending' ? ticket : reject();
};
/**
 * 読取時点のticketと要求から、CASの結果として唯一正しい値を求める。
 * Providerの応答をこの値と比較し、延長・差替え・版の飛越しを検出する。
 */
const expectedPreparation = (
  input: Parameters<RecipientCodeMaintenancePort['prepare']>[0],
  inventoryRevision: string,
): {
  status: RecipientCodeTicketPreparation['status'];
  ticket: RecipientCodeDestructionTicket;
} => {
  const { expected, operationId, window, scope } = input;
  if (expected === null)
    return {
      status: 'created',
      ticket: {
        codeId: scope.codeId,
        operationId,
        adoptingOperationIds: [],
        version: 1,
        inventoryRevision,
        window,
        state: 'pending',
      },
    };
  const owner = expected.operationId === operationId;
  const adopts = !owner && !expected.adoptingOperationIds.includes(operationId);
  const dueAt =
    expected.state === 'pending'
      ? Math.min(expected.window.dueAt, window.dueAt)
      : expected.window.dueAt;
  const changed = adopts || dueAt !== expected.window.dueAt;
  let status: RecipientCodeTicketPreparation['status'] = 'adopted';
  if (expected.state === 'complete') status = 'satisfied';
  else if (owner) status = 'resumed';
  return {
    status,
    ticket: {
      ...expected,
      adoptingOperationIds: adopts
        ? [...expected.adoptingOperationIds, operationId]
        : expected.adoptingOperationIds,
      version: expected.version + (changed ? 1 : 0),
      window: scheduledWindow(dueAt),
    },
  };
};

/**
 * 保守PortとLifecycle Portの応答を検証する入口を作る。合成Providerの成功は実Providerの証拠にしない。
 * @param options コード専用の保守Portと全世代Lifecycle Port。
 * @returns 全応答を検証し、失敗を固定のRecipientCodeUnavailableへ揃えた保守入口。
 */
export const guardRecipientCodeMaintenance = (options: {
  /** ticket・列挙・封鎖のPort。 */ readonly maintenance: RecipientCodeMaintenancePort;
  /** 全世代inventoryとclosureのPort。 */ readonly lifecycle: RecipientCodeMacKeyLifecyclePort;
}): GuardedRecipientCodeMaintenance => {
  const { maintenance, lifecycle } = options;
  const progress = new WeakMap<RecipientCodeScopeCursor, Progress>();
  const generationsOf = async (ticket: RecipientCodeDestructionTicket) => {
    const fields = record(await lifecycle.inventory(ticket.codeId), [
      'codeId',
      'inventoryRevision',
      'generations',
    ]);
    if (
      fields.codeId !== ticket.codeId ||
      fields.inventoryRevision !== ticket.inventoryRevision ||
      !Array.isArray(fields.generations) ||
      fields.generations.length === 0
    )
      return reject();
    const generations = fields.generations.map((value: unknown) => {
      const generation = record(value, ['keyVersion', 'lifecycle']);
      if (!lifecycles.includes(generation.lifecycle as string)) return reject();
      return {
        keyVersion: reference(generation.keyVersion),
        lifecycle: generation.lifecycle,
      };
    });
    distinct(generations.map((generation) => generation.keyVersion));
    return generations;
  };
  const assertClosed = async (
    ticket: RecipientCodeDestructionTicket,
    closure: RecipientCodeMacKeyClosure,
  ) => {
    if ((await lifecycle.verifyClosure(closure)) !== true) reject();
    // verifyClosureの応答だけを信じず、部分世代が残っていないことも照合する。
    for (const generation of await generationsOf(ticket))
      if (generation.lifecycle !== 'destroyed') reject();
  };
  return {
    blockActor: (recipientActorId) =>
      failClosed(async () => {
        const answer = record(
          await maintenance.blockActor(uuid(recipientActorId)),
          ['status', 'recipientActorId'],
        );
        if (
          answer.status !== 'blocked' ||
          answer.recipientActorId !== recipientActorId
        )
          reject();
        return Object.freeze({
          status: 'blocked' as const,
          recipientActorId,
        });
      }),
    scopePage: ({ cursor, limit, recipientActorId }) =>
      failClosed(async () => {
        const previous = cursor === null ? undefined : progress.get(cursor);
        if (cursor !== null && previous === undefined) reject();
        if (recipientActorId !== null) uuid(recipientActorId);
        if (
          previous !== undefined &&
          previous.recipientActorId !== recipientActorId
        )
          reject();
        const size = pageLimit(limit);
        const page = await maintenance.scopePage({
          cursor,
          limit: size,
          recipientActorId,
        });
        // 完全列挙を保証できない応答は、空のsnapshotへ読み替えず停止する（ADR D4）。
        if (page.status !== 'snapshot') return reject();
        const fields = record(page, [
          'status',
          'scopes',
          'total',
          'nextCursor',
        ]);
        const { total, nextCursor } = page;
        if (
          !Number.isSafeInteger(total) ||
          total < 0 ||
          (previous !== undefined && previous.total !== total) ||
          !Array.isArray(fields.scopes) ||
          fields.scopes.length > size ||
          (nextCursor !== null && typeof nextCursor !== 'object')
        )
          return reject();
        const scopes = fields.scopes.map(inventoryScopeOf);
        const seen = new Set(previous?.seen);
        for (const scope of scopes) {
          if (
            seen.has(scope.codeId) ||
            (recipientActorId !== null &&
              scope.recipientActorId !== recipientActorId)
          )
            reject();
          seen.add(scope.codeId);
        }
        if (
          nextCursor === null
            ? seen.size !== total
            : scopes.length === 0 || seen.size >= total
        )
          return reject();
        if (nextCursor !== null)
          progress.set(nextCursor, { seen, total, recipientActorId });
        return Object.freeze({
          scopes: Object.freeze(scopes),
          total,
          nextCursor,
        });
      }),
    prepare: (input) =>
      failClosed(async () => {
        const expected =
          input.expected === null ? null : ticketOf(input.expected);
        const scope = Object.freeze({
          codeId: uuid(input.scope.codeId),
          recipientActorId: uuid(input.scope.recipientActorId),
        });
        const operationId = uuid(input.operationId);
        const window = windowOf(input.window);
        if (expected !== null && expected.codeId !== scope.codeId) reject();
        const request = { scope, operationId, window, expected };
        const fields = record(await maintenance.prepare(request), [
          'status',
          'ticket',
        ]);
        const ticket = ticketOf(fields.ticket);
        const want = expectedPreparation(
          request,
          expected?.inventoryRevision ?? ticket.inventoryRevision,
        );
        if (fields.status !== want.status || !sameTicket(ticket, want.ticket))
          reject();
        return Object.freeze({ status: want.status, ticket });
      }),
    find: (codeId) =>
      failClosed(async () => {
        const answer = await maintenance.find(uuid(codeId));
        if (answer === null) return null;
        const ticket = ticketOf(answer);
        return ticket.codeId === codeId ? ticket : reject();
      }),
    pending: (limit) =>
      failClosed(async () => {
        const size = pageLimit(limit);
        const answer = await maintenance.pending(size);
        if (!Array.isArray(answer) || answer.length > size) return reject();
        const tickets = answer.map(pendingTicketOf);
        distinct(tickets.map((ticket) => ticket.codeId));
        tickets.forEach((ticket, index) => {
          if (
            index > 0 &&
            tickets[index - 1].window.dueAt > ticket.window.dueAt
          )
            reject();
        });
        return Object.freeze(tickets);
      }),
    byOperation: (operationId) =>
      failClosed(async () => {
        const answer = await maintenance.byOperation(uuid(operationId));
        if (!Array.isArray(answer)) return reject();
        const tickets = answer.map(ticketOf);
        distinct(tickets.map((ticket) => ticket.codeId));
        for (const ticket of tickets)
          if (
            ticket.operationId !== operationId &&
            !ticket.adoptingOperationIds.includes(operationId)
          )
            reject();
        return Object.freeze(tickets);
      }),
    scopes: (ticket) =>
      failClosed(async () => {
        const current = ticketOf(ticket);
        const answer = await maintenance.scopes(current);
        if (!Array.isArray(answer) || answer.length !== 1) return reject();
        const fields = record(answer[0], ['codeId', 'recipientActorId']);
        if (fields.codeId !== current.codeId) return reject();
        return Object.freeze([
          Object.freeze({
            codeId: current.codeId,
            recipientActorId: uuid(fields.recipientActorId),
          }),
        ]);
      }),
    close: (ticket) =>
      failClosed(async () => {
        const current = pendingTicketOf(ticket);
        await generationsOf(current);
        const closure = closureOf(
          await lifecycle.closeAllGenerations({
            codeId: current.codeId,
            operationId: current.operationId,
            inventoryRevision: current.inventoryRevision,
            deadlineAt: current.window.deadline,
          }),
          current,
        );
        await assertClosed(current, closure);
        return closure;
      }),
    complete: (ticket, closure) =>
      failClosed(async () => {
        const current = pendingTicketOf(ticket);
        const proof = closureOf(closure, current);
        await assertClosed(current, proof);
        const done = ticketOf(
          await maintenance.complete({ ticket: current, closure: proof }),
        );
        return sameTicket(done, {
          ...current,
          version: current.version + 1,
          state: 'complete',
        })
          ? done
          : reject();
      }),
  };
};
