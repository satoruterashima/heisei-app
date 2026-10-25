# HEISEI 通報MVP Release Candidate（DRAFT / local-only）

## 位置づけ

本RCは、PR #60を基点に、通報MVPのローカル統合可能な範囲を一つの候補として
固定する。main、staging、production、共有DB、実Secret、remote Cloudflare
resource、課金設定は変更しない。production PASSや公開承認を意味しない。

## MVPの採用範囲

### 有効化するローカル機能

- 実JWTから検証済みserver identityを取得するHono API
- activeかつL2以上の本人による `POST /api/v1/reports`
- 8KiB、カテゴリ、UUIDv4 Idempotency-Key、説明文の入力境界
- 原文AES-256-GCM envelopeと正規化fingerprintの分離
- accepted / replayed / duplicate / deniedの非開示202契約
- HMAC version候補による冪等性照合とpending一意制約
- Durable Objectsのactor単位quota、予約、保存開始、確定、uncertain保持
- G2 visibility、G4 atomic保存、RLS、監査、read-only reconciliation
- `report_id`単位のstaff assignment、pendingメタデータ閲覧、案件単位監査

### 明示的に除外する機能

- 復号、鍵返却、本文閲覧
- pendingからclosedへの審査状態変更
- 処分、自動停止、被通報者通知・開示
- 担当割当の公開または管理者API
- legal holdの設定・解除API
- 本番削除Job、実Secret、remote DO、staging/production接続

## PR依存関係と統合方針

GitHub確認時点で、PR #39〜#41、#43、#45〜#60はmain向けDraft openかつ未マージだった。
#42と#44はGitHub上で取得できず、マージ対象にしない。

実装依存は次の一本化された順序で確認する。

```text
#39 → #43/#45 (G2)
#46 + #47 → #48 → #49 → #50 → #51 (G3/G4)
#52 → #53 → #54 → #55 → #56 (G5/local API)
#57 → #58 → #59 → #60 (公開準備/運営境界)
```

各元PRを順番にmainへマージするのではなく、本RCのcommit履歴を統合候補とする。
古いPRのmigrationを追加でcherry-pickしない。現RCのmigration順は
`0000`〜`0006`で、案件管理の追加は `0006_report_case_assignments_local.sql` に
集約されている。`roles.sql`再適用と隔離DBで権限拡大がないことを確認する。

## Phase B pending運用

### 監視対象

- pending件数と作成時刻別滞留数
- actor別のaccepted/replayed/duplicate/denied/429/503件数
- DO reservationのreserved / in_flight / uncertain件数
- uncertainの最古時刻、reconciliation試行数、key欠落数
- DB接続、lock待機、commit不明、監査失敗件数
- staff閲覧監査件数とRLS拒否件数
- Worker/DO invocation、Storage read/write、状態サイズ

ログ・メトリクスには本文、暗号鍵、raw Idempotency-Key、JWT、対象の不要な個人情報を
含めない。request ID、結果クラス、集計値だけを相関に使う。

### 滞留・uncertain確認手順

1. request IDと検証済みactorを使って対象reservationを特定する。
2. actor、key version、scope digest、payload fingerprintの完全なtupleを内部境界で照合する。
3. `stored`を確認できた場合だけcommittedへ進める。
4. 保存不成立の証明がない場合はuncertainを保持する。
5. DB障害、鍵欠落、0件検索、候補不一致では解放・再INSERTしない。
6. 操作結果と理由を監査し、手動解放は別途承認された運用手順に限定する。

pendingは経過日数だけで削除しない。closed後90日、監査365日、冪等性30日、legal
hold優先の契約は保持するが、現schemaはpendingのみでclosed遷移がないため、本番削除は
未有効化である。

## staging導入チェックリスト（未実施）

### 承認・構成

- [ ] CEOがMVP範囲、staff assignment、quota、429/503/Retry-Afterを承認
- [ ] Cloudflare staging Worker名、DO namespace/binding、compatibility dateを確定
- [ ] 実Secret provider、active/旧鍵version、rotationと削除条件を確定
- [ ] PostgreSQL接続先、TLS CA検証、pool上限、connect/query/statement timeoutを確定
- [ ] 専用role、NOLOGIN/NOBYPASSRLS、membership、RLS検査を承認
- [ ] 料金上限、監視通知、停止担当を確定

### 適用前検査

