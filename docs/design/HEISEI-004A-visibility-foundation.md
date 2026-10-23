# HEISEI-004A：ユーザー可視性認可基盤（DRAFT）

Status: **DRAFT / G2 BLOCKED**
Issue: [#42](https://github.com/satoruterashima/heisei-app/issues/42)
Related: [#34](https://github.com/satoruterashima/heisei-app/issues/34), [#29](https://github.com/satoruterashima/heisei-app/issues/29), PR [#41](https://github.com/satoruterashima/heisei-app/pull/41)

この文書は、ユーザー可視性を判定する共通認可境界の調査・最小実装案である。公開ルール、関係、migration、APIを承認済み仕様として確定しない。

## 1. Phase 0 調査根拠

| 確認対象 | 確認結果 | 根拠 |
| --- | --- | --- |
| 仕様の優先順位 | 正式V2資料、`.claude/rules`、実装、DRAFT文書の順。DRAFTは承認済み仕様ではない | `docs/index.md` |
| 認証主体 | JWT subjectをserver-side identityへ解決し、認証属性をクライアント申告から分離 | `packages/database/src/identity-loader.ts`, `apps/api/src/index.ts`, `packages/auth/src/types.ts` |
| active/L2以上 | 既存の認証レベル・active・role・block関係のfail-closed判定 | `packages/auth/src/authorization.ts`, `packages/auth/src/access-policy.ts` |
| profile | 現行APIは本人profile取得が中心。他人profileの可視性predicateはない | `apps/api/src/index.ts`, `packages/database/src/postgres-stores.ts` |
| schema | `profiles`にaccount statusはあるが、profile visibility列・関係テーブル・visibility grantはない | `packages/database/src/schema.ts` |
| block | `blocks`とRLS/専用writerは存在するが、blockは表示許可の証明ではない | `packages/database/src/schema.ts`, `packages/database/drizzle/0000_auth_foundation.sql`, `packages/database/drizzle/roles.sql` |
| friend/community | 正式方針上の機能領域はあるが、現行mainで可視性証明に利用できる実装済み関係は確認できない | `.claude/rules/project.md`, `packages/database/src/schema.ts` |
| Issue #29対策 | block mutationと一覧表示権限を分離し、任意UUID操作を表示証明に使わない | `docs/design/HEISEI-003H-U2-block-list-safety.md`, `docs/design/HEISEI-003H-U2-P0-eligibility-proof.md` |
| G2設計 | 他ユーザー表示の承認済みpredicate未実装のため、通報の対象可視性ゲートはBLOCKED | `docs/security/HEISEI-003I-A-G2-visibility-gate.md`, PR #41 |

正式V2資料は公開情報・マイフレ・コミュニティ等の機能領域を示すが、任意のactor-targetペアに対して、どの属性をどの条件で表示してよいかという本Issueの実行可能なpredicateまでは確定していない。

## 2. 判定対象の分離

可視性評価では、以下を一つの「存在する/しない」値へ混ぜない。

1. targetの存在（present / absent / deleted / unavailable）
2. targetのアカウント状態（active / 停止等 / unavailable）
3. profile公開設定（未実装を含む）
4. actor-targetのblock関係（双方向）
5. actor-targetの関係性（friend/community等。現行では未実装）
6. 対象機能ごとの承認済み認可条件
7. DB/RLS/依存サービスの判定不能

DB障害やRLS例外を「対象なし」へ変換してはならない。外部応答を統一する場合も、内部では deny と unavailable を分離して監査・運用する。

## 3. 今回の最小実装

`packages/auth/src/visibility.ts` に純粋関数 `evaluateUserVisibility` と以下の型を追加した。

- `VisibilityDecision`: `allow | deny | unavailable`
- `VisibilityEvidence`: server-sideで取得した判定材料のみを表す入力
- `VisibilityTargetState`, `ProfileVisibilityState`, `RelationshipState`

現在の正式承認済みpredicateがないため、実装上の到達可能な結果は次の通り。

- 不正UUID、actor=target、target不在/削除、actor/target停止、双方向block、関係拒否: `deny`
- target lookup/DB障害、block lookup、公開設定未定義、公開設定lookup障害、関係未定義: `unavailable`
- server-sideの公開ルールが承認・実装されるまで、全条件が揃っても `allow` にしない

JWTのrole、client申告のvisibility、client側のtarget情報は判定根拠にしない。今回、API、DB、migration、RLS変更、capability/grant、通報・block一覧・検索APIは追加していない。

## 4. 将来のデータ接続設計（DRAFT）

CEO承認後に、少なくとも次をserver-side transaction境界で取得する必要がある。

- 検証済みserver identityとactorのactive/auth level
- targetの存在・停止・退会/削除状態
- 承認済みprofile visibility
- 双方向block関係
- 承認済みfriend/community等の関係性
- 機能別の認可policy version

DB接続はactorをリクエスト入力で差し替えられない形にし、RLSのactor設定、専用role、reader/writerの権限を分離する。判定途中の障害は `unavailable` として扱い、通報保存などの副作用を開始しない。新規テーブル、RLS、migrationはこのDRAFTでは適用しない。

## 5. 負例テスト

`tests/visibility.test.ts` で以下を固定した。

- target不在・削除済み、actor/target停止
- 相互block、関係拒否
- 公開設定・関係・block情報の未定義/障害
- actor/target入れ替え、不正UUID、actor差替え
- client visibility claimを付けても判定が変わらない
- 完全なfixtureでも承認済みserver policyがない限りallowしない

既存の認証・認可テストは削除・無効化していない。

## 6. G2判定と未決定事項

**G2: BLOCKED。** 純粋関数と負例テストだけでは、実サーバー側データに基づく承認済み表示認可を証明できない。

CEO承認が必要な項目:

1. L2以上のactorが他ユーザーを表示できる正式predicate（公開設定、friend、同一community等の組み合わせ）
2. profile visibilityの値・初期値・停止/退会時の優先順位
3. blockと表示認可の優先順位、および関係の失効時点
4. unavailable時のAPI外部契約（500/503、非開示投影、監査方針）
5. 将来のreader role/RLS、visibility dataの保持・削除・監査要件

これらが承認され、実データを読むadapterとRLS結合テストが実装されるまで、通報MVP G2のPASSや他ユーザー向けのallowを宣言しない。
