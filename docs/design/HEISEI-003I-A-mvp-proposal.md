# HEISEI-003I-A 通報MVP仕様決定書（DRAFT）

Status: **DRAFT / 未承認**  
Purpose: Issue #34 Phase Bへ進む前に、CEOが事業・プライバシー判断を行うための候補を整理する。  
本書は正式仕様、API契約、DB変更の承認を意味しない。実装・migration・デプロイは行わない。

## 1. 調査結論

正式v2.0で確認できるのは、通報が安全機能・MVP2候補として存在し、API経由で監査可能にする方針までである。技術選定書には `/reports` の領域と通報へのAI補助構想があるが、AIの利用条件や処分権限は確定していない。

Phase A監査と現行コードから、以下は事実である。

| 項目 | 現状 | 判定 |
| --- | --- | --- |
| `POST /api/v1/reports` | routeなし | NOT_IMPLEMENTED |
| `reports` / `moderation_cases` | schema・migrationなし | NOT_IMPLEMENTED |
| 通報専用DB role/RLS | なし | NOT_IMPLEMENTED |
| 通報用テスト | fixture・結合テストなし | NOT_IMPLEMENTED |
| JWT検証・DB identity・active/L2認可 | session/profile/blockで実装済み | 再利用候補 |
| 専用writer・RLS・同一transaction監査 | block/profileで実装済み | 設計パターンとして再利用候補 |

## 2. MVP案の評価

以下は依頼された案の評価であり、採用済みの仕様ではない。

| 論点 | 提案案 | 評価 | 承認要否 |
| --- | --- | --- | --- |
| 対象 | user / post / comment | 利用価値は高いが、3種類の認可・存在非開示・退会処理が必要 | CEO承認＋対象ごとのowner/visibility根拠 |
| 通報者 | active、L2以上 | 既存の安全API境界と整合するが、正式v2.0に明示表はない | CEO承認 |
| 理由 | category＋任意自由記述 | 自由記述はPII、秘密、第三者情報、プロンプトインジェクションを取り込む | categoryは候補、自由記述は別承認 |
| 添付 | 初期対象外 | データ漏えい・マルウェア・保持コストを抑えられ、安全 | 採用候補 |
| 重複 | 未処理の同一reporter・同一targetを統合 | `未処理`の定義と、異なる理由の扱いが未定義。照合方法が存在推測を生む | CEO承認＋status定義 |
| HTTP受付 | target存在を開示しない202 | 非同期・人間レビュー方針と整合。入力不正・認証/認可・DB障害は別エラー | CEO承認 |
| 自動処分 | 禁止 | 正式方針と整合。受付は違反認定ではない | 採用候補 |
| 最終判断 | 運営者 | 人間レビュー方針と整合。ただし担当scope・操作権限は未定義 | CEO承認 |
| 保存期間 | 未承認 | 法務・プライバシー・バックアップ消去に直結 | 必須承認 |

### 推奨する段階案（未承認）

安全性と実装難易度のバランスでは、初期受付を **user / post / commentのいずれか、または承認された対象だけ** に限定し、添付を持たず、理由カテゴリを固定し、受付成功を一律202とする案が最小である。

自由記述を同時採用する場合は、最大長、PII警告、サニタイズ、暗号化、staff閲覧scope、保持期間を同時に承認する必要がある。これらが未承認のままなら、初期版では自由記述を受け付けない案を推奨する。

## 3. 脅威モデル

### 3.1 対象存在の推測

攻撃者が既知・未知・不可視のuser/post/commentを順に送信し、status、body、レスポンス長、監査結果、処理時間から存在を推測する。成功・重複・対象なしを同じ受付形状へ統一し、target名、内部ID、case情報を返さない必要がある。

### 3.2 重複判定による漏えい

`409 already reported`、重複件数、既存case IDを返すと、対象が存在するだけでなく、他人の通報状況まで漏れる。重複判定はサーバー内だけで行い、既存・統合・未知・不可視の応答投影を同じにする。異なるreporter間の統合可否は業務判断である。

### 3.3 自由記述・個人情報

本文には氏名、連絡先、認証情報、第三者の会話、医療・年齢等のセンシティブ情報が混入し得る。audit_logs、アプリログ、エラー、AI入力へ本文を複製しない。自由記述を採用するなら保存目的、暗号化、アクセス範囲、削除、バックアップ消去を先に承認する。

### 3.4 並列送信

同一reporter/targetを並列POSTすると、read-before-writeだけでは二重行・二重監査が生じる。承認済みの重複意味に応じたDB unique制約またはidempotency keyを使い、transaction内で一意性を保証する。

### 3.5 権限昇格・主体偽装

bodyのactor/reporter/role/auth level/statusを拒否または無視し、JWTのsubjectをDB profileへ解決する。active/L2判定はserver-side identityだけで行う。対象の所有者、staff権限、処分権限をclient入力から決めない。

### 3.6 RLS・監査迂回

一般roleにreportまたはauditのmutation権限を与えず、`heisei_report_writer`を専用化する。writer、actor、transaction-local context、target範囲をRLSで拘束する。report INSERTと`report.create`監査INSERTは同一transactionとし、監査失敗時は両方ROLLBACKする。

## 4. 代替案比較

### 通報内容

