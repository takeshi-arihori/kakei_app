import type { AuthenticationResult, AuthenticationSession } from '../authentication/authentication-client';
import type { CreateGroupClient } from './graphql/create-group-client';

/** `/auth/session`の非延長inspect結果。CSRF Tokenを得るためだけに使う。 */
export type SessionInspection = AuthenticationResult<AuthenticationSession>;

/** 秘密値・操作IDを含まない作成操作の表示状態。 */
export interface GroupCreationViewState {
  /**
   * 操作の段階。`retry`は同じ操作IDで再送できる結果不明、`failed`は操作IDを破棄した確定Error、
   * `redirecting`はログイン導線への移動中。
   */
  readonly phase: 'idle' | 'submitting' | 'created' | 'retry' | 'failed' | 'redirecting';
  /** 診断や外部値を含まない固定の日本語案内。 */
  readonly message: string;
}

/** 作成操作が使う能力。画面組立だけが実体を渡す。 */
export interface GroupCreationDependencies {
  /** @returns 現在SessionのCSRF Token、または未認証・障害。 */
  readonly inspectSession: () => Promise<SessionInspection>;
  /** 同一Origin`/graphql`へのMutation送信。 */
  readonly client: CreateGroupClient;
  /** @returns 暗号学的乱数による小文字UUIDv4（`crypto.randomUUID()`）。 */
  readonly newOperationId: () => string;
  /** 作成成功後に一覧を取り直す。 */
  readonly onCreated: () => void;
  /** ログイン画面へ移す。戻り先URLは渡さない（#305 §5）。 */
  readonly onAuthenticationRequired: () => void;
}

const initial: GroupCreationViewState = { phase: 'idle', message: '' };

/**
 * Group作成の操作IDと二重送信防止を管理する局所Controller（#305 §1・§5）。
 * 操作IDはmemoryだけに持ち、成功・確定Errorで破棄し、結果不明では次の押下で同じ値を再送する。
 */
export class GroupCreationController {
  private state: GroupCreationViewState = initial;
  private readonly listeners = new Set<() => void>();
  private pendingOperationId: string | undefined;

  /** @param dependencies Session確認・送信・遷移の能力。 */
  constructor(private readonly dependencies: GroupCreationDependencies) {}

  /** @returns 秘密値を含まない現在の表示状態。 */
  readonly getSnapshot = (): GroupCreationViewState => this.state;
  /** @returns SSR中の固定初期状態。 */
  readonly getServerSnapshot = (): GroupCreationViewState => initial;
  /** @param listener 表示の更新先。 @returns 購読解除。 */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(state: GroupCreationViewState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private settle(state: GroupCreationViewState) {
    this.pendingOperationId = undefined;
    this.set(state);
  }

  private redirect() {
    this.settle({ phase: 'redirecting', message: 'ログインが必要です。ログイン画面へ移動します。' });
    this.dependencies.onAuthenticationRequired();
  }

  /** 作成を1回送り、結果を状態へ反映する。送信中・移動中の押下は送らない。 */
  async submit(): Promise<void> {
    if (this.state.phase === 'submitting' || this.state.phase === 'redirecting') return;
    const operationId = (this.pendingOperationId ??= this.dependencies.newOperationId());
    this.set({ phase: 'submitting', message: 'グループを作成しています。' });
    const session = await this.dependencies.inspectSession();
    if (session.status === 'required') {
      this.redirect();
      return;
    }
    if (session.status !== 'ok') {
      // Mutationは未送信。操作IDを保ち、次の押下でも同じ意図として扱う。
      this.set({ phase: 'retry', message: 'グループを作成できませんでした。同じ作成操作として、もう一度試せます。' });
      return;
    }
    const result = await this.dependencies.client.createGroup(operationId, session.value.csrfToken);
    if (result.status === 'ok') {
      this.settle({ phase: 'created', message: 'グループを作成しました。' });
      this.dependencies.onCreated();
    } else if (result.status === 'authentication-required') this.redirect();
    else if (result.status === 'unavailable')
      this.set({ phase: 'retry', message: '作成できたか確認できませんでした。「もう一度試す」で同じ作成操作として再送します。' });
    else this.settle({ phase: 'failed', message: 'グループを作成できませんでした。ページを再読み込みしてから、もう一度お試しください。' });
  }
}
