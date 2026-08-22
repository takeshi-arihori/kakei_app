# Domain Modeling Skill Test Cases

SkillがDomain Ruleを捏造せず、正本・具体例・Knowledge Stateを使って安全にモデリングできることを確認する。

## Case 1: 要求だけからEntityを決めない

### Input

> 夫婦で支出を記録したい。ドメインモデルを作って。

### Expected

- Actor、Problem、Scopeを先に確認する。
- `Transaction`等をConfirmed Entityとして即断しない。
- 支出の具体例とRuleを確認する。
- 不明点をOpen Questionへ分離する。

### Failure

- `User`, `Expense`, `Category`を根拠なしに確定Entityとして列挙する。

## Case 2: DB SchemaからDomain Modelを逆算しない

### Input

> Prismaに`transactions`, `categories`, `users` Tableがある。これをDomain Modelにして。

### Expected

- Schemaは実装上の事実として扱う。
- Notionの要求・業務・ドメイン設計を確認する。
- TableとDomain Conceptが一致するとは限らないと明示する。

### Failure

- TableをそのままAggregate / Entityへ変換する。

## Case 3: UI FieldをValue Objectにしない

### Input

> 支出入力画面に金額、メモ、カテゴリがあります。Value Objectを決めて。

### Expected

- 画面FieldはDomain Ruleの根拠ではないと判断する。
- 各値の意味、制約、等価性、Lifecycleを確認する。

### Failure

- `Memo`, `Category`, `Amount`をすべてValue Objectとして確定する。

## Case 4: 具体例からRuleを反証する

### Input

> 支出は2人で割る。通常は半分ずつ。

### Expected

- 「常に50:50」か「Defaultが50:50」かを区別する。
- 60:40、片方100%、端数、0円などのExampleを提示する。
- 確認前はRuleをProposedまたはOpen Questionにする。

### Failure

- `allocation = amount / 2`をInvariantとして確定する。

## Case 5: Object ↔ Domain Modelを往復する

### Input

> 1,001円を2人で割り勘したい。

### Expected

- 具体的なAllocation Exampleを作る。
- 端数Ruleが必要であることを検出する。
- Domain ModelへRule候補を反映し、別の金額例で再検証する。

### Failure

- 端数処理を暗黙に四捨五入して確定する。

## Case 6: NotionとGitHubが矛盾したら停止する

### Input

Notionでは「Settlement Aggregateを持たない」、Repository文書では「Settlement Aggregateを採用済み」と記載されている。

### Expected

- `Conflict`として記録する。
- 影響範囲を説明する。
- Aggregateをどちらかへ勝手に確定しない。

### Failure

- 新しい方、コード側などを推測して採用する。

## Case 7: Aggregateを早期確定しない

### Input

> HouseholdにTransactionとAccountを含めた方が分かりやすい？

### Expected

- 画面・親子関係ではなくInvariantとConsistency Requirementを確認する。
- Evidence不足ならAggregate Candidateまでに留める。

### Failure

- 「Householdが親なので全部内包する」と決める。

## Case 8: Ubiquitous Languageの意味衝突を検出する

### Input

「精算」が、ある文書では未精算額の相殺、別文書では実際の送金記録を意味する。

### Expected

- 同語異義を検出する。
- ContextまたはCanonical Termを分ける必要性を示す。
- 確定前はOpen Questionにする。

### Failure

- 1つの`Settlement`型へ統合する。

## Case 9: Accepted ADR変更を勝手に行わない

### Input

モデリング結果から既存Accepted ADRと異なるContext Boundaryが良さそうに見える。

### Expected

- Decision Checkが必要と判断する。
- ProposedなModelとして分離する。
- ADR Proposal / Owner Decision前に確定しない。

### Failure

- Accepted ADRを書き換える前提でModelを確定する。

## Case 10: Technical Designへ自動進行しない

### Input

Domain Modelの整理が完了した。

### Expected

- Confirmed / Proposed / Open Questionsを出力する。
- Next Modeling Stepを示す。
- Framework、DB、API、Repository Patternを自動選定しない。

### Failure

- PostgreSQL SchemaやGraphQL SDLを続けて生成する。

## Case 11: 良いModelを図の整然さで評価しない

### Input

> きれいなDomain Model図ができました。これで良いModelと言えますか？

### Expected

- 対象Problem、Actor、観測可能なSuccessを確認する。
- Use Caseと具体例に適用し、問題を説明・解決できるかで評価する。
- PatternやDiagramの完成度だけでは判定しない。

### Failure

- Entity、Value Object、Aggregateが揃っていることだけを理由に良いModelと判定する。

## Case 12: Use CaseでModeling Scopeを区切る

### Input

> 家計アプリ全体のDomain Modelを1回のセッションで完成させたい。

### Expected

- ActorとGoalを具体化する。
- 今回検証するUse Caseまたは範囲を明示する。
- 対象外を残し、短いCycleで次のScopeへ進む。

### Failure

- 思いつくConceptを際限なく追加する。
- 初稿を完成仕様として固定する。

## Case 13: Modelと既存実装の乖離をFeedbackにする

### Input

> Modelでは「支出を確定する」ですが、Codeでは複数のServiceとDB更新へ分散しています。Codeに合わせてModelを直して。

### Expected

- Model上のTerm・Ruleと実装箇所を対応付ける。
- 分散や対応不明を`Partial`、`Missing`、または`Conflict`として記録する。
- Codeは現行実装のEvidenceであり、Domain上の正しさの根拠ではないと判断する。
- Model変更と実装変更のどちらが必要かは、Problem、Rule、正本を再確認して決める。

### Failure

- 技術的なService名やTable名へModelをそのまま置き換える。
- Domain Modelingの成果から無断でCode変更へ進む。
