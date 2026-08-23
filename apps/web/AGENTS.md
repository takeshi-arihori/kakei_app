# Web開発ルール

このファイルは`apps/web`配下へ適用し、ルート`AGENTS.md`を補足する。

## 責務

- WebはRoute、Layout、Server Component、画面組立、入力、表示、ブラウザAPI、局所UI状態を担当する。
- 業務API、認証、認可、永続化、業務不変条件はHono APIのApplication／Domainを正本とする。
- Domain Model、Aggregate、Prisma ModelをWebへ共有しない。
- API契約には生成されたGraphQL Operation型を使い、Response型を手書きしない。
- サーバーの認可をUIの表示制御で代替しない。

## 構成

- `app`: Route、Layout、Server Component、Data Fetch、画面組立
- `features/<feature>`: Domain固有のComponent、GraphQL Operation、hook、form schema
- `shared/ui/primitives`: Button、Input、Dialogなど最小共通UI
- `shared/ui/composites`: MoneyInput、MemberSelectorなど業務横断UI
- `shared/graphql`、`shared/lib`: 複数Featureで使う基盤だけ
- `atoms`／`molecules`／`organisms`をアプリ全体のFolder分類にしない。
- 共通化は実際に2箇所以上で再利用されてから判断する。

## Component・状態

- Server Componentを基本とし、入力、局所状態、Browser APIが必要な境界だけClient Componentにする。
- API由来の状態、Form状態、表示状態を分離する。
- 一覧のFilter、Sort、Page Cursorなど共有可能な画面状態はURL Queryを正本にする。
- 重要MutationではUUIDの`idempotencyKey`を生成し、通信失敗の再送で同じKeyを使う。
- 送信中、成功、Validation Error、Network Error、Conflictを明示し、入力を不必要に失わない。
- Client側検証はUXのために行う。Domain Ruleと認可は必ずServer側でも検証する。

## 画面・アクセシビリティ

- Mobile First、Tailwind CSS、shadcn/ui、Design Tokenを使用する。
- 色だけで状態を伝えず、可視Label、Focus Ring、DialogのFocus管理を保証する。
- WCAG 2.2 AAを目標にKeyboard、Screen Reader、200% Zoom、Reduced Motionを確認する。
- Loading、Empty、Error、Validation、権限なし、Conflict、Mobileの状態を設計する。

## テスト

- 表示と純粋な変換はUnit／Component Testで検証する。
- 操作可能な共通UIやDomain WidgetはStorybook＋MSW＋Interaction＋Accessibility Testの対象とする。
- 認証、Group切替、Group Expense、割り勘、Settlement申請・承認、支払報告・受取確認、Archive参照の主要利用経路はPlaywright E2Eで検証する。
- Frontend TestだけでBackendのDomain Rule検証を代替しない。

<!-- BEGIN:nextjs-agent-rules -->
# このNext.jsは学習済み知識と異なる可能性がある

このVersionには破壊的変更が含まれ、API、規約、File構成が学習済み知識と異なる可能性がある。コードを書く前に`node_modules/next/dist/docs/`の関連Guideを読み、非推奨のNoticeに従う。
<!-- END:nextjs-agent-rules -->
