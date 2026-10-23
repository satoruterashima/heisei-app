# HEISEI-003H-U2-P0: ブロック一覧の表示権限証明元監査

Status: BLOCKED. This is a source audit and implementation-readiness report for
Issues #32 and #29. It does not implement an API, add a table or migration,
change a provider, mutate a database, or deploy anything.

関連:

- [Issue #32](https://github.com/satoruterashima/heisei-app/issues/32)
- [Issue #29](https://github.com/satoruterashima/heisei-app/issues/29)
- [U2 safety design](HEISEI-003H-U2-block-list-safety.md)

## 1. 判定

### BLOCKED: 現時点で安全なブロック一覧実装は開始しない

現行リポジトリには、攻撃者が任意UUIDをPOSTすることとは独立して、actorが
targetプロフィールを表示してよいとサーバーが証明できる実装済みの関係ソースが
ない。従って、`GET /api/v1/blocks` を全block行に対して実装する根拠はなく、
一覧の件数・項目・カーソルを使ったPOST→GET存在推測を防げない。

v2.0正式資料は、ゲストの「公開情報の一部閲覧」、マイフレの相互承認、同じ
コミュニティ等のプロダクト方針を定めている。しかし、どのプロフィール項目を
どのactorへ、どのサーバー判定で返せるかという表示認可契約までは定めていない。
ドラフトの `public_read` やクライアントの画面名を、UUIDからプロフィールへ
解決する認可として扱うことはできない。

### 現時点で許容できる範囲

- 既存のblock作成・block ID解除・target UUID解除は変更しない。
- target UUIDを受け取らず、対象一覧を作らない設計調査・DB/RLS試験計画は進められる。
- 正式に選ばれた表示権限ソースが実装されるまで、block list APIとdisplay proofの
  発行を追加しない。

### GOに変えるための条件

次のすべてを承認・実装・検証する必要がある。

1. 最初の表示権限ソース（プロフィール公開範囲、マイフレ、コミュニティ等）を
   CEO/仕様責任者が明示的に決める。
2. そのソースに対応するserver-sideのactor/target関係、失効、停止、退会の
   判定を実装する。
3. 任意UUIDだけでは証明を発行できないことを、APIとRLSの実テストで確認する。
4. 証明済み行だけを返す一覧のレスポンス、件数、cursor、退会時挙動を承認する。
5. 実RS256 JWT、Hono、隔離PostgreSQL、RLS、並列実行の負例を通す。

## 2. 調査対象と優先順位

`docs/index.md:6-18`に従い、優先順位を次のようにした。

1. 今回のIssue #32の明示要件。
2. `資料/V2/`の正式v2.0原本。
3. `AGENTS.md`、既存の認証・DB信頼境界。
4. 現行コードとテスト（実装事実）。
5. `docs/`の既存設計案・未決定事項。

確認した正式資料:

- `資料/V2/HEISEI_企画要件定義_基本設計書_v2.0.docx`
- `資料/V2/HEISEI_会員ワークフロー仕様書_v2.0.docx`
- `資料/V2/HEISEI_技術選定書_v2.0.docx`
- `資料/V2/HEISEI_正式デザイン方針書_v2.0.docx`

これらは2026年8月5日付v2.0原本であり、今回の報告書は原本を変更しない。

## 3. 正式v2.0仕様と実装事実の照合

| v2.0の記載 | 原本の根拠 | 現行ソースの確認結果 | 表示証明としての評価 |
| --- | --- | --- | --- |
| ゲストは公開情報の一部を閲覧 | 基本設計書 §3、pandoc抽出行91 | `GET /api/v1/profile`は認証済み本人のみ（`apps/api/src/index.ts:69-82`）。target公開プロフィールAPIなし | 仕様方針はあるが、対象UUIDからの公開解決を許可する具体的predicateなし。採用不可 |
| マイフレは相互承認 | 基本設計書 §4・§8、抽出行119・192-194 | `friend_requests`/`friendships`テーブル、store、routeは未実装。`apps/mobile/App.tsx:63-69`はタブ表示だけ | NOT_IMPLEMENTED。証明元にならない |
| 同じコミュニティ等の関係で個別交流を制御 | 会員ワークフロー §3、抽出行80、権限マトリクス | `community_members`や参加関係を保持するmigration/APIはない。`community_speak`は抽象的prerequisiteだけ（`packages/auth/src/access-policy.ts:86-93`） | NOT_IMPLEMENTED。membershipを証明できない |
| コミュニティ参加・詳細・メンバー画面 | 基本設計書 §7・§11、抽出行176-188・254-258、デザイン方針 §9 | Drizzleに`communities`概念表はあるが、migrationとmember関係はない（`packages/database/src/schema.ts:107-118`） | UI/概念設計だけで、server-side表示権限なし |
| プロフィール/検索API | 技術選定書 §4・§9、抽出行107-125・197-203 | 技術候補のAPI領域と検索方針のみ。targetプロフィール検索のroute/store/RLSなし | NOT_IMPLEMENTED。検索結果を表示証明とみなせない |
| 退会後の関係解除 | 会員ワークフロー §9、抽出行163-198 | account statusのidentity読込はあるが、friend/community/profile表示関係のcascadeはない | lifecycle要件はあるが、証明の失効実装なし |

### 重要な不一致

正式資料の「公開情報の一部閲覧」は、任意の内部UUIDを入力すれば対象プロフィールを
返すという意味ではない。現在のAPIにはtarget profile readがなく、`public_read`は
抽象的なoperation判定にすぎない。実装前に公開範囲、対象項目、停止/退会時の扱い、
block優先順位を別途決める必要がある。

## 4. 実装済みの認証・関係境界

### 本人プロフィールだけ

`apps/api/src/index.ts:69-82`は、verified JWTからDB identityを得て、L1以上の
actor本人のprofileだけを`findOwn(identity.userId)`で返す。target IDを受け取る
パラメータがないため、他人のプロフィール表示証明には使えない。

`packages/database/src/postgres-stores.ts:94-99, 221-233`のprofile SELECTも
`id = $1`であり、現在のProfileStore契約は`findOwn`だけである。

### 抽象的なrelationship callback

`apps/api/src/index.ts:13-20`には`approveRelationship`、`approvePrerequisites`、
`approveScope`の注入点がある。`apps/api/src/index.ts:188-212`ではaccess policy
のヒント計算に使われるが、`createApiAppWithDatabase`の実装は
`apps/api/src/index.ts:218-230`でidentity/profile/block storeだけを配線し、関係
storeや承認サービスを提供していない。従って、型上のcallbackは実在する表示証明
ソースではない。

`packages/auth/src/access-policy.ts:44-57, 79-95, 141-158`も、relationshipや
prerequisiteを「trusted server-side input」として受け取ってfail-closedするだけで、
その値を発行・検証・失効するDB実装は持たない。

### block relationは表示権限ではない

`packages/database/src/identity-loader.ts:26-33, 109-120`のBlockRelationStoreは、
actor/target双方のblock有無を読むためのものに限られる。blockが存在すること、または
blockを作成できたことは、targetプロフィールを表示してよい証明ではない。

### DB/RLSの現状

- `packages/database/src/schema.ts:47-66`はuser settingsとblocksを定義するが、
  friend関係、community member、conversation participant、display grantはない。
- `packages/database/drizzle/0000_auth_foundation.sql:61-68`はblocksだけを作り、
  `:169-188`のRLSは自分が作成したblockの変更と参加者向けblock readを制限する。
- `packages/database/drizzle/0000_auth_foundation.sql:197-207`のblock writer監査は
  `block.create`/`block.delete`だけである。表示証明の発行権限はない。
- `docs/architecture/data-model-proposal.md:13-25`もfriends等を「後続追加」とし、
  現在の初期ERDには含めていない。

## 5. 表示権限ソースの監査

### 5.1 プロフィール閲覧

**結論: NOT_IMPLEMENTED。**

v2.0は公開情報の一部閲覧を記載するが、以下が未定義/未実装である。

- actorがtarget profileを検索・閲覧できる具体的条件。
- targetごとの公開範囲、停止・退会・blockの優先順位。
- target UUIDを公開profile locatorへ変換する認可。
- 閲覧成功をblock listの表示証明として保存するタイミング。

本人profile APIをtarget readへ拡張するだけでは、任意UUID probingを許すため不十分。
公開profileを最初のsourceにするなら、検索/locator自体のoracleと表示項目を別設計し、
その結果が「一覧に表示してよい」ことをserver-sideに束縛する必要がある。

### 5.2 マイフレ関係

**結論: NOT_IMPLEMENTED。**

正式仕様の相互承認は、対象の正当な関係を証明できる候補である。しかし現行には
`friend_requests`、`friendships`、承認/取消イベント、RLS、API、監査がない。単に
`user_settings.allow_friend_requests`（`packages/database/src/schema.ts:47-54`）が
あることは、承認済み関係を意味しない。

最小の実装候補は、相互承認済みのfriendshipをserver-sideで判定し、その時点でだけ
actor-target display grantを発行すること。ただし、マイフレの申請上限、block優先、
解除/取消、停止/退会、複数端末の可視性を先に承認する必要がある。

### 5.3 コミュニティ参加

**結論: NOT_IMPLEMENTED。**

`communities`の概念表はあるが、member row、参加承認、待機3日、退出、停止時の
membership、targetを表示できる範囲が実装されていない。正式仕様の「同じコミュニティ」
は関係の候補であって、現在のDBから独立に証明できない。

また、同じcommunityにいることが、そのcommunity外のユーザーprofile全体を表示して
よいことを意味するかも仕様未決定である。community member一覧を第一sourceにする
場合は、対象範囲とblock優先順位を明示する必要がある。

### 5.4 会話参加者・その他

**結論: NOT_IMPLEMENTED。**

v2.0のメール/交換日記はL3・許可された関係を要求するが、会話・日記・参加者テーブル
とAPIはない。将来実装されても、「会話参加者ならtargetをblock listに表示可能」とは
自動的に決まらないため、sourceとして別承認が必要である。

### 5.5 JWT、任意UUID、block存在

いずれも表示証明のsourceにできない。

- JWTの`sub`はactorのsubjectを識別するだけでtargetの閲覧許可を示さない。
- clientが送るtarget UUIDは未検証の入力であり、認可根拠ではない。
- blockのINSERT成功、FK失敗、既存blockの存在は、一覧表示権とは別である。
- `POST /api/v1/blocks`は既存/unknown targetに一律202を返すため、POST結果から
  display proofを発行してはならない。

## 6. 任意UUID POSTから証明を作れないことの検証

### 現行の安全性

`apps/api/src/index.ts:124-147`のPOSTは、認証済みactor、L2、厳格なbody、self-block
を確認してblock storeを呼ぶが、レスポンスにtarget存在やblock IDを含めない。
`PostgresBlockMutationStore.blockOwn`は専用writerでINSERT/監査を行うが、これは
block mutationであって表示権限発行ではない。

### 実装時に守る不変条件

以下のいずれもdisplay proofを作成できてはならない。

1. unknown UUIDへのPOST。
2. knownだがactorに表示許可のないUUIDへのPOST。
3. 他人が作成したblock、既存random block IDの指定。
4. POSTの再送、並列POST、失敗後のretry。
5. JWT claimへの権限/target追加、client bodyへのactor/relationship追加。

proof発行関数はtarget UUIDを引数に取るだけでは不十分で、server-sideで既に検証済み
のdisplay contextまたは関係IDを必須にする。block mutation storeとproof storeを
同じtransactionに束ねる場合でも、proofの発行条件をblockの存在/FK成功に依存させない。

### 攻撃チェーンテスト

`POST guessed UUID → request eligible proof → GET list`を、次の組み合わせで比較する。

- existing target / unknown target。
- 正当な表示証明がない / 期限切れ / 失効済み。
- actor Aの証明をactor Bが再利用。
- 同一proofのparallel consume/replay。
- 既存random block ID / 新規block。
- target退会・suspended・削除後。

いずれも、証明なしのunknownとknownが一覧のitems、件数、nextCursor、順序、エラー、
更新時刻で区別できないことを要求する。

## 7. capability方式とdisplay grant方式

| 観点 | capability | display grant |
| --- | --- | --- |
| 基本 | 正当な表示ソースが発行するactor/target束縛tokenをblock経路で消費 | 正当な表示ソースの判定後、actor-target-blockに表示権行を保存 |
| 現状の実装可能性 | **BLOCKED**。発行元となる関係/閲覧APIがない | **BLOCKED**。保存するdisplay proofと発行トリガーがない |
| replay | token hash、one-time consume、短い期限、actor bindingが必要 | grant id/unique制約、expiry/revoked、actor/target bindingで制御 |
| 端末移行 | server tokenなら可能だが、token再取得/refresh設計が必要 | actorに紐づく行なら自然に可能 |
| 失効 | source失効イベントでtokenを無効化。期限と鍵管理が必要 | `revoked_at`/expiryとsource versionを更新。鍵管理が少ない |
| 監査 | issue/consume/replay/revokeを記録。token自体は記録しない | grant issue/revoke/list利用を記録。target情報のログ漏えいに注意 |
| DB変更 | capability hash、actor、target、source、expiry、used_at等 | actor、target、block、source、expiry、revoked_at等 |
| 部品数 | token生成、hash、期限、replay防止、key/secret運用が増える | DB row、専用writer/RLS、source revocationが中心 |
| 推奨用途 | 既に署名済みの一時的な画面遷移/明示同意が必要な場合 | 継続的な自分の一覧と複数端末UX |

### 比較結果

安全性が同等にできる前提では、今回の継続的なblock listにはdisplay grantの方が
秘密値・鍵・replay処理が少なく、運用と複数端末復旧が単純である。最初の表示ソース
としてmutual friendshipを正式に採用できる場合は、friendshipの確定transaction内で
grantを作る案を第一候補とする。ただしこれは仕様承認前の提案であり、決定ではない。

capabilityは、プロフィール表示を一回だけ許可する等の短期用途には有用だが、現状は
正当なmint channelがない。任意UUID POSTにcapabilityを返す実装は、方式名を変えても
oracleを復活させるため禁止する。

## 8. 最小構成の実装提案（承認後のみ）

### 前提

最初のsourceとして「相互承認済みマイフレ」を採用する場合の最小案を示す。これは
未承認の仮案であり、実装開始の許可ではない。プロフィール公開や同一communityを
sourceにする場合は、別の表示境界とテストが必要になる。

### API

1. 既存のfriend request/accept/revoke APIを、target UUIDの存在を不要に漏らさない
   契約で追加する。
2. server-sideで確定したfriendshipから、actor専用のdisplay grantを作る。clientの
   任意UUID POSTからgrantを作らない。
3. `GET /api/v1/blocks`はgrantが有効な自分のblockだけ返し、`total`、hidden count、
   block ID、grant ID、内部エラーを返さない。
4. list itemの解除は既存by-target APIを使う。既存blockがgrantを持たない場合も、
   既知のtarget UUIDを使う解除契約は変更しない。

### DB/RLS

- `friend_requests`、`friendships`（または正式決定した同等モデル）を追加する。
- `block_display_grants`を追加し、actor、target、block、source relation、source
  version、issued/revoked/expiryを保存する。block IDのrandom性を外部に出さない。
- `heisei_app`へ直接のgrant/block mutation権限を与えない。
- friendship確定、block作成、grant作成の範囲を明確にし、専用writerとRLS policyを
  分ける。どのwriterがどの監査actionをINSERTできるかをmigration再適用後も固定する。
- list SELECTはactorの`app.user_id`、有効grant、表示可能なtarget状態に限定する。

### 監査

- friend accept/revoke、grant issue/revoke、block create/deleteをactor、source、
  rule version、requestIdで監査する。
- tokenや秘密値をログに出さない。list readを監査する場合も、target UUIDやhidden
  countを本文に書かない。
- 失敗時は関係変更・grant・block・監査のatomicityを保つ。no-op解除は現行方針どおり
  監査を作らない。

## 9. 負例テスト計画

### 表示権限の根拠

- 本人profileだけが返り、target UUIDを指定したprofile readが勝手に許可されない。
- `approveRelationship: true`相当のclient入力、JWT claim、body fieldが無効。
- friend request送信中、片側承認、revoke後、block後をfriendshipと混同しない。
- 同じcommunityのmemberであっても、正式に許可したscope以外を表示できない。
- public profileのunknown UUID lookupが、list proofをmintしない。

### オラクルと一覧

- existing/unknownへのPOST後にproofを要求し、items、total相当、cursor、order、
  status、body shapeを比較する。
- proofなし、expired、revoked、別actor、別target、parallel consume、replayを拒否。
- targetのsuspended、ai_suspended、banned、dormant、deletedで専用差分を返さない。
- legacy random block IDと新規blockが、表示証明なしでは同じ非表示扱いになる。

### DB境界・障害

- 一般 `heisei_app` からblocks、friendships、grantsを直接INSERT/DELETEできない。
- RLSのactor変更、GUC漏れ、connection reuse、migration再適用を検証する。
- grant発行、block変更、監査の各失敗で全体ROLLBACKする。
- GETのDB/RLS障害、cursor署名/検証障害はsafe 500/503で内部情報を出さない。
- 実RS256 JWT + Hono + 隔離PostgreSQLで正常系、負例、並列、複数端末を検証する。

## 10. 承認が必要な未決定事項

次を独断で確定しない。`docs/decisions/open-questions.md`にも未決定として追記する。

1. 最初のdisplay eligibility sourceを、mutual friendship、プロフィール公開、
   community membership、別の関係のどれにするか。
2. 「公開情報の一部」の対象項目、UUID locator/searchの可否、blockとの優先順位。
3. friendshipの申請・相互承認・取消・block優先・停止/退会時の状態モデル。
4. 同じcommunityで表示できる対象範囲と、参加3日待機が表示権に影響するか。
5. capabilityとdisplay grantの採用、TTL、失効、複数端末復旧、秘密鍵/ハッシュ運用。
6. legacy任意UUID blockを、後から正当な関係ができたとき一覧へ昇格させるか。
7. dormant/deleted targetのblock/grant保持、匿名化、解除UI、法定保存期間。
8. GET listを監査するか。監査でtarget UUIDや件数を記録しないことの承認。
9. 仕様責任者/CEOの承認者、承認日、正式仕様への反映方法。

## 11. 変更範囲と次の工程

今回の変更はこの報告書と未決定事項の追記だけにする。以下は承認後の別工程であり、
本PRでは開始しない。

1. 最初の表示ソースの正式決定と、v2.0差分の記録。
2. 関係モデル/API/RLS/監査の実装（friendshipを採用する場合）。
3. display grantまたはcapabilityのschema、writer、失効処理。
4. proof付きblock経路と、proofなし既存POSTの互換維持。
5. proofだけを返す安全なGET list、UI、退会/legacy/複数端末UX。
6. Quality CIと隔離PostgreSQLのセキュリティ負例を実行してから、Issue #29の
   GET API実装可否を再判定する。

Issue #29は設計ゲートとしてOPENのまま維持する。HEISEI-003Iには進まない。
