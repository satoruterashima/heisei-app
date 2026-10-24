# HEISEI-003I-A G4：通報保存・監査契約（DRAFT）

Status: **DRAFT / implementation preparation only**

この文書はG4の実装開始前に、データ契約、RLS、監査原子性、G2接続、G3暗号 envelope の候補を整理する。今回、通報API、schema、migration、DB role、RLS policy、Secret binding は実装・適用しない。

## 1. 判定区分

### CEO承認済みとして扱う前提

- 通報対象はユーザーに限定する。
- 通報者はサーバーで検証した active / L2以上の identity とする。
- 同一通報者・同一対象の未処理通報は統合候補とする。
- 通報本文は審査終了後90日、監査記録は365日、冪等性記録は30日という保持値をG3承認仕様の前提として扱う。ただし削除・法的保全・バックアップ復元の運用は別途具体化する。
- 自動処分は行わず、最終判断は運営者とする。
- G2のserver-side visibilityが `allow` であることを通報保存の前提とする。

### 技術レビューで確定候補にできる事項

- UUID主キー、server-side actor binding、strict check制約、pending部分一意インデックス。
- 生のIdempotency-Keyを保存せず、actorスコープのHMAC fingerprintを保存すること。
- 通報受付writerを一般DB roleから分離し、`report.create` 以外の監査INSERTを拒否すること。
- report INSERT と `report.create` 監査INSERTを同一transactionで行うこと。
- G3 envelope の ciphertext、nonce、algorithm version、AAD version、encryption key version、fingerprint version、fingerprint key versionを別々に保存すること。
- writerに通報の更新・削除権限を与えず、審査・削除は別の承認済み境界で扱うこと。

### 追加承認が必要な事項

- NFKC/trim後の本文だけを証拠として保存するか、原文の暗号化保存・原文ハッシュを併用するか。現行G3は正規化してfingerprint/暗号化するが、原文変更の証拠性ポリシーは確定しない。
- `pending` 以外の状態遷移、再通報時の扱い、対象ユーザー削除後の保持と閲覧。
- 運営者の復号権限、MFA、scope、閲覧監査、鍵rotationと削除の手順。
- 30日TTLの起点、期限切れ処理、監査・バックアップ・法的保全の例外。
- G2判定時点と通報保存後のvisibility/status/block変更が、既存通報の審査可否に与える影響。
- G5のactor単位レート制限、429/503の契約。

### BLOCKED

- production Secret/DB/provider binding。
- G2のallow根拠を再検証せずに保存するAPI。
- visibilityの判定とINSERTを別transactionにしたまま、競合時の再検証・ロック契約がない構成。
- 未承認の原文保存、スタッフ閲覧、保持・削除仕様のruntime確定。

## 2. Schema候補（まだ実装しない）

### `reports`

候補列：

- `id uuid primary key`
- `reporter_user_id uuid not null`
- `target_type text not null check (target_type = 'user')`
- `target_user_id uuid not null`
- `category text not null`（G3 category versionと対応するcheckまたは参照）
- `description_ciphertext bytea not null`
- `description_nonce bytea not null`
- `encryption_algorithm_version text not null`
- `encryption_key_version text not null`
- `aad_version text not null`
- `status text not null`（状態集合は追加承認が必要）
- `created_at timestamptz not null`
- `review_closed_at timestamptz null`

平文本文、生のIdempotency-Key、秘密鍵は保存しない。未処理統合の候補は次のような部分一意制約とするが、状態集合の承認後にmigration化する。

```sql
unique (reporter_user_id, target_type, target_user_id)
where status = 'pending'
```

### `report_idempotency`

候補列：`reporter_user_id`, `reporter_scope_digest`, `payload_fingerprint`, `fingerprint_version`, `fingerprint_key_version`, `report_id`, `created_at`, `expires_at`。actorとscope digestの組を一意にし、payload不一致を同じkeyの再利用として検出する。30日TTLはこの再照合記録の寿命であり、`reports.status = 'pending'` の重複防止とは独立する。

G3の鍵version変更後も、保存recordにある `fingerprint_key_version` を使って旧keyを指定して再計算する。旧keyが保管期限内にない場合は一致・不一致を推測させず安全な障害として扱う。

