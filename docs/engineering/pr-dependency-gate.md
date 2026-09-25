# PR依存関係Gate

後続Pull Requestが依存するPull Requestより先に`develop`へmergeされることを防ぐ。

## PR本文

依存PRがある場合、PR本文へ次の形式で記載する。

```text
Depends-On: #108
```

複数ある場合は1行ずつ記載する。

```text
Depends-On: #108
Depends-On: #109
```

依存PRがない場合は`Depends-On`を記載しない。

## CI

`.github/workflows/pr-dependency-gate.yml`がPR本文を検査する。

- すべての依存PRがmerged: `依存PR確認`成功
- 未mergeの依存PR: 失敗
- 存在しない番号またはIssue番号: 失敗
- 自分自身のPR番号: 失敗
- PR本文を編集した場合も再検証する

## merge制御

`develop`のRulesetでStatus Check `依存PR確認`をRequiredにする。

Required化されていない場合、CIは失敗を表示するだけでmerge自体をGitHubが強制的に禁止しないため、Ruleset設定とセットで運用する。

## 今回の順序

```text
PR #108
   ↓
#109 のPR
   ↓
#110 のPR
```

#109のPR本文には`Depends-On: #108`を記載する。#110は#109のPR番号が確定した後、その番号を`Depends-On`へ設定する。
