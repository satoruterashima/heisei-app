# HEISEI-003I-A: ユーザー通報受付APIの仕様監査と実装ゲート

Status: Phase A GO / Phase B BLOCKED. This report is documentation only. It
does not add `POST /api/v1/reports`, a table, migration, role, production
configuration, or an AI/moderation action.

関連:

- [Issue #34](https://github.com/satoruterashima/heisei-app/issues/34)
- [Issue #29](https://github.com/satoruterashima/heisei-app/issues/29)

## 1. 判定

### Phase A: GO

正式v2.0と現行コードを調査し、L2以上のactive identityを入口にして、Hono、
PostgreSQL RLS、専用writer、同一トランザクション監査を使うべき境界までは
根拠を持って定義できる。通報をAIへ直接渡さず、AIによる自動処分を行わない
ことも確定できる。

### Phase B: BLOCKED

現時点で安全に永続化できる最小の通報契約が確定していない。v2.0は通報の存在、
監査可能なAPI、MVP2への包含を示すが、次の必要なデータ/ポリシーを確定していない。

- 通報対象の型（user、post、comment、thread、community、message等）とID形式。
- 通報理由の分類、自由記述の有無、文字数、言語、証拠/添付の扱い。
- 同一reporter-targetの重複と並列送信の業務意味。
- 保存期間、削除/匿名化、法定保存、バックアップからの消去。
- 通報者、被通報者、スタッフ、運営者それぞれの閲覧範囲。
- case化、status、優先度、SLA、異議申立て、処分との連携。

これらを独断で決めてPOSTを実装すると、入力値・個人情報・保持期間・重複状態を
正式仕様にしてしまう。Issue #34の指示に従い、Phase Bは実装せず、承認後に
実装できる安全契約と受入テストだけを提示する。

## 2. 調査対象と証拠

### 2.1 正式v2.0で確定している範囲

| 項目 | 根拠 | 判定 |
| --- | --- | --- |
| 通報は安全機能として存在する | `資料/V2/HEISEI_企画要件定義_基本設計書_v2.0.docx` §11、抽出行262-264 | APPROVED: 画面/管理領域の存在。ただし画面契約は未定義 |
| 通報はMVP2の範囲 | 同基本設計書 §14、抽出行314-327 | APPROVED: 優先度。入力仕様は未定義 |
| 通報はAPI経由・監査可能 | `資料/V2/HEISEI_技術選定書_v2.0.docx` §2、抽出行87-95 | APPROVED: trust boundary。テーブル/監査actionは未定義 |
| `/reports` はAPI領域の候補 | 同技術選定書 §4、抽出行107-130 | APPROVED候補: pathの方向性のみ。HTTP payload/responseは未定義 |
| AIは通報の重大度・カテゴリ・要約をJSON出力する構想 | 同技術選定書 §7、抽出行161-179 | DRAFT相当の設計方針。AI投入条件、モデル、処分権限は未確定 |
| 最小保存・人間の最終判断 | 同基本設計書 §10・§13-15、抽出行230-239、300-340 | 方針として確定。ただし具体的な保持期間・公開範囲は未定義 |

v2.0の「通報」は受付の存在を承認しているが、任意の分類、本文、target type、
status、retentionを承認しているわけではない。

### 2.2 草案・提案と現行実装

| ソース | 事実 | 判定 |
| --- | --- | --- |
| `docs/api/auth-and-safety-contracts.md:7-33` | `POST /api/v1/reports`をL2、共通JSON、request ID/idempotency、通報内容最小保存として提案 | DRAFT/PROPOSAL。target/fields/duplicate semanticsは未定義 |
| `docs/architecture/data-model-proposal.md:13-29` | `reports/moderation_cases`を概念ERDと後続migrationに置く | DRAFT。実DBの承認済みschemaではない |
| `docs/moderation/requirements-draft.md:1-40` | ルール検知、人間レビュー、可逆性、AI制限を記載 | DRAFT。保存期間、公開範囲、処分条件等は明示的に未決定 |
| `docs/decisions/open-questions.md:5-23` | 保存期間、AI閾値、停止条件等を未決定として管理 | APPROVEDな確定値なし |
| `apps/api/src/index.ts` | session/profile/access/blockのみ。reports routeなし | NOT_IMPLEMENTED |
| `packages/database/src/schema.ts:4-81` | profiles、verification、settings、blocks、audit_logsのみ。reportsなし | NOT_IMPLEMENTED |
| `packages/database/drizzle/0000_auth_foundation.sql:61-214` | blocks/auditのRLSと固定roleのみ。reports role/policyなし | NOT_IMPLEMENTED |
| `tests/` | reportsのunit/API/PostgreSQL結合fixtureなし | NOT_IMPLEMENTED |

## 3. 通報者・対象・データ・閲覧権限の監査

### 通報者

正式v2.0には「誰が通報できるか」の明示的な表はない。既存の安全API案はL2を
候補にしているが、これは正式v2.0原本ではなく提案文書である。したがって、今回
安全に採用できる最小候補は「verified JWTがDB identityへ解決され、activeかつ
L2以上の利用者」だが、最終的にはIssue #34の承認事項として記録する。

通報者は必ずserver-side identityから決定し、body/JWT claimに含まれるactor ID、
role、auth level、statusを信頼しない。停止中の通報窓口をどうするかは、正式な
法的窓口・異議申立てとの関係を承認するまで確定しない。

### 通報対象

正式資料は安全画面、管理画面、投稿/コミュニティ等を列挙するが、受付対象を
ユーザーだけに限定するか、投稿/comment等を含めるかを決めていない。従って、
target typeとIDを勝手に`userId`へ固定しない。未知targetの存在を返すと、通報API
自体がアカウント/投稿の存在oracleになるため、対象不在・対象不可視・block関係・
権限不足の応答設計も対象型ごとに必要である。

### 通報内容

v2.0の禁止事項（外部連絡先、金銭要求、権利侵害等）はサービスルールの例であり、
通報理由enumの承認済み一覧ではない。自由記述本文を受けるか、添付を許すか、
PII/秘密/他人の本文をどう扱うかも未確定である。現段階で最小保存を理由に、
任意の`reason`、`description`、`evidence`を実装してはならない。

### case、status、retention

`moderation_cases`、status、priority、SLA、保存期間、削除/匿名化は未実装かつ
未承認である。通報を受け付けたことは違反認定ではなく、アカウント停止・非表示・
AI処分へ自動遷移させない。`docs/moderation/requirements-draft.md`の
`active`/`ai_suspended`/`suspended`/`banned`は運営草案であり、今回のAPIが状態を
変更する根拠にはならない。

### 閲覧制限

reporterへの受付確認と、staffの調査閲覧は分離する。reporterには受付結果とopaque
request ID以外のcase情報、被通報者情報、他の通報者、内部メモを返さない。staffの
閲覧scope、被通報者への通知、通報者の開示可否、監査ログの見える範囲は未承認で
あり、今回の受付APIで公開しない。report本文や対象本文をLLM、ログ、エラー応答へ
そのまま渡さない。

## 4. 既存の安全境界との整合

- `packages/auth/src/authorization.ts:35-64`はactive statusとminimum auth levelを
  trusted identityで判定する。L2以上の受付に再利用できるが、report target権限は
  別途必要である。
- `packages/database/src/identity-loader.ts`のDB identity loaderはJWT subjectと
  profile/verificationを照合し、claimの権限を採用しない。DB障害はfail-closedする。
- `apps/api/src/index.ts:69-118`のprofile APIは本人profileだけ、`:122-175`のblock
  APIは既存のL2 active/専用writer/安全エラーのパターンを示す。
- `packages/database/drizzle/roles.sql:34-60`では一般`heisei_app`のblocks/audit
  mutationを拒否し、専用writerのみを許可している。reportsでも同じ原則を守る。
- `packages/database/drizzle/0000_auth_foundation.sql:190-214`のaudit RLSはroleと
  actor/GUCを結び付ける。report用writerはblock/profile writerと分け、監査actionを
  allowlistする必要がある。

## 5. Phase Bに進むための安全契約案（未承認）

以下は実装前に承認を得るための候補であり、現在のAPI契約ではない。

### 5.1 候補endpoint

```http
POST /api/v1/reports
Authorization: Bearer <verified-jwt>
Content-Type: application/json
Idempotency-Key: <opaque-client-key>
```

入力は、正式承認後にtarget型・target locator・reason・description・evidenceを
最小限のschemaへ固定する。actor ID、role、status、auth level、reporter profile
は入力に含めない。8KiB上限は既存block/profileの実装パターンと整合する候補だが、
通報本文/証拠を承認なしに受け付ける根拠にはならない。

### 5.2 応答候補

targetが存在するか、reporterに見えるか、既に通報済みかを応答から判定できない
ようにする。受付を非同期/人間レビュー前提とするなら、候補は次の形である。

```json
{
  "data": { "accepted": true },
  "requestId": "<server-request-id>"
}
```

候補statusは `202`。ただし、同じIdempotency-Keyの再送を同じ受付結果として扱う
か、既存通報を409にするかは未承認であり、独断で選ばない。入力構文不正は400/422、
JWT不正は401、L2未満/停止は403、保存先未設定は503、DB/監査失敗は内部情報を
含まない500/503とする候補である。

### 5.3 非開示原則

- unknown target、存在するが不可視のtarget、既存report、他人のreportを同一の
  accepted/no-op形状にできるかを対象型ごとに検証する。
- responseにtarget表示名、target存在、case ID、分類、重複件数、他人のreport、
  DB error、stack、入力本文を返さない。
- `requestId`は相関用であり、内部report IDや連番を兼ねない。
- `Cache-Control: no-store`を付ける。ログ/metricsにも本文、token、PIIを出さない。

## 6. DB/RLS/監査の実装案（承認後のみ）

### 最小候補schema

正式承認後に、target型と内容を確定してから次のような構造を設計する。名称、列、
保持期間は未確定であり、このPRでは作成しない。

- reports: server-generated report ID、reporter user ID、target type、target ID、
  approved reason fields、status、idempotency fingerprint、created_at。
- evidence/content: 本文/添付を採用する場合のみ、目的・暗号化・保持期間・アクセス
  scopeを別承認する。本文をaudit_logsへ複製しない。
- moderation_cases: case化を今回の受付に含める場合のみ別テーブルで設計する。

### role/RLS

- `heisei_app`へreports/auditのINSERT/UPDATE/DELETE権限を追加しない。
- `heisei_report_writer`を`NOLOGIN NOSUPERUSER NOBYPASSRLS`の固定roleとして作り、
  actorをtransaction-local `app.user_id`に束縛する。
- reporterのINSERTはserver-approved actorと入力されたtargetの最小範囲に限定する。
  reporterは他人のreportをSELECT/UPDATE/DELETEできない。
- staff閲覧roleは、承認済みの担当scopeが実装されるまで作らない。staff APIを今回
  の受付APIに混ぜない。
- `audit_logs`のreport actionはreport writerだけがallowlistでINSERTできる。block/profile
  writerの権限を拡張しない。
- migration再適用で一般roleの権限、RLS policy、監査allowlistが復活/拡大しない。

### 原子性

report INSERTと`report.create`監査INSERTを同じtransactionで実施する。監査失敗、
FK/constraint失敗、接続失敗はreportを残さずROLLBACKし、APIは安全な500/503を返す。
no-op/idempotent再送で新しいreport行を作らない場合に監査を追加するかは、承認した
idempotency semanticsに従う。

## 7. 実装前の負例テスト計画

### 認証・入力

- token欠落、不正署名、期限切れ、unknown subject、JWTのactor/role/level偽装。
- L1、suspended、ai_suspended、banned、無効なidentityを拒否。
- bodyのactorUserId、reporterId、role、target owner、statusを無視/拒否。
- Content-Type不正、空/未知フィールド、target型不正、長すぎる文字列、8KiB超過、
  malformed JSONを検証する。未承認のreason enumをテストデータとして固定しない。

### 非開示・対象

- existing/unknown/inaccessible targetへの同じ入力形状でstatus/body/requestId以外を
  比較し、存在、可視性、既存report、他人reportを推測できないことを確認する。
- user/post/comment等のtarget型を承認前に勝手に有効化しない。実装後は型ごとに
  RLS、FK、削除/退会、block、不可視状態を検証する。
- reporterに他人のreport、内部case、被通報者の個人情報、通報者のidentityを返さない。

### 重複・並列・障害

- 同じIdempotency-Keyの再送、異なるkeyで同一内容、同一reporter/targetの並列POST。
- 同じtargetへの別reporterの並列POST。業務上の重複許可/統合は承認後に確認する。
- audit INSERT失敗でreport rowが残らないこと、report INSERT失敗でauditだけ残らないこと。
- DB障害、RLS拒否、role未設定、migration再適用、pool/GUC漏れ、missing storeを検証する。
- response、structured log、audit本文にreport content、token、秘密、stackを出さない。
- report保存後にAI/処分/停止が自動起動しないことを確認する。

### 実結合

実RS256 JWT → Hono → 隔離PostgreSQLで、synthetic fixturesのみを使う。mock storeだけ
で完了判定しない。TypeScript、ESLint、Vitest、PostgreSQL RLS、role/grant、migration
reapply、Worker bundleをQuality CIで通す。

## 8. 実装工程（承認後）

1. **仕様承認**: target型、reason、content/evidence、duplicate、retention、閲覧権限、
   status/case化、法務/CEO承認を正式仕様へ記録する。
2. **契約/脅威モデル**: unknown target非開示、202/201、idempotency、rate-limit hook、
   reporter/staff境界を固定する。rate limitは閾値を勝手に決めず、未設定時はfail-closed
   できる接続点を定義する。
3. **DB/RLS**: reportsと必要なcontent/caseを小さいmigrationで追加し、report writer、
   grant、policy、reapply/rollbackを検証する。
4. **repository/API**: bound SQL、verified DB identity、active L2+、strict Zod schema、
   report/audit atomic transaction、safe errorsを実装する。
5. **テスト**: unit、RLS、実JWT/Hono/PostgreSQL、並列、duplicate、監査失敗、障害、
   privacyを通す。
6. **運用承認**: retention/deletion、staff workflow、monitoring、問い合わせ/appealを
   承認してから、別PRで本番反映可否を判断する。

## 9. 未決定事項・BLOCKED解除条件

次を独断で確定しない。

1. 最小MVPのtarget type（userのみか、投稿等を含むか）。
2. reason categoryの正式な列挙、自由記述、文字数、添付証拠の採否。
3. 受付成功の`202`/`201`、idempotency keyの保存と再送応答、重複の業務意味。
4. 通報者のL2要件の正式承認、停止中の法的窓口、対象への通知/非通知。
5. report内容・個人情報・添付の保存期間、削除、匿名化、法定保存、backup消去。
6. reporter/staff/被通報者/運営者の閲覧・開示範囲と担当scope。
7. reportとmoderation_caseの関係、status、priority、SLA、異議申立て。
8. AIへの送信条件、モデル、費用、要約の利用範囲。自動処分は今回の範囲外。

これらが正式仕様または明示的な承認記録で確定した時点で、Phase BをGOへ再判定する。
Issue #29のblock list、表示権限、capability、HEISEI-003I-B以降には着手しない。
