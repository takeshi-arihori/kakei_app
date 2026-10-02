# Receipt Adjustment整数配賦契約

Task [#175](https://github.com/takeshi-arihori/kakei_app/issues/175)の純Domain計算契約。業務Ruleは[現行Product Model](../product/current-model.md)のReceipt Adjustment節と[ADR #170](../adr/receipt-category-consistency-boundary.md)に従う。

## 入力と検証

- Item参照は空でなく、Receipt内で一意とする。元金額は非負safe integerのJPYとする。
- 種別は`Tax`／`Shipping`／`Discount`／`Point`。TaxとShippingは正、DiscountとPointは負の、非0 safe integerとする。Adjustmentなしは空配列で表す。
- Item対象は同一入力に存在する1つのItemだけを参照する。Receipt対象はItemの元金額合計が正の場合だけ計算する。
- 不正入力または最終金額の負額／safe integer超過は、固定メッセージと識別コードを持つ`ReceiptAdjustmentViolation`で全体を拒否する。

## 配賦と結果

Receipt対象の各Adjustmentは同じ元Item金額を重みにし、絶対Adjustment額をBigIntの商・剰余で配る。床関数後の残額は剰余降順、同率なら元のItem配列順で1円ずつ配り、最後にAdjustmentの符号を適用する。元金額0のItemの配賦は0円となる。Item対象額は対象行だけへ符号付きで適用する。

全Adjustmentの符号付き配賦をBigIntで合算してから各最終Item額を検証する。Adjustment間の再加重・逐次clampは行わない。成功時は入力順を保つItem結果とAdjustment別の配賦内訳を返し、出力配列と各値を凍結する。入力オブジェクトは変更しない。

## 境界

この契約はReceipt Root、Draft確認・履歴、宣言Receipt合計との一致確認、Bundle対応、公開API、認可、永続化を実装しない。特に確定時に調整後Item合計とReceipt合計を照合する処理は後続Draft確認Taskの責務である。DBや外部Serviceへの依存はない。
