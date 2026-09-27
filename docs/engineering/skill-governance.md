# Skillガバナンス

`.agents/skills/`は「どう作業するか」を定義し、`docs/`は「このRepositoryで何が正しいか」を定義する。Skillへ静的ルールを複製しない。

## 正本の分離

| 種別 | 正本 | 内容 |
| --- | --- | --- |
| 作業Workflow | `.agents/skills/` | 入力、順序、分岐、成果物、停止条件、次に使うSkill |
| Engineering Loop | `docs/engineering/engineering-loop.md` | 設計からDeliveryまでの状態遷移とGate |
| Project／技術ルール | `docs/` | Architecture、DDD、Coding、API、Persistence、Security、Test、Operations、Git／PR |
| Requirement／Done Criteria | GitHub Issue | 対象成果と完了条件 |
| Decision | Accepted ADR | 採用済みの重要判断 |

矛盾した場合は、利用者の最新明示指示、GitHubのAccepted Decision／Requirement、Repositoryの`docs/`を優先し、Skill本文で上書きしない。

## Skillに書いてよいもの

- Skillの目的と適用条件
- 必要な入力と期待する出力
- `docs/`のどこを読むかを決めるRouting
- 他Skillとの順序、委譲、戻り先
- 調査／設計／実装／Reviewの手順
- `pass`／`fail`／`blocked`等のWorkflow上の状態
- ToolやAgent Harnessを安全に使うための操作手順

## Skillに固定しないもの

次はRepositoryの`docs/`へ置き、Skillは必要時に参照する。

- 特定のProgramming LanguageとそのCoding Rule
- 特定のDB、Data Store、ORM、Migration Tool
- 特定のFramework、Library、Runtime
- 特定のAPI Protocol、Schema方式、生成Tool
- 特定のCloud Service、Queue、Cache、Observability製品
- Project固有のDirectory配置、公開API Document Rule
- JSDoc等、採用言語に依存するDocumentation Rule
- Test Runner、Lint、Typecheck、Build等の具体Command
- Migration、Security、Retention、Operations等のProject固有ルール

`API`、`Persistence`、`Migration`、`Domain`、`Test`のような技術中立な概念はWorkflowのRouting語彙として使用できる。

## Skill内referencesの扱い

`references/`はWorkflowを実行しやすくするTemplate、出力形式、質問例、操作例に限定する。Projectの正しさを決める規範的Ruleは`references/`を正本にせず、`docs/`へ置く。

既存Referenceに規範的Ruleが残っている場合、Skillはそれを正本として参照しない。改修時に対応する`docs/`へ移し、ReferenceはTemplateまたは補助資料へ縮小する。

## 技術変更への耐性

採用技術が変更されても、作業の意味が同じならSkillを変更しない。

```text
技術変更
   │
   ├─ Project Ruleが変わる ──▶ docsを変更
   │
   └─ Workflow自体が変わる ──▶ Skillを変更
```

例えば、永続化製品やAPI方式が変わっても、`database-change`や`api-design`は同じWorkflowを使い、具体的な制約だけを変更後のdocsから取得する。

## Review Gate

SkillまたはEvaluatorを新規作成・変更するときは次を確認する。

- 具体技術の採用をSkillだけで決めていないか
- Project RuleをSkillへ複製していないか
- 参照する`docs/`が明示されているか
- `docs/`変更だけで将来の技術変更を反映できるか
- 他Skillのルール本文をコピーせず、委譲しているか
- 循環呼出しがなく、統括Skillだけが全体順序を決めているか

違反があればPR前セルフレビューで修正し、独立EvaluatorでもRepositoryルール違反として扱う。
