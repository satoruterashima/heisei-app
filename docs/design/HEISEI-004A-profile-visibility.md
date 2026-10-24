# HEISEI-004A：公開プロフィール可視性認可基盤

Status: **DRAFT / Phase B implementation**
Issue: [#44](https://github.com/satoruterashima/heisei-app/issues/44)
Related: [#34](https://github.com/satoruterashima/heisei-app/issues/34), [#29](https://github.com/satoruterashima/heisei-app/issues/29)

## 1. 調査根拠

- `AGENTS.md`: server-side identity、最小変更、機密情報非開示、既存RLS維持。
- `docs/index.md`: 正式V2資料、`.claude/rules`、実装、DRAFTの優先順位。
- `packages/auth/src/authorization.ts`, `access-policy.ts`: active/auth levelと双方向blockの既存認可。
- `packages/database/src/schema.ts`: `profiles.accountStatus`、`blocks`、RLS対象schema。公開設定は未実装だった。
- `packages/database/src/postgres-stores.ts`: `PostgresBlockRelationStore`はactor transactionで双方向を取得する既存境界。
- `packages/database/src/local-postgres-executor.ts`: transaction-local role/GUCをpool接続ごとに設定し、失敗時にrollback/releaseする既存境界。
- `packages/database/drizzle/roles.sql`, `0000_auth_foundation.sql`: 一般role、block writer、監査role、RLSの既存制限。
- `docs/security/HEISEI-003I-A-G2-visibility-gate.md`: 既存のG2判断は、公開predicateがなければ通報保存を開始しないという設計根拠。
- `docs/design/HEISEI-003H-U2-P0-eligibility-proof.md`, `HEISEI-003H-U2-block-list-safety.md`: block操作を表示権限の証明に使わず、任意UUIDの存在推測を防ぐ根拠。

## 2. 実装した契約

`packages/auth/src/visibility.ts` の純粋関数 `evaluateUserVisibility` は、次をすべて満たしたときだけ `allow` を返す。

1. actor/targetが有効なUUIDで別ユーザー。
2. targetがserver-side projection上で存在する。
3. actor/targetがともにactive。
4. targetの `profile_visibility` が `public`。
5. blockが双方向とも存在しない。
6. 必要な依存値が欠落していない。

private/未設定/不存在/削除/停止/不正入力は `deny`、DB/RLS/SQLや必要情報の取得不能は `unavailable` とする。client申告のrole/visibilityは入力根拠として使用しない。

## 3. DB/RLS境界

`0001_profile_visibility.sql` は隔離ローカルDB用のexpand-only migrationである。

- `profiles.profile_visibility varchar(20) NOT NULL DEFAULT 'private'`
- 値は `private` / `public` のCHECK制約
- `heisei_visibility_reader` は `NOSUPERUSER NOBYPASSRLS NOLOGIN`
- readerは公開targetの `id/account_status/profile_visibility` と、actor-targetのblock両方向だけSELECT可能
- readerにINSERT/UPDATE/DELETE/audit権限はない
- actor/targetはtransaction-local `app.user_id` / `app.visibility_target_id`で固定
- 一般 `heisei_app`、`heisei_block_writer`、監査権限の既存境界は変更しない

migrationは初回適用と再適用を隔離PostgreSQLで検証し、本番・共有DBには適用していない。

## 4. 非公開設計

visibility repositoryは外部APIを持たず、プロフィール本文や存在判定を返さない。private targetはRLS projectionから除外され、public targetと不存在を外部へ区別する経路は追加していない。通報API、プロフィールGET、block一覧、検索APIは今回変更していない。

## 5. 残存条件

本実装はG2の技術基盤を実データとRLSで検証するが、G3〜G5は別ゲートであり、通報APIへ自動接続しない。公開設定変更API、公開プロフィール本文の外部契約、運用上の削除/退会データ処理は別途承認・実装が必要である。
