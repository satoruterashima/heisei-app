# HEISEI-003I-A G4：PostgreSQL・RLS・監査設計（DRAFT）

Status: **DRAFT / G4 CONDITIONAL、Phase B実装BLOCKED**  
Scope: local isolated PostgreSQL design only. No migration, role, grant, RLS policy, or application code is added.

## 1. 現状境界

- `profiles`、`user_verifications`、`user_settings`、`blocks`、`audit_logs`が既存schema。
- `heisei_app`はblocks/audit mutationを持たず、block/profileは専用writerでtransactionを作る。
- RLSはtransaction-local `app.user_id`等と固定roleを組み合わせる。
- `reports`、`report_idempotency`、`heisei_report_writer`、`report.create` allowlistは存在しない。
- staff閲覧・審査・status変更APIは存在しない。

根拠: `packages/database/src/schema.ts`、`packages/database/drizzle/0000_auth_foundation.sql`、`packages/database/drizzle/roles.sql`、`packages/database/src/local-postgres-executor.ts`、`packages/database/src/postgres-stores.ts`。

## 2. 最小schema候補

名称・index名・暗号列の型は実装レビューで固定する候補であり、承認済みmigrationではない。

### reports

| 列 | 候補 | 制約 |
| --- | --- | --- |
| id | server-generated UUID | client指定不可 |
| reporter_user_id | UUID | profiles FK、actor RLSと一致 |
| target_user_id | UUID | profiles FK、可視性確認済みのみ保存 |
| category | enum相当varchar | 6カテゴリ、versionを監査/行へ保持候補 |
| description_ciphertext | bytea/text | AES-GCM ciphertextのみ、平文不可 |
| description_nonce | bytea/text | record unique nonce |
| description_key_version | varchar | secret rotation用 |
| status | varchar | 初期値`pending`のみ |
| created_at/updated_at | timestamptz | server time |
| review_closed_at | nullable timestamptz | Phase Bではnull固定、後続用 |
| retention_deadline | nullable timestamptz | pendingは自動起算しない |

### 一意性

- `UNIQUE (reporter_user_id, target_user_id) WHERE status = 'pending'`相当のpartial unique index。
- `report_idempotency`にactor namespace、key digest、payload fingerprint、key version、last_used_at、accepted projection、optional report referenceを保存する候補。
- unknown/invisible acceptedはreport本体を作らず、key記録だけ同じ投影で作成する。key記録がtarget存在時だけ作られる設計は禁止。
- idempotency keyの30日保持とpending uniquenessは別制約・別期限で維持する。

## 3. role/RLS候補

### `heisei_report_writer`

`NOLOGIN NOSUPERUSER NOBYPASSRLS`。必要なsequence/schema usage、reports INSERT、idempotency INSERT/更新、限定SELECTだけを付与する。一般`heisei_app`へreport/audit mutationを付与しない。

### policy境界

- reports INSERT: `current_user = 'heisei_report_writer'`かつ`reporter_user_id = current_setting('app.user_id', true)`。
- reports SELECT: Phase BではAPIのINSERT RETURNINGに依存せず、reporter/staffの一覧SELECTを付与しない候補。必要なINSERT結果はserver-generated request IDのみ返す。
- reports UPDATE/DELETE: Phase Bではpolicy/権限なし。審査・削除は後続工程。
- idempotency INSERT/更新: actor namespaceとtransaction-local actorが一致。別actorのkey存在を観測できない。
- audit INSERT: report writerは`action = 'report.create'`、固定rule version、actor/GUC一致、request ID非nullだけ許可。
- audit SELECT/UPDATE/DELETE: report writerには付与しない。staff scopeは別承認・別実装。

### migration再適用

1. role作成は`IF NOT EXISTS`後に固定属性へ矯正。
2. 一般roleのreport/audit mutationを毎回REVOKE。
3. report writerのgrantを必要列・必要操作に限定。
4. policyをdrop/createしてallowlistを固定。
5. role membership、PUBLIC grant、owner/BYPASSRLSをテストで確認。

## 4. transaction

一つのtrusted transactionで次を実行する候補：

1. actor contextを設定し、server identity・active/L2を確認。
2. idempotency keyをinsert/lockし、同一keyのfingerprintを判定。
3. targetのserver-side visibility predicateを確認。未実装・不明・DB障害なら保存しない。
4. allowed targetだけpending uniqueを原子的にinsert。競合は既存行を変更せずaccepted投影。
5. `report.create`を1回だけinsert。
6. commit。監査、RLS、FK、接続、暗号化の失敗は全ROLLBACK。

未知・不可視の202とDB failureを同じcatchで処理してはならない。未知対象由来の想定FKだけを許可する場合もconstraintを明示し、audit failureやconnection failureを202へ握りつぶさない。

## 5. 保持・削除・復元

CEO承認済みの運用目標を設計に反映するが、Phase Bでは自動処理を実装しない。

- closed後90日: ciphertextとtarget referenceを削除または復元不能匿名化。
- audit: 365日。本文、秘密、不要な識別情報を保存しない。
- idempotency: 最終使用から30日。pending uniquenessは別制約で維持。
- pending: 30日ごとに滞留点検。自動closed遷移は実装しない。
- backup: 上限30日を運用目標。restore時に削除記録を再適用。
- legal hold: 理由、承認者、解除条件、範囲を記録する別設計。

実DBのbackup/restore仕様、暗号鍵破棄、法令適合性が検証できない限り、本番運用はBLOCKED。

## 6. RLS・監査テスト計画

- 一般`heisei_app`のreport INSERT/UPDATE/DELETE、audit INSERTを拒否。
- writerが別actor、別target、別role、任意の`app.user_id`を使えない。
- report writerが`profile.update`、`block.create`等をauditへ書けない。
- migration再適用で権限が復活・拡大しない。
- 同一key、異なるkey、別actorの並列送信でreport/audit件数を確認。
- pending partial unique競合で既存category/本文が上書きされない。
- audit failure、FK/RLS、DB接続、暗号失敗でreportとauditが残らない。
- pooled connectionでactor/GUC/roleが次のtransactionへ漏れない。
- unknown/invisibleではreport本体がなく、key投影だけが外部差異を作らない。

## 7. 判定

DDL/RLS/transaction設計: **CONDITIONAL**。承認済み事業仕様に沿う候補を作成済み。  
実装・検証: **BLOCKED**。G2 visibility predicate、G3本文鍵管理、実DBレビューが未解消。

