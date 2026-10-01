# 精算残高からの支払指示候補導出

対象は[Task #156](https://github.com/takeshi-arihori/kakei_app/issues/156)。業務Ruleは[現在のモデル](../product/current-model.md)の「Group全体の精算」を正本とし、[ADR #24](https://github.com/takeshi-arihori/kakei_app/issues/24)のSettlement Context内に配置する。[ADR #152](https://github.com/takeshi-arihori/kakei_app/issues/152)のOwner AcceptedなCase境界に関連するが、Caseの状態遷移は本契約に含めない。新しいProduct／Architecture Decisionは採用しない。

## 入力と責務

`ParticipantBalance`は集計済みの残高値を表すValue Object。Participant参照、Group参加順、signed JPY整数額を固定する。正は受取、負は支払、0は送金不要。計算額は実支払額合計−負担額合計だが、支出からの集計そのものは後続のSnapshot作成の責務とする。

参照は空白のみを拒否し、参加順は1以上のsafe integerとする。Participant参照と参加順は集合内でそれぞれ一意。[ADR #52](https://github.com/takeshi-arihori/kakei_app/issues/52)の履歴上の参加順を使い、配列順やIDの辞書順で代用しない。旧Participantと再参加Participantの参照を置換・合算しない。現在Active人数1〜4を過去の複数支出に含まれるParticipantのunion上限へ流用せず、新しい人数上限を設けない。

内部の金額表現は`bigint`。選択支出の合算がNumberの安全整数を超えても丸めない。負額を扱えない既存のMoneyへ無理に写像せず、公開APIのScalar・JSONや保存Schemaを決めない。同じGroup・同じ固定判断点の入力であること、本人性・現在membership、支出のSource確認は後続Application／Snapshot作成の責務。このVOは認可の証拠にならない。

## 契約と検証

| ID | 条件 | 観測する検証 |
| --- | --- | --- |
| CAL-INV1 | 総和0。候補の受取額−支払額が各Participantの元残高と一致。候補額は正JPY整数、支払側は負残高、受取側は正残高 | 4000/1000/-5000、2人、0混在、大整数、全110個の小整数vectorで保存則・符号・edge重複なし |
| CAL-INV2 | 送金回数が最少。同率候補のedgeを支払側参加順→受取側参加順で並べ、その列の辞書順最初を選ぶ。額を追加tie-breakにしない | greedyが3回になる4/6/-6/-4を2回へ、5000同率、部分相殺の同率、独立zero-sum partition oracle |
| CAL-POST1 | 入力順に依存しない不変候補。0残高は送金しない。全0または空の計算入力は空配列 | 入力逆順、非連続参加順、8人の旧／再参加ID保持、VO／集合／候補の不変性、呼出し間cache分離 |
| CAL-FAIL1 | 無効な値・重複・総和非0を分類して拒否し、入力・業務状態を変更しない | 下記6コードと拒否前後の入力比較 |

エラーは`SettlementInvariantViolation`の内部コードで分類する。公開Errorへの変換は本Scope外。

| コード | 拒否条件 |
| --- | --- |
| PARTICIPANT_ID_EMPTY | 空／空白だけ、またはstringでない参照 |
| JOIN_ORDER_INVALID | 正のsafe integerでない参加順 |
| BALANCE_NOT_INTEGER | bigintでない残高 |
| PARTICIPANT_DUPLICATED | 集合内でParticipant参照が重複 |
| JOIN_ORDER_DUPLICATED | 集合内で参加順が重複 |
| BALANCE_TOTAL_NOT_ZERO | 残高総和が0以外 |

## 導出と正しさ

`derivePaymentInstructionCandidates`はSettlement-ownedのstateless Domain Rule。参加順に固定した残量vectorについて全ての負残量／正残量pairを探索する。各pairで小さい方の絶対額を送金し、少なくとも一方の残量を0にする。残量vectorを呼出し内でmemo化し、候補のedge数と参加順の列で比較する。毎stepで非0要素が減るため有限に終了する。Framework、I/O、他ContextのEntity／Table／Domain型には依存しない。

最少送金候補の正額edgeにはcycleが不要。cycle上の流量を交互に増減して保存則を保ち、少なくとも1本を0にすればedge数を減らせるため、最少候補のsupportはforestとなる。forestにはleafがあり、leafの残量をその隣接pairで消す送金額は両残量の絶対値の最小となる。leafを順に除去する探索順序を全pair探索は含むので、最少候補を取りこぼさない。forest上の額は残高とedgeから一意に決まり、額を追加比較せずとも候補は決定的になる。

テストの最少性oracleは送金探索を再実装しない。非0残高集合を分割できる最大のzero-sum部分集合数を求め、最少edge数を非0要素数−最大分割数として照合する。1〜4要素、各値[-2..2]、総和0の全110入力で独立に検証する。4/6/-4/-6も最少2回の正常例だが、greedyとの差の例は負側の順が異なる4/6/-6/-4を使う。

## 出力と接続前のGate

返すのは参照・正JPY額・通貨の不変な`PaymentInstructionCandidate`配列。発番、有効化、Case／Revision／Approval／Attempt作成、予約、保存、Actor認可を行わない。全員承認前の候補を有効なPayment Instructionとして公開してはいけない。

探索は指数的なcostを持つ。memoは重複計算を減らすが、多人数の時間・メモリを保証しない。現在の1〜4人と過去union8人の検証はProduct上限を意味しない。公開Snapshot操作へ接続する前に、実際の選択規模とCPU／timeout／制限方針を別途評価する。本Taskでは未接続の内部計算のみを実装する。

純計算の追加により業務Rule、集約の状態・所有権、公開API、保存Schema、UI、保護Record、運用手順は変更しない。正式図の状態やContext配置も変わらないため、関連Schema／Migration／図／Runbookの更新は不要。
