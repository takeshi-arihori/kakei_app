# フロントエンドの責務

## 境界

Frontendは業務を「表示・入力・操作」する境界であり、業務判断の正本ではない。

Frontendが担当する:

- Route、Layout、Navigation、Server Component、画面組立
- GraphQL Query／Mutationの実行と生成型の利用
- Form入力、即時Feedback、表示用Formatting、局所UI状態
- Loading、Empty、Error、Conflict、Successの表現
- Responsive、Accessibility、Keyboard、Focus、Browser履歴
- Mutationの二重操作防止と、通信失敗時の同一Idempotency Key再送

Frontendが担当しない:

- Domain Invariant、認可の最終判断、DB Access
- Split Allocation、Participant Balance、Payment Instruction、月次Category集計の正本計算
- SessionやTokenの独自保存・発行
- Prisma Model、Backend Aggregate、Backend Domain Serviceの共有
- GraphQL Response型の手書き

Client側で同じRuleを入力支援として計算する場合も、Server側を正本とし、結果不一致を扱えるUIにする。

## Folder責務

```text
apps/web/src/
  app/                       Route、Layout、Server Component、画面組立
  features/
    groups/                  components、graphql、hooks、schemas
    expenses/
    settlements/
    receipts/
  shared/
    ui/
      primitives/            Button、Input、Dialog
      composites/            MoneyInput、MemberSelector
    graphql/
    lib/
```

Feature名は責務例であり、TaskのBounded ContextやAggregateを先に確定するものではない。

- Domain固有UIとOperationは該当Featureへ置く。
- 複数Featureで意味と変更理由が同じUI・基盤だけを`shared`へ置く。
- Atomic DesignはDesign Systemの思考方法に限定し、アプリ全体のFolder Architectureへ使わない。
- Page固有UIは早期に抽象化せず、2箇所以上の実利用から共通化を判断する。

## サーバー／クライアントコンポーネント

- Data Fetchと静的な画面組立はServer Componentを基本とする。
- 入力、Browser API、Event Handler、局所状態が必要な最小境界だけ`use client`にする。
- Client Component化をData Fetchの既定手段にしない。
- Server専用ModuleをClient Bundleへ到達させない。
- Next.jsのAPIやConventionは`node_modules/next/dist/docs/`の該当Versionを確認する。

## 状態設計

状態を混在させない。

- Server State: GraphQLから取得した正本・Cache
- Form State: 入力、Touched、Validation、Submitting
- URL State: Filter、Sort、Page、選択状態のうち共有・復元すべきもの
- Local UI State: Dialog、Tab、展開状態など局所的なもの

一覧条件はURL Queryを正本とし、戻る・進む・共有URLで復元できるようにする。Server確定前のOptimistic Stateは明確に区別し、Conflict時に最新状態と再入力導線を示す。

## フォーム・更新操作

最低限、次の状態を設計する。

- 初期状態／入力中
- Invalid: 項目直下とPage上部の要約
- Submitting: 二重操作防止
- Success: 完了内容と次のAction
- Conflict: 最新Versionと再確認
- Network Error: 入力保持、同一Key再送、Cancel

金額、`occurredOn`、Category、Participant、Split AllocationのClient Validationは即時Feedbackを目的とする。Server ErrorをField Errorへ安全に対応付け、未知Errorを握り潰さない。

## アクセシビリティ・利用体験

- WCAG 2.2 AAを目標とする。
- Placeholderだけに依存せず、入力へ可視Labelを付ける。
- Focus順、Focus Ring、DialogのFocus Trapと復帰先を維持する。
- 色だけで収支、Warning、Errorを区別しない。
- 44px相当のTouch Target、200% Zoom、Reduced Motionを確認する。
- 破壊的操作は影響、復元可否、猶予、再認証要否を実行前に示す。
- Group Role、端数の割当先、Participant Balance、Payment Instructionの導出根拠を文字でも確認できるようにする。

## コンポーネントテスト

- PrimitiveとCompositeは主要な表示・Keyboard・Accessibilityを検証する。
- Domain WidgetはDefault、Loading、Empty、Error、Validation、Conflict、Mobileを必要に応じてStory化する。
- GraphQLはStorybookでMSW Mockし、実Backendや実Dataへ依存させない。
- Route全体の主要利用経路はPlaywright、Domain RuleはBackend Testで検証する。

## 参照元

- [ユーザージャーニー・ユースケース](https://app.notion.com/p/3a906467984f817a9a5ac19b4be025bd)
- [03. UX・情報設計](https://app.notion.com/p/3a906467984f81b7bce7e1ada5416f0f)
- [ドメイン設計](https://app.notion.com/p/3a906467984f80728058c839a403e6f0)
- [未確定事項・Documentation Conflict](https://app.notion.com/p/3a906467984f814ba736c627901ead38)
