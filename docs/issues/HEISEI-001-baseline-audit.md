# HEISEI-001: リポジトリ実行検証と欠落・仕様差分の監査

状態: READY / 対象: Codex Cloud
優先度: P0
範囲: 調査・ローカル検証・修正提案まで（原則アプリケーションの本格実装は行わない）

## 目的
GitHub上の初期コードが実際にビルド・起動できるか確かめ、足りないものを根拠付きで列挙する。修正を別Issueに切り出す。

## 手順
1. `AGENTS.md`、`docs/index.md`、既存正式資料、`docs/audits/2026-10-22-baseline.md` を必要な箇所だけ読む。
2. `git status`、Node/pnpmのバージョンとルートscriptsを確認。
3. `pnpm install --frozen-lockfile` と、存在する範囲の型チェック・ビルド・テストを実行。失敗を隠さず原因分類する。
4. `apps/mobile` のimport、TSX拡張子、画像アセット、Expo設定、API到達性を静的検査。
5. `apps/api` のヘルスチェックとWorker設定、DBスキーマとマイグレーション、パッケージ依存の実在を確認。
6. 技術選定書のWeb/PWA先行と現存Expo実装の差を整理。不要な技術変更を行わない。
7. SNSとAI運営の必須機能について、実装済／設計済／未実装／未検証の一覧を更新。
8. 修正タスクを依存順に分割し、各Issueに受入条件を付ける。

## 受入条件
- 実行コマンドと実際の成功・失敗が記録されている。
- 重大度(P0/P1/P2/P3)、対象ファイル、再現方法、修正案がある。
- 仕様承認が必要なものを技術バグと分離する。
- 本番操作、API課金、秘密情報公開はゼロ。
- 次に着手すべきIssueを1つ推薦して停止する。

## 参考資料
- `docs/CODEX_WORKFLOW.md`
- `docs/moderation/requirements-draft.md`
- `docs/decisions/open-questions.md`

## 報告先
GitHub IssueまたはPR本文に検証結果を記録し、ユーザーの承認を待つ。
