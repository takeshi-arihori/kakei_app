/** 読取とは別のRecord鍵発行能力。鍵MaterialをStoreへ返さない。 */
export interface RecipientCodeStateKeyAllocationPort {
  /**
   * codeId/世代ごとに独立した256bit鍵を生成し、全世代inventoryへ先に登録する。
   * 同一Descriptorが既存なら再生成せずcreated=falseで再確認する。上書き/破棄Scope復活は拒否する。
   * DB rollbackは鍵を巻き戻さない。新Recordではcreated=trueだけを受理する。
   * 孤立Scopeも期限を保持し、期限/終端/Actor無効化の最早時点+24h以内の全世代破棄へ引き継ぐ。
   * @param input 新規Scopeまたは旧Record再MAC用の未発行世代と、延長しないコード期限。
   * @returns 完全一致する固定Ackだけ。成功後は読取Portから同じ独立鍵を取得できる。
   * @throws Error Provider障害。不明結果でもStoreは業務処理を自動retryしない。
   */
  allocate(input: {
    /** Server生成UUIDv4。 */ readonly codeId: string;
    /** key-state Lock下の唯一のwrite世代。 */ readonly keyVersion: string;
    /** UTC期限。既存Recordの再MACでも延長しない。 */ readonly expiresAt: number;
  }): Promise<
    | {
        /** 秘密Materialを含まない発行確認。 */ readonly status: 'allocated';
        /** 今回の新規作成か、完全一致する既存鍵の再確認か。 */ readonly created: boolean;
        /** 要求への完全束縛。 */ readonly codeId: string;
        /** 要求への完全束縛。 */ readonly keyVersion: string;
        /** 有限の孤立Scope inventoryにも保持する期限。 */ readonly expiresAt: number;
      }
    | {
        /** 廃棄/Descriptor不一致/不明を復元しない。 */ readonly status: 'unavailable';
      }
  >;
}

/** Record別MACの全世代一覧。読取可能集合だけでは清掃完了を判定できない。 */
export interface RecipientCodeMacKeyInventory {
  /** 永久封鎖する対象のcodeId UUIDv4。 */ readonly codeId: string;
  /** Providerが認証する全世代集合の版。DB Backupと独立して管理する。 */ readonly inventoryRevision: string;
  /** current/旧読取/廃棄済みを含む全世代。鍵Materialを返さない。 */
  readonly generations: readonly {
    /** codeId内の独立256-bit MAC鍵世代。 */ readonly keyVersion: string;
    /** 廃棄済みも欠落させず、再生成/再導出しない。 */ readonly lifecycle:
      'current' | 'read-only' | 'destroyed';
  }[];
}

/** 全世代のclosureを照合する、Provider外へ秘密値を持ち出さない参照。 */
export interface RecipientCodeMacKeyClosure {
  /** 他Recordのclosureを転用しない。 */ readonly codeId: string;
  /** 応答喪失後も同じ破棄要求を再照合するID。 */ readonly operationId: string;
  /** 封鎖した全世代Inventoryの認証済み版。 */ readonly inventoryRevision: string;
  /** Providerが真正性/所属/永久封鎖を検証する参照。文字列だけでは証拠としない。 */ readonly evidenceReference: string;
}

/**
 * 読取Crypto Portから分離するRecord別全世代inventory/closure能力。
 * 終端/期限/Actor無効化の最早時点+24h以内の破棄をBackup読取保持より優先する。
 * #244/#245のdurable ticket/DB削除/0-row/Restore照合が完了するまで本番保証しない。
 */
export interface RecipientCodeMacKeyLifecyclePort {
  /**
   * 既知の全世代を取得する。未登録Scopeを空集合の成功へ変換しない。
   * @param codeId 対象Record。読取不能/破棄済み世代も列挙する。
   * @returns DB外の認証済みInventory。例外/不完全集合は清掃停止とする。
   * @throws Error Provider障害・真正性を確認できない場合。清掃を完了扱いにしない。
   */
  inventory(codeId: string): Promise<RecipientCodeMacKeyInventory>;
  /**
   * 同scopeへの新鍵発行も永久封鎖し、同operationで冪等に全世代を破棄する。
   * @param input durable ticketへ束縛するScope/版/要求と最早due+24hの期限。
   * @returns 認証対象のclosure候補。呼出し成功だけでDB清掃完了としない。
   * @throws Error Provider障害・真正性を確認できない場合。清掃を完了扱いにしない。
   */
  closeAllGenerations(input: {
    /** 読取不能でも信頼済みInventoryから指定する。 */ readonly codeId: string;
    /** DB Backupと独立する破棄要求。 */ readonly operationId: string;
    /** inventoryから得た全世代の版。 */ readonly inventoryRevision: string;
    /** Backup windowの終了まで延長できないUTC milliseconds。 */ readonly deadlineAt: number;
  }): Promise<RecipientCodeMacKeyClosure>;
  /**
   * 全世代破棄と永久封鎖の真正性/所属をProviderの外部状態へ照合する。
   * @param closure 対象codeId/operation/Inventory版を含む候補。
   * @returns 実証済みのclosureだけtrue。文字列・0-row・偽証跡を成功にしない。
   * @throws Error Provider障害・真正性を確認できない場合。清掃を完了扱いにしない。
   */
  verifyClosure(closure: RecipientCodeMacKeyClosure): Promise<boolean>;
}
