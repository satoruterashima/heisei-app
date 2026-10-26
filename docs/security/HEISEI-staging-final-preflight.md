# HEISEI 隔離staging導入直前確認（DRAFT）

基準RC: PR #61 / `4e470d59d0e430aaec2bde98f268fd48ac9de2f2`

本書は読み取り調査・設定準備・dry-runの記録である。Cloudflare resource、PostgreSQL、
Secret、remote deploy、課金を実行していない。

## 暫定quota設定

CEO承認済みのstaging暫定値を、既存の `quotaConfigFromSource` の環境変数へ次のように
対応付ける。値は設定源へ投入しておらず、実環境では全項目が揃うまでfail closedとなる。

| 契約 | 環境変数 | 値 |
| --- | --- | ---: |
| 短期10回/分 | `HEISEI_QUOTA_SHORT_WINDOW_MS` / `HEISEI_QUOTA_SHORT_REQUEST_LIMIT` | `60000` / `10` |
| 長期100回/日 | `HEISEI_QUOTA_LONG_WINDOW_MS` / `HEISEI_QUOTA_LONG_REQUEST_LIMIT` | `86400000` / `100` |
| 新規通報20件/日 | `HEISEI_QUOTA_ADMISSION_WINDOW_MS` / `HEISEI_QUOTA_NEW_ADMISSION_LIMIT` | `86400000` / `20` |
| 同時予約5件 | `HEISEI_QUOTA_MAX_ACTIVE_RESERVATIONS` | `5` |
| 予約TTL60秒 | `HEISEI_QUOTA_RESERVATION_TTL_MS` | `60000` |

`HEISEI_QUOTA_STATE_RETENTION_MS` は承認値に含まれていないため、勝手に補完しない。
この値がない状態では起動設定を拒否する。429は確定したquota超過だけ、503は依存障害・
commit結果不明だけに使用し、Retry-Afterは省略する。

## Cloudflare構成調査

ローカルのWrangler 3.114.17で次をdry-runした。

- 通常Worker: bindingなしで成功
- local DO Worker: `QUOTA_ACTOR`、`QuotaActor`、migration v1を認識
- staging/production template: 環境別Worker名、DO binding、migration v1、quota設定源を認識
- `staging-worker.ts`: 通常のHonoテストとCloudflare専用DO entrypointを分離

Cloudflare公式pricing/limits URLは、この実行環境のHTTPS proxyでCONNECT 403となり、
現在の単価・無料枠を取得できなかった。したがって金額や無料枠は断定しない。CEO承認前に
公式料金ページと契約プランを取得し、次の実測値で再計算する。

`DO invocation + storage read/write + Workers request + logs/observability + PostgreSQL`

## PostgreSQL候補の比較

価格はprovider、region、compute、storage、egress、connection proxyで変わるため、候補名を
確定していない現段階では相対比較とする。

| 候補 | 費用特性 | 運用・安全性 | staging推奨 |
| --- | --- | --- | --- |
| マネージドserverless PostgreSQL | 低負荷時の従量課金に向くが、接続・compute・egressの変動がある | TLS、backup、監査、RLS運用をprovider契約と確認 | 小規模検証の第一候補。ただしprovider選定が必要 |
| マネージド固定compute PostgreSQL | 最低月額は発生するが費用予測が容易 | pool、TLS、backup、復元を管理しやすい | 負荷試験・長期staging向け |
| 自前VM/PostgreSQL | 見かけの単価は低くても運用・監視・backup・障害対応費が増える | patch、暗号化、復元、可用性を自社で担保 | 今回は非推奨 |

候補選定前の推奨は、隔離専用のマネージド構成で、専用database/role、TLS検証、
connection pool上限、statement/query timeout、backup/restoreを契約に含めること。共有DBや
既存環境への接続は行わない。

## Secretと権限監査

- staging専用provider・専用key versionを使用する
- AES key、HMAC active key、旧HMAC keyを別versionで管理する
- raw key、平文、Idempotency-Keyはログ・監査・DO stateへ出さない
- `heisei_report_tx_writer`、reconciler、staff reader、TTL writerを分離する
- 全roleについて `NOSUPERUSER`、`NOBYPASSRLS`、不要membershipなしを確認する
- staging Secret投入前にkey length、version、rotation、欠落時fail-closedを検査する

## E2E計画

1. staging専用JWT issuer/keyでactive・L2 actorを作る。
2. Workerの内部quota RPCをactor単位で呼び出し、予約・beginSave・保存・finalizeを確認する。
3. 専用PostgreSQLへmigration `0000`〜`0006`をexpand-onlyで適用する。
4. accepted/replay/duplicate/deniedを202、quota超過を429、依存障害・commit不明を503として確認する。
5. RLS、案件割当、スタッフ失効、監査、暗号化列非開示を確認する。
6. 並列送信、DB接続断、DO応答喪失、commit不明、state復元を実施する。
7. 監視が安定するまで一般公開・削除Job・復号・処分を有効化しない。

実ユーザーデータは使用せず、fixtureまたはstaging専用synthetic userだけを使う。

## 停止・ロールバック

- 受付をWorker version/feature flagで停止し、安全な503へ退避する
- uncertain reservationを自動解放せず、read-only reconciliation対象として保持する
- Worker/DOは直前versionへ戻す
- DBはdown migrationを使わず、backup/restoreまたは承認済みexpand/contractで戻す
- Secret rotationは旧keyを保持したまま再照合を確認し、旧key削除は別承認とする
- migration、監査、復元、停止時刻を記録する

## 外部操作直前の承認対象

| 対象 | 操作 | 影響 |
| --- | --- | --- |
| Cloudflare account | staging Worker/DO namespace、binding作成 | 新規remote resource・課金可能性 |
| PostgreSQL account | staging database、role、migration、backup作成 | DB費用・データ領域・権限変更 |
| Secret provider | staging AES/HMAC key登録 | 機密値の保存・rotation責任 |
| Worker deployment | staging version deploy | remote実行・DO invocation費用 |
| Billing/plan | quota・ログ・DBの上限設定 | 継続費用・上限超過リスク |

現時点では上記すべて未実施であり、対象アカウント名、実リソース名、月額見込みを確定
できるprovider/account情報も未提示である。CEO承認後に、実値を含む操作計画を作成してから
一括実行する。
