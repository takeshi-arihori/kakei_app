# Project-local draw.io MCP Server

家計アプリRepository内の`.drawio`ファイルを、AI Agentがraw XMLを直接組み立てずに作成・読取・更新・検証するためのProject-local MCP Serverです。

## Responsibility

このServerは**描画・ファイル操作だけ**を担当します。

扱うもの:

- typed Diagram Specificationから`.drawio`を作成する
- supportedな`.drawio`をtyped dataとして読む
- node / edge単位で更新する
- XML構造と参照整合性を検証する

扱わないもの:

- Domain Conceptの抽出
- Entity / Value Object / Aggregateの判断
- Business Rule / Invariantの推測
- Bounded Contextの決定
- NotionやADRのDecision変更

これらは呼び出し元のSkillと人間の判断に残します。

## Runtime

RepositoryのNode.js要件に合わせてNode.js 24以上を使用します。追加npm dependencyはありません。

```bash
node .mcp/drawio/server.mjs
```

Serverはstdin/stdoutのstdio transportでJSON-RPCをやり取りします。stdoutはProtocol Message専用、診断出力はstderrへ送ります。

## Root Directory

既定ではRepository rootだけを操作対象にします。

必要な場合のみ、起動時に明示的にrootを変更できます。

```bash
DRAWIO_MCP_ROOT=/path/to/repository node .mcp/drawio/server.mjs
```

Toolへ渡す`path`はrootからの相対Pathかつ`.drawio`拡張子に限定されます。絶対Pathと`../`によるroot外参照は拒否します。

## Supported MCP Eras

互換性のため次のHandshakeを扱います。

- MCP 2026-07-28: `server/discover`
- MCP 2025系: `initialize` + `notifications/initialized`

Tool APIはどちらでも同一です。

## Tools

### `drawio_create`

新しいDiagramを作成します。既存Fileは`overwrite: true`を明示しない限り上書きしません。

```json
{
  "path": "docs/diagrams/domain-model.drawio",
  "diagram": {
    "name": "Domain Model",
    "nodes": [
      { "id": "household", "label": "Household", "x": 40, "y": 40 },
      { "id": "transaction", "label": "Transaction", "x": 300, "y": 40 }
    ],
    "edges": [
      {
        "id": "household-transaction",
        "source": "household",
        "target": "transaction",
        "label": "1 : many"
      }
    ]
  }
}
```

### `drawio_read`

raw XMLではなく、`name / nodes / edges`のDiagram Specificationとして返します。

```json
{
  "path": "docs/diagrams/domain-model.drawio"
}
```

### `drawio_update`

既存Diagramを読み込んでからtyped operationを適用します。

利用可能なoperation:

- `rename_diagram`
- `upsert_node`
- `upsert_edge`
- `remove_element`

Nodeを削除した場合は、そのNodeへ接続しているEdgeも削除します。

### `drawio_validate`

supportedなuncompressed `mxGraphModel`であることと、Node / Edge参照を検証します。

## Supported draw.io Format

このServerは、追跡可能でDiffしやすい**uncompressed mxGraphModel XML**だけを対象にします。

- `darkMode="0"`を生成する
- Nodeは`vertex="1"`
- Edgeは`edge="1"`でsource / targetをNode IDへ参照する
- compressed Diagramや未知の高度なdraw.io機能を読み替えない

unsupportedなFileを無理に編集せず、validation errorとして返します。

## Safety

- Repository root外のPathを拒否する
- `.drawio`以外のFileを拒否する
- 5 MiBを超える既存Fileを拒否する
- Create時は既定で既存Fileを上書きしない
- 書込みはtemporary fileからrenameする
- Node / Edge IDの重複を拒否する
- 存在しないNodeへのEdge参照を拒否する
- Tool ErrorはMCPの`isError: true`として返す

## Test

```bash
node --test .mcp/drawio/test/*.test.mjs
```

主な検証対象:

- Path Traversal
- serialize / parse round trip
- accidental overwrite防止
- Node削除時のEdge整合性
- modern / legacy handshake
- tools/list / tools/call
- MCP Tool Error

## Client Configuration

MCP Client側では、Project rootをworking directoryとして次のCommandをstdio Serverとして起動してください。

```text
node .mcp/drawio/server.mjs
```

Clientごとの設定File名・SchemaはClientの現行仕様を確認してください。このRepositoryでは、特定Clientの未確認な設定形式を正本として固定しません。
