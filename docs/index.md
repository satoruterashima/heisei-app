# HEISEI 開発ドキュメント索引

更新日: 2026-10-22

## 仕様の優先順位

1. ユーザーが明示的に承認した最新の決定と、その承認記録。
2. `資料/V2/`の正式設計書（承認済み変更がない項目）。
3. `.claude/rules/`のHEISEI固有ルール（v2.0の要約・補足）。
4. 既存のコード・テスト（事実としての実装状況。仕様の承認そのものではない）。
5. `docs/`の草案・Issue・提案。**草案は正式な決定ではない**。

## 正式な資料

- `資料/V2/HEISEI_企画要件定義_基本設計書_v2.0.docx`
- `資料/V2/HEISEI_会員ワークフロー仕様書_v2.0.docx`
- `資料/V2/HEISEI_技術選定書_v2.0.docx`
- `資料/V2/HEISEI_正式デザイン方針書_v2.0.docx`
- `.claude/rules/project.md`、`architecture.md`、`database.md`、`design.md`
- `CLAUDE.md`、`モックアップ/`（正式UIと販促用を区別）

## 新規の作業資料

- [現状監査](audits/2026-10-22-baseline.md): GitHub上で確認できた実装の事実と欠落。
- [Codexワークフロー](CODEX_WORKFLOW.md): Issue、検証、報告、変更権限のルール。
- [HEISEI-001](issues/HEISEI-001-baseline-audit.md): Codexへ最初に依頼する作業。
- [AI運営追加要件](moderation/requirements-draft.md): 非AI監査＋必要時AI、可逆的処分、異議申し立て。
- [未決定事項](decisions/open-questions.md): 承認されるまで実装値を固定しない論点。

## 範囲と技術方針の注意

既存のv2.0技術選定書はWeb/PWA先行ですが、GitHubに現存するアプリは`apps/mobile`（React Native + Expo）です。先行プラットフォームは**未確定**として扱い、既存コードを勝手にNext.jsへ移し替えたり削除したりしないでください。

AI運営基盤は、新しい要求を整理した草案です。ユーザーが承認するまでAIに処分の自動実行を許可しないでください。開発上の標準は手動レビュー＋監査可能な提案処理です。

## 文書更新方針

既存v2.0の原本は保管します。新決定は日付・決定者・影響・差分を記録してから仕様に反映します。変更の必要がない資料を一括で書き直さないでください。
