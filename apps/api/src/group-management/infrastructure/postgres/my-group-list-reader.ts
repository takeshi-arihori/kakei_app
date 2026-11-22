import type {
  ProtectedRecordCodec,
  ProtectedRecordHeader,
} from '../../../shared/infrastructure/protected-record/index.js';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import {
  actorMembershipIndexDigestInput,
  type GroupActorMembershipIndexCandidate,
  type GroupActorMembershipIndexKeyPort,
} from '../../application/group-access-policy.js';
import type {
  MyGroupCandidateReadResult,
  MyGroupListReadPort,
} from '../../application/my-group-list-read-port.js';
import { MY_GROUP_LIST_LIMIT } from '../../application/use-cases/list-my-groups.js';
import { GroupId, type ActorSubject, type Group } from '../../domain/group.js';
import { PostgresGroupReadRepository } from './group-read-repository.js';

type IndexHitRow = QueryResultRow & { group_id: string };
type LockedGroupRow = QueryResultRow & {
  aggregate_version: string;
  access_policy_version: string;
};

const keyVersionPattern = /^[A-Za-z0-9._:-]+$/;

/** 1回の読取で引く候補の上限。Use Caseの上限＋続きの有無の判定用の1件。 */
const MAX_CANDIDATE_LIMIT = MY_GROUP_LIST_LIMIT + 1;

class MyGroupListReadFailure extends Error {
  constructor() {
    super('My Group list read failed');
    this.name = 'MyGroupListReadFailure';
  }
}

const storedVersion = (value: string): number => {
  if (!/^[1-9][0-9]*$/.test(value)) throw new MyGroupListReadFailure();
  const version = Number(value);
  if (!Number.isSafeInteger(version)) throw new MyGroupListReadFailure();
  return version;
};

/** 鍵Portの候補を検証し、索引照会のbind値へ写す。不正があれば照会しない。 */
const indexPredicate = (
  candidates: readonly GroupActorMembershipIndexCandidate[],
  firstParameter: number,
): Readonly<{ sql: string; values: readonly unknown[] }> => {
  if (candidates.length === 0) throw new MyGroupListReadFailure();
  const versions = new Set<string>();
  const values: unknown[] = [];
  const predicates = candidates.map(({ digest, digestKeyVersion }, index) => {
    if (
      !(digest instanceof Uint8Array) ||
      digest.length === 0 ||
      typeof digestKeyVersion !== 'string' ||
      digestKeyVersion.length > 255 ||
      !keyVersionPattern.test(digestKeyVersion) ||
      versions.has(digestKeyVersion)
    ) {
      throw new MyGroupListReadFailure();
    }
    versions.add(digestKeyVersion);
    values.push(Buffer.from(digest), digestKeyVersion);
    const digestParameter = firstParameter + index * 2;
    return `(i.actor_digest = $${digestParameter} AND i.digest_key_version = $${digestParameter + 1})`;
  });
  return { sql: `(${predicates.join(' OR ')})`, values };
};

/**
 * 自分のGroup一覧の候補をActor単位のGroup索引から読む（#310）。
 * Group一覧ADR（#305）論点4とActor単位のGroup索引ADR（#306）§2に従い、業務Pool上の
 * 1 Transactionで次の順に処理する。
 *
 * 1. 鍵Portの現行＋Retiredの全候補digestで索引を引き、`group_aggregate_record.created_at`の
 *    新しい順（同時刻は`group_id`昇順）に最大`limit`件のGroupIdを得る
 * 2. hitしたGroupをGroupId昇順に`FOR SHARE`で固定する
 * 3. Lock後に自分の索引行がまだあるかを確かめ、無ければ競合として復号せずに除く
 * 4. 残ったGroupだけを復号し、固定した版・Policy版と一致することを確かめる
 *
 * 全候補missならGroupを読まず、Group鍵の取得と復号を行わない（存在非開示）。索引行が
 * 残っているGroupの再認可はApplicationが行い、否ならAlertする。障害は一部だけ返さず
 * `Unavailable`にする。Lock timeout等のTransaction設定はPoolを作るCompositionが持つ。
 */
export class PostgresMyGroupListReader implements MyGroupListReadPort {
  /**
   * @param options 業務Poolと既存GM Envelopeの復号、Context単位の索引鍵。認証Poolを渡さない。
   */
  constructor(
    private readonly options: Readonly<{
      /** 業務Pool。読取のTransactionをこのAdapterが所有する。 */
      pool: Pick<Pool, 'connect'>;
      /** 期待Header照合を行う既存AEAD。 */
      codec: Pick<ProtectedRecordCodec, 'open'>;
      /** 既存Envelopeのcanonical AAD。 */
      encodeAad: (header: ProtectedRecordHeader) => Uint8Array;
      /** 読取は現行＋Retiredの全候補を使う。書込用の`currentDigest`は使わない。 */
      membershipIndexKeys: Pick<
        GroupActorMembershipIndexKeyPort,
        'candidateDigests'
      >;
      /** 入力・元例外を含まない障害通知。 */
      onUnavailable?: () => void;
    }>,
  ) {}

