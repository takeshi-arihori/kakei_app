# MVP Webの入口と共通App shell

## 承認と範囲

[Task #150](https://github.com/takeshi-arihori/kakei_app/issues/150)は[Web Epic #90](https://github.com/takeshi-arihori/kakei_app/issues/90)の入口・共通外枠を実装する。2026-10-01、提示したUX案に対するOwnerの「承認で。続けてください。」を、この範囲のAccepted記録とする。

入力は[現行モデル](current-model.md)、[Group Management Inventory](mvp-web-group-management-inventory.md)、[Expense／Receipt／Category Inventory](mvp-web-expense-receipt-category-inventory.md)、Settlement／Paymentの[Task #148／PR #149](https://github.com/takeshi-arihori/kakei_app/pull/149)と、Ownerへ提示した横断UX案。#149の文書差分は入口Codeの前提ではなく背景参照であり、この文書の成立・検証にそのMergeを必要としない。

採用する入口の目的は「グループで支出を記録し、精算する」。アプリ名は「共有割り勘」。1〜4人、アプリ内送金なしは既存モデルを説明する。本Taskは認証や業務操作の提供完了を意味しない。Backend比較案、未決のOwnership／認証／公開契約をAcceptedに変更しない。[design-gates](design-gates.md)のGateは維持する。

## 入口と共通外枠

- 入口は、支出を記録 → みんなで内容を確認 → 支払い・受け取りまで確認、という流れを説明する。
- 「利用開始の準備を進めています。」を表示する。未接続のログイン・Group作成・業務リンク、架空のGroup一覧・残高・成功状態は置かない。
- RootLayoutがHeader、最初のSkip link、単一のMain、Route内容のslotを持つ。Page／Loading／NotFoundはMainを重ねない。
- Headerのアプリ名はホームへ戻る導線。Skip linkはTabで可視化し、Enterで本文へFocusを移す。Focus outlineと44px相当のTargetを維持する。
- 日本語の文書言語とMetadataを使用する。多言語化の方式は確定しない。OSの日本語System fontを利用し、外部Font取得は行わない。
- Narrow viewportでは流れを1列、広い画面では3列で読む。高さは内容に従い、拡大で文章を隠さない。Animation・Transitionを追加せずReduced Motionでも同じ情報を読める。
- 静的な組立はServer Component。共通外枠はData Fetch・認可・Domain計算・Session保存を担わない。

実装は既存の `apps/web/app` のNext Route配置を維持する。ContentStateはこのRoute階層内に留め、将来のFeature FolderやDesign Systemを先行作成しない。

## 状態Matrix

| 状態 | 確認できる事実 | 表示／通知 | 本Taskでの利用 |
| --- | --- | --- | --- |
| Entry | 業務操作の提供前 | 目的と準備中の案内。空の業務一覧を表示しない | `page.tsx` |
| Loading | Route内容がSuspenseで待機中 | 読み込みの見出しと説明、`role=status`。完了を推測しない | `loading.tsx`。静的入口で表示を強制するDelayは置かない |
| Empty | 呼出し元が空集合を確認済み | 見出し・理由・必要な次Action。Errorや完了と混同しない | ContentStateの表示契約とComponent Test。業務API未接続なので入口では利用しない |
| Unavailable | Routeに対応する内容がない | 内部情報を含めない表示不可とホーム復帰 | `not-found.tsx`。業務上の存在／認可を推測しない |
| 認可拒否／存在非開示／Validation／Conflict／未知Error | 公開Error契約が必要 | 特定Resourceの存在漏えいを防ぎ、契約に沿って区別 | 後続SliceのGate。404から独自に業務Errorへ変換しない |

ContentStateのkindは表示の通知方式を選ぶだけで、APIのErrorを分類しない。Route全体の見出しを提供するため、部分Widgetへの再利用は別途判断する。再送導線は権限・再送可否・同じIdempotency Keyの契約がReadyになってから呼出し元が提供する。

## 後続Navigationと接続Gate

Group選択後の構成入力は「支出」「レシート」「精算」「履歴」「設定」。このTaskではリンクを公開しない。Group選択はClientの認可根拠にならない。

| 機能 | 構成入力 | 接続前に必要な契約 |
| --- | --- | --- |
| Group | 一覧／詳細／招待、Owner・在籍操作の補助flow | 本人性、Group Read／Command、操作時点Policy |
| 支出 | 一覧／詳細、手入力・訂正の補助flow | ER Data Owner、版・予約、公開Read／Command |
| レシート | 本人Draft作業、確定Receipt詳細 | Uploader権限、確定Itemと画像の別Read、OCR／Storage |
| 精算 | Case／Revision詳細・支払指示、申請／承認／報告の補助flow | 固定版・承認者・Snapshot関与、Expense予約、payer／payeeの公開契約 |
| 履歴 | Settlement Archive月別、Category購入月別 | archivedAtとoccurredOnの区別、Left／owner-at-archiveのPolicy |
| 設定 | Group Owner操作、Category、終了、CSV | 現在Owner／固定Owner、Category所属、終了・CSV契約 |

Route URL、検索・Pagination、Readの存在非開示、画像権限、再送Key、本番Sessionは各SliceのReady時に確定する。金額・Split・Balance・最終認可はBackendの正本を表示し、Frontendで導出しない。

## Requirementから検証へのTrace

| Taskの条件 | Evidence |
| --- | --- |
| DC1 目的・準備中・日本語・偽操作なし | `app/app-shell.spec.ts`、E2E「入口で目的と利用開始前の状態」 |
| DC2 外枠・内容slot・Keyboard／Focus | SSRのchildren保持／単一Main、E2E「最初のTabとEnter」、ホームTarget |
| DC3 Reflow／拡大／Reduced Motion／Contrast | E2Eの320／1280px、200%CSS zoom、640px＋200%文字サイズ、幾何確認、配色Contrast、Reduced Motion |
| DC4 状態の区別と復帰 | `app/_components/content-state.spec.ts`、E2Eの不明Route→ホーム |
| DC5 既存Test・実E2E・CI | Web unit／Playwright、`pnpm check`、CIのWeb E2E |
| DC6 同期・Review | 本文書、[Testing Rule](../engineering/testing.md)、Task／PR、Self Reviewと独立Evaluator |

検証対象はChromiumの本番Build。200%のCSS zoomと縮小viewport／文字拡大は拡大時のLayout検証であり、ブラウザUIのnative Zoomを操作した検証とは区別する。Firefox／WebKit、native Zoom、Screen Reader実機操作、WCAG全項目の適合判定は未実施。業務APIがないため主要なGroup→支出→精算のE2Eは後続Taskで行う。
