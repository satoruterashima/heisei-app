# HEISEI-003I-A G2：通報対象の可視性・非開示ゲート（DRAFT）

Status: **DRAFT / G2 BLOCKED**  
Scope: user-only report target visibility. This document is design evidence only; it does not implement an API, schema, migration, RLS policy, or capability system.

## 1. 判定

**G2: BLOCKED。**

CEO承認済み仕様は「サーバー側で閲覧を許可されたユーザーだけを保存対象とする」としている。しかし、現行mainには、認証済みactorが他ユーザーのプロフィールを閲覧できるかを判定する承認済みpredicateがない。

対象可視性が未実装・不明・DB障害の場合は保存しないという承認条件を満たせないため、report本体の永続化を開始してはならない。

## 2. 調査根拠

| 対象 | 確認結果 | 根拠 |
| --- | --- | --- |
| JWT主体 | JWT subjectをDB identityへ解決する実装あり | `packages/database/src/identity-loader.ts`、`apps/api/src/index.ts` |
| active/L2認可 | trusted identityを用いた判定あり | `packages/auth/src/authorization.ts`、`packages/auth/src/access-policy.ts` |
| 本人profile | `GET /api/v1/profile`は本人行だけ | `apps/api/src/index.ts`、`packages/database/src/postgres-stores.ts` |
| 他人profileの可視性 | 判定API・predicateなし | target profile route、visibility service、関係テーブルなし |
| block関係 | block mutation/relationは存在するが、表示許可の証明ではない | `PostgresBlockRelationStore`、`blocks` RLS |
| friend/community関係 | 関係テーブル/API/RLSが未実装 | `packages/database/src/schema.ts`、Phase A監査 |
| client申告 | role、user ID、visibilityを認可根拠にする経路なし | 既存auth boundaryはserver-side identityを使用 |
| reports | route/schema/role/RLSなし | `apps/api/src/index.ts`、`packages/database/src/schema.ts`、drizzle files |

正式v2.0は公開情報、マイフレ、コミュニティ等の機能領域を示すが、任意のtarget userをreporterが閲覧できる具体条件を定義していない。PR #40のDRAFTも同じ不足を記録している。Issue #29のblock listや汎用capability基盤を、このゲートの解決策として新設してはならない。

## 3. 脅威モデル

### 3.1 直接POSTによる推測

攻撃者が既知・未知・不可視のUUIDをPOSTし、202以外の応答、応答サイズ、処理時間、監査件数、後続GET、再送結果から存在を推測する。

### 3.2 認可境界の誤用

- JWTの`sub`をtargetの閲覧許可と誤認する。
- bodyの`userId`、role、visibility、relationshipを信頼する。
- block関係の存在を「閲覧可能」と誤認する。
- profileのFKエラーやRLSの空結果を、対象不在と同じ成功へ包括的に変換する。
- staff用scopeやowner RLSをreporterのtarget閲覧に流用する。

### 3.3 二次観測

HTTP bodyだけでなく、次を同じ脅威モデルで扱う。

- 同一Idempotency-Keyの再送結果
- pending統合の監査イベント、件数、内部job
- 後続のreport/status API（初期版では提供しない）
- DB処理時間、ロック待ち、429/500/503の差
- 退会・停止・block解除後の状態変化

## 4. 保存前に必要な最小predicate案

対象userを保存できるのは、次のすべてを同一のserver-side transaction境界で確認できる場合だけとする。これは実装仕様ではなく、レビュー用の必要条件である。

1. actorのJWTが検証済みで、DB identityがactiveかつL2以上。
2. target UUIDが正規化済みの有効UUID。
3. targetが存在し、削除済み・停止・匿名化状態を含む可否が承認ルールに適合。
4. actorからtargetへのプロフィール閲覧許可predicateがserver-sideでtrue。
5. actor/targetのblock・関係・可視性情報が不足なく読み取れる。
6. DB/RLS/認可依存が失敗した場合は保存せず、安全な500/503を返す。

predicateがfalseまたは対象が未知・不可視の場合は、保存せず202を返す。ただしDB障害や認可基盤障害を202へ変換してはならない。falseとfailureの内部分類は、外部レスポンス、ログ、監査、処理時間から区別できないよう別途検証する。

## 5. 解消候補と評価

| 案 | 内容 | 評価 |
| --- | --- | --- |
| A | user profile visibility serviceを新設し、承認済みpredicateを一元化 | 正攻法だが、新しい可視性事業ルール・API/RLS・テストの承認が必要 |
| B | 既存の関係（friend/community等）を証明元にする | 現行mainに関係モデルがなく、Issue #29の範囲を拡張するため採用不可 |
| C | target profileの公開閲覧を全L2へ許可 | CEO承認されておらず、存在推測・プライバシーリスクがあるため採用不可 |
| D | target存在だけをDBで確認して保存 | 可視性要件を満たさず、採用不可 |
| E | 可視性を確認できない限り常に保存しない | 安全だが、受付MVPとして実用機能にならない。fail-closed境界としては採用可能 |

推奨はAを別途承認・設計し、当面はEで保存を行わないこと。新しいprofile公開、friend/community、capability基盤は本Issueへ自動追加しない。

## 6. 応答設計候補

| 内部状態 | 保存 | 外部候補 | 注意 |
| --- | --- | --- | --- |
| 許可済みtarget | Phase Bで可能 | 202 | report/auditを原子保存 |
| 未知target | なし | 202 | accepted投影を他の非開示状態と同一化 |
| 不可視target | なし | 202 | target存在を返さない |
| pending重複 | 既存行不変 | 202 | 重複状態を返さない |
| 認可predicate不明 | なし | 500/503候補 | target有無と結びつかない固定応答が必要 |
| DB/RLS障害 | ROLLBACK | 500/503 | 202へ握りつぶさない |

この表の実装には、処理時間・key記録・監査投影を含む結合テストが必要である。現在はpredicateがないため、許可済みtargetの保存経路を実装してはならない。

## 7. 負例テスト計画

- JWTのactorとbodyのtargetを入れ替えても、主体や可視性を偽装できない。
- unknown、不可視、停止、削除済み、block関係あり/なしを同じ安全投影で比較する。
- 認可predicateがnull、例外、timeout、DB接続失敗のとき、report行・audit行が残らない。
- 同じtargetへのPOST、POST→再送、Idempotency-Key衝突、後続APIの不在から存在が推測できない。
- status、stable body、header、監査副作用、処理時間の許容差を記録する。
- DB障害を202へ変換しないこと、内部SQL・target UUID・stackを返さないことを確認する。

## 8. CEO追加判断

1. L2 userが他ユーザーを「閲覧可能」となる正式predicateは何か。
2. 公開profile、friend、community、block、停止、退会の優先順位は何か。
3. 可視性判定不能時の外部応答を500または503のどちらにするか。
4. 監査・key記録の処理時間差をどの範囲まで許容するか。

G2判定: **BLOCKED**。技術文書を作成しただけではPASSにしない。

