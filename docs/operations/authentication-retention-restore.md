# 認証Retention・削除・Restore Runbook

[保守契約](../security/authentication-maintenance.md)と[Accepted A2](../security/authentication-protected-storage.md) §8を運用へ写像する。#217はPort／Coordinator／DB Adapterと合成障害検証まで。本Runbookは実Provider、Scheduler、Operator CLI、監視配信、本番の開通機構が実装済みという証拠ではない。これらの具体運用値と権限を決める正式Taskを本番接続前にReady化する。

## 清掃と期限未達

1. 注入ClockのUTCと正常な鍵Stateを確認する。小Batch単位で清掃を呼び、期限前のRowを消さない。呼出し頻度／Batch／retry backoffは本番Taskで決める。
2. dueAtから24時間以内にRowと全DEK世代の破棄を終える。Auditは90日経過をdueAtとする。通常認証は期限時点で拒否する。
3. 固定operation／Codeと最古dueAt／deadlineの監視を収集する。Lock skipを期限遵守と数えず、overdue・Provider／SQL／Audit失敗・結果不明を通知する。通知にはToken、Cookie、Google本人性、直接Actor／scope ID、管理参照、自由文例外を含めない。
4. 既知overdueは鍵照会／破棄や削除disableより先に利用受付を封鎖し、後続障害時も封鎖を維持する。途中で期限を跨いだ失敗も再判定する。quarantineは利用受付を封鎖し、進行中leaseをdrainする。外部閉鎖の実体を確認できない場合も成功を返さない。DB quarantine中の保守清掃は再試行できるが、restoring中はRestore専用手順を使う。
5. 行削除後の鍵障害／commit応答喪失はdurable pending ticketと新Transaction 0-rowで再照合する。元ticket／operationを捨てて完了件数を増やさない。監視または破棄証跡を失った状態で通常受付へ戻さない。

## 削除の再試行

外部Prepared・Checkpoint／Witness → DB disabled／全Session revoked／同Intent／Auditの共通commit → scope inventory確定／Row除去 → 全世代Destroyed／closure＋0-row → 外部Complete／Witness → DB completeを確認する。ActorとGroup過去参照は保持する。利用者の受付認可・未完了業務判断は別機能であり、この内部Portを直接公開しない。

Preparedは取り消さない。障害後は同operationを最新Ledgerと全ticket版へ照合する。Completeが外部にあっても旧BackupのRowが復活していれば再削除する。片側Checkpointのみ、Witness遅延、DBだけのIntent、孤児ticket、参照／仮名世代不一致、必要旧鍵欠損、fork／stale headは隔離する。単なる「AlreadyDestroyed」や最新一世代だけを完了証拠にしない。

Providerの読取例外は管理票欠落と断定せず同operationで再照合する。正常応答でPrepared／Completeに対応する管理票の欠落・参照・期限・Identity scopeの不一致を確認した場合は、期限内でもDBを封鎖し固定Codeを通知する。封鎖確認後の通知障害で隔離状態を取り消さない。封鎖の成否が不明ならunavailableとし、隔離完了を主張しない。

Witness修復は真正な同headとFailure domainの運用証拠を確認する専用Operator手順で行い、forkを上書きしない。外部Prepared前の孤児ticketは自動受諾・取消せず、Providerに残るappend結果を独立証跡で裁定する。本実装に手動force-openや証跡skipの入口を設けない。

## Backup復旧の順序

