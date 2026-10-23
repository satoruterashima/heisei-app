# HEISEI-003I-A CEO承認チェックリスト（DRAFT）

Status: **DRAFT / 承認待ち**  
対象: Issue #34 Phase Bの実装開始可否  
この文書のチェックは、未実施の承認を意味しない。

## A. 先に確認する前提

- [ ] 正式v2.0資料では、通報機能・監査可能なAPI境界までが確認事項であり、詳細payload・保持・閲覧権限は確定していないことを確認した。
- [ ] `docs/design/HEISEI-003I-A-report-intake-audit.md` のPhase B BLOCKED判定を確認した。
- [ ] 通報受付は違反認定、処分、AI判断、caseの最終判断ではないことを確認した。
- [ ] Issue #29、ブロック一覧、表示権限、capability基盤を本Issueの依存に含めないことを確認した。

## B. MVPの選択

各項目は一つを選び、決定日・決定者・理由を正式な意思決定記録へ残す。

| 論点 | 候補 | CEO決定 | 決定日/決定者/理由 |
| --- | --- | --- | --- |
| 対象 | user / post / commentの範囲 | 未決定 | 未記入 |
| 通報者 | activeかつL2以上 / 別条件 | 未決定 | 未記入 |
| 理由 | 固定カテゴリのみ / カテゴリ＋自由記述 | 未決定 | 未記入 |
| 添付 | 初期対象外 / 採用 | 未決定 | 未記入 |
| 成功 | 一律202 / その他 | 未決定 | 未記入 |
| 冪等性 | key再送のみ統合 / 同一reporter-target統合 / 毎回別件 | 未決定 | 未記入 |
| 自動処分 | 常に禁止 | 承認候補 | 未記入 |
| 最終判断 | 運営者 | 未決定 | 未記入 |

## C. データ・プライバシー

- [ ] target typeとID形式を確定した。
- [ ] 対象不在・不可視・既存通報・他人の通報をレスポンスから区別させない契約を承認した。
- [ ] 理由カテゴリの値、表示文言、versionを確定した。
- [ ] 自由記述を採る場合、最大長、PIIの扱い、暗号化、ログ除外、staff scopeを確定した。
- [ ] 保存期間を、本文・target参照・監査メタデータ・backupごとに確定した。
- [ ] 削除・匿名化・法的保全・backup消去の責任者と手順を確定した。
- [ ] reporter、staff/operator、被通報者、運営者の閲覧・開示範囲を確定した。
- [ ] 通報者への受付確認、対象者への通知の有無を確定した。

## D. 技術承認

- [ ] `reports` schemaと必要なcase schemaの範囲を確定した。
- [ ] `heisei_report_writer`専用role、RLS、audit action allowlistを承認した。
- [ ] 一般`heisei_app`へmutation権限を付与しないことを承認した。
- [ ] report INSERTと`report.create`監査INSERTの同一transactionを承認した。
- [ ] DB障害・監査失敗時は安全な500/503とし、ROLLBACKすることを承認した。
- [ ] rate limitの閾値、または未設定時にfail-closedする接続点を確定した。
- [ ] staff閲覧API、通知、AI連携、処分、異議申立てを本MVPから分離することを確認した。

## E. GO判定

Phase BをGOにできるのは、B〜Dの必須項目が承認記録へ反映され、API契約・schema・RLS・保持/削除方針の矛盾が解消された場合だけとする。

現時点の判定: **BLOCKED**

承認後に必要な工程:

1. 承認内容を正式仕様またはADRへ記録。
2. API payload/responseと脅威モデルを確定。
3. migration、専用role、RLS、監査transactionを設計レビュー。
4. unit、RLS、実JWT/Hono/隔離PostgreSQL結合、並列・障害テストを実装。
5. Quality CIとlockfile不変性を確認。

