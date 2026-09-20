# Forward Cases

このSkillの変更時に、独立Evaluatorが入力だけを読み、期待される分類・Trace・停止条件を再現できるか確認する。各Caseで`Expected`を満たし、`Must not`に該当しなければpassとする。

## Case 1: 正常なDomain Command

### Input

- Confirmed: 現在Ownerだけが、同じGroupのActive ParticipantへOwnerを譲渡できる。
- Confirmed: Active Ownerは常に1人で、Ownerは同じGroupのActive Participantである。
- Confirmed: 譲渡成功後、旧OwnerはActive Participantとして残る。

### Expected

- 現在Ownerであることと譲渡先の状態を`PRE`へ分類する。
- 新Ownerへの変更と旧Ownerの在籍維持を`POST`へ分類する。
- Ownerの唯一性と在籍条件を`INV`へ分類する。
- 正常ScenarioがPRE／POST／INVをTraceする。

### Must not

- Actor取得、DB更新順、Transaction方式をDomain Invariantとして追加しない。

## Case 2: 拒否時の状態保証

### Input

- Case 1のConfirmed Rule。
- 非OwnerがOwner譲渡を要求する。

### Expected

- `PRE`違反に対応する`FAIL`を出力する。
- 拒否され、Owner、Participant、業務履歴を変更しない保証を、根拠のある範囲で記録する。
- 拒否Scenarioを該当PRE／FAIL／INVへTraceする。

### Must not

- 「エラーにする」だけで状態保証を省略しない。
- 根拠のないAudit保存やError Codeを確定しない。

## Case 3: 技術制約との混同

### Input

- DB Schemaに`owner_id NOT NULL`がある。
- Owner存在を要求するRequirement／Domain Ruleは提示されていない。

### Expected

- `NOT NULL`をDB Constraint／実装Evidenceとして分離する。
- Owner存在Ruleは`Open Question`または根拠不足として扱う。
- Owner存在に依存する契約確定と実装を止め、必要な業務根拠を示す。

### Must not

- DB Constraintだけを根拠に`INV: Ownerは必ず存在する / Confirmed`を出力しない。

## Case 4: ApplicationとDomainの境界

### Input

- Applicationは認証済みActorを取得できる。
- Confirmed: 現在OwnerだけがOwner譲渡を要求できる。

### Expected

- Actor取得をApplication／Trust Boundaryへ置く。
- 現在OwnerであることをBusiness Authorizationの`PRE`へ置く。
- 両者の関連を示しても、一つのDomain Invariantへ結合しない。

### Must not

- 認証方式、Provider、Token形式を発明しない。

## Case 5: 未確定Rule

### Input

- Participant最大人数はまだOwner Decision前である。
- 案Aは最大4人、案Bは最大6人で、どちらもProposedである。

### Expected

- 最大人数を`Open Question`または`Conflict`として記録する。
- 影響するINV、境界Test、依存実装を停止対象にする。
- 両案の境界Test候補はKnowledge Stateを保持して提示できる。

### Must not

- `INV: 最大4人 / Confirmed`または`INV: 最大6人 / Confirmed`を生成しない。

## Case 6: Test Traceと契約漏れ

### Input

- ConfirmedなPRE、POST、INVが各1件ある。
- PRE違反時は業務状態を変更しないConfirmed Ruleがある。
- 応答喪失時の再試行保証は未定義である。

### Expected

- 正常ScenarioがPRE／POST／INV、拒否ScenarioがPRE／FAIL／INVを参照する。
- すべてのConfirmed Contract IDが最低1 ScenarioへTraceされる。
- 再試行は`Open Question`または「Requirement未定義」とし、保証方式を発明しない。

### Must not

- FAILの欠落、Contract IDの未Trace、根拠のない冪等性保証を見逃さない。

## Evaluation Result

Evaluatorは次を返す。

```text
verdict: pass | fail
findings:
  - case: Case N
    problem: ...
    evidence: ...
missing_evidence:
  - ...
```

`pass`は全CaseのExpectedを満たし、Must not違反がなく、`findings`と`missing_evidence`が空の場合だけとする。
