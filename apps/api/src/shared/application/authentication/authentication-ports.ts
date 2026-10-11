import type { VerifiedGoogleIdentity } from '../google-id-token-verification.js';

/** Owner承認済みの試行・Session期限。全Adapterで同じmillisecondsを用いる。 */
export const authenticationLifetime = Object.freeze({
  /** 一回限りのLogin Attemptは発行から5分で無効になる。 */
  attempt: 300_000,
  /** Sessionは活動が続いても発行から7日を超えない。 */
  absolute: 604_800_000,
  /** 許可された活動が24時間なければSessionを無効にする。 */
  idle: 86_400_000,
});

/** 時刻判断を実時間から分離する。Storeはlock取得後にも取得する。 */
export interface AuthenticationClock {
  /** @returns 非負safe integerのUTC Unix epoch milliseconds。 */
  now(): number;
}

/** 秘密値の用途。Adapterは用途間・発行間でも独立した乱数を生成する。 */
export type AuthenticationSecretPurpose =
  'attempt' | 'nonce' | 'login-csrf' | 'session' | 'session-csrf';

/** 具体暗号実装を共有Applicationへ持ち込まない乱数Port。 */
export interface AuthenticationEntropy {
  /**
   * @param purpose 用途を混在させないための発行目的。
   * @returns 新しい32-byte CSPRNG値のcanonical unpadded Base64URL（43文字）。
   */
  generate(purpose: AuthenticationSecretPurpose): string;
}

/** 障害詳細や秘密値を含まない。commit済みか不明な場合もこの結果となる。 */
export interface AuthenticationUnavailable {
  /** 確実なrollbackを意味しない。成功Resultや秘密値は復元しない。 */
  readonly status: 'unavailable';
}

/** Browserが保持する試行秘密値と、その試行に束縛されたCSRF。 */
export interface AttemptBinding {
  /** HttpOnly Cookie由来の秘密値。URLやLogへ出さない。 */
  readonly attemptSecret: string;
  /** 試行専用CSRF。比較・保存保護はStore Adapterが所有する。 */
  readonly csrf: string;
}

/** Google検証中にDB lockを保持しないための版付き読取り結果。 */
export interface AttemptSnapshot {
  /** Store内部の試行参照。外部入力のRecord選択を許さない。 */
  readonly recordId: string;
  /** 消費・更新競合をcommit時に再検証する版。 */
  readonly version: number;
  /** Serverが保持した期待nonce。Clientから指定させない。 */
  readonly nonce: string;
  /** この時刻以上では読取り・消費とも拒否する。 */
  readonly expiresAt: number;
}

/** 新規試行の保存Command。期限はStoreが判断点のClockから算出する。 */
export interface BeginAttemptCommand extends AttemptBinding {
  /** Googleへ渡すServer発行nonce。認証用途の保護保存が必要。 */
  readonly nonce: string;
  /** 存在すれば同じBrowserの旧未消費試行だけを失効する。 */
  readonly previousAttemptSecret?: string;
  /** 有効なら再ログインを拒否する。これだけでActorを指定しない。 */
  readonly currentSessionSecret?: string;
}

/** 有効なSessionからの再ログインを拒否する内部結果。 */
export interface AlreadyAuthenticated {
  /** Account切替は先に現在SessionをLogoutしてから行う。 */
  readonly status: 'already-authenticated';
}

/** 試行不正・期限・消費・Actor無効を詳細なしで再開始へ導く。 */
export interface RestartRequired {
  /** 同じ試行から秘密値を復元せず、新規試行から開始する。 */
  readonly status: 'restart-required';
}

/** 試行保存結果。失敗時に生成秘密値を含めない。 */
export type BeginAttemptResult =
  | {
      /** 試行が保存された。後続HTTPがCookieへ変換する。 */
      readonly status: 'started';
      /** lock下のClockから算出した5分後の期限。 */
      readonly expiresAt: number;
    }
  | AlreadyAuthenticated
  | AuthenticationUnavailable;

/** Google検証前の読取り結果。readyでもcommit前に全条件を再検証する。 */
export type ReadAttemptResult =
  | {
      /** 読取り時点でBrowser・CSRF・期限・未消費が成立している。 */
      readonly status: 'ready';
      /** ApplicationがCopyし、Google検証後にもStoreが再検証する版。 */
      readonly snapshot: AttemptSnapshot;
    }
  | RestartRequired
  | AuthenticationUnavailable;

/** 検証済みIdentityだけからActor解決とSession発行をcommitする入力。 */
export interface CompleteAttemptCommand extends AttemptBinding {
  /** Google通信前に取得したimmutableな試行版。 */
  readonly snapshot: AttemptSnapshot;
  /** 既存Google Verifierの最小Copy。ProfileやTokenを保存しない。 */
  readonly identity: VerifiedGoogleIdentity;
  /** Cookieへ返す新しいSession秘密値。Storeはdigest lookupで保護する。 */
  readonly sessionSecret: string;
  /** Sessionごとの新しいCSRF。試行CSRFから引き継がない。 */
  readonly sessionCsrf: string;
  /** commit時に有効ならAccountの暗黙切替を拒否する。 */
  readonly currentSessionSecret?: string;
}

