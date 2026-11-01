import type { QueryResult, QueryResultRow } from 'pg';
import type { CommitGroupRequest } from '../../application/group-repository.js';

/** GM保存処理へ借用する単一query能力。Pool/Transaction制御/接続解放を含まない。 */
export interface GroupSqlQuery {
  /**
   * 所有者が開始したTransaction、または既存standalone読取へ固定SQLを送る。
   * @param sql GM所有Tableに対する固定SQL。参加時はregistryが単一DMLを検証する。
   * @param values SQL本文へ連結しないbind値。
   * @returns 指定した固定SELECT/RETURNINGの行。DB障害は呼出し側のrollbackへ伝播する。
   * @throws Error DB/Scope/SQL障害。
   */
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

/** 状態Writerはoperation形式を所有せず、既存CAS/現在行/履歴/索引だけを保存する。 */
export type GroupStateWritePlan = Omit<CommitGroupRequest, 'operation'>;
