# Modeling Principles

## 目的

ドメインモデリングは、Software Patternを当てはめる作業ではなく、対象Domainの問題・概念・Ruleを理解し、変更に耐えられる共通言語を形成する活動とする。

Domain Modelは現実を網羅的に写すものではない。解決する問題に関係する側面を意図的に選んだ抽象であり、良し悪しは図の整然さやPatternの数ではなく、対象の問題を説明・検証・解決できるかで判断する。

## Concrete First, Abstract Later

抽象概念だけで議論を進めず、必ず具体例へ戻る。

- 具体例からObjectを確認する
- Object間の共通点からConceptを抽出する
- Concept間のRuleをDomain Modelへ表現する
- Modelを再度具体例へ適用して破綻しないか確認する

モデルを説明できる具体例が存在しない場合は、理解が十分ではない。

## Model is a Hypothesis

Domain Modelは確定仕様ではなく、現時点のDomain理解を表す仮説である。

新しい事実が判明した場合は、Use Case、Object Example、Domain Model、Ubiquitous Languageを同時に見直す。

初稿から清書しない。複数の視点を素早く出して書き換えられる粗いModelから始め、意味が安定した後に正本へ反映する。

## Keep Model, Implementation, and Operation in a Feedback Loop

既存実装または運用実績がある場合は、Modelと双方向に照合する。

- ModelのTerm・Rule・Lifecycleが実装のどこに表現されているか確認する
- 実装から得た制約や運用上の発見を、Modelの反例またはQuestionとして戻す
- 対応が不明、分散、または技術語へ置換されている箇所をFeedbackとして記録する
- 小さなScopeでModelingと検証を短く往復し、失敗を早く発見する

ModelとCodeの形を機械的に同一にすることが目的ではない。Domain上の意味を追跡でき、変更時に相互の影響を説明できることを目指す。Repositoryは現行実装のEvidenceであり、それだけでDomain RuleをConfirmedへ昇格させない。

## Domain Knowledge Must Have Evidence

Domain Ruleには根拠が必要である。

根拠の優先順位:

1. 利用者の最新の明示指示
2. NotionのCurrent / Accepted情報
3. Domain Expertへの確認結果
4. Repositoryに実装されている事実
5. Working Assumption

4は「現在そう実装されている」ことの証拠であり、「業務上正しい」ことの証拠ではない。

## Separate Knowledge States

すべての重要なRule・Boundary・Termを次のいずれかへ分類する。

| State | 意味 |
| --- | --- |
| Confirmed | 根拠があり、現時点で採用済み |
| Proposed | 検討案。採用前 |
| Assumption | 一時的な仮定 |
| Open Question | 情報不足で判断不能 |
| Conflict | 複数の正本が矛盾 |
| Deprecated | 廃止済み |
| Superseded | 新しい判断に置換済み |

AIはStateを暗黙に昇格させない。

## Ubiquitous Language

名称だけでなく意味を揃える。

同一語が複数Contextで異なる意味を持つ場合は、無理に統合せずContextごとのLanguageとして保持する。

## Technical Concerns Are Not Domain Facts

次はDomain Ruleの根拠にしない。

- DB Schema
- ORM Model
- API Schema
- UI Form
- Frameworkの制約
- Existing Directory Structure

これらとDomain Modelが一致する場合でも、Domain側の根拠を別途確認する。

## Aggregate is a Later Decision

AggregateはEntityの集合ではなく、同時に整合性を守る最小境界として検討する。

Aggregate候補を決める前に、最低限次を確認する。

- Invariant
- 変更単位
- 同時更新要件
- Lifecycle
- Transactional Consistencyの必要範囲

画面単位、Table単位、API Mutation単位を理由にAggregateを決めない。

## Source Notes

このGuideは次の発表から、問題解決のための抽象、Use CaseによるScope設定、粗い初稿、Modelと実装・運用のFeedback Loopを採用している。

- [DDDオンライン勉強会 #1「モデリング/実装入門」— Modelと良いModel（30:48〜）](https://www.youtube.com/watch?v=19Gbx9jWLdc&t=1848s)
- [同 — Use CaseとDomain Model図（53:13〜）](https://www.youtube.com/watch?v=19Gbx9jWLdc&t=3193s)
- [同 — ModelとCodingの反復（2:00:14〜）](https://www.youtube.com/watch?v=19Gbx9jWLdc&t=7214s)
- [同 — 短いCycleでのModeling（3:07:54〜）](https://www.youtube.com/watch?v=19Gbx9jWLdc&t=11274s)

発表内ではDomain Model図作成時にAggregateも決める方法が紹介されているが、このSkillではInvariantとConsistency RequirementのEvidenceが揃った時点でのみAggregate候補を判断する。
