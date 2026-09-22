import { describe, expect, it } from 'vitest';

import {
  CloseIntentId,
  GroupId,
  UtcInstant,
  type CloseFenceReceipt,
  type CloseUnfenceReceipt,
  type GroupCloseContext,
} from '../domain/group.js';
import type {
  GroupCloseContextPort,
  InstallGroupCloseFenceRequest,
  RemoveGroupCloseFenceRequest,
} from './group-close-context-port.js';

const instant = (value: string): UtcInstant => UtcInstant.from(new Date(value));

class ContextFencedError extends Error {}
class FenceBindingError extends Error {}

type Deferred = Readonly<{ promise: Promise<void>; resolve: () => void }>;
const deferred = (): Deferred => {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

class InMemoryCloseFenceContextFake implements GroupCloseContextPort {
  private readonly inflight = new Map<string, Set<Promise<void>>>();
  private readonly unfinished = new Set<string>();
  private readonly fenceVersions = new Map<string, number>();
  private readonly installingFences = new Map<
    string,
    Readonly<{
      request: InstallGroupCloseFenceRequest;
      receipt: Promise<CloseFenceReceipt>;
    }>
  >();
  private readonly activeFences = new Map<string, CloseFenceReceipt>();
  private readonly removedFences = new Map<string, CloseUnfenceReceipt>();
  private readonly terminalIntents = new Set<string>();

  constructor(
    readonly context: GroupCloseContext,
    private readonly now: () => UtcInstant,
  ) {}

  async write(
    groupId: GroupId,
    commandId: string,
    completion: Promise<void>,
    leavesUnfinishedWork: boolean,
  ): Promise<void> {
    if (
      this.activeFences.has(groupId.value) ||
      this.installingFences.has(groupId.value)
    ) {
      throw new ContextFencedError('The Group is fenced for closing');
    }

    const commands = this.inflight.get(groupId.value) ?? new Set();
    const committed = completion.then(() => {
      if (leavesUnfinishedWork) {
        this.unfinished.add(`${groupId.value}:${commandId}`);
      }
    });
    commands.add(committed);
    this.inflight.set(groupId.value, commands);
    try {
      await committed;
    } finally {
      commands.delete(committed);
    }
  }

  async installFence(
    request: InstallGroupCloseFenceRequest,
  ): Promise<CloseFenceReceipt> {
    if (this.terminalIntents.has(this.intentKey(request))) {
      throw new FenceBindingError(
        'A removed close Intent must never install another fence',
      );
    }
    const current = this.activeFences.get(request.groupId.value);
    if (current !== undefined) {
      if (
        current.closeIntentId.equals(request.closeIntentId) &&
        current.cutoff.equals(request.cutoff)
      ) {
        return current;
      }
      throw new FenceBindingError('A different close fence is active');
    }

    const installing = this.installingFences.get(request.groupId.value);
    if (installing !== undefined) {
      if (
        installing.request.closeIntentId.equals(request.closeIntentId) &&
        installing.request.cutoff.equals(request.cutoff)
      ) {
        return installing.receipt;
      }
      throw new FenceBindingError('A different close fence is installing');
    }

    const fenceVersion =
      (this.fenceVersions.get(request.groupId.value) ?? 0) + 1;
    this.fenceVersions.set(request.groupId.value, fenceVersion);
    const admitted = [
      ...(this.inflight.get(request.groupId.value) ?? new Set()),
    ];
    const receipt = (async (): Promise<CloseFenceReceipt> => {
      await Promise.allSettled(admitted);
      const prefix = `${request.groupId.value}:`;
      const completed: CloseFenceReceipt = Object.freeze({
        kind: 'CloseFenceInstalled',
        ...request,
        context: this.context,
        fenceVersion,
        eligible: ![...this.unfinished].some((key) => key.startsWith(prefix)),
        completedAt: this.now(),
      });
      this.activeFences.set(request.groupId.value, completed);
      this.installingFences.delete(request.groupId.value);
      return completed;
    })();
    this.installingFences.set(request.groupId.value, { request, receipt });
    return receipt;
  }

  async removeFence(
    request: RemoveGroupCloseFenceRequest,
  ): Promise<CloseUnfenceReceipt> {
    await Promise.resolve();
    const key = `${request.groupId.value}:${request.closeIntentId.value}:${request.cutoff.value}:${request.fenceVersion}`;
    const replay = this.removedFences.get(key);
    if (replay !== undefined) {
      return replay;
    }

    const current = this.activeFences.get(request.groupId.value);
    if (
      current === undefined ||
      !current.closeIntentId.equals(request.closeIntentId) ||
      !current.cutoff.equals(request.cutoff) ||
      current.fenceVersion !== request.fenceVersion
    ) {
      throw new FenceBindingError('The fence removal binding is stale');
    }

    const receipt: CloseUnfenceReceipt = Object.freeze({
      kind: 'CloseFenceRemoved',
      ...request,
      context: this.context,
      completedAt: this.now(),
    });
    this.activeFences.delete(request.groupId.value);
    this.removedFences.set(key, receipt);
    this.terminalIntents.add(this.intentKey(request));
    return receipt;
  }

  fenceVersion(groupId: GroupId): number {
    return this.fenceVersions.get(groupId.value) ?? 0;
  }

  private intentKey(request: InstallGroupCloseFenceRequest): string {
    return request.closeIntentId.value;
  }
}

const groupId = GroupId.from('group-a');
const closeIntentId = CloseIntentId.from('close-intent-a');
const cutoff = instant('2026-09-21T00:00:00.000Z');
const now = (): UtcInstant => instant('2026-09-21T00:01:00.000Z');
const request = { groupId, closeIntentId, cutoff };

describe.each(['ExpenseRecording', 'Settlement'] as const)(
  '%s close fence contract',
  (context) => {
    it('fence前にadmitしたCommandのcommitを待って終了可否へ含める', async () => {
      const fake = new InMemoryCloseFenceContextFake(context, now);
      const inFlight = deferred();
      const write = fake.write(
        groupId,
        'command-before-fence',
        inFlight.promise,
        true,
      );

      const receiptPromise = fake.installFence(request);
      let receiptIssued = false;
      void receiptPromise.then(() => {
        receiptIssued = true;
      });
      await Promise.resolve();
      expect(receiptIssued).toBe(false);
      await expect(
        fake.write(groupId, 'command-after-fence', Promise.resolve(), false),
      ).rejects.toBeInstanceOf(ContextFencedError);

      inFlight.resolve();
      await write;
      await expect(receiptPromise).resolves.toMatchObject({
        context,
        eligible: false,
        fenceVersion: 1,
      });
    });

    it('fence前Commandのrollback完了後に終了可能Receiptを発行する', async () => {
      const fake = new InMemoryCloseFenceContextFake(context, now);
      const inFlight = deferred();
      const rollback = fake.write(
        groupId,
        'rolled-back-command',
        inFlight.promise,
        false,
      );
      const receiptPromise = fake.installFence(request);

      inFlight.resolve();
      await rollback;
      await expect(receiptPromise).resolves.toMatchObject({
        context,
        eligible: true,
      });
    });

    it('設置中の同一Intent再送もdrain完了まで待って同じ最終Receiptを返す', async () => {
      const fake = new InMemoryCloseFenceContextFake(context, now);
      const inFlight = deferred();
      const write = fake.write(
        groupId,
        'command-before-retry',
        inFlight.promise,
        false,
      );
      const first = fake.installFence(request);
      const retry = fake.installFence(request);
      let firstResolved = false;
      let retryResolved = false;
      void first.then(() => {
        firstResolved = true;
      });
      void retry.then(() => {
        retryResolved = true;
      });

      await Promise.resolve();
      expect({ firstResolved, retryResolved }).toEqual({
        firstResolved: false,
        retryResolved: false,
      });
      inFlight.resolve();
      await write;
      const [firstReceipt, retryReceipt] = await Promise.all([first, retry]);
      expect(retryReceipt).toBe(firstReceipt);
      expect(firstReceipt.eligible).toBe(true);
    });

    it('fence後の新規Commandを拒否し、同じIntentの設置再送は同じReceiptを返す', async () => {
      const fake = new InMemoryCloseFenceContextFake(context, now);
      const first = await fake.installFence(request);

      await expect(
        fake.write(groupId, 'command-after-fence', Promise.resolve(), false),
      ).rejects.toBeInstanceOf(ContextFencedError);
      await expect(fake.installFence(request)).resolves.toBe(first);
    });

    it('unfenceは全bindingを照合し、応答喪失後の再送へ同じReceiptを返す', async () => {
      const fake = new InMemoryCloseFenceContextFake(context, now);
      const fence = await fake.installFence(request);
      const removal = { ...request, fenceVersion: fence.fenceVersion };

      await expect(
        fake.removeFence({ ...removal, fenceVersion: fence.fenceVersion + 1 }),
      ).rejects.toBeInstanceOf(FenceBindingError);

      const removedBeforeResponseLoss = await fake.removeFence(removal);
      const replay = await fake.removeFence(removal);
      await expect(
        fake.removeFence({
          ...removal,
          cutoff: instant('2026-09-21T00:00:00.001Z'),
        }),
      ).rejects.toBeInstanceOf(FenceBindingError);
      expect(replay).toBe(removedBeforeResponseLoss);
      expect(replay).toMatchObject({
        kind: 'CloseFenceRemoved',
        groupId,
        closeIntentId,
        cutoff,
        context,
        fenceVersion: 1,
      });
    });

    it('解除済みIntentの遅延install再送を終端拒否して再fenceしない', async () => {
      const fake = new InMemoryCloseFenceContextFake(context, now);
      const fence = await fake.installFence(request);
      await fake.removeFence({ ...request, fenceVersion: fence.fenceVersion });

      await expect(fake.installFence(request)).rejects.toBeInstanceOf(
        FenceBindingError,
      );
      await expect(
        fake.installFence({
          ...request,
          cutoff: instant('2026-09-21T00:00:00.001Z'),
        }),
      ).rejects.toBeInstanceOf(FenceBindingError);
      await expect(
        fake.installFence({
          ...request,
          groupId: GroupId.from('another-group'),
        }),
      ).rejects.toBeInstanceOf(FenceBindingError);
      expect(fake.fenceVersion(groupId)).toBe(1);
      expect(fake.fenceVersion(GroupId.from('another-group'))).toBe(0);
      await expect(
        fake.write(
          groupId,
          'command-after-cancellation',
          Promise.resolve(),
          false,
        ),
      ).resolves.toBeUndefined();
    });
  },
);
