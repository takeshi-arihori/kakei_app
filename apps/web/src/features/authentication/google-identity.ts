import type { GoogleAttemptBindings } from './authentication-controller';
/** Google公式Scriptの実行時検査を通した最小能力。 */
export interface GoogleIdentity {
  /** @param config Server試行に束縛した設定。 */ initialize(config: Readonly<{
    /** 公開Client ID。 */ client_id: string;
    /** Server期待nonce。 */ nonce: string;
    /** 自動認証をしない。 */ auto_select: false;
    /** 自動アカウント選択をしない。 */ button_auto_select: false;
    /** UIによる明示操作だけを使う。 */ ux_mode: 'popup';
    /** @param response Googleの未検証応答。 */ callback(response: unknown): void;
  }>): void;
  /** @param element 表示先。 @param config 公式buttonの表示設定。 */ renderButton(element: HTMLElement, config: Readonly<{
    /** アイコン単独にしない。 */ type: 'standard';
    /** 既存画面に合う標準outline。 */ theme: 'outline';
    /** 操作可能な標準大サイズ。 */ size: 'large';
    /** 日本語表示。 */ locale: 'ja';
    /** 狭幅にも収まる表示幅。 */ width: number;
    /** ログイン用の公式文言。 */ text: 'signin_with';
    /** @returns UI待ち状態への遷移だけ。 */ click_listener(): void;
  }>): void;
  /** 自動再選択を抑止する。Google自体のlogout/権限撤回ではない。 */ disableAutoSelect(): void;
}
declare global { interface Window { /** 外部Script由来。利用前に検査する。 */ google?: unknown; } }
const record=(v:unknown):v is Record<string,unknown> => typeof v==='object' && v!==null;
const identity=(v:unknown):v is GoogleIdentity => record(v) && typeof v.initialize==='function' && typeof v.renderButton==='function' && typeof v.disableAutoSelect==='function';
let pending: Promise<GoogleIdentity> | undefined;
const initialized = new WeakSet<Document>();
/**
 * /loginで必要になった時だけ公式の固定URLを一度読み込む。
 * @returns 実行時検査済みGIS能力。失敗/timeoutは固定Errorでrejectする。
 * @throws Script読込/構造の不正、15秒の期限超過。
 */
export const loadGoogleIdentity = (): Promise<GoogleIdentity> => {
  if (pending) return pending;
  pending=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client?hl=ja';script.async=true;script.referrerPolicy='no-referrer-when-downgrade';
    const timer=setTimeout(()=>{script.onload=null;script.onerror=null;reject(new Error('ログインを準備できません'));},15_000);
    const finish=()=>{clearTimeout(timer);script.onload=null;script.onerror=null;};
    script.onerror=()=>{finish();reject(new Error('ログインを準備できません'));};
    script.onload=()=>{finish();const g=window.google;const id=record(g)&&record(g.accounts)?g.accounts.id:undefined;if(identity(id))resolve(id);else reject(new Error('ログインを準備できません'));};
    document.head.append(script);
  });return pending;
};
/**
 * Server nonceと一回限りのcallbackを公式buttonへ結び付ける。
 * @param google 検査済み公式能力。
 * @param element 当画面の表示先。
 * @param clientId 公開Client ID。
 * @param bindings 当試行の秘密を永続化しない能力。
 * @returns 当画面のbuttonを外す処理。Google popupの強制終了は主張しない。
 * @throws 同じdocumentの再初期化。再開始は全文書reloadで行う。
 */
export const mountGoogleButton=(google:GoogleIdentity,element:HTMLElement,clientId:string,bindings:GoogleAttemptBindings): (()=>void) => {
  if(initialized.has(element.ownerDocument)) throw new Error('ログインをやり直してください');
  initialized.add(element.ownerDocument);
  google.initialize({client_id:clientId,nonce:bindings.nonce,auto_select:false,button_auto_select:false,ux_mode:'popup',callback:response=>{if(record(response))void bindings.onCredential(response.credential);else void bindings.onCredential(undefined);}});
  // 公式button外枠と拡大時の端数のため、表示先の幅に余白を残す。
  google.renderButton(element,{type:'standard',theme:'outline',size:'large',text:'signin_with',locale:'ja',width:Math.max(200,Math.min(280,Math.floor(element.clientWidth)-2)),click_listener:bindings.onClick});
  return ()=>{element.replaceChildren();};
};

/** @returns 当documentでGoogleを初期化済みならtrue。新試行は全文書reloadする。 */
export const requiresGoogleReload=():boolean=>initialized.has(document);
/** 確認済logout後に自動再選択だけを抑止する。未読込なら何もしない。 */
export const disableGoogleAutoSelect=():void=>{const g=window.google;const id=record(g)&&record(g.accounts)?g.accounts.id:undefined;if(identity(id)){try{id.disableAutoSelect();}catch{ /* Logout確定後の補助失敗でServer状態を偽らない。 */ }}};
