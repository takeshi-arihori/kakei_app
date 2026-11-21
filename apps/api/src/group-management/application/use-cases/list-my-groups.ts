import type {
  ActorSubject,
  Group,
  GroupId,
  ParticipantSnapshot,
  UtcInstant,
} from '../../domain/group.js';
import type {
  MyGroupListIntegrityAlertPort,
  MyGroupListReadPort,
} from '../my-group-list-read-port.js';

/** 一覧で返す最大件数（#305 論点2）。続きの取得は提供しない。 */
export const MY_GROUP_LIST_LIMIT = 50;

export type MyGroupLifecycle = 'Active' | 'Closing' | 'Canceling' | 'Archived';
export type MyGroupRole = 'Owner' | 'Participant';

export type MyGroupSummary = Readonly<{
  groupId: GroupId;
  lifecycle: MyGroupLifecycle;
  myRole: MyGroupRole;
  activeParticipantCount: number;
  /** joinOrder 1の参加者の参加時刻。`Group.create`が作成時刻を入れる。 */
  createdAt: UtcInstant;
  /** 一覧の対象になった自分のParticipantの参加時刻。 */
  joinedAt: UtcInstant;
  deleteEligibleAt: UtcInstant | null;
}>;

export type MyGroupList = Readonly<{
  items: readonly MyGroupSummary[];
  hasMore: boolean;
}>;

export type ListMyGroupsQuery = Readonly<{ actorSubject: ActorSubject }>;

export type MyGroupListApplicationErrorCode = 'UNAVAILABLE';

export class MyGroupListApplicationError extends Error {
  constructor(
    readonly code: MyGroupListApplicationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MyGroupListApplicationError';
  }
}

const unavailable = (message: string, cause?: unknown) =>
  new MyGroupListApplicationError(
    'UNAVAILABLE',
    message,
    cause === undefined ? undefined : { cause },
  );

/**
 * 現在Groupを参照できるActorの対象Participantを返す（#305 論点3）。
 * Archived以外は自分のActive Participant、ArchivedはownerAtArchiveだけ。
 * Leftの旧Participantは対象にしない。
 */
const viewerParticipant = (
  group: Group,
  actorSubject: ActorSubject,
): ParticipantSnapshot | null => {
  if (group.status === 'Archived') {
    const ownerAtArchive = group.ownerAtArchiveParticipantId;
    return (
      group.participants.find(
        ({ id, subject }) =>
          ownerAtArchive !== null &&
          id.equals(ownerAtArchive) &&
          subject.equals(actorSubject),
      ) ?? null
    );
  }
  return (
    group.participants.find(
      ({ status, subject }) =>
        status === 'Active' && subject.equals(actorSubject),
    ) ?? null
  );
};

const lifecycleOf = (group: Group): MyGroupLifecycle => {
  if (group.status === 'Closing') {
    return group.closing?.phase === 'Canceling' ? 'Canceling' : 'Closing';
  }
  return group.status;
};

const roleOf = (group: Group, viewer: ParticipantSnapshot): MyGroupRole => {
  if (group.status === 'Archived') {
    return 'Owner';
  }
  const ownerParticipantId = group.ownerParticipantId;
  return ownerParticipantId !== null && viewer.id.equals(ownerParticipantId)
    ? 'Owner'
    : 'Participant';
};

const createdAtOf = (group: Group): UtcInstant => {
  const creator = group.participants.find(({ joinOrder }) => joinOrder === 1);
  if (creator === undefined) {
    throw unavailable('The Group has no Participant with join order 1');
  }
  return creator.joinedAt;
};

const summarize = (group: Group, viewer: ParticipantSnapshot): MyGroupSummary =>
  Object.freeze({
    groupId: group.id,
    lifecycle: lifecycleOf(group),
    myRole: roleOf(group, viewer),
    activeParticipantCount: group.activeParticipantCount,
    createdAt: createdAtOf(group),
    joinedAt: viewer.joinedAt,
    deleteEligibleAt:
      group.status === 'Archived' ? group.deleteEligibleAt : null,
  });

const newestFirst = (left: MyGroupSummary, right: MyGroupSummary): number => {
  if (right.createdAt.isBefore(left.createdAt)) {
    return -1;
  }
  if (left.createdAt.isBefore(right.createdAt)) {
    return 1;
  }
  if (left.groupId.value === right.groupId.value) {
    return 0;
  }
  return left.groupId.value < right.groupId.value ? -1 : 1;
};

/**
 * 自分のGroup一覧のQuery Use Case（#308）。読取Portが固定版で返した候補を
 * 現在状態で再認可し、否となった候補は除外して通知する。障害と契約違反は
 * 一部だけ返さず一覧全体を`UNAVAILABLE`にする。
 */
export class MyGroupQueryService {
  constructor(
    private readonly readPort: MyGroupListReadPort,
    private readonly alertPort: MyGroupListIntegrityAlertPort,
  ) {}

  async listMyGroups(query: ListMyGroupsQuery): Promise<MyGroupList> {
    try {
      return await this.list(query.actorSubject);
    } catch (error) {
      if (error instanceof MyGroupListApplicationError) {
        throw error;
      }
      throw unavailable('The Group list could not be read', error);
    }
  }

  private async list(actorSubject: ActorSubject): Promise<MyGroupList> {
    const candidateLimit = MY_GROUP_LIST_LIMIT + 1;
    const result = await this.readPort.readCandidates({
      actorSubject,
      limit: candidateLimit,
    });
    if (result.kind !== 'Read') {
      throw unavailable('The Group list read port is unavailable');
    }
    const candidates = result.groups;
    if (candidates.length > candidateLimit) {
      throw unavailable(
        'The read port returned more candidates than requested',
      );
    }
    const groupIds = new Set(candidates.map(({ id }) => id.value));
    if (groupIds.size !== candidates.length) {
      throw unavailable('The read port returned a Group more than once');
    }

    const summaries: MyGroupSummary[] = [];
    const denied: GroupId[] = [];
    for (const group of candidates) {
      const viewer = viewerParticipant(group, actorSubject);
      if (viewer === null) {
        denied.push(group.id);
      } else {
        summaries.push(summarize(group, viewer));
      }
    }

    for (const groupId of denied) {
      await this.alertPort.reportDeniedIndexHit(Object.freeze({ groupId }));
    }

    return Object.freeze({
      items: Object.freeze(
        summaries.sort(newestFirst).slice(0, MY_GROUP_LIST_LIMIT),
      ),
      hasMore: candidates.length > MY_GROUP_LIST_LIMIT,
    });
  }
}
