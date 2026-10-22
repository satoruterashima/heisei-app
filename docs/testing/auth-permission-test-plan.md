# 認証・権限テスト計画

## テストマトリクス

| 領域 | ケース | 期待 |
|---|---|---|
| L0〜L4 | 各levelで投稿、profile、個別交流、出品を試行 | 仕様表どおり許可/403 |
| 権限昇格 | 端末payloadのuserId、会員、age flagを書換え | serverのidentityを優先し拒否 |
| token | 署名改ざん、issuer/audience不一致、exp切れ、失効、logout後 | 401、監査に秘密値なし |
| 他人データ | profile patch、private message、verification取得を他人IDで試行 | 403/404、存在を不必要に漏らさない |
| block | 双方向profile、申請、投稿相互作用、mail、notification | 403または非表示、解除後のみ復帰 |
| 停止 | active、ai_suspended、suspended、bannedで各API | 法的窓口以外を拒否、AI単独banなし |
| 関係・年齢 | non-friend、同community、L2/L3、受信設定 | 関係とL3条件をAPIで判定 |
| 利用回数 | 投稿連投、申請、OTP、mail、ksk | サーバー時刻・429・transactionで上限 |
| 同時実行 | 二重like、block、状態遷移、冪等key再送 | unique/transactionで一回だけ |
| DB | RLS所有者、他人、staff、service role、migration再適用 | deny/allowが設計どおり、再実行安全 |

## 受入条件

認証middleware、認可policy、validation、DB transaction、auditを分離したAPI統合テストを用意する。401/403/404/409/429の契約を固定し、レスポンス・ログにtoken、phone、本人確認書類、秘密を含めないことを確認する。Expoではcallback、SecureStore復帰、refresh競合、ログアウト、再インストール相当をdevelopment buildで確認する。CIだけで済ませず、iOS実機でOS復帰とSecureStoreの結果を記録する。

AIはテスト対象の判定補助に留め、正式停止・永久停止の自動実行を有効化しない。外部SMS/eKYC、決済、本番DBをテストで呼ばず、adapterのfakeとsandboxを使う。事業者・保存期間・会費など未決定値はテストに固定しない。
