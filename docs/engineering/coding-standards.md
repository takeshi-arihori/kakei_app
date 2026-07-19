# コーディング規約

## 基本原則

- TypeScriptは`strict: true`を維持する。
- `any`を原則禁止し、外部入力は`unknown`からSchemaまたは明示的なGuardで検証する。
- Public APIは呼出し側が意図と制約を理解できる名前・型にする。
- 型Assertionで不整合を隠さず、境界で変換・検証する。
- 正常系を短くするために失敗・認可・競合を省略しない。

## 単一責任と凝集

- Module、Class、Functionは1つの変更理由を持つようにする。
- Resolver、Use Case、Domain Rule、Persistence、Projection、Viewを同じClassへ混在させない。
- 1つのUse Caseを無意味に多数の薄いFunctionへ分割しない。RuleとDataが一緒に変わる範囲へ凝集させる。
- Boolean引数で無関係な複数挙動を切り替える設計を避け、意図が分かる型・Command・Methodへ分ける。
- `utils`や`common`へDomain固有の概念を退避しない。所有するFeature／Contextを明確にする。
- 共有化は重複の形だけでなく、変更理由と意味が同じ場合に行う。

## 依存と境界

- PresentationはApplicationだけを呼ぶ。
- ApplicationはDomainとPortへ依存する。
- DomainはFrameworkとInfrastructureへ依存しない。
- Infrastructureは内側が定義したPortを実装する。
- Context間でEntity、Repository、Prisma Tableを直接参照しない。
- WebとAPIの共有は生成GraphQL契約に限定し、Backend Domain Codeを共有しない。
- DTOはData運搬に限定し、重要な業務Ruleを持たせない。

## 型・値・日時

- Domain IDは可能な範囲でBranded TypeまたはValue Objectとして区別する。
- Moneyは整数AmountとCurrencyで表し、JavaScriptの小数計算へ依存しない。
- 内部TimestampはUTCで保存・伝播し、月次集計はAsia/Tokyoへ明示変換する。
- `Date`の暗黙Timezoneや文字列比較へ依存しない。
- Enum的な値は許可集合を型とRuntime Validationの両方で制約する。
- `null`、`undefined`、空文字の意味を境界ごとに決め、暗黙変換しない。

## エラー

- 予期されるDomain違反は機械判定可能なDomain Errorとして表す。
- 内部Stack Trace、SQL、機密DataをGraphQLへ公開しない。
- GraphQL Errorは`code`、利用者向け`message`、必要時の`fieldErrors`、`correlationId`へ変換する。
- Resolverごとの重複`try/catch`ではなく、Presentationの共通変換で一貫性を保つ。
- Retry可能な障害と、入力修正が必要なErrorを区別する。

## セキュリティ・プライバシー

- Password、JWT、Cookie、Refresh Token、OAuth Code、金融Memo、暗号鍵をLog、Sentry、Fixtureへ出さない。
- Input全体やGraphQL Variablesを安易にLogしない。
- Household Dataを取得・更新するQueryは`household_id`でScopeし、Application認可とRepository条件の両方で守る。
- Clientの表示制御、Resolver Guard、Cloudflare通過だけを認可の正本にしない。
- Random TokenやKeyは暗号学的に安全な生成器を使い、平文保存しない。
- SecretはEnvironment／Secret Managerから受け取り、RepositoryとContainer Imageへ含めない。

## 命名・Comment

- DomainのClass、Method、Event、TestはNotionのユビキタス言語を使う。
- Eventは過去形、Commandは命令、Queryは取得意図が分かる名前にする。
- `Manager`、`Helper`、`Data`のような責務不明な名前を避ける。
- Commentは「何をしているか」ではなく、理由、制約、Trade-off、外部仕様を説明する。
- 古いCommentを残すより、Codeで意図を表し、必要な背景だけを最新に保つ。

## 依存Package

- 新しい本番依存関係は追加前に承認を得る。
- 追加・更新時は公式Document、Release Note、Security Advisory、License、Bundle／Runtime影響を確認する。
- Lockfile差分をレビューし、目的と無関係な更新を混ぜない。
- 小さなDomain RuleをLibrary導入で置き換えない。

## 参照元

- [08 アプリケーション・インフラアーキテクチャ](https://app.notion.com/p/39a06467984f811c9461c0bb6bddbdb9)
- [09 セキュリティ・プライバシー・監査設計](https://app.notion.com/p/39a06467984f8146bd2ccadf82529e6a)
- [10 開発ルール・Notion運用](https://app.notion.com/p/39a06467984f81ceadc7c3da95dfed68)
