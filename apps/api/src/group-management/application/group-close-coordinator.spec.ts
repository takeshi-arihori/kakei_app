import { describe, expect, it, vi } from 'vitest';

import {
  ActorSubject,
  CloseIntentId,
  GroupId,
  UtcInstant,
  type CloseFenceReceipt,
  type GroupCloseContext,
} from '../domain/group.js';
import {
  GroupCommandApplicationError,
  type ReserveGroupClosingCancellationCommand,
} from './group-command-service.js';
import {
  GroupCloseCoordinationError,
  GroupCloseCoordinator,
  type GroupClosingCancellationReservationPort,
} from './group-close-coordinator.js';
import type { GroupCloseContextPort } from './group-close-context-port.js';
import { OperationId } from './group-repository.js';

const instant = (value: string): UtcInstant => UtcInstant.from(new Date(value));
const groupId = GroupId.from('00000000-0000-4000-8000-000000000001');
const closeIntentId = CloseIntentId.from(
  '00000000-0000-4000-8000-0000000000a1',
);
const cutoff = instant('2026-09-21T00:00:00.000Z');

const reservationCommand: ReserveGroupClosingCancellationCommand = {
  actorSubject: ActorSubject.from('owner-subject'),
  operationId: OperationId.from('cancel-reservation'),
  groupId,
  closeIntentId,
  expectedVersion: 4,
};

const fenceReceipt = (
  context: GroupCloseContext,
  overrides: Partial<CloseFenceReceipt> = {},
): CloseFenceReceipt => ({
  kind: 'CloseFenceInstalled',
  groupId,
  closeIntentId,
  cutoff,
  context,
  fenceVersion: context === 'ExpenseRecording' ? 3 : 7,
  eligible: true,
  completedAt: instant('2026-09-21T00:01:00.000Z'),
  ...overrides,
});

const contextPort = (
  context: GroupCloseContext,
  phase: () => 'Fencing' | 'Canceling' | 'Archived',
) => {
  const removeFence = vi.fn<GroupCloseContextPort['removeFence']>(
    async (request) => {
      await Promise.resolve();
      expect(phase()).toBe('Canceling');
      return {
        kind: 'CloseFenceRemoved',
        ...request,
        context,
        completedAt: instant('2026-09-21T00:02:00.000Z'),
      };
    },
  );
  const port: GroupCloseContextPort = {
    context,
    installFence: vi.fn(),
    removeFence,
  };
  return { port, removeFence };
};

describe('GroupCloseCoordinator', () => {
  it('Archive先勝ちのCAS conflictではunfenceを一度も呼ばない', async () => {
    const phase: 'Fencing' | 'Archived' = 'Archived';
    const reservationPort: GroupClosingCancellationReservationPort = {
      reserveGroupClosingCancellation: vi.fn<
        GroupClosingCancellationReservationPort['reserveGroupClosingCancellation']
      >(async () => {
        await Promise.resolve();
        throw new GroupCommandApplicationError(
          'CONFLICT',
          'Archive committed first',
        );
      }),
    };
    const expense = contextPort('ExpenseRecording', () => phase);
    const settlement = contextPort('Settlement', () => phase);
    const coordinator = new GroupCloseCoordinator(reservationPort, [
      expense.port,
      settlement.port,
    ]);

    await expect(
      coordinator.reserveAndRemoveFences({
        reservationCommand,
        fenceReceipts: [
          fenceReceipt('ExpenseRecording'),
          fenceReceipt('Settlement'),
        ],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(expense.removeFence).not.toHaveBeenCalled();
    expect(settlement.removeFence).not.toHaveBeenCalled();
    expect(phase).toBe('Archived');
  });

  it('取消予約先勝ちではCAS後だけunfenceし、以後のArchiveを拒否する', async () => {
    let phase: 'Fencing' | 'Canceling' = 'Fencing';
    const reservationPort: GroupClosingCancellationReservationPort = {
      reserveGroupClosingCancellation: vi.fn<
        GroupClosingCancellationReservationPort['reserveGroupClosingCancellation']
      >(async () => {
        await Promise.resolve();
        phase = 'Canceling';
        return {
          kind: 'GroupClosingCancellationReserved',
          groupId,
          closeIntentId,
          version: 5,
        };
      }),
    };
    const expense = contextPort('ExpenseRecording', () => phase);
    const settlement = contextPort('Settlement', () => phase);
    const coordinator = new GroupCloseCoordinator(reservationPort, [
      expense.port,
      settlement.port,
    ]);

    const result = await coordinator.reserveAndRemoveFences({
      reservationCommand,
      fenceReceipts: [
        fenceReceipt('ExpenseRecording'),
        fenceReceipt('Settlement'),
      ],
    });

    expect(result.reservation.version).toBe(5);
    expect(expense.removeFence).toHaveBeenCalledOnce();
    expect(settlement.removeFence).toHaveBeenCalledOnce();
    const archive = (): never => {
      if (phase === 'Canceling') {
        throw new Error('Archive rejects Canceling');
      }
      throw new Error('Unexpected phase');
    };
    expect(archive).toThrow('Archive rejects Canceling');
  });

  it('Receiptの別Group／cutoffではCASもunfenceも呼ばない', async () => {
    const phase = 'Fencing' as const;
    const reserveGroupClosingCancellation = vi.fn();
    const reservationPort: GroupClosingCancellationReservationPort = {
      reserveGroupClosingCancellation,
    };
    const expense = contextPort('ExpenseRecording', () => phase);
    const settlement = contextPort('Settlement', () => phase);
    const coordinator = new GroupCloseCoordinator(reservationPort, [
      expense.port,
      settlement.port,
    ]);

    await expect(
      coordinator.reserveAndRemoveFences({
        reservationCommand,
        fenceReceipts: [
          fenceReceipt('ExpenseRecording'),
          fenceReceipt('Settlement', {
            groupId: GroupId.from('00000000-0000-4000-8000-00000000000a'),
          }),
        ],
      }),
    ).rejects.toBeInstanceOf(GroupCloseCoordinationError);
    await expect(
      coordinator.reserveAndRemoveFences({
        reservationCommand,
        fenceReceipts: [
          fenceReceipt('ExpenseRecording'),
          fenceReceipt('Settlement', {
            cutoff: instant('2026-09-21T00:00:00.001Z'),
          }),
        ],
      }),
    ).rejects.toBeInstanceOf(GroupCloseCoordinationError);
    expect(reserveGroupClosingCancellation).not.toHaveBeenCalled();
    expect(expense.removeFence).not.toHaveBeenCalled();
    expect(settlement.removeFence).not.toHaveBeenCalled();
    expect(phase).toBe('Fencing');
  });
});
