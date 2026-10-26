# Issue219 認証画面の表示Evidence

[UI契約](../../security/google-authentication-ui.md)の日本語/状態表示/狭幅に対応する合成画面です。Googleの実アカウント・個人情報を使わず、独立Browser Contextで認証HTTPとGISだけを表示用Fixtureへ置換しました。署名検証/実API/PGのE2Eおよび実Googleの手動確認は別Evidenceです。Google buttonの実デザインを実証する画像ではありません。

- [320px viewportの準備完了](authentication-320.png): Google準備済み、取消導線。
- [1280px viewportのログイン中](authentication-1280.png): Session状態とlogout導線。

撮影対象は`.app-main`、Browser chromeを含みません。Chromium/Playwright1.63.0、ja-JP/Asia-Tokyo、Reduced Motion、animation/caret停止、対象状態とFont読込完了を待機。Keyboard/Focus/200%の時間的挙動は操作Testを正本とします。

2026-10-26 Reviewer: Codex visual inspection。40px高の合成Google buttonを製品CSSで44pxへ拡大した最新画面を再撮影し、全2画像を表示して日本語/状態/欠落/重なり/情報漏洩を確認しpass。これらの合成画像自体のHuman acceptanceを主張しません。OwnerはRepository Maintainer、Taskが要求するSource EvidenceとしてGit履歴で保持し、後続PRで置換/削除します。生成用一時画像とBrowser ContextはCleanup済みです。

## 実Google手動確認（画像とは別の記録）

2026-10-25、OwnerはCookie共存修正後の実Google開発Client/localhost環境で次の4項目を確認し、「4項目すべて確認できた」と回答しました。

- Googleログイン準備から実Googleでログイン。
- 再読込後も「ログイン中」を表示。
- 現在のアプリSessionをログアウト。
- 再準備後にGoogle画面を閉じ、「ログインを中止」。

親Agentによる会話結果の転記です。実アカウント情報、Token、Cookie値、Google画面や通信本文は保管/公開しません。初回の手動失敗と合成回帰のRedは保持し、[Cookie共存ADR](../../adr/authentication-cookie-coexistence.md)のOwner承認後に再確認しました。合成画面画像を実Google操作の証拠として扱わず、画面確認からProductionや招待/GroupのGateを解除しません。

## 公式buttonのKeyboard／Focusと未検証項目

2026-10-26、親Agentが匿名Chromiumと実GIS／localhost APIで、320px／1280pxそれぞれのTab→準備→公式buttonへのTab移動、可視Focusの変化、EnterによるGoogle popup起動、閉じた後の取消を確認しました。最終Sourceでbutton高44pxとPage／表示先の横方向のはみ出しがないことを確認しています。実アカウントへのログイン、画面・音声・Profile・Traceの保存は行わず、固定した成功可否と寸法だけを記録しました。上記Ownerの機能4項目とは別の検証です。

Ownerは2026-10-26に実スクリーンリーダーによる読み上げ操作テストのスキップを明示しました。今回は未検証であり、成功／非該当とは扱いません。Label／status／alertの実装と自動検査、およびKeyboard／可視Focusの検証は維持します。機能4項目の確認後には、上記の表示寸法修正と認証Cookie末尾空白拒否の修正が加わっており、古い手動結果を最終Source全体の再確認と主張しません。
