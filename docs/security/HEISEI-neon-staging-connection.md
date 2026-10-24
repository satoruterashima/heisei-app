# HEISEI Neon PostgreSQL staging接続確認（DRAFT）

基準: PR #61 / `4e470d59d0e430aaec2bde98f268fd48ac9de2f2`

本書はNeon接続の読み取り調査とローカル準備の記録である。Neonのremote resource、
branch、role、schema、Secret、migration、Cloudflare resource、deployは変更していない。

## 確認結果

- Neon CLI: `8.11.1`（global install）
- Organization: `org-polished-sky-62711896`（ユーザー指定値）
- Project: `crimson-art-20319312`（ユーザー指定値）
- Branch: `production`（ユーザー指定値。HEISEIの本番環境と同一視しない）
- `neon init`: 未実行。現状のリポジトリへ`neon.ts`や`.neon`を生成し、環境情報を取得する可能性があるため、外部操作の承認ゲート後に実行する。
- Neon APIのproject/branch/role/config読み取り: HTTPS proxyのCONNECT 403により到達できず未確認。
- 接続文字列・パスワード・API key: 取得・表示・保存していない。
- リポジトリ内の`.env`、`.env.local`、Neon接続設定: 新規作成・変更していない。

CLIは導入済みだが、ネットワーク到達性とNeon認証が復旧するまで、ブラウザ認証やAPI key発行を
自動実行しない。公式Neon Agent Skills（`neon`、`neon-postgres`）はCLIで参照したが、
生成されたSkillファイルはリポジトリへコミットしない。

## 既存HEISEIとの適合性

既存実装は`pg`互換の`TrustedPostgresExecutor`境界と、ローカル隔離PostgreSQL用の
`createLocalTrustedPostgresExecutor`を持つ。`productionPostgresSettings`は接続を開かず、
TLS検証、pool上限、接続・statement・query timeoutを環境変数から検証する。Neon専用のORMや
認証へ置き換える必要はない。

既存の実行契約は次のとおりである。

- `app.user_id`、`app.auth_subject`、`app.visibility_target_id`等のtransaction-local GUCを、
  trusted server identity確定後に設定する。
- `SET ROLE`、RLS、advisory lock、監査、atomic report関数を同一transaction境界で扱う。
- `heisei_app`、`heisei_report_writer`、`heisei_report_tx_writer`、reader、audit、TTL writerを
  分離し、`NOBYPASSRLS`と不要なmembershipなしを維持する。

## 接続方式の比較と推奨

Neon公式Skillの整理に従い、migration・admin操作・session stateを使う処理と、Workerの通常通信を
分ける。

| 用途 | 候補 | 判定 |
| --- | --- | --- |
| Migration、role作成、`SET ROLE`、session state検証 | Neon direct/unpooled PostgreSQL URL | 推奨。専用migration接続で実行し、アプリpoolへ流さない |
| Workerの通常トラフィック | Cloudflare Hyperdrive経由の`pg`互換接続 | 第一候補。ただしRLS GUC、role切替、transaction関数、advisory lockのstaging E2E確認が必須 |
| Workerの単発SQL | `@neondatabase/serverless` HTTP transport | session stateを要求しない読み取り等に限定。HEISEIの原子的保存境界の代替にはしない |
| Workerのtransaction | `@neondatabase/serverless` WebSocket transport | 実行環境・接続寿命・同時実行を別途検証。現行`pg` executorの置換はしない |
| Neon pooled URLをmigrationに使用 | PgBouncer transaction pooling | 不採用。`SET`やsession stateの保持を前提にできない |

推奨構成は、migrationをdirect URL、Workerのアプリ接続をHyperdriveまたは同等の検証済み
pooling経路とする二層構成である。ただし、Hyperdrive経由でtransaction-local GUCと専用roleが
確実に同一transactionへ適用される証拠が得られない場合、通報受付のremote E2EはBLOCKEDとする。
接続方式を変えるためにRLSや認可条件を緩めてはならない。

## Migration 0000〜0006の互換性確認

ローカルPostgreSQL 16で、初回適用・`roles.sql`再適用・0000〜0006の再適用、RLS、専用role、
監査、atomic保存、staff case scopeを検証済みである。Neon実DBではAPI到達不能のため未適用である。

Neonで実行する場合は次を事前に確認する。

1. owner/admin相当のdirect接続でのみ`CREATE ROLE`、`ALTER ROLE`、grant/revokeを実行する。
2. `roles.sql`をアプリケーションpoolまたは低権限runtime roleで実行しない。
3. `pgcrypto`、UUID、CHECK、partial unique index、RLS、`SECURITY DEFINER`、固定search_path、
   `current_setting(..., true)`が利用可能であることを確認する。
4. `SET ROLE`とtransaction-local GUCが同一セッション・transactionで有効なことを確認する。
5. migrationはdirect URLで一度だけ適用し、再適用後のrole membershipと権限差分をcatalogから確認する。
6. 既存の`production` branchに適用する前に、Neonの独立staging branchまたは専用DBをCEO承認の対象として確定する。

現時点の互換性判定は「PostgreSQL機能としては適合見込み、Neon実環境での権限・接続pool挙動は未検証」
であり、PASSとはしない。

## 実staging接続前チェック

- [ ] Neon API認証とproject/branch/role/databaseの読み取り確認
- [ ] `neon.ts`の有無と差分確認（新規作成は承認後）
- [ ] Neon無料プラン、compute、storage、egress、branch保持の現行条件確認
- [ ] 独立staging branch/databaseの作成承認
- [ ] migration用direct URLとruntime用接続方式の分離
- [ ] staging専用roleとSecret providerの登録承認
- [ ] `0000`〜`0006`のdry-run、適用、再適用、権限監査
- [ ] JWT→Worker→接続adapter→RLS→atomic reportのE2E
- [ ] pool再利用、actor context漏洩、lock timeout、commit不明の障害試験
- [ ] rollbackはdown migrationではなく、承認済みbackup/restoreまたはexpand/contractで行う

## 外部操作の承認対象

次の操作は、対象、差分、既存環境への影響、月額見込みを報告してからCEO承認を取得する。

| 操作 | 現状 | 承認が必要な理由 |
| --- | --- | --- |
| `neon init` / `neon link` / env pull | 未実行 | `.neon`、`neon.ts`、環境ファイル生成や接続情報取得が発生し得る |
| Neon branch/database/role作成・変更 | 未実行 | remote DB・権限・費用の変更 |
| migration適用 | 未実行 | schema、role、RLS、監査境界を変更 |
| Secret登録・取得 | 未実行 | DB接続情報・暗号鍵の機密操作 |
| Cloudflare Hyperdrive/Worker/DO設定・deploy | 未実行 | remote resource・実行費用・外部到達性が発生 |

## 現時点の結論

ローカル実装と既存品質検証は維持できる。Neon接続用の秘密情報やremote設定はまだ存在せず、
この状態で安全に実staging E2Eへ進むことはできない。次に必要なのは、Neon API到達性・認証を
復旧したうえで、独立staging対象とdirect/runtime接続方式をCEO承認し、読み取り確認から開始する
ことである。
