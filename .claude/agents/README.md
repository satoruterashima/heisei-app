# サブエージェント体制

HEISEIの開発は、モノレポ構成（`.claude/rules/architecture.md` 3章）に対応させた役職別サブエージェントで進める。各エージェントの定義は同じディレクトリの `*.md` ファイル（frontmatterで `name` / `description` / `tools`）に記載されている。Agent toolから `subagent_type` にファイル名（拡張子なし）を指定して呼び出す。

## 役職一覧

| エージェント | 担当領域（モノレポ） | 主な責務 | 主要参照ルール |
|---|---|---|---|
| [frontend-web-agent](frontend-web-agent.md) | apps/web | Next.js/PWA画面実装 | design.md, project.md |
| [design-system-agent](design-system-agent.md) | packages/ui, packages/theme | デザイントークン・共通コンポーネント・着せ替え基盤 | design.md |
| [api-agent](api-agent.md) | apps/api | Hono APIルーティング・入出力検証 | architecture.md |
| [domain-logic-agent](domain-logic-agent.md) | packages/domain | 上限判定・XP・コイン・スレッド消滅等のビジネスルール | project.md, architecture.md |
| [database-agent](database-agent.md) | packages/database | Drizzleスキーマ・マイグレーション・RLS | database.md |
| [auth-security-agent](auth-security-agent.md) | apps/api（認証領域）, packages/domain（認証ルール） | 段階認証、SMS/年齢確認連携、セキュリティ全般 | project.md 3章, architecture.md 8章 |
| [payments-agent](payments-agent.md) | apps/api（課金領域）, packages/domain（コイン台帳） | Stripe決済・コイン購入・Webhook処理 | project.md 8章, architecture.md 7章 |
| [ai-integration-agent](ai-integration-agent.md) | apps/jobs（AI連携） | Gemini連携（トレンディ生成・投稿監視・通報要約） | architecture.md 6章, project.md 4章 |
| [moderation-admin-agent](moderation-admin-agent.md) | apps/admin | 管理画面、通報対応、風紀委員フロー | project.md 9章 |
| [qa-test-agent](qa-test-agent.md) | packages/testing 他横断 | Unit/Integration/E2Eテスト実装 | architecture.md 9章 |
| [devops-infra-agent](devops-infra-agent.md) | Cloudflare Workers/Queues/Cron, wrangler設定 | インフラ構成・監視・コストアラート | architecture.md 5, 9, 11章 |

## 運用ルール

* 各エージェントは着手前に自分の担当範囲に関連する `.claude/rules/*.md` を確認する。プロジェクト全体・全資料の一括読み込みは行わない（ユーザーのグローバルルール §4）。
* `project.md` 11章の「未決定・要確認事項」に該当する仕様に依存する実装は、着手前に必ずユーザーへ確認する。
* 担当範囲をまたぐ変更（例：APIの入出力形式変更がフロントに影響する場合）は、影響先のエージェントの担当ファイルを勝手に書き換えず、呼び出し元セッションで調整してから着手する。
* 本番環境操作・Git push・破壊的DB操作は、担当エージェントであっても共通CLAUDE.mdのルールに従い、明示的な許可なく実行しない。
* 現時点はMVP1着手前の仕様固めフェーズ。全エージェントを常時稼働させる必要はなく、`資料/V2` の未決定事項が確定した領域から順に起動する。
