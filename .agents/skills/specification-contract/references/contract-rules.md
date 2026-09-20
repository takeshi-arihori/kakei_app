# Contract Rules

## 1. 入力と根拠

最初に対象操作と根拠を固定する。

- Requirement／User Goal／Actor／Trigger／Success Outcome
- Accepted ADR、Confirmed Domain Rule、用語定義
- 正常、境界、拒否、競合、再試行の具体例
- 現行実装やDB制約を確認した場合は、業務根拠ではなく実装Evidenceとして分離した記録

各条件にEvidenceとKnowledge Stateを持たせる。

| State | 扱い |
| --- | --- |
| `Confirmed` | 正本または明示Decisionで確認済み。契約とTestの確定入力にできる |
| `Proposed` | 採用案。採用済みとして実装しない |
| `Assumption` | 作業継続の仮定。検証先と影響を示す |
| `Open Question` | 回答が必要。依存する確定・実装を止める |
| `Conflict` | 根拠が矛盾。解消まで依存する確定・実装を止める |

`Proposed`や`Assumption`を、記述の都合や既存Codeの存在だけで`Confirmed`へ昇格させない。

## 2. 契約4分類

### Precondition

操作開始時にActor、入力、対象状態が満たす必要のある条件。違反時の拒否と状態保証を対応する`FAIL`へ記載する。

例: 現在OwnerだけがOwner譲渡を要求でき、譲渡先は同じGroupのActive Participantである。

### Postcondition

操作成功後に必ず成立するDomain State、結果、外部から観測可能な効果。希望や実装手順ではなく検証可能な結果を書く。

例: 成功後のOwnerは指定Participantで、旧OwnerはActive Participantとして残る。

### Invariant

操作前後と有効なDomain Stateで常に成立する業務Rule。単一操作だけの開始条件や、DBの都合だけで課した制約をInvariantへ入れない。

例: Active Ownerは常に1人で、そのOwnerは同じGroupのActive Participantである。

### Failure / Rejection

Precondition違反、Domain拒否、競合、依存障害、再試行時に返す結果と、変化してよい状態・変化してはいけない状態を書く。単に「失敗する」で終えない。

原則としてDomain拒否では業務状態を変更しない。Audit、Metric、Log等の技術的副作用は業務状態と分け、保存可否・機密性・失敗時の扱いに根拠がある場合だけ記録する。

## 3. ConcernとLayerを混同しない

| 候補 | 分類の観点 | 契約への置き方 |
| --- | --- | --- |
| Business Authorization | Actorと対象状態の業務関係で許可が決まる | `PRE`または`INV`と、違反時の`FAIL` |
| Identity / Trust Boundary | 認証済みActorを取得・検証する | Application／Security境界として明記。業務Ruleと分ける |
| Input Validation | 型、形式、必須、業務上の値範囲を検査する | 技術形式はApplication、業務上の有効範囲は根拠付き`PRE` |
| Application Coordination | 読込、Domain呼出、Port、Transaction、結果変換を調整する | Coordinationとして記録し、Domain Invariantへ昇格しない |
| Domain Invariant | 有効なDomain Stateで常に成立する | 根拠付き`INV` |
| DB Constraint | `NOT NULL`、FK、Unique等で保存形を制約する | 実装Evidence。Requirement／Domain Ruleの根拠なしに`Confirmed`な`INV`にしない |

同じ文が複数Concernを含む場合は分割する。たとえば「認証済みOwnerだけが譲渡できる」は、Actor確立をApplication／Trust Boundary、現在OwnerであることをBusiness Authorizationへ分ける。

## 4. 分類手順

1. 条件が「開始前に満たすか」「成功後に成立するか」「常に守るか」を一つずつ問う。
2. 一文に複数の時点・Concernがあれば条件を分割する。
3. 各条件の根拠を確認し、根拠が技術実装だけなら業務契約候補から外すかKnowledge Stateを未確定にする。
4. すべての`PRE`へ違反時の`FAIL`を対応させる。
5. 成功時の`POST`が`INV`を維持することを確認する。
6. 競合と再試行で二重反映、部分反映、結果喪失が起きるかを確認し、Requirementに必要な範囲だけ保証を書く。
7. 未決条件を契約本文から消さず、`Open Question`または`Conflict`として影響と停止対象を記録する。

## 5. 完全性と停止判定

次のいずれかがあれば契約を確定済みとしない。

- Actor、Trigger、Success Outcome、拒否条件のいずれかが不明
- `PRE`違反時または失敗時の状態保証がない
- `POST`と`INV`が矛盾する
- DB／UI／Frameworkだけを根拠に業務RuleをConfirmedにしている
- `Open Question`または`Conflict`が操作結果、Invariant、権限、金額、履歴を左右する
- Requirement／ADR／Domain Rule間の矛盾が解消されていない

停止時は、停止する実装・正本反映、依存しない継続作業、必要なOwner DecisionまたはDomain確認を明示する。
