import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ActorSubject, GroupId, ParticipantId } from '../domain/group.js';
import { OperationId } from './group-repository.js';
import {
  actorAccessIndexDigestInput,
  canReadSnapshot,
  type ExclusiveMutationResult,
  type ExpectedGroupAccessPolicyVersion,
  type FixedGroupAccessPolicy,
  type GroupAccessPolicyPort,
  type GroupPolicyDigest,
  type GroupPolicyDigestPort,
  type GroupOperationLocatorKeyPort,
  type GroupOperationLocatorCandidate,
  type GroupOperationReplayPort,
  membershipDigestInput,
  operationFingerprintDigestInput,
  operationLocatorDigestInput,
  permitsNewBusinessOrAccessMutation,
  resolveOperationReplay,
  type SnapshotInvolvement,
  type SnapshotReadCallbackResult,
  type SnapshotReadResult,
} from './group-access-policy.js';

const groupId = GroupId.from('00000000-0000-4000-8000-000000000001');
const owner = ParticipantId.from('participant-owner');
const active = ParticipantId.from('participant-active');
const left = ParticipantId.from('participant-left');
const rejoined = ParticipantId.from('participant-rejoined');
const ownerSubject = ActorSubject.from('owner-subject');
const activeSubject = ActorSubject.from('active-subject');
const leftSubject = ActorSubject.from('left-subject');
const rejoinedSubject = ActorSubject.from('rejoined-subject');

const policy = (
  overrides: Partial<FixedGroupAccessPolicy> = {},
): FixedGroupAccessPolicy =>
  Object.freeze({
    groupId,
    groupVersion: 7,
    accessPolicyVersion: 3,
    status: 'Active',
    ownerParticipantId: owner,
    ownerAtArchiveParticipantId: null,
    memberships: [
      { participantId: owner, actorSubject: ownerSubject, status: 'Active' },
      { participantId: active, actorSubject: activeSubject, status: 'Active' },
      { participantId: left, actorSubject: leftSubject, status: 'Left' },
      { participantId: left, actorSubject: rejoinedSubject, status: 'Left' },
      {
        participantId: rejoined,
        actorSubject: rejoinedSubject,
        status: 'Active',
      },
    ] as FixedGroupAccessPolicy['memberships'],
    ...overrides,
  });

const involvement = (
  overrides: Partial<SnapshotInvolvement> = {},
): SnapshotInvolvement => ({
  requesterParticipantId: null,
  requiredApproverParticipantIds: [],
  paymentPayerParticipantId: null,
  paymentPayeeParticipantId: null,
  expensePayerParticipantId: null,
  allocationParticipantIds: [],
  ...overrides,
});

const digest = (bytes: readonly number[]): GroupPolicyDigest =>
  Uint8Array.from(bytes) as GroupPolicyDigest;

class FakeGroupPolicyDigestPort implements GroupPolicyDigestPort {
  readonly calls: {
    purpose: string;
    groupId: string;
    canonicalInput: Uint8Array;
  }[] = [];

  digest(input: {
    purpose: string;
    groupId: string;
    canonicalInput: Uint8Array;
  }): Promise<
    Readonly<{ digest: GroupPolicyDigest; digestKeyVersion: string }>
  > {
    this.calls.push(input);
    return Promise.resolve({
      digest: digest(
        Buffer.from(
          `${input.purpose}\u0000${input.groupId}\u0000${Buffer.from(input.canonicalInput).toString('base64')}`,
        ).toJSON().data,
      ),
      digestKeyVersion: 'fake-key-v1',
    });
  }
}

class FakeOperationLocatorKeyPort implements GroupOperationLocatorKeyPort {
  readonly calls: { purpose: string; canonicalInput: Uint8Array }[] = [];

  constructor(
    private readonly versions: readonly string[] = ['current', 'retired'],
  ) {}

  currentDigest(input: {
    purpose: 'group-operation-locator/v2';
    canonicalInput: Uint8Array;
  }): Promise<GroupOperationLocatorCandidate> {
    this.calls.push(input);
    return Promise.resolve(
      this.makeCandidate(input, this.versions[0] ?? 'current'),
    );
  }