1. **DBを差し戻す前に**、DB外の所有run fenceでTraffic、新規認証、保守Writer、別Restoreを閉じる。進行中Writerをdrainし、拒否が実際に効くことを確認する。DBのactive flagやDB Backup内のfenceを信用しない。
2. 信頼済みcatalogから35日以内のBackupを選ぶ。物理BackupとManifest（取得UTC、schema v6、key-state版、epoch、checkpoint sequence／hash）の真正性・対応をProviderで確認する。未来／35日超／欠損は拒否する。認証鍵、Nonce registry、Ledger、Witness、外部epoch制御をDB Backupと一緒に巻き戻さない。
3. 閉鎖下でBackupを復元し、同run IDでRestore Coordinatorを呼ぶ。key_state排他Lockでdrainし、初回はManifestと現DB版の完全一致を確認する。固定Manifest／runへ許可した隔離版をDB外へdurable登録してからrestoringへ移行し、再試行はその進行記録を照合する。最新Checkpoint／Witnessの署名・challenge・chain・MAC・Manifest所属を検証する。
4. 最初に、未完了Actor票をProvider所有の固定snapshot cursorで真の末尾まで全件照合する。1,000件超も打ち切らず、途中の集合／版変更・不正cursor・重複／欠落で隔離する。その後、最新の全Prepared／Completeを再適用する。DBだけのIntentを拒否し、削除Identity／Session／Alias、全鍵世代Destroyed、0-rowを確認する。削除済み鍵の復号失敗を理由に削除意思をskipしない。
5. 全Attempt／Sessionを期限に関係なく除去する。削除前のdurable scope登録、全世代破棄・0-rowを確認し、旧Cookieを拒否する。
6. 外部revision CASで新epochと現行全用途鍵世代を公開し、応答喪失時は同runの公開実体を読み直す。保持Identityの旧鍵Sealを永久停止し、独立新DEK／durable Nonce世代で再Sealする。Actor MAC、全required Alias、本人一意性と参照整合を再検証する。破損や重複はrollback／隔離する。
7. 最新削除headを再確認し、増分を適用する。移行fingerprintを持つ同run recovery checkpointをconditional appendしWitness一致を確認する。DB completion所有と現在fingerprintを再検証しactiveへCAS、最後に外部fence／epoch／revision／head CASで開通する。いずれか不一致なら閉鎖を維持する。
8. #218／#219接続後は、旧Cookieの実HTTP拒否、新規ログイン、清掃、監視配信まで確認する。現段階のEvidenceは内部Storeの旧Cookie拒否・新epochの新Attempt成立まで。

各段の中断後も同run／operationを保持して再試行する。発行済みepoch、burn済みNonce、破棄済み鍵を巻き戻さない。DB active直後・外部open前の中断では外側fenceを維持する。外部open応答喪失や開通後の監視失敗では、同runで直ちに外部を再閉鎖・検証し、DBも拒否状態にする。両方の封鎖が確認できた場合だけquarantined、一方でも不明ならunavailableとし、成功扱いしない。破壊的Down Migrationや古い鍵への戻しは使わない。

## 本番接続前の未実装Capability

| 必須Capability | 必要な実Evidence |
| --- | --- |
| 認証専用鍵／Nonce Provider、IAM、独立ランダム用途鍵 | DB外のdurable単調割当、後退検知、rollback burn、旧鍵Seal停止、新世代、全scope／burn世代inventoryとclosure |
| durable destruction ticket／proof／pending列挙 | Process再起動・応答喪失・部分破棄・inventory変更時の版束縛、固定snapshot全件列挙と所有cursor、別operation／scope証跡拒否 |
| 認証Ledger／Checkpoint／独立Witnessとattestation Verifier | append-only、linearizable latest、expected head CAS、fresh challenge、独立Failure domain、rollback／fork検知と復旧訓練 |
| DB外Restore fence／epoch publish／Traffic open | 所有run／revision CAS、Manifestと隔離進行版のDB外durable記録、他Writer停止とdrain、別Restore拒否、DB巻戻しで開通しない実配置 |
| 信頼済みBackup catalog／Manifest | 物理Backupとの真正な対応、35日保持・削除、鍵と外部制御の別管理、定期復旧訓練 |
| Scheduler／監視／運用入口 | 頻度・Batch・retry・権限・Alert配信・24時間未達時の封鎖・最古overdueの継続監視 |
| 認証HTTP／画面・退会業務 | #218／#219の個別Ready、CSRF／Origin／Cookie／Rate limit／Proxy、未完了業務と過去参照の受付方針 |

合成Providerの成功をこれらの完了へ読み替えない。具体製品・配置・運用値は未承認のまま固定せず、後続Taskの設計・独立Security Review・実運用Evidenceが揃ってから本番Compositionへ接続する。
