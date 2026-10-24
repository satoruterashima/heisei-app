# HEISEI 通報MVP ローカル統合（DRAFT）

## 実装範囲

隔離 PostgreSQL、fixture 鍵、ローカル Durable Object/Storage を使い、認証済み server identity から quota 予約、保存開始、G4 ReportRepository、quota 確定までを接続した。公開サービスへの有効化、実 Cloudflare namespace、実 Secret は含まない。

`POST /api/v1/reports` はローカル Hono 境界として実装した。active かつ L2 以上の identity のみを受け付け、actor は JWT の申告値ではなく DB identity から決定する。入力は 8KiB、カテゴリ、UUIDv4 Idempotency-Key、説明文の既存制約を通過した場合だけ Repository に渡す。

## 応答と障害

- accepted / replayed / duplicate / denied / 不可視対象: 同一の 202
- 同一 key の内容差異: 409 の固定エラー
- quota 超過: 429 の固定エラー
- DB、DO、暗号化、reconciliation、commit 結果不明: 503 の固定エラー

対象 UUID、保存有無、DB SQL、暗号鍵、本文は応答・ログ・quota state に出さない。Retry-After、production threshold、費用上限は未承認のため設定値として外部化する余地だけを残し、本番値は設定していない。

## Reconciliation

`heisei_report_reconciler` は `NOLOGIN/NOSUPERUSER/NOBYPASSRLS` の専用 role で、`report_idempotency` の actor-bound `SELECT` のみを持つ。`PostgresReportIdempotencyReadOnlyLookup` は key version、scope digest、payload digest の完全一致を確認する。通常の 0 件検索は `not_stored` の証明に変換しない。INSERT、UPDATE、DELETE、reports/audit_logs 読み書きは許可しない。

## quota の安全性

quota 予約は server-generated reservation ID を使用する。保存後の応答喪失、unknown commit、DO/DB障害は `uncertain` を自動解放しない。Repository が replay/duplicate/denied を確定して返した場合だけ、今回の予約を消費せず安全に終了する。保存成功時だけ admission を確定する。

## テスト

実 JWT → Hono → ReportRepository → actor-bound PostgreSQL/RLS の正常系、replay、idempotency conflict、未知対象の非開示、監査行数、read-only reconciliation、quota 並列・再起動・障害テストを実行する。

## 残存条件

1. 実 Cloudflare での namespace、費用、容量、障害特性の承認・検証。
2. production quota threshold、Retry-After、費用上限、監視・Secret 運用の CEO 承認。
3. 本番用鍵 provider と本番 PostgreSQL 接続の承認。
4. 本番デプロイと公開 API 有効化の承認。