  candidateDigests(input: {
    purpose: 'group-operation-locator/v2';
    canonicalInput: Uint8Array;
  }): Promise<
    readonly { digest: GroupPolicyDigest; digestKeyVersion: string }[]
  > {
    this.calls.push(input);
    return Promise.resolve(
      this.versions.map((version) => this.makeCandidate(input, version)),
    );
  }

  private makeCandidate(
    input: {
      purpose: 'group-operation-locator/v2';
      canonicalInput: Uint8Array;
    },
    digestKeyVersion: string,
  ): GroupOperationLocatorCandidate {
    return {
      digest: digest(
        Array.from(
          createHmac('sha256', `fake-locator-key:${digestKeyVersion}`)
            .update(input.purpose)
            .update(input.canonicalInput)
            .digest(),
        ),
      ),
      digestKeyVersion,
    };
  }
}

type Failure = 'Timeout' | 'Deadlock' | 'ConnectionLost' | null;

/** Backend-independent fake used to prove the public port's transaction semantics. */
class FakeGroupAccessPolicyPort implements GroupAccessPolicyPort {
  private callbackCallCount = 0;
  private policyDecryptCallCount = 0;
  private readonly policies = new Map<string, FixedGroupAccessPolicy>();
  private readonly actorIndex = new Map<string, string>();
  private readonly membershipIndex = new Set<string>();
  private failure: Failure = null;
  private changeBeforeReturn = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly digestPort: GroupPolicyDigestPort,
    initial: FixedGroupAccessPolicy,
  ) {
    this.policies.set(initial.groupId.value, initial);
  }

  async seedActorAccessIndex(initial: FixedGroupAccessPolicy): Promise<void> {
    for (const membership of initial.memberships) {
      this.actorIndex.set(
        await this.actorIndexKey(initial.groupId, membership.actorSubject),
        initial.groupId.value,
      );
      this.membershipIndex.add(
        await this.membershipIndexKey(
          initial.groupId,
          membership.participantId,
        ),
      );
    }
  }

  failNext(failure: Exclude<Failure, null>): void {
    this.failure = failure;
  }

  changeVersionBeforeReturn(): void {
    this.changeBeforeReturn = true;
  }

  current(): FixedGroupAccessPolicy {
    return this.policies.get(groupId.value) as FixedGroupAccessPolicy;
  }

  get callbackCalls(): number {
    return this.callbackCallCount;
  }

  get policyDecryptCalls(): number {
    return this.policyDecryptCallCount;
  }

  async withSnapshotRead<T>(input: {
    groupId: GroupId;
    actorSubject: ActorSubject;
    callback: (access: {
      groupVersion: number;
      accessPolicyVersion: number;
      canReadSnapshot: (input: SnapshotInvolvement) => boolean;
    }) => Promise<SnapshotReadCallbackResult<T>>;
  }): Promise<SnapshotReadResult<T>> {
    const indexedGroupId = this.actorIndex.get(
      await this.actorIndexKey(input.groupId, input.actorSubject),
    );
    if (indexedGroupId !== input.groupId.value) {
      return { kind: 'Unavailable' };
    }
    const current = this.decryptPolicy(indexedGroupId);
    if (current === undefined) {
      return { kind: 'Unavailable' };
    }
    if (this.takeFailure()) {
      return { kind: 'Unavailable' };
    }

    const fixedGroupVersion = current.groupVersion;
    const fixedAccessPolicyVersion = current.accessPolicyVersion;
    let callback: SnapshotReadCallbackResult<T>;
    try {
      this.callbackCallCount += 1;
      callback = await input.callback({
        groupVersion: fixedGroupVersion,
        accessPolicyVersion: fixedAccessPolicyVersion,
        canReadSnapshot: (snapshot) =>
          canReadSnapshot(current, input.actorSubject, snapshot),
      });
    } catch {
      return { kind: 'Unavailable' };
    }
    if (this.changeBeforeReturn) {
      this.changeBeforeReturn = false;
      this.policies.set(current.groupId.value, {
        ...current,
        accessPolicyVersion: current.accessPolicyVersion + 1,
      });
    }
    const returned = this.policies.get(current.groupId.value);
    if (
      this.takeFailure() ||
      returned?.groupVersion !== fixedGroupVersion ||
      returned.accessPolicyVersion !== fixedAccessPolicyVersion ||
      callback.kind === 'Denied' ||
      !canReadSnapshot(current, input.actorSubject, callback.involvement)
    ) {
      return { kind: 'Unavailable' };
    }
    return { kind: 'Allowed', value: callback.value };
  }

  async withExclusiveMutation<T>(input: {
    expectedPolicies: readonly ExpectedGroupAccessPolicyVersion[];
    callback: (
      policies: readonly FixedGroupAccessPolicy[],
    ) => Promise<ExclusiveMutationResult<T>>;
  }): Promise<SnapshotReadResult<T>> {
    let release: () => void = () => undefined;
    const previous = this.mutationQueue;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.mutateExclusively(input);
    } finally {
      release();
    }
  }

  private async mutateExclusively<T>(input: {
    expectedPolicies: readonly ExpectedGroupAccessPolicyVersion[];
    callback: (
      policies: readonly FixedGroupAccessPolicy[],
    ) => Promise<ExclusiveMutationResult<T>>;
  }): Promise<SnapshotReadResult<T>> {
    const values = input.expectedPolicies.map(({ groupId: id }) => id.value);
    if (
      values.length === 0 ||
      values.some((value, index) => index > 0 && values[index - 1] >= value)
    ) {
      return { kind: 'Unavailable' };
    }
    const policies = input.expectedPolicies.map(({ groupId: id }) =>
      this.policies.get(id.value),
    );
    const fixed = policies.filter(
      (candidate): candidate is FixedGroupAccessPolicy =>
        candidate !== undefined,
    );
    if (
      fixed.length !== policies.length ||
      fixed.some(
        (current, index) =>
          current.groupVersion !==
            input.expectedPolicies[index]?.groupVersion ||
          current.accessPolicyVersion !==
            input.expectedPolicies[index]?.accessPolicyVersion,
      ) ||
      fixed.some(
        (candidate) => !permitsNewBusinessOrAccessMutation(candidate),
      ) ||
      this.takeFailure()
    ) {
      return { kind: 'Unavailable' };
    }
    try {
      const result = await input.callback(fixed);
      if (
        fixed.some(
          (current) =>
            result.nextGroupVersion <= current.groupVersion ||
            result.nextAccessPolicyVersion <= current.accessPolicyVersion,
        )
      ) {
        return { kind: 'Unavailable' };
      }
      for (const current of fixed) {
        this.policies.set(current.groupId.value, {
          ...current,
          groupVersion: result.nextGroupVersion,
          accessPolicyVersion: result.nextAccessPolicyVersion,
        });
      }
      return { kind: 'Allowed', value: result.value };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  private takeFailure(): boolean {
    const failure = this.failure;
    this.failure = null;
    return failure !== null;
  }

  private decryptPolicy(groupKey: string): FixedGroupAccessPolicy | undefined {
    this.policyDecryptCallCount += 1;
    return this.policies.get(groupKey);
  }

  private async actorIndexKey(
    indexedGroupId: GroupId,
    actorSubject: ActorSubject,
  ): Promise<string> {
    const indexed = await this.digestPort.digest(
      actorAccessIndexDigestInput(indexedGroupId, actorSubject),
    );
    return Buffer.from(indexed.digest).toString('base64');
  }

  private async membershipIndexKey(
    indexedGroupId: GroupId,
    participantId: ParticipantId,
  ): Promise<string> {
    const indexed = await this.digestPort.digest(
      membershipDigestInput(indexedGroupId, participantId),
    );
    return Buffer.from(indexed.digest).toString('base64');
  }
}

class FakeOperationReplayIndex<T> implements GroupOperationReplayPort<T> {
  decryptCalls = 0;
  dataKeyReads = 0;
  private readonly records = new Map<
    string,
    { fingerprint: GroupPolicyDigest; result: T }
  >();

  constructor(
    locator: GroupOperationLocatorCandidate | null,
    record: {
      fingerprint: GroupPolicyDigest;
      result: T;
    } | null,
  ) {
    if (locator !== null && record !== null) {
      this.records.set(this.key(locator), record);
    }
  }

  findOperation(input: {
    locatorCandidates: readonly {
      digest: GroupPolicyDigest;
      digestKeyVersion: string;
    }[];
  }): Promise<
    | { kind: 'Missing' }
    | { kind: 'Found'; record: { fingerprint: GroupPolicyDigest; result: T } }
  > {
    expect(input.locatorCandidates.length).toBeGreaterThan(0);
    const record = input.locatorCandidates
      .map((candidate) => this.records.get(this.key(candidate)))
      .find((candidate) => candidate !== undefined);
    if (record === undefined) {
      return Promise.resolve({ kind: 'Missing' });
    }
    this.dataKeyReads += 1;
    this.decryptCalls += 1;
    return Promise.resolve({ kind: 'Found', record });
  }

  private key(locator: GroupOperationLocatorCandidate): string {
    return `${locator.digestKeyVersion}:${Buffer.from(locator.digest).toString('base64')}`;
  }
}

const fakePolicyPort = async (
  initial: FixedGroupAccessPolicy = policy(),
): Promise<{
  digestPort: FakeGroupPolicyDigestPort;
  port: FakeGroupAccessPolicyPort;
}> => {
  const digestPort = new FakeGroupPolicyDigestPort();
  const port = new FakeGroupAccessPolicyPort(digestPort, initial);
  await port.seedActorAccessIndex(initial);
  return { digestPort, port };
};

describe('Group access policy digest contract', () => {
  it('用途ごとにversioned Canonical TLVを分離し、区切り文字の曖昧さを作らない', () => {
    const actor = actorAccessIndexDigestInput(
      groupId,
      ActorSubject.from('a:b'),
    );
    const membership = membershipDigestInput(groupId, active);
    const locator = operationLocatorDigestInput(
      ActorSubject.from('a'),
      OperationId.from('b:c'),
    );
    const fingerprint = operationFingerprintDigestInput(
      groupId,
      'InviteParticipant',
      'target=participant-b',
    );

    expect([
      actor.purpose,
      membership.purpose,
      locator.purpose,
      fingerprint.purpose,
    ]).toEqual([
      'group-actor-access-index/v1',
      'group-membership-index/v1',
      'group-operation-locator/v2',
      'group-operation-fingerprint/v1',
    ]);
    expect(actor.canonicalInput).not.toEqual(locator.canonicalInput);
    expect(locator.canonicalInput).toEqual(
      operationLocatorDigestInput(
        ActorSubject.from('a'),
        OperationId.from('b:c'),
      ).canonicalInput,
    );
    expect(
      operationLocatorDigestInput(
        ActorSubject.from('a:b'),
        OperationId.from('c'),
      ).canonicalInput,
    ).not.toEqual(
      operationLocatorDigestInput(
        ActorSubject.from('a'),
        OperationId.from('b:c'),
      ).canonicalInput,
    );
  });
});

describe('Group access policy matrix', () => {
  it('Owner、Active、Left、Rejoined、非在籍者を各Participant IDで評価する', () => {
    const current = policy();
    expect(canReadSnapshot(current, ownerSubject, involvement())).toBe(true);
    expect(
      canReadSnapshot(
        current,
        activeSubject,
        involvement({ allocationParticipantIds: [active] }),
      ),
    ).toBe(true);
    expect(canReadSnapshot(current, activeSubject, involvement())).toBe(false);
    expect(
      canReadSnapshot(
        current,
        leftSubject,
        involvement({ paymentPayeeParticipantId: left }),
      ),
    ).toBe(true);
    expect(
      canReadSnapshot(
        current,
        leftSubject,
        involvement({ expensePayerParticipantId: left }),
      ),
    ).toBe(false);
    expect(
      canReadSnapshot(
        current,
        rejoinedSubject,
        involvement({ expensePayerParticipantId: left }),
      ),
    ).toBe(false);
    expect(
      canReadSnapshot(
        current,
        rejoinedSubject,
        involvement({ expensePayerParticipantId: rejoined }),
      ),
    ).toBe(true);
    expect(
      canReadSnapshot(current, ActorSubject.from('nonmember'), involvement()),
    ).toBe(false);
  });

  it('Closingは既存matrixのreadだけを保ち、Archive後はowner-at-archiveだけを許可する', () => {
    const closing = policy({ status: 'Closing' });
    expect(
      canReadSnapshot(
        closing,
        activeSubject,
        involvement({ requesterParticipantId: active }),
      ),
    ).toBe(true);
    expect(permitsNewBusinessOrAccessMutation(closing)).toBe(false);

    const archived = policy({
      status: 'Archived',
      ownerParticipantId: null,
      ownerAtArchiveParticipantId: owner,
    });
    expect(canReadSnapshot(archived, ownerSubject, involvement())).toBe(true);
    expect(canReadSnapshot(archived, activeSubject, involvement())).toBe(false);
  });
});

describe('GroupAccessPolicyPort fake contract', () => {
  it('actor index missを存在非開示で拒否し、callback/decryptを0回にする', async () => {
    const { digestPort, port: fake } = await fakePolicyPort();

    await expect(
      fake.withSnapshotRead({
        groupId,
        actorSubject: ActorSubject.from('nonmember'),
        callback: () =>
          Promise.resolve({
            kind: 'Allowed',
            value: 'payload',
            involvement: involvement(),
          }),
      }),
    ).resolves.toEqual({ kind: 'Unavailable' });
    expect(fake.callbackCalls).toBe(0);
    expect(fake.policyDecryptCalls).toBe(0);
    await expect(
      fake.withSnapshotRead({
        groupId: GroupId.from('00000000-0000-4000-8000-000000000007'),
        actorSubject: activeSubject,
        callback: () =>
          Promise.resolve({
            kind: 'Allowed',
            value: 'payload',
            involvement: involvement(),
          }),
      }),
    ).resolves.toEqual({ kind: 'Unavailable' });
    expect(fake.callbackCalls).toBe(0);
    expect(fake.policyDecryptCalls).toBe(0);
    expect(digestPort.calls.at(-1)?.purpose).toBe(
      'group-actor-access-index/v1',
    );
    expect(digestPort.calls.map(({ purpose }) => purpose)).toContain(
      'group-membership-index/v1',
    );
  });

  it('callbackが提示した関与をPort自身が再検証し、許可されたpayloadだけを返す', async () => {
    const { port: fake } = await fakePolicyPort();
    await expect(
      fake.withSnapshotRead({
        groupId,
        actorSubject: activeSubject,
        callback: () =>
          Promise.resolve({
            kind: 'Allowed',
            value: 'permitted',
            involvement: involvement({ requesterParticipantId: active }),
          }),
      }),
    ).resolves.toEqual({ kind: 'Allowed', value: 'permitted' });
    await expect(
      fake.withSnapshotRead({
        groupId,
        actorSubject: activeSubject,
        callback: () =>
          Promise.resolve({
            kind: 'Allowed',
            value: 'must not escape',
            involvement: involvement(),
          }),
      }),
    ).resolves.toEqual({ kind: 'Unavailable' });
  });

  it.each(['Timeout', 'Deadlock', 'ConnectionLost'] as const)(
    '%s、callback例外、return直前version変更をpayloadなしのUnavailableへfail closedする',
    async (failure) => {
      const { port: fake } = await fakePolicyPort();
      fake.failNext(failure);
      await expect(
        fake.withSnapshotRead({
          groupId,
          actorSubject: activeSubject,
          callback: () =>
            Promise.resolve({
              kind: 'Allowed',
              value: 'payload',
              involvement: involvement({ requesterParticipantId: active }),
            }),
        }),
      ).resolves.toEqual({ kind: 'Unavailable' });

      await expect(
        fake.withSnapshotRead({
          groupId,
          actorSubject: activeSubject,
          callback: () => Promise.reject(new Error('callback failed')),
        }),
      ).resolves.toEqual({ kind: 'Unavailable' });

      fake.changeVersionBeforeReturn();
      await expect(
        fake.withSnapshotRead({
          groupId,
          actorSubject: activeSubject,
          callback: () =>
            Promise.resolve({
              kind: 'Allowed',
              value: 'payload',
              involvement: involvement({ requesterParticipantId: active }),
            }),
        }),
      ).resolves.toEqual({ kind: 'Unavailable' });
    },
  );

  it('排他mutationは昇順lock orderとpolicy version増加を要求し、失敗時はrollbackする', async () => {
    const { port: fake } = await fakePolicyPort();
    await expect(
      fake.withExclusiveMutation({
        expectedPolicies: [
          {
            groupId: GroupId.from('00000000-0000-4000-8000-000000000005'),
            groupVersion: 7,
            accessPolicyVersion: 3,
          },
          { groupId, groupVersion: 7, accessPolicyVersion: 3 },
        ],
        callback: () =>
          Promise.resolve({
            value: 'not used',
            nextGroupVersion: 8,
            nextAccessPolicyVersion: 4,
          }),
      }),
    ).resolves.toEqual({ kind: 'Unavailable' });

    await expect(
      fake.withExclusiveMutation({
        expectedPolicies: [
          { groupId, groupVersion: 7, accessPolicyVersion: 3 },
        ],
        callback: ([current]) =>
          Promise.resolve({
            value: 'committed',
            nextGroupVersion: current.groupVersion + 1,
            nextAccessPolicyVersion: current.accessPolicyVersion + 1,
          }),
      }),
    ).resolves.toEqual({ kind: 'Allowed', value: 'committed' });
    expect(fake.current().accessPolicyVersion).toBe(4);

    const before = fake.current();
    await expect(
      fake.withExclusiveMutation({
        expectedPolicies: [
          { groupId, groupVersion: 8, accessPolicyVersion: 4 },
        ],
        callback: () => Promise.reject(new Error('rollback')),
      }),
    ).resolves.toEqual({ kind: 'Unavailable' });
    expect(fake.current()).toEqual(before);
  });

  it('同一Groupの並行mutationは最初のcommitだけを許可し、古いversionをrollbackする', async () => {
    const { port: fake } = await fakePolicyPort();
    let releaseFirst: () => void = () => undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = fake.withExclusiveMutation({
      expectedPolicies: [{ groupId, groupVersion: 7, accessPolicyVersion: 3 }],
      callback: async ([current]) => {
        await firstCanFinish;
        return {
          value: 'first',
          nextGroupVersion: current.groupVersion + 1,
          nextAccessPolicyVersion: current.accessPolicyVersion + 1,
        };
      },
    });
    const second = fake.withExclusiveMutation({
      expectedPolicies: [{ groupId, groupVersion: 7, accessPolicyVersion: 3 }],
      callback: ([current]) =>
        Promise.resolve({
          value: 'second',
          nextGroupVersion: current.groupVersion + 1,
          nextAccessPolicyVersion: current.accessPolicyVersion + 1,
        }),
    });

    releaseFirst();
    await expect(first).resolves.toEqual({ kind: 'Allowed', value: 'first' });
    await expect(second).resolves.toEqual({ kind: 'Unavailable' });
    expect(fake.current()).toMatchObject({
      groupVersion: 8,
      accessPolicyVersion: 4,
    });
  });
});

describe('operation replay contract', () => {
  it('index missではdecryptせず、同じlocatorの完全一致fingerprintだけをreplayする', async () => {
    const digestPort = new FakeGroupPolicyDigestPort();
    const locatorKeyPort = new FakeOperationLocatorKeyPort();
    const locator = await locatorKeyPort.candidateDigests(
      operationLocatorDigestInput(
        ActorSubject.from('actor-a'),
        OperationId.from('operation-a'),
      ),
    );
    const stored = (
      await digestPort.digest(
        operationFingerprintDigestInput(
          groupId,
          'InviteParticipant',
          'target=participant-a',
        ),
      )
    ).digest;
    const missing = new FakeOperationReplayIndex<string>(null, null);
    expect(
      resolveOperationReplay(
        await missing.findOperation({ locatorCandidates: locator }),
        stored,
      ),
    ).toEqual({ kind: 'Execute' });
    expect(missing.decryptCalls).toBe(0);
    expect(missing.dataKeyReads).toBe(0);

    const found = new FakeOperationReplayIndex(locator[0] ?? null, {
      fingerprint: stored,
      result: 'result-a',
    });
    expect(
      resolveOperationReplay(
        await found.findOperation({ locatorCandidates: locator }),
        stored,
      ),
    ).toEqual({ kind: 'Replay', result: 'result-a' });
    expect(found.decryptCalls).toBe(1);
    expect(found.dataKeyReads).toBe(1);
    const otherActorLocator = await locatorKeyPort.candidateDigests(
      operationLocatorDigestInput(
        ActorSubject.from('actor-b'),
        OperationId.from('operation-a'),
      ),
    );
    const otherOperationLocator = await locatorKeyPort.candidateDigests(
      operationLocatorDigestInput(
        ActorSubject.from('actor-a'),
        OperationId.from('operation-b'),
      ),
    );
    await expect(
      found.findOperation({ locatorCandidates: otherActorLocator }),
    ).resolves.toEqual({ kind: 'Missing' });
    await expect(
      found.findOperation({ locatorCandidates: otherOperationLocator }),
    ).resolves.toEqual({ kind: 'Missing' });
    expect(found.decryptCalls).toBe(1);
    expect(found.dataKeyReads).toBe(1);
    expect(
      resolveOperationReplay(
        { kind: 'Found', record: { fingerprint: stored, result: 'result-a' } },
        (
          await digestPort.digest(
            operationFingerprintDigestInput(
              groupId,
              'InviteParticipant',
              'target=participant-b',
            ),
          )
        ).digest,
      ),
    ).toEqual({ kind: 'Mismatch', alert: 'OperationFingerprintMismatch' });
    expect(locatorKeyPort.calls.map(({ purpose }) => purpose)).toContain(
      'group-operation-locator/v2',
    );
    expect(digestPort.calls.map(({ purpose }) => purpose)).toContain(
      'group-operation-fingerprint/v1',
    );
  });

  it('current keyだけを新規書込みに使い、retired keyの結果はread candidateで再送照合する', async () => {
    const keyPort = new FakeOperationLocatorKeyPort();
    const input = operationLocatorDigestInput(
      ActorSubject.from('actor-a'),
      OperationId.from('create-group-a'),
    );
    const current = await keyPort.currentDigest(input);
    const candidates = await keyPort.candidateDigests(input);
    expect(current).toEqual(candidates[0]);
    expect(candidates.map(({ digestKeyVersion }) => digestKeyVersion)).toEqual([
      'current',
      'retired',
    ]);
    expect(candidates[0]?.digest).not.toEqual(candidates[1]?.digest);

    const fingerprint = digest([1, 2, 3]);
    const replay = new FakeOperationReplayIndex(candidates[1] ?? null, {
      fingerprint,
      result: 'existing-group',
    });
    expect(
      resolveOperationReplay(
        await replay.findOperation({ locatorCandidates: candidates }),
        fingerprint,
      ),
    ).toEqual({ kind: 'Replay', result: 'existing-group' });
    expect(replay.dataKeyReads).toBe(1);
    expect(replay.decryptCalls).toBe(1);

    const missing = new FakeOperationReplayIndex<string>(null, null);
    await expect(
      missing.findOperation({ locatorCandidates: candidates }),
    ).resolves.toEqual({ kind: 'Missing' });
    expect(missing.dataKeyReads).toBe(0);
    expect(missing.decryptCalls).toBe(0);
  });
});
