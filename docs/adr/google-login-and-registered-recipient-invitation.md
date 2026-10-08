# Googleログインと登録済み宛先への招待

- Status: Accepted（ログインProvider・事前登録・コード共有方式のみ）
- Decision record: [Owner承認証跡 ADR #203](https://github.com/takeshi-arihori/kakei_app/issues/203)
- Related Task: [文書同期 #204](https://github.com/takeshi-arihori/kakei_app/issues/204)
- Related Epic: [認証・招待利用経路 #202](https://github.com/takeshi-arihori/kakei_app/issues/202)
- Proposed / Accepted Date: 2026-10-08
- Decision Owner: Project Owner
- Decision Check: 方針変更あり
- Amends: [Command本人性・認可・再試行](group-management-command-authorization.md)、[招待・再参加](group-invitation-and-rejoin.md)の未決Provider・宛先解決・配送部分を補完する。既存Accepted判断は維持する。

## Context

内部のGroup Commandは信頼済みActorSubjectを受け取り、Invitationは宛先Actorへ束縛される。Provider、利用者登録、招待配送の利用経路は未確定だった。MVPを画面から利用できるようにするため、Ownerがログイン方式と招待相手の指定方法を決定した。

## Decision

承認対象は次の3点に限る。

1. MVPのログインはsocial loginのみとし、最初のProviderはGoogleだけとする。
2. 招待される相手は先にGoogleでログインし、アプリに登録する。
3. 登録済みの相手本人が一回限りの招待コードを表示し、Ownerへ共有する。現在Ownerがそのコードを入力して宛先Actorに束縛されたPending Invitationを作り、相手本人がアプリ内で受諾する。アプリからの招待メール配送は採用しない。

コードは宛先指定のための手段であり、Invitation、Participant、人数枠ではない。コードの共有やOwner入力だけでGroup参加は成立しない。未登録利用者へのInvitationはこの経路では作らない。

Googleの外部識別子は検証済みissuerとsubの組で扱い、メールアドレスをActorの識別子としない。これは[GoogleのIDトークン検証仕様](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)に沿う技術上の識別境界である。内部Actorとの対応付け、登録・保存・削除の契約は後続設計で定める。

## 維持する既存契約

- ADR #36の信頼済みActor、同じGroup版での認可・保存、ClientのRole／subject自己申告の拒否、非在籍者へGroupの存在を漏らさない外部境界を維持する。
- ADR #52の宛先Actor束縛、Invitationの7日期限・延長なし、枠予約なし、受諾時の最新状態・空き枠・本人再検証、現在Ownerによる取消、Owner譲渡後の既存Pending継続を維持する。
- Invitation消費と新Participant／joinOrder／Membership履歴／Group版／operation結果の原子的commit、同じActor・operationによる成功結果の再取得を維持する。脱退後は新Invitation・新Participantで再参加する。
- [ADR #55](snapshot-revision-security-and-retention.md)の保護保存・Retention・Backup・Production接続Gateを維持する。

Invitationの7日期限は招待コード自体の期限を決めるものではない。

## Alternatives

| 選択肢 | 扱い | 利点 | コスト・制約 |
| --- | --- | --- | --- |
| Googleのみ | Accepted | MVPのログインProviderを一つに絞れる | Googleアカウントが必要 |
| 複数social Provider | MVP対象外 | 利用者の選択肢が増える | Provider間のAccount対応・検証・復旧が増える |
| Password認証 | MVP対象外 | 外部Accountなしで登録できる | Password保護・Reset・認証メール等が必要 |
| 登録済み宛先本人のコード共有 | Accepted | 宛先Actorを指定でき、アプリの招待メール配送が不要 | 事前登録と利用者同士の共有が必要 |
| 未登録メール宛先へ配送 | 採用しない | 登録前に招待できる | メール所有確認と登録後の本人対応、配送契約が必要 |

## Consequences / Open Questions

Sessionや宛先指定コードの技術的Lifecycleは本Decisionで確定しない。

- Google IDトークン検証に使うSDKの追加承認、具体Port／Adapter、署名・宛先・発行元・期限・ログイン試行の対応確認。
- ログイン試行、内部Actorとの対応、Sessionの保護保存・Cookie・TTL・失効・Logout・Account削除／保持。
- CSRF／CORS、公開Error、Rate limit、監査の最小項目、Account復旧。
- コードの文字種・長さ・期限・発行数・再発行／取消・失効・保存保護・削除・原子消費とInvitation作成の競合・再送。
- 招待の宛先確認表示、本人へのPending一覧、受諾画面、API契約、E2E、本番Gateの充足。

これらに依存するTaskは設計・必要なOwner Decision・独立Planning評価を経るまでReadyにしない。具体DB／Cloud／API Schemaや新しい業務ContextをこのADRで選定しない。

## Implementation Boundary

1. 本ADRと参照するProduct／Domain Gateの文書を同期し、developへ統合する。
2. 後続のGoogle本人確認、Actor／Session、招待コード、公開API／画面を独立して検証可能なTaskに分割し、個別Ready評価する。
3. 未Merge差分へ依存する必要が生じた場合は、実装前にPR Dependency／Stack計画を評価する。
4. Google検証の単体成功や文書同期は、ログイン経路・招待保存・Production公開の完成を意味しない。

## Owner Decision

- Date: 2026-10-08
- Decided by: Project Owner（takeshi-arihori）
- Evidence: 利用者は「ログイン方式 -> social loginのみ」と指定した。Googleから始める提案・登録済み宛先を招待する提案への「はい。・」、宛先本人が一回限りのコードを表示・共有しOwnerが入力する提案への「はい」を、上記Decisionの明示承認として記録する。
- 証跡Issueは親Agentによる当該会話の転記である。Owner本人のGitHub CommentやGitHub承認操作が行われたとは主張しない。
- Conditions: Acceptedは3つのProduct選択だけ。SDK、Session、コードTTL／保存、公開接続・Production Gateは別に扱う。

## Rollback / Review Trigger

Provider追加・変更、Password追加、未登録宛先への招待、メール配送、Account統合・復旧、コードLifecycle、保存・保持・本番接続の変更が必要になったら、新しいDecisionで既存利用者・Invitationとの互換性を確認する。Accepted履歴を直接上書きしない。本Taskは文書だけを追加・同期し、実行挙動や保存Dataを変更しない。
