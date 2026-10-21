# HEISEI

HEISEIは、18歳以上を対象とした、話題・趣味を通じて交流するSNSです。141文字投稿、スレッド、コミュニティ、マイフレ、本日のトレンディなどを段階的に開発します。

> **現在の状態（2026-10-22、GitHub上でのファイル確認）**: 開発初期のモノレポ／Expo試作画面／Honoヘルスチェック／DBスキーマ草案。SNS本体の主要フローが動作する段階ではありません。ビルド・実機テストは未実施です。

## 開発の入口

- [資料・ルールの索引](docs/index.md)
- [2026-10-22 現状監査](docs/audits/2026-10-22-baseline.md)
- [Codex作業手順](docs/CODEX_WORKFLOW.md)
- [最初の開発Issue](docs/issues/HEISEI-001-baseline-audit.md)
- [AI運営の追加要件（草案）](docs/moderation/requirements-draft.md)
- [未決定事項](docs/decisions/open-questions.md)

## 現存するコード

- `apps/mobile`: React Native + Expoの暫定ホーム画面。実際の投稿・認証などの導線は未実装。
- `apps/api`: Honoの`GET /health`。
- `packages/*`: DBスキーマ、検証、ドメイン定数、テーマなどの初期骨格。
- `資料/V2/`: 2026年8月の正式な仕様・技術・デザイン文書。
- `モックアップ/`: 画面・ロゴ資料。

## 開発環境

ルートの`package.json`はpnpmワークスペースとTurborepoを使用します。まずNode.jsとpnpmの互換性を確認してください。現時点のルート指定は`pnpm@11.20.0`と`node >=18`です。変更する場合は理由と影響を報告してください。

- インストール: `pnpm install --frozen-lockfile`
- 型チェック: `pnpm typecheck`
- lint: `pnpm lint`
- ビルド: `pnpm build`
- モバイル開発起動: `pnpm --filter @heisei/mobile start`
- API開発起動: `pnpm --filter @heisei/api dev`

**注意**: 上記は既存スクリプトに基づく案内であり、成功確認済みのコマンドではありません。現存するパッケージの一部には`build`/`lint`スクリプトがありません。`apps/mobile/app.json`が参照する画像アセットも未確認です。実行結果を記録してから整備してください。

## 開発・ソース管理方針

このGitHubリポジトリをコードと変更履歴の正式な保管場所にします。Codex Cloudは、このリポジトリを接続して作業し、原則としてIssueごとに変更・検証・報告します。Google Driveは必要に応じた資料の補助保管先であり、Codexの実行ディレクトリではありません。

既存の`AGENTS.md`にはAIエージェント共通ルールがあります。HEISEI固有の規則は本索引から参照し、現存する正式設計と未承認の変更提案を混同しないでください。

## 本番・個人情報

実運用前に認証、権限、通報、ブロック、AI監査、復旧、データ削除、バックアップ、規約、年齢確認、課金方式を検証します。秘密情報はリポジトリに追加しないでください。
