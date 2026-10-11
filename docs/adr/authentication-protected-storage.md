# 認証Dataの保護保存・原子的確定・復旧

- Status: Proposed（Owner承認待ち。実装／Production有効化の承認ではない）
- Proposed Date: 2026-10-11（Asia/Tokyo）
- Decision Owner: Project Owner
- Decision Issue: [ADR #212](https://github.com/takeshi-arihori/kakei_app/issues/212)（Proposed）
- Design Task: [A2 #213](https://github.com/takeshi-arihori/kakei_app/issues/213)
- Related Epic: [#202](https://github.com/takeshi-arihori/kakei_app/issues/202)
- Supplements: [認証Lifecycle ADR](google-login-actor-session.md)、[ADR #55](snapshot-revision-security-and-retention.md)
- 詳細契約: [認証保護保存仕様](../security/authentication-protected-storage.md)

## Problem / Scope

PR #211は認証Applicationと原子的Store Portを実装したが、認証DB、暗号・鍵・検索、一意性、Audit、清掃、Restoreの実証はない。Group用Envelope／Digest PortはGroup IDを要求し、そのままAccountへ使えない。A2はこのGapを設計し、後続を検証可能なTaskへ分割する。今回の差分は文書のみである。

## Decision案

1. 既存PostgreSQL 17・raw pg・番号付きSQL Migrationを使い、`authentication` SchemaがActor、Identity、Attempt、Session、認証Audit、鍵世代の制御行を所有する。GroupとのCascade／直接Table参照は追加しない。
2. Google issuer＋sub、Server期待nonce、Login／Session CSRFは認証専用AES-256-GCM Envelopeへ入れる。Cookie秘密値は暗号化も平文保存もせず、用途別HMAC-SHA-256検索値だけを保存する。nonce／CSRFは検索Keyにしないため追加Digestを保存せず、束縛Envelopeの復号値を定数時間比較する。
3. Identity暗号鍵はActor別、Attempt／Session暗号鍵はRecord別、検索鍵・Audit仮名鍵・削除証跡鍵は別用途・別Namespaceとする。認証専用Canonical TLV AADでRow、版、期限、状態、索引を束縛する。既存Group形式とGolden vectorは変更しない。
4. Identity検索鍵の更新は世代Stateの共有／排他Lockと全検索可能世代のAliasを使い、全移行・重複検査後に旧世代を退役する。Cookie検索鍵は原値を保存しないため再Hashせず、旧世代の有効Recordがなくなるまで読取を継続する。全鍵はDB Backupと別管理し、Nonce割当はrollbackでも戻さない。
5. Google通信はDB Transaction外で行う。completeでは保存時点に再検証し、Actor作成／再利用、Identity Alias、Session、Attempt消費、成功Auditを同じPostgreSQL Transactionで確定する。Session利用・Logout・Actor無効化・清掃は共通Lock順に従う。commit不明時は秘密値やCallback結果を返さず再ログインさせる。
6. 認証判定は常に期限／状態を確認し、Batch完了を待たない。Attempt／Sessionは無効化から24時間以内、Auditは90日後の清掃対象とする。退会は無効化・全Session失効を先に行い、Identityと全復号鍵の除去を24時間以内に検証する。Groupの過去Actor参照は残す。
7. 最大35日のBackup復旧ではTrafficを閉じ、外部Checkpoint／Witness・削除Ledger・鍵Stateを検証する。復旧したAttempt／Sessionをすべて破棄し新しい認証epochへ切り替える。削除済みIdentityの復活をLedgerと鍵破棄で防ぎ、Nonce世代を更新する。期限超過Backup、証跡不整合・不足・鍵障害では開通しない。

## Alternatives / Consequences

| 代替 | 判断案と理由 |
| --- | --- |
| Group IDを仮造して既存Codecを使う | 不採用。Data Owner／用途境界を偽装する |
| issuer＋subの平文Unique／非Keyed Hash | 不採用。DB漏出時の外部Identity照合を容易にする |
| 決定的暗号で検索も兼ねる | 不採用。検索用HMACと乱数NonceのAEADを分離する |
| nonce／CSRFも索引化する | 不採用。Record選択はCookie Digestで足り、相関項目を増やす必要がない |
| Session秘密値を暗号化保存し再送成功を復元 | 不採用。既存の秘密値非復元契約を維持する |
| RestoreしたSessionを失効履歴で救済 | 不採用。全破棄・再ログインの方が欠落履歴からの復活を防ぎやすい |

認証Schema内のランダムActor FKによるIdentity／Sessionの関連、行数・時刻・活動量はDBに見える。検索HMACも匿名化ではなく、鍵侵害時は照合可能である。APIプロセスとKey Providerの同時侵害、完全に整合したDB rollbackはAEADだけでは防げない。Checkpoint／Witness、最小権限、Providerの独立ReviewをProduction Gateとして残す。

## Acceptance / Delivery Gate

Owner承認と独立Security Reviewの両方が揃うまで本ADRをAcceptedにせず、依存実装TaskをReadyにしない。設計案の文書化／Review Taskだけは進められる。方式・TTL・保持の既存Accepted ADRは変更しない。独立ReviewのpassはOwner承認やProduction実証の代替ではない。

通常のdevelop向けDraft PR。A2統合後、Schema → 暗号部品 → 原子的Store → 清掃／復旧境界 → HTTP → Google画面の順に個別Ready評価する。未Merge Codeを使わずStackは不要。具体Cloud／KMS、durable Provider／外部Ledger／Witness／Backup Job、退会と未完了業務、Proxy／Rate limit／開発Compositionは各TaskのGateに残す。

## Rollback / Review Trigger

今回はData変更なし、文書をrevertできる。実Data適用後は追加MigrationによるForward-fixとし、空で未使用の分離DBだけDownを許可する。暗号方式、AAD、検索／鍵更新、Actor一意性、保持／削除、Restore、Provider／本番接続を変更する場合は新Decision・Security Reviewを行う。Accepted履歴を上書きしない。
