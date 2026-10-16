declare const serializedValueBrand: unique symbol;
declare const transactionScopeBrand: unique symbol;

/** lease内で本文を確定したhandle。実際の所有ScopeはAdapterがObject identityで検証する。 */
export interface AuthenticationSerializedValue {
  /** 後続Transportがcommit後にそのまま送るJSON本文。再serializationしない。 */
  readonly body: string;
  /** 呼出し側で通常のObjectを確定本文と取り違えないための非公開型Brand。 */
  readonly [serializedValueBrand]: true;
}

/** Callbackの操作受付期間だけ使える技術契約。SQLや接続所有権は公開しない。 */
export interface AuthenticationTransactionScope {
  /** 別の技術Scopeと構造だけで互換にしないための非公開型Brand。 */
  readonly [transactionScopeBrand]: true;
  /**
   * JSON-safeな値を同期Copyし、leaseを保持したまま本文を固定する。
   * @param value Accessor・独自prototype・非JSON型・循環を含まない値。
   * @returns このScopeが発行した不変handle。元値の後続変更は反映しない。
   * @throws 値不正または操作受付終了。open中の失敗は握り潰してもcommitを拒否する。
   */
  serialize(value: unknown): AuthenticationSerializedValue;
}
