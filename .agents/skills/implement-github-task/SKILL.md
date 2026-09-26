---
name: implement-github-task
description: Ready済みGitHub Taskの開始・Branch・公開Gate・Draft PRまでのDelivery Lifecycleを管理し、実作業をfeature-developmentへ委譲する。
---

# GitHub Taskの実装Lifecycle

Ready済みTaskを、GitHubとRepositoryの正本に従ってDraft PRまで届ける。Notionは読み書きしない。本SkillはGitHub上のLifecycleを担当し、設計・実装・Test・Reviewの詳細は[feature-development](../feature-development/SKILL.md)へ委譲する。

## Taskと作業環境を固定する

1. [delivery-workflow](../../../docs/engineering/delivery-workflow.md)のReady・Branch・文書影響を確認する。GitHub取得先と固定Commitは[正本入口](../../../docs/governance/README.md)で確認する。
2. Task Issue、Project Field、Epic、Dependencies、Accepted ADR、固定Commitの仕様を取得する。
3. Status、Requirement、Done Criteria、Estimate、Decision Check、Related ADRがReady条件を満たすことを確認する。
4. 同TaskのOpen PR、現在Branch、`origin/develop`、作業ツリーを確認する。
5. 無関係または所有者不明の変更を移動、破棄、Stage、Commitしない。必要なら`origin/develop`から隔離worktreeと`codex/` Branchを作る。

GitHubへの最初の書き込み前に[保存と公開Gate](../../../docs/engineering/delivery-workflow.md#githubでの保存と公開gate)を確認する。開始記録を含む公開本文・添付ごとに機械検査と手動Reviewを行い、非公開情報は公開しない。

StatusをIn Progressにし、Issueへ開始記録を残す。`develop`へ直接CommitまたはPushしない。

## 実作業を委譲する

[feature-development](../feature-development/SKILL.md)へ、Task、Requirement、Done Criteria、Accepted ADR、固定Commit、既知の制約を渡す。

`feature-development`が変更内容を判定し、必要な以下のSkillだけを組み合わせる。

- `pre-investigation`
- `domain-design`
- `api-design`
- `database-change`
- `implementation`
- `testing`
- `code-review`

既存の`domain-modeling`、`specification-contract`、`solid-ddd-pr-review`、`prepare-pr-evidence`は、それぞれの専門Skillから必要時に利用する。

本番依存関係の追加、破壊的Migration、破壊的Schema変更、ADR必須Decisionは、Repository Ruleに従って承認・Decisionを得るまで依存作業を止める。

## Deliveryを完了する

`feature-development`から次を受け取る。

- 実装・文書差分
- Test／検証結果
- `code-review`結果
- 未実施検証と残Risk
- 未決事項

Blocker／Majorが残っている場合はDraft PR作成へ進まない。解消後、[独立評価とDraft PR](references/delivery.md)に従い、評価、Commit、Push、Draft PR、Issue／Project更新まで進める。

PR Ready化・Mergeは利用者の明示依頼がある場合だけ行う。

## 完了条件

- GitHub Taskと最終DiffがTraceできる。
- 必要なSkill選択と省略理由が記録されている。
- Test／検証と`code-review`が完了している。
- 公開Gateを満たしたDraft PRがTaskへLinkされている。
- 未実施検証、未決事項、残Riskが明示されている。
