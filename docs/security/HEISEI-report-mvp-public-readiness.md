# HEISEI 通報MVP 公開準備レビュー（DRAFT）

## 位置づけ

本書は、PR #56 のローカル通報MVPを、公開前レビューへ提出するための統合確認記録である。対象は隔離PostgreSQL、fixture鍵、ローカルCloudflare Durable Objects runtimeのみであり、production/staging、実Secret、remote namespace、課金設定は変更しない。

## ローカル統合の範囲

- 検証済みserver identityから actor を決定し、クライアント申告のactor/role/visibilityを認可根拠にしない。
- `POST /api/v1/reports` のHono境界は、request quota、admission予約、`beginSave`、G4 ReportRepository、確定処理をこの順で接続する。
- `DurableObjectQuotaBoundary` は actor UUID を正規化して `idFromName` で同一DOへルーティングし、RPCを介してquota状態を読み書きする。
- ローカル実DOのHono内部経路で、RPCによる予約・保存開始・確定とStorage復元を検証する。公開quota endpointは持たない。
- 実JWT→Hono→隔離PostgreSQLの通報経路は既存の統合テストで検証し、DO RPC境界はDO runtimeテストで検証する。

### 応答と非開示

| 内部結果 | 外部候補 | 契約 |
| --- | --- | --- |
| accepted / replayed / duplicate / denied | 202 | 対象存在、保存有無、内部IDを返さない |
| idempotency conflict | 409候補 | payload差異のみを示し、keyやDB情報は返さない |
| quotaを確実に超過 | 429候補 | `Retry-After` の有無・値は承認待ち |
| DB/DO/鍵/reconciliation/commit不明 | 503 | 固定本文。SQL、鍵、本文、対象情報を返さない |

quotaのunknown/uncertainはTTLだけで解放せず、G4のactor/key/payload対応証拠が得られるまで保持する。通常の検索結果0件だけでは `not_stored` と判定しない。

## Durable Objects仕様照合

確認対象は公式資料の以下のページである。

- [Durable Objects overview](https://developers.cloudflare.com/durable-objects/reference/how-durable-objects-work/)
- [Durable Object Storage API](https://developers.cloudflare.com/durable-objects/api/storage-api/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

この実行環境では上記公式URLへのHTTPS取得がプロキシの `CONNECT 403` で失敗したため、料金表の現在値やremote runtimeの実測を本書で断定していない。ローカルで確認できた範囲は、Wrangler/Miniflareの実DO runtimeにおける actor routing、RPC input gate、Storage永続化、再取得、破損stateのfail-closedである。Cloudflareの料金・remote eviction・障害挙動は公開前に公式資料と契約プランで再確認する必要がある。

実装上は、同一actorを同一DOへ固定し、重要状態をメモリだけに置かずStorageへpersistする。quota成功は保存成功確認後にだけ返し、Storageや応答の不明状態はuncertainとして扱う。これは公式仕様の確認に代わるものではない。

## 運用構成の準備（未適用）

| 項目 | ローカル | 公開前に必要な決定 |
| --- | --- | --- |
| Secret provider | fixture provider | 実provider、key version、rotation、欠落時のfail-closed、削除・復旧手順 |
| DB接続 | 隔離PostgreSQL executor | 接続プール、TLS、timeout、監視、RLS role切替の運用設定 |
| quota閾値 | fixture値のみ | 短期/長期request、受付数、予約TTL、同時予約、uncertain上限 |
| HTTP制限 | 429/503候補 | 429と503の厳密な使い分け、Retry-After、再送案内 |
| 監視 | テスト検証のみ | actor別拒否率、429/503、uncertain滞留、lock待機、Storage容量、機密情報除外 |
| 保持・削除 | 削除Jobなし | idempotency 30日契約の運用Job、report retention、法的保全、uncertainの手動処理 |

### 推奨初期案（未承認・未設定）

まずfixtureと同じ構造の設定を環境変数またはbinding由来の構造化設定にし、production値をコードへ埋め込まない。初期リリースでは、`429` はquota超過を確実に判定できる場合だけ、`503` は依存障害またはcommit不明の場合だけに限定する。Retry-Afterは固定値を採用するか省略するかをCEOが決めるまで返さない。対象存在や内部状態が待ち時間から推測されないよう、外部本文とヘッダーは結果クラスごとに固定する。

### 料金試算の方法

現時点の公式単価を取得できないため、金額を捏造しない。公開前に請求画面・公式pricingを取得し、次の実測値を掛け合わせる。

`月額 = DO request数 × request単価 + Storage read/write量 × storage単価 + Workers実行量 × Workers単価 + PostgreSQL接続/DB費用 + 監視・ログ費用`

最低限、低・標準・ピークの3シナリオで、report POST数、invalid/replayを含むrequest数、actor数、DO invocation数、Storage read/write、状態サイズ、uncertain滞留数、DB query/connection時間を1日単位で測定する。無料枠、地域、プラン、ログ保持期間を含めて月額を算定し、上限通知と停止手順をCEO承認後に設定する。

## セキュリティ確認

- G2: active/L2以上、target public/active、双方向block、DB障害を分離したfail-closed判定。
- G3: 原文と正規化fingerprintを分離し、原文はAES-GCM envelope、平文・raw key・raw idempotency keyはログ/quota stateへ渡さない。
- G4: report/idempotency/auditの原子性、actor-bound RLS、専用role、直接INSERT拒否、read-only reconciliationを維持。
- G5: request負荷制限と受付予約を分離し、同一actorの並列処理、予約期限切れ、unknown commit、DO再起動、破損stateを検証。
- 情報非開示: accepted/replayed/duplicate/denied/unknown対象の外部応答を同一202にし、対象UUID・保存有無・SQL・鍵を返さない。

残存リスクは、実Secret/provider、remote DOの課金・eviction・障害実測、production DB接続、承認済みquota値、Retry-After、staff閲覧とretention削除運用である。

## PR依存関係とマージ案

PR #39〜#56はすべてmain向けDraft openで、GitHub上のmergeは実施していない。実装依存順は次の通り。

`#39` → `#43/#45`（G2）

`#46`（G3） + `#47`（G4-A） → `#48`（統合preflight） → `#49`（G4-B1） → `#50` → `#51`（G4-B2）

`#52`（G5 core） → `#53`（DO adapter） → `#54`（local DO runtime） → `#55`（G5 local completion） → `#56`（local report MVP） → 本PR

PR #40/#41は設計記録、#42/#44はGitHub上で未取得/不存在の番号であり、マージ対象として扱わない。実際のマージでは、重複した独立PRをそのまま順番に入れず、承認された最終ブランチを選び、migration番号・roles.sql・同一ファイルの競合を手動レビューする。本PRは整理・自動マージを行わない。

## 公開前の必須作業とCEO判断

1. 実Secret provider、key rotation、削除・復旧手順を承認する。
2. production PostgreSQL接続、RLS role運用、監査・retention削除を承認する。
3. quota閾値、uncertain上限、429/503/Retry-Afterを承認する。
4. Cloudflareプラン、remote namespace/binding、料金上限、監視通知を承認する。
5. 本番相当負荷・障害注入・セキュリティレビューを実環境で実施する。
6. 公開後のstaff閲覧、復号、保存期間、法的保全と問い合わせ運用を承認する。

上記が未承認のため、このローカルPRでG5 runtimeの本番化、remote deploy、公開サービス有効化、production PASSを宣言しない。
