# Group ManagementのDomain

`group.ts`は、既存Importとの互換性を維持するAggregate Moduleです。独自の検証・等価性判断を担うDomainの基礎型は、次のModuleへ分離しています。

- `group-value-objects.ts`: Group／Participant／Invitation／Close Intentの識別子、Actor Subject、UTC時刻
- `group-invariant-violation.ts`: Groupの不変条件違反CodeとError

`group.ts`はこれらのSymbolを再Exportして既存Importの互換性を保ち、`Group` AggregateはLifecycleと不変条件の制御に集中します。
