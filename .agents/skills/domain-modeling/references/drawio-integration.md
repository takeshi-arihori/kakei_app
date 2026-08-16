# draw.io Integration Contract

Domain Modelingの判断結果をdraw.io MCPへ渡すときの責務境界と安全条件を定義する。

## Principle

Domain ModelingとDiagram Renderingを分離する。

```text
Notion / Domain Expert
        ↓
Domain Modeling Skill
        ↓
Validated Domain Model
        ↓
Diagram Specification
        ↓
draw.io MCP
        ↓
.drawio file
```

MCPはDiagram Specificationを描画するだけで、Domain Concept、Business Rule、Aggregate、Bounded Contextを推測しない。

## When to Use MCP

draw.io MCPを呼び出せるのは次をすべて満たす場合だけとする。

- UserがDiagram作成・更新を求めている、または成果物としてDiagramが明示されている。
- 描画対象のConcept、Relationship、LabelがDomain Modeling側で特定済み。
- Diagramの意味を変える`Conflict`がない。
- Diagramの意味を変える`Open Question`がない、または未確定部分をDiagramから除外できる。
- 対象PathがRepository内で決まっている。

MCPが利用できない場合はDomain Modelingを停止しない。Diagram Specificationまで返し、`.drawio`作成だけを未実施として報告する。

## Diagram Specification

MCPへ渡すDataは次の形に正規化する。

```json
{
  "name": "Domain Model",
  "nodes": [
    {
      "id": "concept-transaction",
      "label": "Transaction",
      "x": 40,
      "y": 40
    }
  ],
  "edges": [
    {
      "id": "relation-household-transaction",
      "source": "concept-household",
      "target": "concept-transaction",
      "label": "1 : many"
    }
  ]
}
```

## ID Rules

Diagram IDは描画上の安定識別子として扱い、Domain IdentityやDB IDとして扱わない。

推奨:

- `actor-<name>`
- `system-<name>`
- `external-<name>`
- `usecase-<name>`
- `concept-<name>`
- `relation-<source>-<target>`

同じ意味のElementは更新時も同じIDを維持する。

## Label Rules

- CanonicalなUbiquitous Languageを使う。
- Domain ModelではTechnical Class名よりDomain Termを優先する。
- Relationship Labelには必要な場合だけRole、Direction、Multiplicityを記載する。
- ConfirmedでないBusiness Ruleを確定表現でDiagramへ書かない。
- 詳細なRule表はtext output / Notionを正本とし、Diagramへ情報を詰め込みすぎない。

## Mapping

### System Context

Node:

- Actor
- Target System
- External System

Edge:

- Major Interaction

### Use Case

Node:

- Actor
- Use Case

Edge:

- Actorが達成するGoalとの関連

### Domain Model

Node:

- Confirmedまたは明示的にProposedと区別できるDomain Concept

Edge:

- Relationship
- Direction
- Multiplicity

Object ExampleはDomain Modelと同じFileへ混在させず、必要なら別Diagram/Pageに分ける。

## Create Flow

1. Domain ModelingのOutputを確定する。
2. `Conflict` / `Open Question`が描画意味へ影響しないことを確認する。
3. Diagram Specificationを生成する。
4. `drawio_create`を呼ぶ。
5. `drawio_validate`を呼ぶ。
6. Validation errorがあれば完了扱いにしない。
7. 作成Pathと、Diagramに含めたKnowledge Stateを報告する。

既存Fileがある場合に`overwrite: true`を自動指定しない。既存Fileを更新するFlowへ切り替える。

## Update Flow

1. `drawio_read`で既存Diagramを読む。
2. Existing IDとModel差分を比較する。
3. Domain上の変更理由を確認する。
4. `drawio_update`へ最小のtyped operationを渡す。
5. `drawio_validate`を実行する。
6. Domain ModelとDiagramの差分を再確認する。

未知・unsupportedなdraw.io構造をMCPが読めない場合、Fileを作り直して上書きしない。Blockerとして報告する。

## Tool Contract

期待するTool名:

- `drawio_create`
- `drawio_read`
- `drawio_update`
- `drawio_validate`

SkillはToolが存在すると仮定しない。利用可能なToolを確認してから呼び出す。

## Knowledge-State Guardrail

### Confirmed

通常のDomain Diagramへ描画してよい。

### Proposed

必要な場合だけ、Proposalであることが利用者に分かるDiagramまたは別Pageへ描画する。Confirmedと同じ見た目・同じ扱いで混在させない。

### Assumption

原則として正式Diagramへ含めない。検討用Diagramが必要な場合はAssumptionであることを明示する。

### Open Question

意味が確定しないElement / Relationshipは正式Diagramへ追加しない。

### Conflict

Conflict対象を更新しない。先に正本の整合を解消する。

## Never Do

- MCP Toolへ「適切なAggregateを考えて」のようなDomain判断を委譲しない。
- `.drawio`に存在する箱を理由にDomain ConceptをConfirmedへ昇格しない。
- Existing DiagramをNotionより優先する正本として扱わない。
- Validation前にDiagram作成を完了扱いにしない。
- Existing Fileを読まずに更新しない。
- MCP unavailableを理由にDomain Modeling全体を失敗扱いにしない。
