# HEISEI 通報案件管理基盤（DRAFT / local-only）

## 目的と範囲

この文書は、通報対象ユーザー単位ではなく、通報 `report_id` 単位で担当スタッフの
閲覧範囲を制限するローカル実装の契約である。本番の担当割当、審査処理、復号、
処分、被通報者への開示は有効化しない。

## 案件割当

`report_staff_assignments(report_id, staff_user_id, assigned_at, revoked_at)` を使用する。
有効な割当は `revoked_at IS NULL` の行に限る。割当の作成・変更・解除用の公開APIは
存在せず、隔離DBの特権fixtureだけがテストデータを作成する。

スタッフreaderは `heisei_report_staff_reader`（NOLOGIN、NOSUPERUSER、NOBYPASSRLS）に
固定され、次の条件をDB側で同時に満たす必要がある。

- `app.user_id` が検証済みスタッフIDと一致する
- staff profile が `active`、L3以上、`admin` roleである
- reportに有効な案件割当が存在する
- reportは現在 `pending` である

JWTやHTTPのtarget ID、任意のscope GUCは割当根拠にならない。RLSはreport IDを
assignment表で照合し、別案件・別スタッフ・割当失効後の行を返さない。

## 閲覧と監査

`GET /api/v1/staff/reports` はローカルのメタデータ境界であり、report ID、対象種別、
対象ID、カテゴリ、状態、作成日時、review_closed_atだけを返す。暗号文、nonce、鍵、
平文本文は選択しない。各案件の閲覧は `audit_logs.report_id` を含む
`report.staff.view` として監査される。監査条件を満たさない直接INSERTはRLSで拒否する。

## 審査状態と保持

現行schemaのreport状態は `pending` のみである。したがって、審査終了、
`review_closed_at` の確定、終了後90日削除の本番経路は未実装である。保持計画は
既存契約（pendingは経過日数だけで削除しない、closed 90日、監査365日、
冪等性30日、legal hold優先）を維持し、実削除はローカルの原子的fixture境界に限る。

## 検証済み範囲

- 割当済みreportだけを閲覧可能
- 別スタッフ、割当失効、staff停止で即時拒否
- 暗号化列の取得拒否
- staff監査イベントの偽造・無関係操作拒否
- migration初回・再適用でrole membershipと権限が拡大しない
- 既存のG2〜G5、通報、DO、PostgreSQL回帰

## 本番前の承認事項

担当割当の正規管理者・変更監査、審査状態の許可遷移、復号権限、処分権限、
被通報者への通知・開示、legal hold管理者、closed状態を追加するmigrationと
削除Jobの運用をCEOが承認する必要がある。
