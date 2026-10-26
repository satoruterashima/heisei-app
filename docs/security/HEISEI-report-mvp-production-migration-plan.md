# HEISEI 通報MVP 本番移行計画（DRAFT）

基点はPR #57のローカル検証済み構成である。本書は、承認後に環境差分を適用するための準備であり、実Secret・DB・Cloudflare resourceは扱わない。

## 準備済みのローカル境界

- `SecretReportKeyProvider`: Workers Secret binding等からversion付きbase64url 32-byte keyを読み、AES-256-GCM/HMAC-SHA-256へimportする。未登録version、欠落鍵、サイズ不正、形式不正はfail closed。旧fingerprint key versionは候補として明示的に保持できる。
- `productionPostgresSettings`: `postgresql://`、TLS証明書検証、pool上限、connect/statement/query timeoutを必須検証する。接続は開かず、passwordを引数として受けない。
- `quotaConfigFromSource`: quota閾値に暗黙のproduction defaultを持たず、全項目が明示されない場合は起動設定を拒否する。
- `planReportRetention`: retention日数と法的保全を入力として削除候補だけを計画する。実削除、未承認保持期間の確定、legal hold解除は行わない。
- `wrangler.public-readiness.template.jsonc`: staging/productionの名前・DO binding・設定源のテンプレートのみ。namespace、binding ID、Secret、remote deployは未設定。

## 鍵運用

1. 現行active versionと、再照合に必要な旧HMAC versionを別々に承認する。
2. 新versionを追加してからread pathで旧versionを保持し、保存はactive versionだけで行う。
3. 旧versionの削除は、30日TTL、未解決reconciliation、バックアップ・法的保全の確認後に別承認する。
4. 鍵値、平文、raw Idempotency-Keyはログ・監査・quota stateに出さない。
5. provider障害・鍵欠落・復号失敗は503相当の内部結果とし、再保存や推測復旧をしない。

## DB接続と権限

本番接続では専用poolを使用し、`heisei_report_tx_writer`、`heisei_report_reconciler`、visibility reader、TTL writerを分離する。接続初期化時に一般roleへのmembership、BYPASSRLS、SUPERUSER、直接report/audit INSERT、任意のrole名・GUC入力がないことを検査する。共有DBへのmigrationはCEO承認まで実行しない。

## quota・HTTPの推奨候補

具体値は未承認であり、以下は設定レビュー用の候補である。

| 項目 | 推奨候補 | 理由 |
| --- | --- | --- |
| request gate | 短期・長期の二層 | invalid/replay/duplicateも暗号・DB負荷の前段で数える |
| admission | actor単位の予約 | 保存成功前に確定しない |
| reservation TTL | 短く設定し、in-flight/unknownは自動解放しない | DB保存の可能性を失わない |
| 429 | quota超過を確定できた場合のみ | DB/DO障害との混同を避ける |
| 503 | provider、DB、DO、lock、commit不明 | 外部本文は固定し内部詳細を隠す |
| Retry-After | CEO承認まで未設定 | 待ち時間から内部状態を推測させない |

productionの閾値は負荷試験・費用上限・不正利用モデルを基にCEOが承認する。設定が欠落した状態では起動または受付をfail closedにする。

## 保持・削除・法的保全

現行仕様では、idempotency記録の30日TTL以外の通報本文保持期間、スタッフ閲覧範囲、法的保全、削除例外は未確定である。したがって本実装では破壊的な削除Jobを有効化しない。

承認後のJobは次を満たす必要がある。

- 専用NOLOGIN roleと固定SQLのみを使用
- legal hold対象を除外し、候補・実行・件数を監査
- reportと関連idempotency/auditの保持関係を明示
- backup・replica・cache・ログの再削除契約を持つ
- 途中失敗は再実行可能だが、二重監査や未承認削除を起こさない
- unknown/uncertain予約をTTLだけで削除しない

## uncertain復旧

`unknown_commit`、DB接続断、DO応答喪失はuncertainとして保持する。運用者は、検証済みactor、key version、scope digest、payload fingerprintの完全なtupleを使うread-only reconciliationだけを実行し、`stored`または保存不成立の証明が得られた場合に限って状態を進める。検索結果0件、鍵欠落、DB障害、候補不一致は解放根拠にならない。

## スタッフ運用

通報の閲覧・復号・処分・アカウント停止は、現時点で承認済みの公開範囲がないため実装しない。スタッフ向け最小境界として必要なのは、別role、目的別scope、監査、復号時の鍵利用記録、二重承認、legal hold、対象者への非開示契約であり、これらの事業判断が承認された後に独立工程として実装する。

## Cloudflare料金・公開前測定

公式料金・制限ページは、公開前に取得可能なネットワークから再確認する。少なくともDO invocation、Storage read/write、state bytes、uncertain滞留、Workers request、DB connection/query時間、ログ量を低・標準・ピーク別に計測する。単価が確定した後、`単価 × 実測量 + DB/監視/ログ費用`で月額上限を算定し、超過通知と停止手順をCEO承認する。

## CEO承認が必要な操作

- 実Secret登録と鍵rotation・旧鍵削除
- staging/production DB接続情報、TLS CA、専用role、migration適用
- DO namespace/binding、remote deploy、Cloudflareプラン・課金上限
- quota閾値、429/503/Retry-After、監視通知
- 通報保持期間、削除Job、legal hold、スタッフ閲覧・復号・処分権限
- 本番負荷試験、障害注入、セキュリティレビュー、段階公開とrollback