## 3. RoleとRLS候補

- `heisei_report_writer` は最小権限、`NOLOGIN`、`NOSUPERUSER`、`NOBYPASSRLS` とし、一般roleのINSERT/UPDATE/DELETE権限は拡張しない。
- writerのINSERTは、transaction内のserver-side identityと`reporter_user_id`が一致する行に限定する。
- actorはJWTの申告roleではなく、検証済みDB identityから決定する。
- RLS policyは対象UUIDの存在確認をクライアントへ返さず、cross-actor read/update/deleteを許可しない。
- writerは監査イベントを`report.create` allowlistと固定rule versionでのみINSERTできる。無関係な監査イベント、直接更新、監査なしのreport INSERTを拒否する。
- migration再適用時も一般roleの権限を復活させない。権限検査は適用後に必須とする。

## 4. TransactionとTOCTOU

推奨候補は、G2 visibility判定、冪等性照合、pending統合またはreport INSERT、`report.create`監査INSERTを、同一actor-bound transactionで実行する方式である。保存直前にtargetの存在・active・公開設定・双方向blockを再確認し、必要なprofile/block行を適切にlockするか、serializable相当の競合検出を用いる。

visibility評価とINSERTを別transactionにする場合、評価直後にtargetが停止・非公開・block状態へ変化し得る。再確認と競合時rollbackがなければ、無許可対象を保存できるため採用しない。別transactionが避けられない場合は、同じactor/targetをserializableまたは明示的lockで再検証し、commit時の条件不成立を検出できる設計が追加条件となる。成立しない場合はBLOCKEDとする。

G2判定後にvisibilityが変化した場合の既存通報の審査可否は、保存時の許可を履歴として維持するか、現在visibilityを再評価するかで事業判断が分かれる。ここは未承認であり、runtime仕様として固定しない。

監査INSERT失敗、暗号化・鍵取得失敗、RLS拒否、部分一意競合の扱いが契約外の場合は、reportと監査をともにrollbackし、内部SQL・鍵・平文を応答へ出さない。

## 5. G3 envelopeとの接続

`reports` はG3の `ciphertext`、96-bit nonce、`aes-256-gcm-v1`、`aad-v1`、encryption key versionを保存する。AADはreport id、reporter、targetを束縛する。冪等性側はpayload fingerprint、fingerprint version、fingerprint key versionを保存する。暗号鍵そのものと原文はDBへ渡さない。

NFKC/trimは現在の入力境界とcanonical fingerprintに必要だが、原文の変更を許す証拠ポリシーを意味しない。原文保存を採用する場合も、保存期間・閲覧者・再暗号化・削除をCEO承認後に定義する。

## 6. 実DBテスト計画（将来）

隔離PostgreSQLで、migration適用後に次を実JWT→Hono→server identity→DBの順で検証する。

1. writerの正常INSERTと同一transactionの監査記録。
2. 一般roleの直接INSERT/UPDATE/DELETE、監査迂回、無関係なaudit eventの拒否。
3. actor入替え、cross-actor RLS、target行の列・行越境がないこと。
4. pending部分一意制約と並列送信の統合。
5. idempotency TTLとpending重複防止が独立して動くこと。
6. G2 deny/unavailable、block/status変更、commit直前の競合で保存されないこと。
7. 監査失敗、RLS/SQL/接続障害、鍵欠落でreportとauditがrollbackすること。
8. migration再適用後も権限が拡大しないこと。

## 7. 最小migration単位と次工程

承認後の最小単位は、まず隔離DB専用のexpand-only migrationで `reports`、`report_idempotency`、必要なaudit allowlist、writer role、RLSを作り、適用後の権限・再適用・rollback試験を行うこととする。本番・共有DBには適用しない。APIやG5レート制限はこの検証の後に別工程とする。

次の最小開発単位は、(1)原文・状態・審査閲覧の承認、(2)TOCTOUのcommit時契約承認、(3)隔離DBの最小migrationとRLS負例テストである。これらが未承認のままG4 DB実装へ進むことはできない。