  async readCandidates(
    input: Readonly<{ actorSubject: ActorSubject; limit: number }>,
  ): Promise<MyGroupCandidateReadResult> {
    const { actorSubject, limit } = input;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_CANDIDATE_LIMIT
    ) {
      return this.unavailable();
    }

    let client: PoolClient | undefined;
    let transactionOpen = false;
    let discardConnection = false;
    try {
      // 鍵Providerの待機中に業務接続を占有しない。
      const candidates =
        await this.options.membershipIndexKeys.candidateDigests(
          actorMembershipIndexDigestInput(actorSubject),
        );
      const predicate = indexPredicate(candidates, 2);

      client = await this.options.pool.connect();
      await client.query('BEGIN');
      transactionOpen = true;

      const hits = await client.query<IndexHitRow>(
        `SELECT i.group_id
           FROM group_actor_membership_index i
           JOIN group_aggregate_record g ON g.group_id = i.group_id
          WHERE ${predicate.sql}
          ORDER BY g.created_at DESC, i.group_id ASC
          LIMIT $1`,
        [limit, ...predicate.values],
      );
      const hitIds = hits.rows.map(({ group_id }) => group_id);
      if (new Set(hitIds).size !== hitIds.length || hitIds.length > limit) {
        // 1つのGroupが複数の鍵版でhitするのは書込の置き換え契約に反する。
        throw new MyGroupListReadFailure();
      }

      const groups: Group[] = [];
      const reader = new PostgresGroupReadRepository({
        database: client,
        codec: this.options.codec,
        encodeAad: this.options.encodeAad,
        // 一覧はoperation locatorを読まない。誤用されたら失敗させる。
        locatorKeys: {
          currentDigest: () => Promise.reject(new MyGroupListReadFailure()),
          candidateDigests: () => Promise.reject(new MyGroupListReadFailure()),
        },
      });
      // CommandのFOR UPDATEと同じGroupId昇順でLockする。
      for (const id of [...hitIds].sort()) {
        const groupId = GroupId.from(id);
        const locked = await client.query<LockedGroupRow>(
          `SELECT aggregate_version, access_policy_version
             FROM group_aggregate_record
            WHERE group_id = $1
            FOR SHARE`,
          [groupId.value],
        );
        if (locked.rows.length === 0) {
          // Lock待ちの間にRetention等で削除された。索引行もcascadeで消えている。
          continue;
        }
        const fixed = locked.rows[0];
        if (locked.rows.length !== 1 || fixed === undefined) {
          throw new MyGroupListReadFailure();
        }
        const stillIndexed = await client.query(
          `SELECT 1
             FROM group_actor_membership_index i
            WHERE i.group_id = $1 AND ${predicate.sql}`,
          [groupId.value, ...predicate.values],
        );
        if (stillIndexed.rows.length === 0) {
          // Leave等との正常な競合。復号せず、Alertもしない（#306 2A）。
          continue;
        }
        const loaded = await reader.load(groupId);
        if (
          loaded === null ||
          !loaded.group.id.equals(groupId) ||
          loaded.version !== storedVersion(fixed.aggregate_version) ||
          loaded.group.accessPolicyVersion !==
            storedVersion(fixed.access_policy_version)
        ) {
          throw new MyGroupListReadFailure();
        }
        groups.push(loaded.group);
      }

      await client.query('COMMIT');
      transactionOpen = false;
      return Object.freeze({
        kind: 'Read',
        groups: Object.freeze(groups),
        indexHitCount: hitIds.length,
      });
    } catch {
      if (client !== undefined && transactionOpen) {
        discardConnection = !(await this.rollback(client));
      }
      return this.unavailable();
    } finally {
      // Rollbackできなかった接続はTransactionが残り得るのでPoolへ戻さず破棄する。
      client?.release(discardConnection);
    }
  }

  private async rollback(client: PoolClient): Promise<boolean> {
    try {
      await client.query('ROLLBACK');
      return true;
    } catch {
      // 接続喪失でRollback不能でも、汎用のUnavailable結果を置き換えない。
      return false;
    }
  }

  private unavailable(): MyGroupCandidateReadResult {
    try {
      this.options.onUnavailable?.();
    } catch {
      // 通知の失敗で汎用の読取失敗を置き換えない。
    }
    return Object.freeze({ kind: 'Unavailable' });
  }
}
