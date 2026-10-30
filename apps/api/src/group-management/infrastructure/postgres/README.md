# GMのPostgreSQL保存と認証Scope参加

[Task #242](https://github.com/takeshi-arihori/kakei_app/issues/242)、[Accepted招待コード設計](../../../../../../docs/security/invitation-code-lifecycle.md)に従う。Domain/公開API/通常main・Devの接続は変更しない。

## 保存責務

- [PostgresGroupCommitKernel](group-commit-kernel.ts)が既存locator key-state、CloseIntent登録、State Writer、保護operation、共通locatorを所有する。PoolやTransaction制御を持たない。
- [PostgresGroupRepository](group-repository.ts)はstandaloneのBEGIN/COMMIT/rollback/releaseと、Unique敗者の全rollback後の成功照会を所有する。COMMIT送信後の障害は接続を破棄し、確定失敗とせず同operationで照合する。
- [State Writer](group-state-writer.ts)と[Preparer](group-record-preparer.ts)はoperation形式に依存せず、既存CAS/Policy版/現在行/追記履歴/在籍索引を共用する。
- [共通Reader](group-read-repository.ts)はActor/opの全Command・全Group共通namespaceを読む。[operation codec](group-operation-record.ts)は旧payloadVersion1をbyte不変で使い、新payloadVersion2だけを追加する。Envelope/AAD/schemaVersionは既存形式を維持する。新旧actionの衝突は両側でMismatchにし、新actionを文字列fingerprintへ偽装しない。

## 認証Scopeへの参加

[createEnlistedGroupRepository](enlisted-group-repository.ts)は、Compositionから`registerGroupParticipant`関数と必要なWriter/暗号/鍵Portだけを受ける。owner registry、Pool、接続取得、BEGIN/COMMIT/ROLLBACK/releaseを保持・公開しない。登録で返るquery/beginPlan/attestを非公開にし、Applicationへは[#241のPort](../../application/recipient-invitation-repository.ts)と保守診断だけを返す。

prepareは同registryのqueryでlocator→proof key-stateをFOR SHAREし、世代をScope identityへ固定する。Actor/Session/codeより前に実行し、Group Lock後にkey-stateへ戻らない。rotationは同じ行の排他Lockを必要とする。current proofが未設定/利用不能でも保持済み成功の読取は可能で、新規時だけcurrentを要求する。

`findOperation`は保存成功のActor/op/Group/版/形式を照合し、結果行をFOR SHAREして削除と直列化する。コード行/宛先Actor/現在Owner/Group現在版/current proof鍵を再送条件にしない。proof照合はApplicationが保存世代の独立Portで行う。

`loadForInvitation`は在籍索引→Group FOR UPDATE→索引再照合→復号の順とし、非在籍はdecrypt0で存在非開示のnullを返す。Groupを複数扱う場合もID昇順を要求する。認可済みRootは呼出し側へ返すGroupと参照を共有しない非公開payloadとして固定し、stage時に独立復元する。返却GroupのOwner/Policy/内部状態を書き換えても認可根拠を変更できない。stageは認可loadしたActor/版と、単一Created履歴/期待Root/Policy/結果/最小本文を照合する。既存の純粋Group遷移と一致したRootだけを共通kernelへ渡す前にregistryの`beginPlan`で新規handle/計画/本文を一回受付し、実GM Audit成功後だけ同handle/codeId/宛先/operation/本文をattestする。

偽Scope、他Scopeの本文、異binding、失敗計画、CAS/Unique/SQL/暗号/Audit障害から新規証跡を返さない。未await/握り潰しSQL/受付終了/consumeと本文の一致は実registryにも検証させ、ownerが全rollbackする。保存済みoperationを新規消費証跡へ変換したり、新規業務を自動再実行したりしない。

## Auditと保持

[独立Audit Protector](../group-invitation-audit.ts)はGM/Group単位の独立256-bit鍵を注入し、Actor/Group/Invitation/request-fingerprintをcanonical TLVと異なるpurposeでHMACする。Group DEK、locator、code proof、認証Audit鍵を流用しない。request semanticはActor/Group/Resource/action/Policy版/operation/proofに束縛し、入力をawait前にCopyする。[Audit Writer](group-invitation-audit-writer.ts)は同queryへ最小仮名だけを保存する。

Auditの平文はserver request UUID/UTC/action/decision/reason/Policy版/用途別仮名/要求指紋/鍵世代だけ。直接Actor/Group/Invitation/codeId、原コード、proof、Profile、SQL例外を保存しない。Group削除cascadeを持たず90日保持し、Audit鍵はその保持と関連Backup35日まで保持する。今回のWriterは招待作成の成功Auditを対象とし、汎用Snapshot Auditや拒否記録/公開運用の完成を意味しない。

proof世代/値とcodeId/宛先bindingは保護operation内だけに置き、平文Actor/proof参照索引を増やさない。`countProofReferences`は保持中の保護結果を検証してlive参照件数を返し、破損/鍵喪失をskipしない。0件は破棄許可ではなく、具体Providerの関連Backup35日window closureも必須。Adapterに鍵破棄能力を追加せず、コード行清掃/Actor削除へproof/Audit鍵を巻き込まない。

## 検証と残る境界

Unitは旧byte互換、新形式/未知field/版/用途/結果binding、Audit独立参照vectorと非同期Copy、偽Scope/能力非公開を確認する。実PGは実GM/既存AEAD/実registryを使い、保存/故障全rollback、非在籍decrypt0、現在Owner喪失・code行なし・旧proof再送、共通namespace/Unique/CAS、2接続のkey-state/Group Lock、結果不明後の明示照会、参照検査/削除を検証する。

実PGでの認証ownerとコード消費Writerは合成であり、実Session本人性・実コード消費・両Context Auditの業務atomicityを保証しない。これらの最終統合は#243、清掃/Restoreは#244/#245、公開契約は#246以降。具体鍵Provider、90日清掃、Backup/Restore、Ledger/Witness、退会、Ingress/監視と既存Production Gateは別途必要であり、通常main/Devへwireしない。


## 新規計画受付の契約Trace（#242）

Knowledge State: Confirmed。根拠はAccepted R4/IC-FAIL-2と#242 Done Criteriaの同Scope/一回証跡/部分確定禁止。技術的受付を新しいDomain Invariantと混同しない。

| ID / 分類・責務 | 条件と状態保証 | 検証 |
| --- | --- | --- |
| GM-PRE-1 / Identity・Trust Boundary | open/準備済みの新規Scope、同一handle/code/宛先、同Scope本文、未受付のoperationをbeginPlanで束縛する | caller-only誤用、偽binding/他Scope本文、受付前DML拒否 |
| GM-PRE-2 / Application・Persistence | 認可loadのActor/版と、純粋Group遷移/最小結果/履歴が一致する | 偽Root、返却GroupのOwner/Policy/内部状態変更、CAS、在籍索引/decrypt0 |
| GM-POST-1 / Persistence | 同queryのGroup/履歴/operation/locator/GM Auditが成功後だけattestする。stageはcommit結果ではない | 各write/Audit故障、Audit guard除去Mutation |
| GM-POST-2 / Coordination | attestは受付時のoperation/本文handleと一致する。GM業務DMLは受付済み計画だけ | operation/value差替え、未受付DML、二度目の受付 |
| GM-INV-1 / Domain | 既存GroupのActive Owner/在籍人数等の業務不変条件を維持し、7日Pending/枠予約なしを変更しない | 既存Domain回帰、実Group遷移再照合 |
| GM-FAIL-1 / Infrastructure | 不正受付/再受付はScopeを失敗済みにする。例外を握り潰してもcommit不可 | caller-only+非SQL障害、二度目stageからの先行証跡消費拒否 |
| GM-FAIL-2 / Infrastructure | 新規ScopeのSQL/非SQL障害は未完成計画を確定せず全rollbackする | fault injection、未await/握り潰し、非SQL障害 |
| GM-FAIL-3 / Concurrency | Unique/CAS敗者は全rollback後の照会、COMMIT不明は同operation明示照会。業務自動再実行なし | 2接続/応答喪失/保存世代再送 |

この受付は認証ownerの管理用queryを制限せず、SQL TransactionのBEGIN/COMMIT/ROLLBACK能力をGMへ渡さない。共有認証はGMの業務意味を持たず、実GM Adapterだけが成功計画とAuditを証明する。
