import type { AuthenticationAttempt, AuthenticationClient, AuthenticationResult, AuthenticationSession } from './authentication-client';
/** 秘密を含まない表示用状態。本人性の正本はServer inspect。 */
export interface AuthenticationViewState {
  /** HTTP/Google操作の局所的な進行状態。 */ readonly phase: 'checking'|'anonymous'|'preparing'|'google'|'waiting'|'completing'|'authenticated'|'logout'|'restart'|'error';
  /** 診断や外部値を含まない固定の日本語案内。 */ readonly message: string;
  /** 予算拒否後の明示再試行可能時刻。 */ readonly retryAt?: number;
}
/** Google Adapterへ一度だけ渡す試行能力。DOM/Storageへ直列化しない。 */
export interface GoogleAttemptBindings {
  /** Server発行nonce。Google初期化専用。 */ readonly nonce: string;
  /** @param credential 未検証callback値。 @returns 一回限りの送信・再確認の完了。 */ onCredential(credential: unknown): Promise<void>;
  /** Google画面待ちを表示する。Requestの成功とは扱わない。 */ onClick(): void;
}
const initial: AuthenticationViewState = {phase:'checking',message:'ログイン状態を確認しています。'};
/** Session/試行の秘密と表示状態を分け、遅い応答を適用しない局所Controller。 */
export class AuthenticationController {
  private state: AuthenticationViewState = initial;
  private listeners = new Set<() => void>();
  private active = false;
  private version = 0;
  private inspection = 0;
  private attempt: AuthenticationAttempt | undefined;
  private session: AuthenticationSession | undefined;
  private attempted = false;
  /**
   * @param client A5のTransport能力だけ。認可や保存を実装しない。
   * @param now UI待機/期限の時計。Serverの判定を代替しない。
   */
  constructor(private readonly client: AuthenticationClient, private readonly now: () => number = Date.now) {}
  /** @returns 秘密を含まない安定した表示Snapshot。 */
  readonly getSnapshot = (): AuthenticationViewState => this.state;
  /** @returns SSR中だけの固定初期状態。Sessionを推測しない。 */
  readonly getServerSnapshot = (): AuthenticationViewState => initial;
  /** @param listener 表示の更新先。 @returns 購読解除。 */
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(state: AuthenticationViewState) { this.state=state; for (const listener of this.listeners) listener(); }
  private blocked() { return ['preparing','completing','logout'].includes(this.state.phase) || (this.state.retryAt ?? 0)>this.now(); }
  private current(version: number) { return this.active && version===this.version; }
  private failed(result: AuthenticationResult<unknown>) {
    this.attempt=undefined;
    this.set({phase:'error',message:result.status==='limited'?'操作が集中しています。しばらく待ってから再試行してください。':'操作を完了できませんでした。状態を確認するか、ログインをやり直してください。',...(result.status==='limited'?{retryAt:result.retryAt}:{})});
  }
  /** @returns 初回inspectの完了。再mount時も古い結果を使わない。 */
  async start(): Promise<void> { this.active=true; ++this.version; this.set(initial); await this.refresh(); }
  /** unmount後の応答/callbackを無効にし、秘密参照を捨てる。 */
  stop(): void { this.active=false; ++this.version; this.attempt=undefined; this.session=undefined; }
  /**
   * @returns 現在Sessionの再確認。popup復帰の401だけでは当試行を捨てない。
   */
  async refresh(): Promise<void> {
    if (!this.active || this.blocked()) return;
    const version=this.version, inspection=++this.inspection;
    const result=await this.client.inspect();
    if (!this.current(version) || inspection!==this.inspection) return;
    if (result.status==='ok') { this.session=result.value;this.attempt=undefined;this.set({phase:'authenticated',message:'ログイン中です。'}); }
    else if (result.status==='required') {
      if (this.attempt && this.now()<this.attempt.expiresAt && ['google','waiting'].includes(this.state.phase)) return;
      const hadSession=!!this.session || this.attempted;this.session=undefined;this.attempt=undefined;
      this.set(hadSession?{phase:'restart',message:'ログイン状態が変わりました。もう一度ログインしてください。'}:{phase:'anonymous',message:'Googleアカウントでログインできます。'});
    } else this.failed(result);
  }
  /** @returns 新しいServer試行の準備。二重操作は送信しない。 */
  async begin(): Promise<void> {
    if (!this.active || this.blocked() || this.attempt || this.session) return;
    const version=++this.version;this.set({phase:'preparing',message:'ログインの準備をしています。'});
    const result=await this.client.begin();if (!this.current(version)) return;
    if (result.status==='ok') { this.attempted=true;this.attempt=result.value;this.set({phase:'google',message:'Googleボタンからアカウントを選んでください。'});this.checkExpiry(); }
    else if (result.status==='restart') { this.set(initial);await this.refresh(); }
    else this.failed(result);
  }
  /**
   * @returns 現在の試行に束縛したGoogle能力。取消/期限後はundefined。
   */
  googleBindings(): GoogleAttemptBindings | undefined {
    const attempt=this.attempt;if (!this.active || !attempt) return undefined;
    return {nonce:attempt.nonce,onClick:()=>{if(this.active && this.attempt===attempt) this.set({phase:'waiting',message:'Googleで確認しています。画面を閉じた場合は中止してやり直せます。'});},onCredential:async credential=>{
      this.checkExpiry();
      if (!this.active || this.attempt!==attempt || !['google','waiting'].includes(this.state.phase)) return;
      this.attempt=undefined;
      if (typeof credential!=='string') {this.failed({status:'rejected'});return;}
      const version=++this.version;this.set({phase:'completing',message:'ログイン結果を確認しています。'});
      const result=await this.client.login(credential,attempt.csrfToken);if (!this.current(version)) return;
      if (result.status==='ok' || result.status==='unavailable' || result.status==='restart') {
        this.set(initial);await this.refresh();
        if (this.current(version) && this.state.phase==='anonymous') this.set({phase:'restart',message:'ログイン結果を確認できませんでした。もう一度ログインしてください。'});
      } else this.failed(result);
    }};
  }
  /** UI上の取消だけを確定し、Server削除やGoogle popup終了を主張しない。 */
  cancel(): void {
    if (!['preparing','google','waiting'].includes(this.state.phase)) return;
    ++this.version;this.attempt=undefined;this.set({phase:'restart',message:'ログインを中止しました。'});
  }
  /** UI期限を越えた試行を送信しない。Server期限判定は維持する。 */
  checkExpiry(): void {
    if (this.attempt && this.now()>=this.attempt.expiresAt) {++this.version;this.attempt=undefined;this.set({phase:'restart',message:'ログイン準備の有効期限が切れました。もう一度はじめてください。'});}
  }
  /** Script/Adapterの失敗を外部診断なしで表示する。 */
  googleUnavailable(): void { if(this.active && ['google','waiting'].includes(this.state.phase)) this.failed({status:'unavailable'}); }
  /** @returns 同Sessionの失効と必要な再確認の完了。 */
  async logout(): Promise<void> {
    const session=this.session;if (!this.active || !session || this.blocked()) return;
    const version=++this.version;this.set({phase:'logout',message:'ログアウトしています。'});
    const result=await this.client.logout(session.csrfToken);if (!this.current(version)) return;
    if (result.status==='ok') {this.session=undefined;this.set({phase:'restart',message:'ログアウトしました。'});return;}
    if (result.status==='limited') {this.failed(result);return;}
    this.set(initial);await this.refresh();
    if(this.current(version) && this.state.phase==='restart') this.set({phase:'restart',message:'ログアウトしました。'});
    if(this.current(version) && this.state.phase==='authenticated') this.set({phase:'authenticated',message:'ログアウトは完了していません。もう一度操作してください。'});
  }
}
