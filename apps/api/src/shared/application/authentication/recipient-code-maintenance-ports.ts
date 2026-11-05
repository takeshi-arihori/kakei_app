import type { AuthenticationRetentionWindow } from './authentication-retention-policy.js';
import type { RecipientCodeMacKeyClosure } from './recipient-code-key-lifecycle.js';

declare const scopeCursorBrand: unique symbol;

/**
 * コード専用の鍵scope。Record暗号のAuthenticationKeyScopeとは別の型で、
 * DEK Port・codec・認証保守の経路へ渡せない（ADR D1）。
 */
export interface RecipientCodeKeyScope {
  /** Server生成UUIDv4。 */ readonly codeId: string;
  /** allocate時に束縛した発行本人のActor UUIDv4。行のない孤立scopeの起算にも使う。 */ readonly recipientActorId: string;
}

/** 固定snapshotの一行。票のない孤立scopeも含み、鍵Materialを含まない（ADR D4）。 */
export interface RecipientCodeInventoryScope extends RecipientCodeKeyScope {
  /** allocateが保持する延長しないUTC期限。 */ readonly expiresAt: number;
  /** Providerが認証する全世代集合の版。 */ readonly inventoryRevision: string;
}

/** 1 ticket=1 codeId。全世代closureと0-rowが揃うまでdurableに残る（ADR D3）。 */
export interface RecipientCodeDestructionTicket {
  /** 対象の1コード。codeIdごとに未完了ticketは高々1つ。 */ readonly codeId: string;
  /** 所有operation。closureは採用経由でも常にこの値へ束縛する。 */ readonly operationId: string;
  /** このticketを採用した所有者以外のoperation。durableで重複しない。 */ readonly adoptingOperationIds: readonly string[];
  /** 版を上げるCASの正の版。窓の前倒し・採用・完了で増える。 */ readonly version: number;
  /** 発行時の全世代版。ticket登録後はallocateの拒否で増えず、破棄でも変えない。 */ readonly inventoryRevision: string;
  /** 所有側と採用側の最早due+24h。前倒しのみで延長しない。 */ readonly window: AuthenticationRetentionWindow;
  /** completeは全closure検証と0-row確認の後だけ。完了後は再作成しない。 */ readonly state:
    'pending' | 'complete';
}

/** prepareの結果。全variantでCAS後のticketを返す。 */
export interface RecipientCodeTicketPreparation {
  /**
   * createdは新規、resumedは所有operationの再実行、adoptedは別operationの採用、
   * satisfiedは完了済みticketの採用。重複ticketは作らない。
   */
  readonly status: 'created' | 'resumed' | 'adopted' | 'satisfied';
  /** CAS適用後のticket。 */ readonly ticket: RecipientCodeDestructionTicket;
}

/** Provider所有の不透明な続き位置。別snapshot・別Provider・別Actor条件へ転用できない。 */
export type RecipientCodeScopeCursor = object & {
  /** 構造的な偽造を型で拒否する。実行時の所有はProviderとguardが検証する。 */
  readonly [scopeCursorBrand]: true;
};

/**
 * 固定snapshotの一Page。完全列挙を保証できないProviderはunavailableを返し、
 * 空のsnapshotへ読み替えない（ADR D4）。
 */
export type RecipientCodeScopePage =
  | {
      /** 完全列挙を保証した固定snapshot。 */ readonly status: 'snapshot';
      /** このPageのscope。同snapshot内で重複しない。 */ readonly scopes: readonly RecipientCodeInventoryScope[];
      /** snapshot全体の件数。全Pageで不変。 */ readonly total: number;
      /** 固定snapshotの続き。nullは全件読了で、残件を切り捨てない。 */ readonly nextCursor: RecipientCodeScopeCursor | null;
    }
  | {
      /** 完全性を保証できない。空成功にしない。 */ readonly status: 'unavailable';
    };

/**
 * コード専用の保守Port。通常の認証保守Reader/Writerへコードscopeを混入させない。
 * 応答はguardRecipientCodeMaintenanceで検証してから使う。
 * 実Providerの線形化・耐久性は保証の対象外で、Production Gateに残る。
 */