/** Actor解決・試行消費・Session・成功Auditが共通commitされた結果。 */
export type CompleteAttemptResult =
  | {
      /** ActorのClient公開を伴わないSession発行成功。 */
      readonly status: 'authenticated';
      /** 発行時点から7日。後続の活動でも変更しない。 */
      readonly absoluteExpiresAt: number;
    }
  | AlreadyAuthenticated
  | RestartRequired
  | AuthenticationUnavailable;

/** 照会ではidleを延ばさず、許可された活動だけを延長対象とする。 */
export type SessionUsage = 'inspect' | 'activity';

/** 有効Sessionからだけ得られる、非公開Callback用の本人性。 */
export interface AuthenticatedActor {
  /** Server生成UUIDv4。Google subやGroup Participantとは独立する。 */
  readonly actorSubject: string;
  /** Sessionの不変な最長期限。期限等値で拒否する。 */
  readonly absoluteExpiresAt: number;
  /** Sessionに束縛されたCSRF。後続Transportで照合し、Logへ出さない。 */
  readonly csrf: string;
}

/** 本人性なし。Callbackを実行せず業務Dataも返さない。 */
export interface Unauthenticated {
  /** 不正・失効・期限切れ・Actor無効の詳細を公開しない。 */
  readonly status: 'unauthenticated';
}

/** lease下のCallback結果。障害ではcommit済みの可能性があっても値を返さない。 */
export type AuthenticatedActorResult<T> =
  | {
      /** Session検証とCallbackのcommit／serializationが完了した。 */
      readonly status: 'authenticated';
      /** 非公開ApplicationのCallback結果。外部公開はTransportで変換する。 */
      readonly value: T;
    }
  | Unauthenticated
  | AuthenticationUnavailable;

/** 現在Sessionの失効結果。照合なし・期限切れ・失効済みも冪等成功。 */
export type LogoutResult =
  | {
      /** 失効成功または有効な対象なし。Store障害を成功へ変換しない。 */
      readonly status: 'logged-out';
    }
  | AuthenticationUnavailable;

/**
 * 原子的な認証保存境界。実Adapterは後続Taskで実DB・故障注入によって証明する。
 * すべての時刻判定はlock取得後のClockで行う。確実なrollback以外の障害では
 * 状態変更済みの可能性を残してunavailableとし、秘密値やCallback値を返さない。
 */
export interface AuthenticationStore {
  /**
   * 有効現在Sessionを拒否し、旧試行失効と新規保存を共通commitする。衝突は上書きしない。
   * @param command Browser束縛と新規秘密値。平文保存しない。
   * @param clock lock取得後に期限と現在Sessionを判断するClock。
   * @returns 保存期限、再ログイン拒否、または結果不明を含む障害。
   */
  begin(
    command: BeginAttemptCommand,
    clock: AuthenticationClock,
  ): Promise<BeginAttemptResult>;
  /**
   * Browser・CSRF・未消費・期限を照合する。Google通信中のlockは不要。
   * @param binding Cookie由来の試行とCSRF。
   * @param clock 読取り判断点のClock。
   * @returns 版付きsnapshot、再開始、または障害。
   */
  readAttempt(
    binding: AttemptBinding,
    clock: AuthenticationClock,
  ): Promise<ReadAttemptResult>;
  /**
   * binding・snapshot全Field・未消費・期限・現在Session・Actor有効性を再検証し、
   * issuer+sub一意Actorの再利用／UUIDv4作成、Session、試行消費、成功Auditを共通commitする。
   * @param command immutable snapshotとVerifier由来Identity、新Session秘密値。
   * @param clock lock取得後に再取得するClock。absolute／idleの算出にも使う。
   * @returns Session期限、再開始、再ログイン拒否、または結果不明を含む障害。
   */
  complete(
    command: CompleteAttemptCommand,
    clock: AuthenticationClock,
  ): Promise<CompleteAttemptResult>;
  /**
   * 失効・Actor有効・absolute／idleをlock下で検証し、Callbackのcommit／serializationまで
   * 同Sessionのleaseを保持する。activityのidle延長はmin(now+24h,absolute)で共通commitする。
   * @param sessionSecret 照合対象の秘密値。他SessionやRoleを選択させない。
   * @param usage 照会か許可された活動か。inspectは延長しない。
   * @param clock lock取得後の期限判断とidle更新に用いるClock。
   * @param callback 同Transaction範囲で実行する内部処理。外部副作用のrollbackは保証しない。
   * @returns Callback結果、本人性なし、または結果不明を含む障害。
   */
  withSession<T>(
    sessionSecret: string,
    usage: SessionUsage,
    clock: AuthenticationClock,
    callback: (actor: AuthenticatedActor) => Promise<T>,
  ): Promise<AuthenticatedActorResult<T>>;
  /**
   * 同Sessionを排他取得して現在Sessionだけを失効する。先に開始したleaseは先に完了する。
   * @param sessionSecret Cookie由来の現在Session秘密値。
   * @param clock 対象の期限を判断するClock。
   * @returns 冪等な失効成功、または結果不明を含む障害。
   */
  revoke(
    sessionSecret: string,
    clock: AuthenticationClock,
  ): Promise<LogoutResult>;
}