- [ ] 取得したcommit SHAとlockfileを固定
- [ ] disposable PostgreSQLで `0000`〜`0006` を初回適用・再適用
- [ ] migration前後のrole/grant/RLS差分を保存
- [ ] stagingバックアップと復元テストを完了
- [ ] 実Secret値をログ・CI出力・設定ファイルへ出さない
- [ ] `wrangler deploy --env staging --dry-run` 相当の設定検証を実行

### 段階公開

- [ ] まず非公開または内部actorだけでJWT→Hono→DO→PostgreSQLを確認
- [ ] accepted/duplicate/deny/429/503の応答非開示を確認
- [ ] staffはmetadata-only・割当案件のみであることを確認
- [ ] pending滞留、uncertain、DB/DO障害を監視できることを確認
- [ ] 監視が安定するまで削除Job・復号・審査状態変更を有効化しない

## ロールバック計画

1. 受付をfeature flagまたはWorker versionで停止し、既存APIの安全な503へ退避する。
2. DOの新規予約を止め、uncertain予約は解放せず保持する。
3. DB migrationはdown migrationで戻さず、バックアップから復元可能なexpand/contract
   手順を使う。`0006`のassignmentは失効処理を優先し、行の破壊的削除は承認なしに行わない。
4. Worker/DOは直前の検証済みversionへrollbackする。
5. DB保存済み・commit不明・監査失敗をread-only reconciliationし、二重INSERTをしない。
6. 監視、監査、復元結果を記録してCEOへ報告する。

## ローカル受入コマンド

```sh
pnpm install --frozen-lockfile
CI=true pnpm typecheck
CI=true pnpm lint
CI=true pnpm test
CI=true pnpm test:do
CI=true pnpm build:check
CI=true bash scripts/test-database-local.sh
CI=true bash scripts/test-api-postgres-local.sh
git diff --check
git diff --exit-code -- pnpm-lock.yaml
```

本RCで確認できるのは隔離DB、fixture鍵、ローカルDO、実JWT/Honoの統合までである。
実Secret、remote Cloudflare、staging DB、料金、eviction、実運用障害は未検証である。

## Staging dry-run結果

Wrangler 3.114.17で次を確認した。

- 通常Workerのdry-runはbindingなしで成功
- local DO Workerのdry-runは `QUOTA_ACTOR: QuotaActor` とmigration v1を認識
- staging/production templateのdry-runは環境別Worker名、DO binding、migration v1、
  `HEISEI_QUOTA_CONFIG_SOURCE` を認識
- staging/production templateは専用 `staging-worker.ts` entrypointから `QuotaActor` を
  exportし、通常のHono unit testへCloudflare専用moduleを持ち込まない

実リソースの作成、remote binding、Secret投入、DB接続、deployは未実施である。

## CEO承認が必要な残作業

- staging/production DBとmigration適用
- Secret provider、鍵rotation、旧鍵削除
- Cloudflare remote namespace/binding、プラン、費用上限
- production quota値、uncertain上限、429/503/Retry-After
- staff assignment管理者、復号、審査終了、処分、通知・開示
- closed状態、legal hold、削除Job、監査保持と復元後再削除
- 段階公開、停止、ロールバックの責任者と実施承認
## OPS-RECONCILE-05 operator経路

stagingの未解決quota状態は、公開WorkerのHTTP APIでは扱わない。Windowsローカルで、127.0.0.1に限定した一時operator WorkerをWranglerで起動し、`scripts/staging-operator-reconcile.mjs`からnonceとoperator IDを渡して、既存stagingのDO/Hyperdrive bindingへ接続する。

既定はdry-runであり、actor UUID・reservation UUID・候補tuple（key version、scope digest、payload fingerprint）を明示する。DO inspectはactor単位、最大50件、cursorページングで、状態・時刻・件数だけを返す。完全一致で保存済みを確認した場合に限り`--apply`を許可し、照合失敗、0件、複数候補、DB/DO障害は`uncertain`を保持する。TTLでの解放・削除は行わない。

監査は専用の`heisei_report_operator`（NOLOGIN・NOSUPERUSER・NOBYPASSRLS）から`report.reconcile`だけをappendする。raw Idempotency-Key、平文、暗号鍵、接続文字列は入力・応答・監査に記録しない。Remote Previewが利用できない環境では、実staging状態の推測走査や公開経路追加で回避せず、判定不能として保留する。
