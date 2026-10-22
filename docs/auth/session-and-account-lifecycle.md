# セッションとアカウントライフサイクル

## Expoセッション

Auth SDKのcallback後、access tokenはメモリで扱い、refresh情報はExpo SecureStore等のOS保護領域へ保存する。service role、秘密鍵、検証事業者のcredentialは端末へ配布しない。アプリ起動時はrefresh→session検証→APIのユーザー状態取得の順に行い、失敗時は公開画面へ戻す。

APIはJWTの署名、issuer、audience、exp、subjectを検証する。期限切れは一度だけrefreshを試し、同時refreshを直列化する。refresh失敗・失効・logout後は401としてセッションを消去する。ログにはtoken値を出さない。

## アカウント状態

```text
pending_email -> email_verified -> active
active -> ai_suspended -> active
active -> suspended -> active
active/suspended -> dormant -> reactivated
dormant -> deletion_pending -> deleted
active -> banned（人間承認のみ。自動遷移なし）
```

状態遷移はAPIのtransactionと監査イベントで行う。同じ遷移の再送は冪等にする。`ai_suspended`は可逆的な暫定状態、`suspended`は人間の正式判断、`banned`は将来承認された場合だけ使用する。

## ログアウト・退会・復帰

ログアウトはrefresh失効、SecureStore消去、ローカルキャッシュ消去を行う。退会は確認画面で失効・削除対象を示し、即時物理削除ではなく状態遷移と通知を記録する。休眠からの復帰はメール等の再認証と状態確認を要求し、期限・保存期間は未決定として実装前に承認する。法定記録と投稿の匿名化可否も別途決める。

## 管理者MFA

管理者・staffのログインはMFA、短いsession、有効な担当範囲、重要操作の再認証を必須にする。community managerは対象communityの設定だけを扱い、停止・削除・権限付与を行わない。管理操作はactor、対象、理由、前後状態、承認者、時刻をaudit logへ記録する。