export interface RecipientCodeMaintenancePort {
  /**
   * Actor単位で新規allocateを冪等に封鎖する。解除する契約は持たない。
   * 応答後に開始したsnapshotは、封鎖前に受理した全allocateを含む（linearizable、ADR D5）。
   * @param recipientActorId 封鎖するActor UUIDv4。
   * @returns 要求Actorへ束縛した固定Ack。
   * @throws Error Provider障害。封鎖済みとして扱わない。
   */
  blockActor(recipientActorId: string): Promise<{
    /** 登録または登録済みの確認。 */ readonly status: 'blocked';
    /** 要求への完全束縛。 */ readonly recipientActorId: string;
  }>;
  /**
   * 票のないscopeを含む全scopeを固定snapshotで列挙する。cursorがnullのとき新しいsnapshotを作る。
   * @param query 続き位置、1〜1000件の上限、任意のActor条件。
   * @returns 固定snapshotの一Page、または完全性を保証できないunavailable。
   * @throws Error Provider障害、別snapshot・別Actor条件のcursor。
   */
  scopePage(query: {
    /** nullは新規snapshot。続きは同じ条件のcursorだけ。 */ readonly cursor: RecipientCodeScopeCursor | null;
    /** 1〜1000件。 */ readonly limit: number;
    /** nullは全Actor。指定時はそのActorのscopeだけ。 */ readonly recipientActorId:
      string | null;
  }): Promise<RecipientCodeScopePage>;
  /**
   * ticketを作成または採用する。findの結果をexpectedへ渡す、版を上げるCAS。
   * @param input 既知scope、要求operation、起算済みwindow、読取時点のticket。
   * @returns CAS適用後のticketと、作成・再実行・採用・充足の区別。
   * @throws Error 未知scope、Actor不一致、allocateが保持するexpiresAtより後のdueAt、版不一致、Provider障害。
   */
  prepare(input: {
    /** allocate済みで束縛Actorが一致するscope。 */ readonly scope: RecipientCodeKeyScope;
    /** 要求operationのServer生成UUIDv4。 */ readonly operationId: string;
    /** 要求側の起算によるwindow。既存より遅ければ延長しない。 */ readonly window: AuthenticationRetentionWindow;
    /** 読取時点のticket。nullは未登録の期待。 */ readonly expected: RecipientCodeDestructionTicket | null;
  }): Promise<RecipientCodeTicketPreparation>;
  /**
   * codeIdのticketを未完了・完了の別なく取得する。
   * @param codeId 対象のUUIDv4。
   * @returns 既存ticket。未登録はnull。
   * @throws Error Provider障害。未登録として扱わない。
   */
  find(codeId: string): Promise<RecipientCodeDestructionTicket | null>;
  /**
   * 未完了ticketをdueAtの早い順に取得する。
   * @param limit 1〜1000件。
   * @returns 最早期限を先頭にした未完了ticket。
   * @throws Error Provider障害。
   */
  pending(limit: number): Promise<readonly RecipientCodeDestructionTicket[]>;
  /**
   * operationが所有または採用した全ticketを完了済みも含めて取得する。
   * @param operationId 所有または採用したoperation。
   * @returns codeIdごとに1件のticket。
   * @throws Error Provider障害。空集合として扱わない。
   */
  byOperation(
    operationId: string,
  ): Promise<readonly RecipientCodeDestructionTicket[]>;
  /**
   * 最新版のticketからscopeを解決する。
   * @param ticket Providerの最新版と一致するticket。
   * @returns ticketのcodeIdに対応する1件のscope。
   * @throws Error 版不一致、Provider障害。
   */
  scopes(
    ticket: RecipientCodeDestructionTicket,
  ): Promise<readonly RecipientCodeKeyScope[]>;
  /**
   * 検証済みclosureとDB 0-rowの確認後にticketを完了する。
   * @param input 最新版のticketと、同じ所有operationのclosure。
   * @returns 版を上げた完了済みticket。
   * @throws Error 偽closure、版不一致、Provider障害。
   */
  complete(input: {
    /** Providerの最新版と一致する未完了ticket。 */ readonly ticket: RecipientCodeDestructionTicket;
    /** ticketの所有operationと全世代版へ束縛したclosure。 */ readonly closure: RecipientCodeMacKeyClosure;
  }): Promise<RecipientCodeDestructionTicket>;
}
