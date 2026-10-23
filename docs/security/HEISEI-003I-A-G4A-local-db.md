# HEISEI-003I-A G4-A：通報データ基盤（DRAFT）

Status: **DRAFT / isolated PostgreSQL only**

G4-Aは、通報APIやG2/G3/G5のruntime統合を行わず、通報保存に必要なschema、専用role、RLS、監査allowlistを隔離PostgreSQLで検証する工程である。PR #45/#46の未マージコードはmainへ取り込まず、G2/G3との接続はG4-Bの契約として残す。

## 実装したlocal-only migration

`packages/database/drizzle/0001_report_foundation_g4a.sql` を、baseline、auth foundation、`roles.sql` の後に適用する。

- `reports`: server-generated UUID、server-side reporter、user target、category/version、`pending`、created/review-closed日時、暗号化本文envelopeを保持する。
- 本文なしはciphertext、nonce、algorithm version、key version、AAD versionをすべてNULLにできる。本文ありは5項目すべて必須で、部分NULLはCHECK制約で拒否する。
- `report_idempotency`: actor scope digest、payload fingerprint、fingerprint/key version、nullable `report_id`、30日TTLのための時刻列を保持する。生key・平文本文は保持しない。
- pendingの `(reporter_user_id, target_type, target_user_id)` は部分一意インデックスで一意化する。TTLとは独立する。
- categoryは承認済み6値と`category-v1`に限定する。暗号envelopeはnonce 12 bytes、ciphertext 16 bytes以上、`aes-256-gcm-v1`、`aad-v1`、空でないkey versionを要求する。これらは形式制約であり、AES-GCM tagの真正性検証はG3側で行う。

## 権限境界

`heisei_report_writer` は `NOLOGIN`、`NOSUPERUSER`、`NOBYPASSRLS` とし、一般roleへreportsのmutation権限を付与しない。writerにはidempotencyの直接UPDATE権限を与えない。`heisei_report_ttl_writer`（`NOLOGIN`、`NOSUPERUSER`、`NOBYPASSRLS`、membershipなし）だけが2列のUPDATE権限を持ち、`SECURITY DEFINER`の`report_idempotency_touch(uuid)`がその権限を使用する。fingerprint、key version、report参照、actor等は関数引数にも更新対象にも含めない。関数は同じactorの行だけをDB時刻で更新し、期限を最終使用から30日に再計算する。RLSはtransaction-local `app.user_id`とserver-side actor行を一致させ、他actorの行を不可視にする。

監査allowlistは `report.create`、rule version `003i-g4a`、actor一致、target/request_id必須に限定する。既存のblock/profile/audit writer policyは変更しない。

## 原子性の境界

隔離SQLテストでは、report INSERTと`report.create`監査INSERTの同一transaction成功、および監査失敗時のreport rollbackを確認する。現状はwriterが`report.create`なしの直接report INSERTを実行できるため、DB単体で監査を必須化するtrigger/限定関数は未実装である。G4-Aではこの境界を明示し、API/repositoryでの強制とG2 visibility再検証をG4-Bの追加ゲートとする。

## 検証範囲

一般role・別actor・更新削除・cross-actor SELECT、pending重複・並列INSERT、別reporter/target、暗号envelope部分NULL、idempotency nullable report参照、監査allowlist、監査rollback、平文列不在、role membership、migration再適用を検証する。

実行は `scripts/test-database-local.sh` と既存の実JWT/Hono/PostgreSQLテストで行い、外部・共有・staging・本番DBには接続しない。

## BLOCKED / G4-B条件

- G2 visibilityを保存直前・commit時に接続するtransaction契約
- report INSERTと監査INSERTをAPIから常に原子的に実行するrepository境界、または承認済みDB強制機構
- G3 ciphertext envelopeを実鍵providerへ接続する方式
- HTTP 202、重複時projection、未知/不可視対象のruntime応答
- TTL削除、スタッフ閲覧・復号、鍵rotation、G5 rate limit

G4-Aのlocal schema/RLS PASSは、通報API Phase Bや本番公開の開始承認を意味しない。
