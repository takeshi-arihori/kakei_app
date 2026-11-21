import { ActorSubject } from '../domain/group.js';
import type { CreateGroupCommand } from './group-command-service.js';
import { OperationId } from './group-repository.js';
import type { ListMyGroupsQuery } from './use-cases/list-my-groups.js';

/**
 * 公開Transportが受けたprimitiveからGroup作成のCommandを組み立てる。
 * PresentationはDomainを参照しないため、Value Objectの生成をここへ置く。
 * 形式の公開検査（UUIDv4等）は呼出し側のPresentationが先に行う。
 * @param input 認証leaseが与えたActorと、Clientが生成したoperationId。
 * @returns Domain Value Objectで構成した凍結済みCommand。
 * @throws GroupInvariantViolation 空のActor・operationId。
 */
export const createGroupCommandFrom = (
  input: Readonly<{ actorSubject: string; operationId: string }>,
): CreateGroupCommand =>
  Object.freeze({
    actorSubject: ActorSubject.from(input.actorSubject),
    operationId: OperationId.from(input.operationId),
  });

/**
 * 公開Transportが受けたActorから自分のGroup一覧のQueryを組み立てる。
 * @param input 認証leaseが与えたActor。
 * @returns 凍結済みQuery。
 * @throws GroupInvariantViolation 空のActor。
 */
export const listMyGroupsQueryFrom = (
  input: Readonly<{ actorSubject: string }>,
): ListMyGroupsQuery =>
  Object.freeze({ actorSubject: ActorSubject.from(input.actorSubject) });
