# 固定指示の支払報告・受取確認Lifecycle

- Status: Confirmed（Payment部分のみ、取消とApplication保存は省略）
- Source of Truth: [現行モデル 支払確認・再試行](../product/current-model.md)、[ADR #152 Case Root](../adr/expense-settlement-consistency-boundary.md)
- Related: [Task #164](https://github.com/takeshi-arihori/kakei_app/issues/164)、[内部契約](../domain/settlement-payment-attempt-contract.md)、[初回承認図](settlement-initial-approval.mermaid.md)
- Last Confirmed: 2026-10-01

```mermaid
flowchart TD
    active["Case: 全員承認済み Payment Active"] -->|"固定指示ごと"| unpaid["指示: 未払い"]
    unpaid -->|"支払本人: 全額報告・新Attempt"| reported["指示: 支払報告済み"]
    reported -->|"受取本人: 理由付き差し戻し・旧Attempt保持"| unpaid
    reported -->|"受取本人: 最新報告の確認"| received["指示: 受取確認済み"]
    received -->|"未確認の別指示あり"| pending["Case: Payment Active継続"]
    pending -->|"別の固定指示"| unpaid
    received -->|"全指示の最新報告が受取確認済み"| archived["Case: Archived・全履歴不変"]
```

各指示の支払相手・全額・ID、精算内容と対象Expense集合は固定する。差し戻しはApprovalの却下とは別で、同じInstructionへ新Attemptを追加する。既にReceivedの指示をUnpaidへ戻す遷移ではない。報告だけで精算全体は完了しない。No Payment Requiredは初回／再申請の全員承認から直接Archiveする別経路。

本人の実認証・過去Participant束縛、Group fence、Case版の先着保存・原子性・operation再送は後続Application契約。純Domainの状態遷移を実送金や保存成功の証拠にしない。Archive後は再開・取消・訂正しない。Groupの終了は別の明示操作で、精算完了から自動終了しない。
