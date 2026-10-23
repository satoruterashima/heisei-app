# HEISEI-003I-A 受入テスト計画（DRAFT）

Status: **DRAFT / 実装前計画**  
対象: CEO承認後の`POST /api/v1/reports`および必要なDB境界  
この文書はテスト計画であり、未承認のpayloadやstatusを確定しない。

## 1. 前提fixture

- syntheticなprofiles、user/post/commentだけを使う。本番DB・顧客データは使わない。
- 実署名RS256 JWT、Hono route、isolated PostgreSQLを一連で通す。
- actorはJWT subjectからserver-side DB identityへ解決する。
- 通報対象の型、理由、自由記述、重複意味は承認後のfixtureだけを有効化する。

## 2. API・認証負例

| ID | ケース | 期待 |
| --- | --- | --- |
| A-01 | token欠落・署名不正・issuer/audience不一致・期限切れ | 401、安全なbody |
| A-02 | unknown subject、identity不一致 | 401または承認済みの安全な拒否 |
| A-03 | L1、suspended、ai_suspended、banned | 403、DB mutationなし |
| A-04 | bodyのactor/reporter/role/level/status偽装 | 拒否または未知フィールド拒否、主体はserver identity |
| A-05 | Content-Type不正、malformed JSON、空body、未知フィールド | 400/422、DB mutationなし |
| A-06 | 承認済みschemaの型・ID・カテゴリ・長さ違反 | 400/422、内部情報なし |
| A-07 | 8KiB上限を採用した場合の境界・超過 | 承認済み契約どおり、本文非出力 |
| A-08 | rate limit未設定または依存障害 | 承認済みfail-closed動作 |

## 3. 非開示・重複

| ID | ケース | 期待 |
| --- | --- | --- |
| P-01 | 存在するuser/post/comment | 承認済み対象なら受付成功候補 |
| P-02 | 未知対象 | P-01とstatus、stable body、cache headerを同等化。target情報なし |
| P-03 | 存在するがreporterに不可視の対象 | P-02と同等。存在を示さない |
| P-04 | 既存の自分の通報 | 承認済み冪等性契約どおり。重複状態を返さない |
| P-05 | 他人が先に通報した対象 | P-02と同等。既存通報・reporterを返さない |
| P-06 | 同一Idempotency-Key再送 | 承認済みの同一受付結果、重複行・監査の扱いを確認 |
| P-07 | 異なるkeyで同一reporter/targetを並列送信 | 承認済み統合・別件方針どおり。raceで制約を破らない |
| P-08 | 異なるreporterが同一targetへ並列送信 | 対象存在や他人の通報を返さず、承認済み業務意味を維持 |
| P-09 | 成功・未知・重複のレスポンス | requestId以外のbody投影、status、cache headerを比較 |

## 4. RLS・role・transaction

| ID | ケース | 期待 |
| --- | --- | --- |
| R-01 | 一般`heisei_app`でreport INSERT/UPDATE/DELETE | 拒否 |
| R-02 | `heisei_report_writer`でactorを別userへ偽装 | RLS拒否 |
| R-03 | report writerが`profile.update`等の無関係auditをINSERT | allowlist拒否 |
| R-04 | migrationを再適用 | 一般role権限・RLS・audit allowlistが拡大しない |
| R-05 | report INSERT成功、監査INSERT失敗 | 両方ROLLBACK、APIは安全な500 |
| R-06 | report INSERT失敗、監査だけ成功する経路 | auditも残らない |
| R-07 | DB接続・SQL・RLS・FK障害 | 500/503、安全な固定メッセージ、stack/SQLなし |
| R-08 | pooled connectionのactor/GUC再利用 | 前のactorやroleが次のtransactionへ漏れない |
| R-09 | staff未承認のSELECT、他人のreport取得 | API・RLSとも拒否または未実装 |

## 5. 自由記述を承認した場合の追加試験

- PII、token、秘密、第三者本文、プロンプトインジェクションを入力しても、レスポンス・構造化ログ・audit_logsへ複製しない。
- 最大長、Unicode、改行、制御文字、正規化、暗号化、検索可否を承認仕様どおり確認する。
- staff scope外の本文を読めないこと、削除・匿名化後に本文とbackup参照が残らないことを確認する。
- AIへ送信する場合でも、送信条件、モデル、費用、出力利用、処分権限の承認がない限り送信しない。

## 6. 状態・保持・運用

保持期間、`未処理`、case/status、削除・匿名化、法的保全が承認された後に、次を追加する。

- 同一reporter/targetの統合前後で監査履歴が正しく残る。
- case終了、再開、異議申立て、対象退会・削除時の参照処理が承認どおりになる。
- 期限処理の再実行が冪等で、対象件数を確認できる。
- staff閲覧・export・開示操作が担当scope、MFA、再認証、監査を満たす。

## 7. 品質ゲート

- frozen install / lockfile不変性
- TypeScript（全workspace・test config）
- ESLint
- unit Vitest
- PostgreSQL RLS、role、migration reapply
- 実JWT → Hono → disposable PostgreSQL結合
- 並列、重複、監査失敗、DB障害、情報非開示
- Worker bundle dry-run
- GitHub Actions Quality

一つでも未承認仕様に依存するテストを、承認済みの受入PASSとして扱わない。Phase Bの実装開始前は、すべてのテストを計画またはBLOCKEDとして管理する。

