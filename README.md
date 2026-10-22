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

ルートの`package.json`はpnpmワークスペースとTurborepoを使用します。まずNode.jsとpnpmの互換性を確認してください。現時点のルート指定は`pnpm@11.20.0`と`node >=22.13.0`です。変更する場合は理由と影響を報告してください。

- インストール: `pnpm install --frozen-lockfile`
- 型チェック: `pnpm typecheck`
- lint: `pnpm lint`
- ビルド: `pnpm build`
- モバイル開発起動: `pnpm --filter @heisei/mobile start`
- API開発起動: `pnpm --filter @heisei/api dev`

### Codex Cloudの依存セットアップ

Node.jsは`>=22.13.0`が必要です（pnpm 11.20.0の要件）。今回のCloudで確認した版を`.nvmrc`の`24.19.0`に固定しています。Corepackも必要です。リポジトリ直下で次を実行してください。

```sh
# nvmを利用する場合のみ
nvm install
nvm use

# 初回も依存導入済み状態も同じコマンド
bash scripts/setup-cloud.sh
```

スクリプトはCorepack経由で`packageManager`指定のpnpmを選択し、`pnpm install --frozen-lockfile`を実行します。lockfile更新・依存アップグレード・本番接続は行いません。キャッシュはcheckout外の`/workspace/.heisei-cloud`を使い、`HEISEI_CLOUD_CACHE_DIR`で書き込み可能な場所へ変更できます。

`pnpm run setup:cloud`も利用できます。ただし、pnpm 11はscript起動前に自動installする場合があるため、初回やlockfile不整合時は上記のBash直接実行を使用してください。Corepack経由で厳密に実行する場合：

```sh
export COREPACK_HOME=/workspace/.heisei-cloud/corepack
export XDG_DATA_HOME=/workspace/.heisei-cloud/data
corepack pnpm --config.verifyDepsBeforeRun=warn run setup:cloud
```

`verifyDepsBeforeRun=warn`はscript開始前の自動installを防ぎます。セットアップ本体は必ずfrozen installを実行し、失敗時は停止します。pnpm 11.20.0では導入後も`enableGlobalVirtualStore`に関する事前検査警告が出る場合があります。

依存インストールの成功はアプリの型チェック・実機動作の成功を意味しません。既存のTypeScriptエラー、画像アセットの欠落、Lint・Test・Buildの未設定は別Issueで対応します。

**注意**: 上記は既存スクリプトに基づく案内であり、成功確認済みのコマンドではありません。現存するパッケージの一部には`build`/`lint`スクリプトがありません。`apps/mobile/app.json`が参照する画像アセットも未確認です。実行結果を記録してから整備してください。

## 開発・ソース管理方針

このGitHubリポジトリをコードと変更履歴の正式な保管場所にします。Codex Cloudは、このリポジトリを接続して作業し、原則としてIssueごとに変更・検証・報告します。Google Driveは必要に応じた資料の補助保管先であり、Codexの実行ディレクトリではありません。

既存の`AGENTS.md`にはAIエージェント共通ルールがあります。HEISEI固有の規則は本索引から参照し、現存する正式設計と未承認の変更提案を混同しないでください。

## 本番・個人情報

実運用前に認証、権限、通報、ブロック、AI監査、復旧、データ削除、バックアップ、規約、年齢確認、課金方式を検証します。秘密情報はリポジトリに追加しないでください。

## 継続的な品質検証

Node.jsは`.nvmrc`、pnpmは`packageManager`（11.20.0）に合わせます。依存導入後、ルートで次を実行します。CloudではREADME上記のCorepackキャッシュ指定も使用してください。

```sh
corepack pnpm --config.verifyDepsBeforeRun=warn typecheck
corepack pnpm --config.verifyDepsBeforeRun=warn lint
corepack pnpm --config.verifyDepsBeforeRun=warn test
corepack pnpm --config.verifyDepsBeforeRun=warn build:check
```

- 型チェックは全9workspaceとテスト／Vitest設定が対象です。
- ESLintの推奨ルールを全workspaceのTypeScript/TSXとテストに適用し、警告も失敗にします。型検査は別コマンドが担当します。
- Vitestは`tests/`の投稿文字数境界、入力検証、API health/CORSをNodeで実行します。テスト0件は失敗です。APIテストはHonoのin-processリクエストで、外部DB・本番APIに接続しません。
- `build:check`（`build`からも委譲）はWranglerの`--dry-run`でAPI Workerをローカルbundleします。アップロード・デプロイは行いません。
- 共通パッケージはTypeScriptソースを直接公開しているため、架空の成果物を生成するbuild scriptは追加しません。型検査と利用側のbundle／テストで検証します。UIのMetro結合検証は未実施です。
- ExpoのiOSネイティブビルド・実機確認はLinux CIでは**NOT_RUN**。画像アセットはIssue #3で管理し、TypeScriptやAPI検証を止めません。

`.github/workflows/quality.yml`はLinux上でfrozen install、型チェック、Lint、テスト、API bundle、lockfile不変を検証します。PR・mainへのpush・品質基盤ブランチへのpush・手動起動が対象で、読取権限のみです。API bundle成功はCloudflare上の実行成功を保証しません。
