# HEISEI-003H-U2: 安全なブロック一覧設計

Status: Design gate for Issue #29. This document does not implement an API,
change the database, or change production configuration.

関連: [Issue #29](https://github.com/satoruterashima/heisei-app/issues/29)

## 1. 結論

単純な `GET /api/v1/blocks` は採用しない。現行の `POST /api/v1/blocks`
は、存在しないUUIDにも実在するUUIDにも同じ `202` を返すことで、ブロック
操作自体の存在推測を抑制している。しかし、その直後に「自分のブロック
一覧」を全件返すと、POSTの結果が一覧に現れるかどうかが新しい存在オラクル
になる。

推奨するのは、次の二層構成である。

1. ブロックの保存と、一覧で対象を表示できる権利を別概念にする。
2. 一覧には、サーバーが現在の利用者に対する正当な表示関係を事前に証明
   できる対象だけを返す。
3. 任意UUIDを受け付ける既存POSTで作成されたブロックは、表示証明がない
   限り一覧に現れない。存在しない対象、未表示対象、退会対象を同じ扱いに
   する。
4. 表示できないブロックも、既存の
   `DELETE /api/v1/blocks/by-target/:targetUserId` で解除できる。ただし
   一覧から対象UUIDを新たに取得する機能にはしない。

この案は、任意UUIDを入力できる現行契約と、複数端末で安全に確認できる
一覧UXを分離する。表示関係を作れない任意UUIDまで一覧で確認したい場合は、
プライバシー要件と両立しないため、別途仕様決定が必要である。

## 2. 現状と信頼境界

調査対象は次のとおりである。

- `POST /api/v1/blocks`: verified JWTから得た内部actor UUIDだけを使用し、
  activeかつL2以上を要求する。構文上有効なtarget UUIDには一律 `202` を返す。
- `DELETE /api/v1/blocks/:id`: block UUIDを受け付け、一律 `202`。所有者でない
  行はRLSにより削除されない。
- `DELETE /api/v1/blocks/by-target/:targetUserId`: target UUIDを受け付け、
  対象なし・未ブロック・他人のブロックを一律 `202` とする。実削除と
  `block.delete` 監査INSERTは同一トランザクションで行う。
- JWTのclaimに含まれる権限は認可根拠にせず、信頼できるDBのidentityを使う。
- 一般DBロール `heisei_app` はblocksの変更権限を持たない。変更は
  `heisei_block_writer` とRLSに限定され、監査権限も `block.create` と
  `block.delete` に限定される。

したがって、一覧の新設でも、actorの認証・active/L2判定・RLS・固定ロール・
監査境界を緩めてはならない。特に「自分の一覧」だけというWHERE条件は、
POST→GETオラクルを単独では解決しない。

## 3. 脅威モデル

### 攻撃者の能力

- 有効なL2以上の自分のアカウントを持つ、またはその認証を取得している。
- UUID形式の候補を大量に生成できる。
- 任意UUIDをtargetとしてPOSTできる。
- 自分のJWTで一覧を繰り返し取得できる。
- 複数端末、複数アカウント、並列リクエストを使える。

### 守る対象

- target UUIDに対応するアカウントの存在、非存在、退会状態。
- 攻撃者が正当な関係を持たないユーザーをブロックした事実。
- 他人が作成したブロックの対象と、ブロック関係の有無。
- legacy random UUIDのblock IDを含む内部識別子。

### 主要シナリオ: POST→GET

1. 攻撃者が候補UUID `x` に `POST /api/v1/blocks` を送る。
2. `GET /api/v1/blocks` を取得する。
3. `x` が一覧に含まれる、件数が増える、表示名が返る、またはページ境界が
   変わるかを観測する。
4. 実在UUIDだけが表示されれば、targetの存在を判定できる。

unknown UUIDとknown UUIDを別レスポンスにしなくても、一覧の項目、件数、
ページカーソル、並び、エラー、更新時刻の差分が判定材料になる。レート制限、
表示遅延、ノイズ、レスポンス時間の均一化だけでは、攻撃者が十分な試行回数を
持つ場合の状態差分を消せないため、根本対策とはしない。

### その他のシナリオ

- 攻撃者Bのblock IDを攻撃者Aが一覧または検索結果から得て、解除や関係推測を
  試みる。
- 退会済みtargetだけが一覧から消えることで、過去に存在したアカウントを
  推測する。
- 端末Aで作成したブロックを端末Bが一覧で見られず、利用者が解除不能と誤認する。
- 並列POSTとGETで、コミット順やページカーソルの差から存在を推測する。
- 表示用JOINがRLSを迂回して、他人のblockまたはprofilesを返す。

## 4. 方式比較

| 方式 | 概要 | 安全性 | 実装難易度 | 運用コスト | 判定 |
| --- | --- | --- | --- | --- | --- |
| A. 関係証明付き一覧 | targetが攻撃者に正当に表示可能だったことをサーバーが証明したblockだけ返す | 高。未知UUIDへのPOSTでは表示証明が作られず、一覧差分が出ない | 中 | 中 | 推奨 |
| B. 表示用capability | 正当なプロフィール/関係画面からactor専用・短期・失効可能なtokenを発行し、tokenに紐づくblockだけ返す | 高。UUID単独ではtokenを発行できない | 中〜高 | 中〜高 | Aの実装手段として推奨 |
| C. 任意UUIDを暗号化したopaque一覧 | 一覧にはtarget UUIDを出さず、暗号化handleだけ返す | 低〜中。項目数、作成結果、handle発行自体がoracleになり得る。解除用tokenの配布も難しい | 中 | 中 | 不採用 |
| D. 全件一覧 + レート制限/遅延/ノイズ | 全blockを返し、推測コストだけ上げる | 低。状態差分を消さず、時間をかけた probing に弱い | 低 | 中 | 不採用 |
| E. 一覧を作らず端末ローカル管理 | サーバーは一覧を提供せず、作成端末がtarget情報を保持する | 高。ただし端末紛失、再インストール、複数端末での復元性が低い | 低〜中 | 低 | 補助案 |

### A/Bを推奨する理由

「所有者だけが読める」ではなく、「所有者が読める対象集合そのものを、
正当な関係の証明によって限定する」ためである。攻撃者が任意UUIDをPOSTしても、
表示証明を持たなければ、unknownと未表示knownのいずれも一覧の項目・件数・
ページング状態に影響しない。

capabilityはDBにハッシュだけを保存し、actor、target、発行理由、発行元の
認可コンテキスト、有効期限、使用/失効時刻に束縛する。クライアント入力の
target UUIDだけでcapabilityを作成・更新できないようにする。

## 5. 推奨アーキテクチャ

### 表示証明の発行

既存のプロフィール表示、承認済み関係、または明示的に認められたユーザー
検索のように、targetを攻撃者へ表示してよい根拠がサーバー側にある場合だけ、
actor専用の表示証明を発行する。証明の根拠はJWT claimではなく、既存の
access policy、関係テーブル、profile visibility判定を使う。

設計上の候補は次のいずれかで、実装時に一つを確定する。

- `block_display_grants` を追加し、actor/target/block/source/expiryを保存する。
- `block_capabilities` を追加し、token hashを保存して、block作成時に一度だけ
  消費し、blockの表示権を作る。

後者は新規block操作の入口をcapability必須にできるため、より強い。ただし
  現行POSTとの互換性を保つため、既存POSTは当面「保存はするが表示証明は作ら
  ない」互換経路として残す。新UIはcapability経路を使う。

### 一覧の読み出し

実装時の読み出しは次の性質を満たす。

- actorはverified JWT由来で、activeかつL2以上。
- `GET` にtarget UUID、block UUID、検索語を受け付けない。
- RLSでactor自身のblockだけを対象にする。
- 表示証明が有効で、target profileが現在も表示可能な行だけを返す。
- 証明のない行、失効した証明、退会/削除済みtargetは結果集合に入れない。
- `total`、全件数、未表示件数、存在を示すフラグを返さない。
- 結果が空でも、unknown UUIDをPOSTした後でも、同一の空リスト形式を返す。
- page cursorはactorとquery versionに束縛した署名済みopaque値とし、内部UUIDを
  そのまま含めない。無効cursorは一般的な400にする。
- レスポンスは `Cache-Control: no-store` と `X-Request-ID` を付ける。

候補API契約:

```http
GET /api/v1/blocks?cursor=<opaque>&limit=25
Authorization: Bearer <verified-jwt>
```

```json
{
  "data": {
    "items": [
      {
        "targetUserId": "<uuid>",
        "displayName": "<allowed profile field>",
        "blockedAt": "<timestamp>",
        "canUnblock": true
      }
    ],
    "nextCursor": "<opaque-or-null>"
  },
  "requestId": "<request-id>"
}
```

`targetUserId`は、既に同じactorへ正当に表示できると証明された対象に限る。
block ID、監査ID、visibility grant、内部エラー、未表示件数は返さない。
一覧の項目は `DELETE /api/v1/blocks/by-target/:targetUserId` に渡して解除
できる。解除APIは従来どおり、対象なしや他人所有を一律202で受理する。

候補ステータス:

- 未認証JWT/identity不在: `401`
- L1、suspended、ai_suspended、banned: `403`
- storage不在: `503`
- cursor不正: `400`（targetの存在情報は含めない）
- DB/RLS障害: 内部情報を含まない `500` または `503`

## 6. 既存・特殊ケース

### 新規の任意UUID block

現行POSTでunknown UUIDへ送信しても、block行が存在しない場合と存在する場合の
応答は同じである。どちらも表示証明がなければ一覧に表示しない。これにより
POST→GETでの存在判定を防ぐ。

### 既存のrandom block ID

一覧でblock IDを公開しない。正当な表示証明がある対象はtarget UUIDで表示し、
解除はby-target APIを使うため、random IDかどうかはUX/APIに影響しない。証明が
ないlegacy blockは一覧に出さないが、既にtarget UUIDを正当に保持している利用者
はby-targetで解除できる。

### 退会・削除されたtarget

退会後に「退会した」と判別できる専用表示は返さない。表示証明が失効または
target profileが表示不可になった場合は一覧から除外する。監査とblockの内部
保持期間、完全削除/匿名化はアカウントライフサイクル方針と合わせて別決定する。
解除を優先する場合も、一覧から退会状態を示すplaceholderを返さない。

### 複数端末

表示証明をactorに紐づけたサーバー側状態にすることで、端末Aで発行された
正当な証明を端末Bでも利用できる。ただし、端末Aで任意UUIDを入力しただけの
互換POSTは証明を作らないため、端末Bの一覧に出ない。この制約をなくすには、
新UIをcapability/関係証明経路へ移行する必要がある。

### 解除UX

- 一覧に表示された対象: 項目のtarget UUIDをby-target解除へ渡す。
- 一覧に表示されないlegacy/互換block: 既存の解除導線（target UUID、または
  保持済みblock ID）を使う。サーバーは「対象が存在しない」と断定表示しない。
- 端末をまたいで一覧に出ない任意UUID blockを復元する機能は、今回の安全な
  仕様では提供しない。プロダクトとして必要なら、まず「対象を表示可能にする
  関係/検索」要件を定義し、capabilityを発行できる経路を追加する。

## 7. 必要な変更（実装フェーズでのみ実施）

### API

1. `GET /api/v1/blocks` を、表示証明付きの対象だけ返す契約で追加する。
2. capabilityを発行/消費する場合は、既存の任意UUID POSTと分離した新しい入力
   契約を追加する。既存POSTの202契約は変更しない。
3. list結果にblock ID、全件数、未表示件数、存在フラグを含めない。
4. by-target解除の一律202、safe 500/503、no-storeを維持する。

### DB/RLS

1. `block_display_grants` または `block_capabilities` を追加する。actor、target、
   block参照、発行根拠、expiry/revocationを持たせ、tokenはhashのみ保存する。
2. 一般ロール `heisei_app` にblock/grantの直接INSERT/DELETE権限を与えない。
3. 一覧のSELECT policyは `app.user_id` に紐づくactor行と、現在有効な表示証明
   のみを返す。表示証明の発行・消費は専用writerと同一トランザクションにする。
4. `heisei_block_writer` の監査権限は `block.create`/`block.delete` の既存制限を
   維持する。新しい `block.list` の監査を導入する場合は、読み取りの高頻度化、
   ログ内の対象情報、監査権限の分離を先に設計する。
5. migration再適用、接続プール再利用、RLS fail-closedを検証する。

### 監査

- 実際のblock作成/解除と表示証明の発行/消費は同一トランザクションで追跡する。
- no-op解除には監査行を作らない現行方針を維持する。
- 一覧GETを監査する場合、対象UUIDや件数を監査本文に書かない。監査ログ自体が
  別の存在情報源にならないよう、requestId、actor、結果区分だけを扱う。

## 8. セキュリティ負例テスト計画

### API契約・オラクル対策

- existing targetとunknown UUIDについて、POST→GETのHTTP status、JSON shape、
  items、nextCursorを比較する。
- unknown UUIDをPOSTした後も、表示証明がない限り一覧の項目数、ページ境界、
  エラー、順序が変わらないことを確認する。
- 自分が正当に表示可能なtargetだけが一覧に出ることを確認する。
- 未表示known target、他人のblock、退会target、失効証明は一覧に出ないことを
  確認する。存在/非存在を示す理由文字列も禁止する。
- block ID、random UUID、監査ID、DB内部エラーがレスポンスに出ないことを確認する。
- invalid/actor-bound cursor、巨大limit、重複cursor、並列GETを検証する。

### 認証・RLS・権限

- 不正JWT、unknown subject、JWTの偽装auth level、L1、suspended、bannedを拒否する。
- actor Aがactor Bの一覧を読めないことを、URL変更なしで確認する。
- `heisei_app` のgrant/block直接INSERT/DELETEが拒否されることを確認する。
- 表示証明のactor/targetを書き換えたSQL、期限切れ、失効済み、replayを拒否する。
- RLS policyの再適用後も権限が復活しないことを確認する。
- 接続プール再利用・並列実行で `app.user_id` が漏れないことを確認する。

### 原子性・障害

- block作成、表示証明発行、監査のいずれかが失敗した場合に全体がROLLBACKする。
- 一覧SELECT障害、RLS障害、cursor署名鍵障害を安全な500/503にし、内部情報を
  含めない。
- 解除の監査失敗がblock削除を残さないことを既存テストで維持する。
- 並列で同じcapabilityを消費しても一つのblock/証明/監査だけになることを確認する。
- 退会処理と一覧取得、解除処理を並列実行して、退会状態のoracleや孤児grantを
  作らない。

### 実環境に近い結合テスト

隔離PostgreSQL、実RS256 JWT、Hono、RLS executorを使い、正当な表示関係のある
target、unknown target、legacy random block ID、他人所有block、複数端末を表す
同一actorの複数JWTで検証する。単なるmock storeのテストだけで完了判定しない。

## 9. 実装工程の分割案

### Phase 0: 仕様決定（実装前）

- 「正当な表示関係」の種類と、プロフィール表示/検索/承認関係の境界を決める。
- 退会後のblock保持期間、匿名化、解除方法を決める。
- compatibility POSTをいつまで残すか、一覧に出ないlegacy blockのUXを承認する。

### Phase 1: 表示証明の基盤

- capabilityまたはdisplay grantのschema、専用role、RLS、migrationを設計する。
- 発行・失効・期限・actor binding・監査を実装し、負例テストを先に追加する。
- 既存POST/DELETE/by-targetの契約を回帰検証する。

### Phase 2: 正当な関係からのblock経路

- server-side access policyで表示可能性を確認する。
- 新UI向けのcapability経路を実装し、blockと表示証明を原子的に作る。
- 既存任意UUID POSTは互換経路として一覧証明を作らないことを明記する。

### Phase 3: read-only list API

- eligible projectionだけを返すGET、opaque cursor、no-store、safe errorsを実装する。
- `total`や未表示件数を返さない。
- 実JWT/Hono/隔離PostgreSQL、RLS、並列、退会、複数端末の結合テストを通す。

### Phase 4: UI・運用・移行判断

- 表示項目の解除UXを実装する。
- legacy blockを自動backfillしない。表示関係が後から証明できる場合だけ、明示的
  な再認可を通してdisplay grantを作る。
- metricsやrate limitは補助防御として追加するが、oracle対策の根拠にはしない。
- セキュリティレビューとIssue #29の明示承認後にのみ本番反映を検討する。

## 10. 未決定事項・承認が必要な点

1. 「正当な表示関係」に含めるソース（公開プロフィール、検索、承認済み関係、
   相互フォロー等）。
2. legacy任意UUID blockを、targetが後から表示可能になった際に一覧へ昇格させるか。
3. 退会targetのblockを保持/匿名化/削除する期間と、利用者への表示方針。
4. capabilityを新設するか、display grantを既存の認可コンテキストから直接生成
   するか。
5. 一覧GETを監査対象にするか。対象UUID・件数をログへ出さない制約を含む。
6. target UUIDをレスポンスで返すことを許容する正当関係の定義。許容しない場合は
   targetRefを使い、解除APIにサーバー側で解決する契約を別途設計する。
7. 一覧に出ないblockを複数端末で解除したい場合の、正当なtarget再確認UX。

Issue #29はこの設計ゲートとしてOPENのまま維持し、これらの承認前にGET API、
schema、migration、UI、本番設定、デプロイを実施しない。
