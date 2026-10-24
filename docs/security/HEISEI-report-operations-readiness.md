# HEISEI 通報運営機能準備（DRAFT）

> 案件単位の現行契約は `HEISEI-report-case-management.md` に更新されている。
> 本書の target-user scope / trusted assignment resolver は履歴上の準備案であり、
> 現行のRLS認可根拠ではない。

## 保持・削除契約

今回の承認済み保持仕様は次の通りである。

- `pending` 通報は経過日数だけでは削除しない。
- 審査終了後の通報データは90日保持する。
- 監査ログは365日保持する。
- `report_idempotency` は最終使用から30日保持する。
- legal hold対象は保持期間を超えても削除しない。

ローカルの削除計画は、審査終了時刻、監査ログとの関係、legal hold、復元後の再実行を入力として候補を作るだけである。削除実行は専用role・固定SQL・削除監査・バックアップ確認を伴う別工程とし、pending、uncertain、法的保全対象を自動削除しない。

ローカルfixtureでは、レポート削除・監査削除候補と削除監査を単一の `applyDeletion` 境界へ渡す実行契約まで検証する。production DBへ接続するJob、未承認のstatus変更、削除の実行時刻・batchサイズは含まない。現行DBのreport statusは `pending` 固定で審査終了経路が未実装のため、closedデータの実DB削除はBLOCKEDである。

復元後は削除済み対象の再削除候補を再計算する。ただし削除証拠がない状態で、復元されたデータを無条件に消去しない。

## スタッフ運用境界

ローカル実装した `GET /api/v1/staff/reports` は、server-side identityが active、L3以上、`admin` roleである場合だけ利用できる。現行実装の割当対象は `report_staff_assignments` の有効な案件IDからDB/RLSで導出する。

返却対象は、pending通報のID、対象、カテゴリ、状態、作成時刻などのmetadataだけである。暗号文、nonce、鍵version、平文本文はSELECT/API応答に含めない。閲覧は `report.staff.view` として監査し、DBのactor-bound案件割当で対象行を制限する。

以下は未実装・未有効化である。

- 復号と鍵利用
- 審査状態変更
- 処分・アカウント停止
- 被通報者への開示
- 割当変更
- legal hold設定・解除

これらは、担当者の範囲、二重承認、開示・異議申立て、復号監査、保持例外の事業承認後に独立して実装する。

## ローカル検証

- staff roleは `NOLOGIN/NOSUPERUSER/NOBYPASSRLS`。
- reportsの暗号化列への列権限を持たない。
- target scope外の行をRLSで取得できない。
- metadata閲覧と閲覧監査INSERTを同一transactionで行う。
- member、停止中、JWT不正、reader障害は拒否または安全なエラーとする。
- migration再適用でrole membership、列権限、RLSが拡大しない。

## 残存承認事項

本番の削除Job、実際のassignment source、スタッフ認証roleとL3/admin対応、復号権限、処分・開示ポリシー、法的保全の操作権限、復元手順、監査ログの365日削除方式はCEO承認が必要である。
