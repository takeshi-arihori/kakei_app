---
name: implement-notion-task
description: 旧Skill名の互換入口。Notionへ接続せず、Ready済みGitHub Taskの実装にはimplement-github-taskを使用する。
---

# GitHub Task実装への互換入口

このSkill名は既存の呼び出しとの互換性のためだけに残す。Notionを読み書きしない。

同じ依頼を[implement-github-task](../implement-github-task/SKILL.md)として処理する。GitHub IssueとPrivate GitHub ProjectからTaskを確認し、Repositoryの固定Commitにある仕様・設計・ADRに従う。
