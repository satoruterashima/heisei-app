# HEISEI-003I-A G5 ローカル統合完了記録（DRAFT）

## 範囲

G5-02B-L のローカル Durable Object runtime、G5 quota core、G4 の read-only reconciliation 契約を、fixture 設定と隔離テストで統合した。通報 HTTP API、実 Cloudflare namespace、実 Secret、共有 PostgreSQL はこの文書の範囲外である。

## Durable Object 契約

`QuotaActor` は actor UUID から `idFromName` で固定され、quota 操作を外部 HTTP に公開しない。実 DO では input gate が同一 actor の RPC turn を直列化し、状態は `ctx.storage` に保存する。メモリ上のキューは正しさの根拠ではない。状態は version 2、actor、時刻、予約 status、各カウンタ、予約数を復元時に検証し、破損・未知フィールド・容量超過・時刻逆行は自動初期化せず fail closed とする。

保存の成功を確認するまで quota の成功を返さない。保存後に応答が失われた場合は、再起動後の同一 reservation の replay として扱う。`in_flight` または `unknown_commit` は TTL だけで解放せず `uncertain` として保持し、window が変わっても受付容量を安全側に占有する。

なお、ローカル pool の実行結果は Cloudflare の課金・容量・本番障害特性を証明しない。公式資料の live 取得は実行環境のネットワーク制限により完了できなかったため、リモート移行前に対象バージョンの公式仕様を再確認する。

## G4 read-only reconciliation

`ReportReadOnlyReconciler` は、server-side actor と、G4 の信頼済み暗号境界が生成した `keyVersion/scopeDigest/payloadDigest` の完全な候補 tuple のみを受け取る。raw Idempotency-Key、本文、暗号鍵は quota state や lookup 境界に渡さない。

- 完全一致する tuple の保存証拠だけを `stored` とする。
- 通常の検索結果 0 件（`not_found`）は `unknown` とし、`not_stored` にしない。
- `not_stored_proven` の明示的な証拠だけを取消候補にする。
- DB 障害・鍵欠落・不一致は `unavailable` / `key_missing` / `unknown` のまま保持する。
- quota の actor lock 下で reconciliation 結果を予約状態へ反映する。

現行の DB role には reconciliation 専用 read-only role を追加していない。したがって、実 PostgreSQL の照合 executor と権限境界は次工程の残存条件であり、既存 writer 権限や RLS を迂回する実装は行っていない。

## 将来の HTTP 応答契約案（未承認）

以下は本番値を確定しない設計案である。

| 内部結果 | HTTP候補 | 外部に返す情報 |
|---|---:|---|
| accepted / replayed / duplicate / denied / unknown target | 202 | 対象の存在・保存状態を示さない固定応答 |
| 確定した quota 超過 | 429 | 固定形式。`Retry-After` の有無と値は承認待ち |
| unavailable / unknown_commit / reconciliation障害 | 503 | 内部状態・DB・鍵情報を含めない固定応答 |
| 同一 key の内容不一致 | 安全な固定エラー候補 | 対象や既存保存の有無を示さない |

request gate は invalid、replay、duplicate、denied も数える。新規受付 quota は予約を確保し、保存結果が確定するまで確定・取消を行わない。閾値、費用上限、Retry-After、監視通知、Secret 運用は CEO 承認が必要である。

## 検証範囲

同一 actor の並列 request/reservation、actor 分離、DO 再起動、保存応答喪失、破損状態、容量上限、in-flight/uncertain の保持、window 切替、read-only reconciliation の証拠検証を実施する。fixture で再現できない実 runtime の crash/課金/ネットワーク挙動は未証明として扱う。

## 残存 BLOCKED

1. 実 Cloudflare namespace/binding と本番相当の公式仕様・費用確認。
2. G4 PostgreSQL の actor-bound read-only reconciliation role/executor。
3. 実 Secret provider、production threshold、Retry-After、運用上限。
4. 公開 `POST /api/v1/reports` と G5 runtime の結合、HTTP 情報非開示の実結合テスト。

