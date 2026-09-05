# Domain Modeling → draw.io Integration Test Cases

## Case 1: Conflictが残る場合はDiagram更新を止める

### Input

GitHubとRepositoryで`Settlement`の意味・存在が矛盾している状態で、既存Domain Diagramを更新してほしい。

### Expected

- Domain Modeling結果へ`Conflict`を記録する。
- Conflict対象のDiagram更新を実行しない。
- `drawio_update`を呼ばない。
- 必要なDecision / Evidenceを利用者へ示す。

### Failure

- Repository側またはGitHub側を暗黙に採用してDiagramを書き換える。

## Case 2: MCP unavailableでもModelingは完了できる

### Input

Domain Modelは検証済みだが、draw.io MCP Toolが利用できない。

### Expected

- Domain Modeling成果を返す。
- Diagram Specificationを返す。
- `.drawio`生成だけを未実施として明示する。

### Failure

- MCP unavailableを理由にDomain Modeling全体を失敗扱いにする。

## Case 3: Existing Diagramはreadしてからupdateする

### Input

`docs/diagrams/domain-model.drawio`が既に存在し、新しいConceptを追加したい。

### Expected

1. `drawio_read`
2. Existing IDとDomain Model差分を確認
3. `drawio_update`
4. `drawio_validate`

### Failure

- `drawio_create`へ`overwrite: true`を付けて既存Fileを置換する。

## Case 4: MCPへDomain判断を委譲しない

### Input

> Aggregateを良い感じに分けてdraw.ioにして。

### Expected

- Aggregate境界の根拠となるInvariant / Consistency RequirementをDomain Modeling側で確認する。
- 根拠不足ならOpen QuestionまたはAggregate Candidateへ留める。
- MCPには検証済みDiagram Specificationだけを渡す。

### Failure

- MCP Toolへ「適切なAggregateを判断して」という入力を渡す。

## Case 5: Open QuestionがDiagramの意味を左右する

### Input

`精算`が送金記録なのかArchive境界なのか未確定だが、正式Domain Model Diagramを作ってほしい。

### Expected

- 語義をOpen Questionとして扱う。
- 未確定Conceptを正式Diagramへ確定表現で追加しない。
- Domain Modelingの他のConfirmed部分は成果として返す。

### Failure

- `Settlement` NodeをConfirmed Conceptとして追加する。

## Case 6: Diagramは正本にならない

### Input

既存`.drawio`には`Settlement` Nodeがあるが、Current GitHubでは廃止済みと記載されている。

### Expected

- `.drawio`を実装上の成果物として読む。
- Current GitHubとのConflict / stale diagramとして扱う。
- Diagramの存在だけでDomain ConceptをConfirmedへ戻さない。

### Failure

- Diagramを根拠にCurrent GitHubの判断を無視する。

## Case 7: 作成後にvalidateする

### Input

新しいDomain Diagramを作成する。

### Expected

- `drawio_create`後に`drawio_validate`を実行する。
- Validation errorがあれば未完了として報告する。

### Failure

- File作成成功だけで完了扱いにする。
