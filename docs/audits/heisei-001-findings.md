# HEISEI-001 調査結果の保全

状態: 調査記録（実装変更なし）  
対象main: `157c645f3b3dcfeb5cfe2ec80f0fd8f716c7ed8b`

この文書は、前回の `/workspace/heisei-001-results/report.md` が現環境で取得できたため、その内容とリポジトリ上の根拠を要約して保全する。元reportは推測で再現していない。

## 実行確認

- Node.js 24.19.0、Corepack 0.34.6、pnpm 11.20.0。
- `bash scripts/setup-cloud.sh`、frozen install、型チェック、ESLint、Vitest、Wrangler API dry-run はmainで成功。
- Honoのローカル `/health` は200、`status: ok`、`service: HEISEI API`。
- Expo設定の読込は成功。iOS実機、Expoネイティブbuild、画像4点は未確認／未解決。

## コード上の根拠と仕様差分

| 対象 | コード上の事実 | 正式仕様との差分 |
|---|---|---|
| `apps/mobile/App.tsx` | 静的カード、5タブのstate、テーマimport | 認証、画面遷移、投稿・通信なし。正式ショートロゴと画像も未接続 |
| `apps/mobile/app.json` | Expo 51、iOS bundle ID、4画像参照 | `assets/icon.png`等4点が不存在。Issue #3で別管理 |
| `apps/api/src/index.ts` | Hono `GET /health` とCORSのみ | 認証、投稿、通報、権限、DB APIなし |
| `packages/domain/src/index.ts` | 141文字判定、スレッド定数 | DB保存、日次制限、認証・会員判定なし |
| `packages/validation/src/index.ts` | 投稿contentの1〜141文字Zod検証 | API接続、空白・文字単位の正式契約は未確定 |
| `packages/database/src/schema.ts` | profiles/posts/threads/communities/trendy_topicsのDrizzle草案 | migration、接続、RLS、統合テストなし |
| `packages/api-client/src/index.ts` | `hc`再export、汎用ApiResponse | 型付き業務route、認証ヘッダー、エラー契約なし |

正式v2.0はWeb/PWA先行だが、現存コードはExpo iOS中心。今回のiOS先行は追加の開発前提であり、正式原本の上書きやWeb構成の削除は行っていない。認証事業者、会費、iOS課金、コミュニティ作成条件、AI停止期限、保存期間は未決定である。

## 既知の制約

認証・DB・AI・決済・SNSの主要フローは未実装であり、既存のhealth成功をサービス準備完了とは扱わない。Expo画像、実機、リモートCI結果は別途確認が必要である。
