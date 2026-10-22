# 初期DB概念設計案

## 概念ERD

```text
auth.users 1---1 profiles 1---1 user_settings
                    | 1---N user_verifications
                    | 1---N audit_logs (actor)
                    | 1---N blocks (blocker/blocked)
profiles 1---N reports/moderation_cases (reporter/subject)
```

## 初期テーブル

| テーブル | 主な責務・制約 |
|---|---|
| `profiles` | auth user idをPK、username unique、公開プロフィールのみ |
| `user_verifications` | kind/status/verified_at/provider_ref/version、同一kindのactiveは1件 |
| `user_settings` | 通知・受信関係設定、user_id unique |
| `blocks` | blocker_id + blocked_id unique、自己block禁止、active状態 |
| `audit_logs` | actor、target、action、reason、version、created_at。改ざん防止方針を別途決定 |

後続でposts/comments、reports/moderation_cases、threads、communities、friends、個別交流、subscriptions、coin_ledger/lotsを依存順に追加する。

重要な一意制約はauth user、username、verification active、block pair、冪等性keyに置く。投稿・like・コイン・状態遷移はサーバー時刻とtransactionで処理し、read-before-writeだけに依存しない。RLSは所有者・関係者・staffのread/writeを分離し、拒否ケースを統合テストする。

## migrationとrollback

migrationは小さく前方互換にし、適用前にschema差分・対象件数・backupを確認する。各migrationは適用済みversion、down相当の復旧手順、データ変換の再実行安全性を記録する。破壊的変更はexpand/contractで分割し、rollbackはコードとDBの互換性を確認してから行う。本番migration・seed・削除は別承認が必要である。
