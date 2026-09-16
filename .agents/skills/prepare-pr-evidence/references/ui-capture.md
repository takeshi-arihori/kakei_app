# UI Screenshotの再現条件

Artifactごとに次を固定する。

- Trace先となるDone Criteria
- 開始状態、操作、期待する最終状態
- 正常、境界、失敗のうち、視覚的に差が出てReview価値がある最小集合
- Browser、Viewport、theme、locale、timezone
- 使用するFixtureと、Fixtureが合成Dataである根拠
- 描画完了条件と撮影対象

Desktopの標準候補は`1440x900`、mobileの標準候補は`390x844`とする。responsiveがDone Criteriaでなければ両方を機械的に作らない。RepositoryやTaskが別のViewportを指定する場合はそちらを優先し、実際に使った値を報告する。

UI撮影ではAnimationとCaret点滅を止め、`prefers-reduced-motion`を有効にする。Font、画像、対象Request、loading表示が完了し、Layoutが安定したことを待つ。任意の固定sleepだけを完了条件にしない。時刻、random値、IDはFixtureで固定し、OS全体、別Tab、通知、開発者用Tokenを写さない。

遷移前後は番号付きの最小Screenshot列で示す。focus順序、Animation、非同期更新など静止画で証明できない振る舞いは、操作Testを主証拠にする。動画またはTraceは時間的挙動そのものがDone Criteriaで、静止画とTestでは不足し、Taskが保存・保持を認める場合だけ選ぶ。Traceは内部Requestや認証Dataを含み得るため、公開Artifactの既定値にしない。
