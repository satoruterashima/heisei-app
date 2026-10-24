# HEISEI-003I-A G4-B2 Phase 1：内部Report Repository（DRAFT）

Status: **DRAFT / isolated PostgreSQL only**

## 実装範囲

`ReportRepository`は公開HTTP APIではなく、検証済みserver identity、検証済みpayload、UUID v4 Idempotency-Keyを受け取る内部境界である。JWTの申告role・visibility・actor IDは認可根拠にしない。

G3の原文と正規化本文を分離し、原文は即時にAES-256-GCMへ渡すだけで、ログ・監査・DB平文列には渡さない。fingerprintは正規化本文から生成する。本文なしはNULL envelopeとする。

## 保存境界

`0004_report_repository_g4b2.sql` の `report_create_atomic_v2` が、以下を一つのtransactionで処理する。

1. canonical actor/target pair lock
2. actor単位のHMAC scope lock
3. 既存idempotencyの再照合
4. G2 active/L2/public/双方向block判定
5. pending重複判定
6. report・idempotency・`report.create`監査の保存

同一actorが同じIdempotency-Keyで別targetへ並列送信する場合も、HMAC scope由来のidempotency lockを取得する。pending一意制約と30日TTLは独立する。

PR #49の旧`report_create_atomic`は、新migration適用後にEXECUTE権限を撤去する。新関数だけを`heisei_report_writer`へ許可し、直接reports/audit INSERTは復活させない。

## 障害契約

- G2 deny、既存keyの不一致、鍵欠落、DB障害は外部へ内部情報を返さずfail closed。
- 監査・idempotency・制約失敗は全ROLLBACK。
- commit結果不明は`unknown_commit`として扱い、無条件の再INSERTを行わない。
- 再試行は同一actor・keyの再照合を先に行い、既存記録がなければ自動作成せずreconciliation対象とする。

## 保証範囲と残存条件

実装済みblock更新経路はcanonical pair lockへ参加する。`profile_visibility`と`account_status`の通常更新APIは未実装であり、高権限SQLによる直接変更は通常運用の保証範囲外である。

timeout、deadlock、commit failure、接続断に対する本番Repositoryの実運用処理と、G3実Secret provider接続は次工程である。通報POST、G5、スタッフ閲覧・復号APIは実装していない。