| 案 | 内容 | 安全性 | 難易度 | 判断 |
| --- | --- | --- | --- | --- |
| A | 固定カテゴリのみ | 高 | 低 | 初期推奨候補 |
| B | カテゴリ＋短い自由記述 | 中 | 中 | PII・保持・閲覧承認が必要 |
| C | カテゴリ＋自由記述＋添付 | 低〜中 | 高 | 初期対象外候補 |

### 重複

| 案 | 内容 | 利点 | リスク |
| --- | --- | --- | --- |
| A | 同一reporter/targetの未処理行を統合 | 行数・審査負荷を抑制 | status、理由更新、並列動作の承認が必要 |
| B | 毎回別reportとして保存 | 事実を失いにくい | スパム・審査負荷・情報量が増える |
| C | idempotency keyの同一再送だけ統合 | 再送安全性が明確 | 異なるkeyの業務上の重複方針が残る |

存在非開示を優先するなら、いずれの案でも成功レスポンスを一律202とし、`already_reported`等を返さない。Aを採る場合は、統合単位と「未処理」の状態遷移をCEOが承認する必要がある。

### 保持・削除・匿名化

| 案 | 保持方針 | 利点 | 課題 |
| --- | --- | --- | --- |
| A | 短期保持後に自動削除 | PIIを最小化 | 再審査・法的要請・backup消去との整合 |
| B | case終了後の固定期間保持 | 審査・異議申立てに対応しやすい | 期間と終了条件が必要 |
| C | 監査メタデータのみ長期保持、本文/target情報を匿名化 | 長期運用の漏えいを抑制 | 再調査能力が低下、匿名化定義が必要 |
| D | 法的保全が必要なものだけ別保管 | 必要性と最小化を両立 | 保全承認、アクセス監査、backup方針が必要 |

推奨候補は、通常データをcase終了後の承認済み期間だけ保持し、期間経過後に本文を削除・target参照を匿名化し、監査メタデータも別の最小保持ルールに分ける方式である。ただし期間、case終了、法的保全、backup消去は未承認であり、実装値を置いてはならない。

### 閲覧権限

| 案 | reporter | staff/operator | 被通報者 |
| --- | --- | --- | --- |
| A | 受付済みだけ確認、case内容なし | 担当scope内のみ | 原則非開示、通知は別承認 |
| B | 自分の受付・状態を限定表示 | 全件閲覧 | 受付事実のみ条件付き通知 |
| C | 受付確認のみ、状態非表示 | 担当scope・再認証・監査 | 法的/運用判断に基づく |

初期受付APIにはAまたはCが安全である。staff API、被通報者通知、通報者の開示は別承認・別APIとし、受付APIへ混在させない。

## 5. API・DB・監査の候補契約（未承認）

### API候補

```http
POST /api/v1/reports
Authorization: Bearer <verified-jwt>
Content-Type: application/json
Idempotency-Key: <opaque-key>
```

成功候補：

```json
{"data":{"accepted":true},"requestId":"<server-request-id>"}
```

候補ステータスは202。targetの存在、可視性、既存通報、統合結果をレスポンスへ出さない。`Cache-Control: no-store`を付け、request IDは内部連番やreport IDを兼ねない。

候補エラーは、JWT不正401、権限不足403、入力不正400/422、保存先未設定503、DB/監査失敗500/503とする。ただし最終コード、停止中の受付、rate limit閾値は承認対象である。

### schema候補

- `reports`: server-generated ID、reporter user ID、承認済みtarget type、target ID、承認済みcategory、状態、idempotency情報、created_at、更新時刻。
- 自由記述を採る場合の本文列、暗号化、PII分類、保持期限、削除状態は別承認が必要。
- 添付、`moderation_cases`、priority、SLAは初期受付へ含めず、必要性を別判断する。

### RLS候補

- `heisei_app`にはreport/auditのINSERT・UPDATE・DELETEを付与しない。
- `heisei_report_writer`は`NOLOGIN NOSUPERUSER NOBYPASSRLS`の固定roleとし、transaction-local actorへ束縛する。
- reporterは自分が作成した行を必要最小限だけ扱い、他人のreportをSELECT/UPDATE/DELETEできない。
- staff閲覧roleは担当scopeとMFA/再認証が承認・実装されるまで作らない。
- audit actionは`report.create`だけをreport writerへallowlistする。migration再適用で権限を拡張しない。

### 監査・原子性

report INSERTと`report.create` audit INSERTを同一transactionで実行する。INSERT、監査、FK、RLS、接続のいずれかが失敗した場合はROLLBACKし、安全な固定メッセージだけを返す。通報本文、token、SQL、stack、targetの表示情報はレスポンス・ログ・監査本文へ出さない。

## 6. CEO承認が必要な事項

1. target typeをuser/post/commentのどこまで採用するか。
2. 通報者をactive/L2以上に限定する正式決定、停止中の法的窓口との関係。
3. 理由カテゴリの正式一覧、自由記述の採否と上限。
4. 添付を初期対象外とする決定。
5. 同一reporter/targetの重複・並列送信・異なる理由の扱い。
6. `202`受付、冪等性key、再送・統合時の応答契約。
7. 通報の保存期間、削除、匿名化、法的保全、backup消去。
8. reporter/staff/operator/被通報者の閲覧・開示範囲と担当scope。
9. case/status/priority/SLA/異議申立てを初期版へ含めるか。
10. AIへの入力条件、モデル、費用、要約利用。自動処分は採用しない。

上記が正式仕様または承認記録に反映されるまで、Phase BはBLOCKEDとする。

