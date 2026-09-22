import type {
  CloseFenceReceipt,
  CloseUnfenceReceipt,
  GroupCloseContext,
} from '../domain/group.js';
import type { GroupClosingCancellationReservedResult } from './group-repository.js';
import type { ReserveGroupClosingCancellationCommand } from './group-command-service.js';
import type { GroupCloseContextPort } from './group-close-context-port.js';

export interface GroupClosingCancellationReservationPort {
  reserveGroupClosingCancellation(
    command: ReserveGroupClosingCancellationCommand,
  ): Promise<GroupClosingCancellationReservedResult>;
}

export type CancelGroupClosingFencesInput = Readonly<{
  reservationCommand: ReserveGroupClosingCancellationCommand;
  fenceReceipts: readonly CloseFenceReceipt[];
}>;

export type CancelGroupClosingFencesResult = Readonly<{
  reservation: GroupClosingCancellationReservedResult;
  unfenceReceipts: readonly CloseUnfenceReceipt[];
}>;

export class GroupCloseCoordinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroupCloseCoordinationError';
  }
}

/**
 * This Application coordinator is the single ordering boundary for unfence:
 * the Group CAS reservation must commit before any Context Port is invoked.
 */
export class GroupCloseCoordinator {
  private readonly ports: ReadonlyMap<GroupCloseContext, GroupCloseContextPort>;

  constructor(
    private readonly reservationPort: GroupClosingCancellationReservationPort,
    contextPorts: readonly GroupCloseContextPort[],
  ) {
    this.ports = new Map(contextPorts.map((port) => [port.context, port]));
    if (
      this.ports.size !== 2 ||
      !this.ports.has('ExpenseRecording') ||
      !this.ports.has('Settlement')
    ) {
      throw new GroupCloseCoordinationError(
        'Both distinct Group close Context Ports are required',
      );
    }
  }

  async reserveAndRemoveFences(
    input: CancelGroupClosingFencesInput,
  ): Promise<CancelGroupClosingFencesResult> {
    const receipts = this.validateFenceReceipts(input);

    // Do not move this CAS below a Port call: Archive-first must unfence zero Contexts.
    const reservation =
      await this.reservationPort.reserveGroupClosingCancellation(
        input.reservationCommand,
      );

    const unfenceReceipts = await Promise.all(
      (['ExpenseRecording', 'Settlement'] as const).map((context) => {
        const receipt = receipts.get(context);
        const port = this.ports.get(context);
        if (receipt === undefined || port === undefined) {
          throw new GroupCloseCoordinationError(
            `Missing ${context} fence Receipt or Port`,
          );
        }
        return port.removeFence({
          groupId: receipt.groupId,
          closeIntentId: receipt.closeIntentId,
          cutoff: receipt.cutoff,
          fenceVersion: receipt.fenceVersion,
        });
      }),
    );

    return Object.freeze({ reservation, unfenceReceipts });
  }

  private validateFenceReceipts(
    input: CancelGroupClosingFencesInput,
  ): ReadonlyMap<GroupCloseContext, CloseFenceReceipt> {
    const receipts = new Map(
      input.fenceReceipts.map((receipt) => [receipt.context, receipt]),
    );
    if (
      receipts.size !== 2 ||
      !receipts.has('ExpenseRecording') ||
      !receipts.has('Settlement')
    ) {
      throw new GroupCloseCoordinationError(
        'Both distinct Context fence Receipts are required before unfence',
      );
    }

    if (
      new Set([...receipts.values()].map((receipt) => receipt.cutoff.value))
        .size !== 1
    ) {
      throw new GroupCloseCoordinationError(
        'Both Context fence Receipts must use the same close cutoff',
      );
    }

    for (const receipt of receipts.values()) {
      if (
        !receipt.groupId.equals(input.reservationCommand.groupId) ||
        !receipt.closeIntentId.equals(input.reservationCommand.closeIntentId)
      ) {
        throw new GroupCloseCoordinationError(
          'Every fence Receipt must match the reserved Group and close Intent',
        );
      }
    }

    return receipts;
  }
}
