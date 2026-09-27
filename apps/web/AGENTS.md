# Web作業の入口

このファイルは`apps/web`配下で、ルート`AGENTS.md`のRoutingを補足する。Web固有の静的Ruleをここへ複製しない。

## 最初に読む

1. Repository rootの`AGENTS.md`
2. [`docs/engineering/engineering-loop.md`](../../docs/engineering/engineering-loop.md)
3. [`docs/engineering/skill-governance.md`](../../docs/engineering/skill-governance.md)
4. [`docs/engineering/frontend.md`](../../docs/engineering/frontend.md)
5. [`docs/engineering/coding-standards.md`](../../docs/engineering/coding-standards.md)
6. [`docs/engineering/testing.md`](../../docs/engineering/testing.md)
7. 公開契約へ影響する場合は[`docs/api/README.md`](../../docs/api/README.md)
8. TaskからTraceできるProduct／Domain／Security／Accepted ADR

採用Framework、Library、Directory、Component、State、Accessibility、API client、Test Tool等の具体Ruleは上記docsを正本とする。このファイルだけを根拠に実装方式を決めない。

## Routing

- Requirement／現状Gapの確認: `pre-investigation`
- 公開契約変更: `api-design`
- Production変更: `implementation`
- Test／Verification: `testing`
- PR前Self Review: `code-review`

業務RuleやInvariantの変更をWeb実装だけで確定せず、必要なら`domain-design`へ戻す。

## 完了条件

- Web変更がRequirement／Done CriteriaへTraceできる。
- `frontend.md`その他の適用docsへ整合する。
- Backend／Domain等、別責務をWebへ移していない。
- 必要なTest／Accessibility／公開契約検証を関連docsに従って実施している。
- Root Engineering LoopのSelf Reviewと独立Evaluatorへ進めるEvidenceがある。
