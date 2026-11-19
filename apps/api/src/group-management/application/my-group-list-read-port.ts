import type { ActorSubject, Group, GroupId } from '../domain/group.js';

export type MyGroupCandidateReadResult =
  | Readonly<{ kind: 'Read'; groups: readonly Group[] }>
  | Readonly<{ kind: 'Unavailable' }>;

/**
 * 自分のGroup一覧の候補を読む。Group一覧ADR（#305）の論点4に従い、実装は1 Transactionで
 * Actor単位の索引から作成の新しい順に最大`limit`件を引き、GroupId昇順に固定版で読み、
 * 復号したGroupを版の不一致がないと確かめてから返す。
 *
 * 索引のhitは認可の根拠ではない。返したGroupの再認可はApplicationが行う。
 * Lock、接続、復号、版不一致等の障害は一部だけ返さず`Unavailable`にする。
 * 索引のmissでは復号しない（存在非開示）。
 */
export interface MyGroupListReadPort {
  readCandidates(
    input: Readonly<{ actorSubject: ActorSubject; limit: number }>,
  ): Promise<MyGroupCandidateReadResult>;
}

/**
 * 索引にhitしたが再認可で否となったGroupを、索引の不整合として通知する。
 * ActorやGroupの内容は渡さない。
 */
export interface MyGroupListIntegrityAlertPort {
  reportDeniedIndexHit(input: Readonly<{ groupId: GroupId }>): Promise<void>;
}
