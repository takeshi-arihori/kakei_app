# official gh-stack Adapter参照

このReferenceは`stacked-pr-delivery`がGitHub公式`github/gh-stack`を利用するときの参照先だけを示す。RepositoryのStacked PR Ruleは`docs/engineering/pr-dependency-gate.md`を正本とし、ここへ複製しない。

## 公式Source

- Repository: https://github.com/github/gh-stack
- CLI install: `gh extension install github/gh-stack`
- Agent Skill install: `gh skill install github/gh-stack`
- CLIの実行時仕様: `gh stack <command> --help`
- 公式Agent Skill: `skills/gh-stack/SKILL.md`

## Repository側の扱い

- `gh-stack`は必須依存ではなく、利用可能時の優先Adapterとする。
- Extension／SkillのInstallやUpgradeはMachine固有変更なので自動実行しない。
- Tool固有のflag、exit code、recoveryは公式Skill／CLI Helpをその時点で確認する。
- `gh-stack`が利用できない場合は`stacked-pr-delivery`のFallbackへ切り替える。
- ToolのStack表現よりRepositoryのPlanning結果と`pr-dependency-gate.md`を優先する。

## 調査時点

Issue #133の初回調査時点（2026-09-27）で、GitHub公式Releaseの最新は`v0.1.1`。VersionをRepositoryへ固定せず、実行時に利用中Versionと公式仕様を確認する。
