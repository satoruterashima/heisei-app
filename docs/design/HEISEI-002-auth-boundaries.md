# HEISEI-002 認証・権限・責務境界設計

更新日: 2026-10-22  
対象: iOS先行のExpoアプリ、Hono API、Supabase/PostgreSQL  
状態: 設計案（実装・事業者選定・本番設定は未実施）

## 1. 前提と決定境界

今回の開発前提はReact Native + ExpoによるiOS先行とする。正式v2.0資料はWeb/PWA先行を記載しているため、この差分は現在の作業上の提案として扱い、iOS先行の正式採用はCEO承認待ちとする。正式v2.0原本は変更しない。将来のWeb/PWAは同じHono APIとドメインルールを利用する。

認証事業者、SMS/eKYC事業者、iOS課金方式、会費（315円と別案）、コミュニティ作成条件、保存期限、AI一時停止の期限・SLAは未決定である。本書では交換可能な境界と受入条件だけを定義し、具体的な事業者や数値を確定しない。

## 2. iOS認証フロー

```text
起動
  ├─ SecureStoreに保存したrefresh情報をAuth SDKへ渡す
  ├─ セッション検証（issuer/audience/exp、失効、ユーザーID）
  └─ 未認証なら公開画面へ

メール登録/ログイン
  → メール検証
  → 規約・プライバシー版への同意を記録
  → プロフィール下書き（L1）
  → SMS OTP（事業者を抽象化）
  → 18歳以上の自己申告（L2。SMSを年齢確認とは扱わない）
  → 年齢確認プロバイダー（L3）
  → 必要時のみ本人確認/eKYC（L4）
```

端末はaccess tokenをBearerでAPIへ送る。APIはJWTの署名・issuer・audience・有効期限を検証し、認証IDをサーバー側で確定する。端末が送る`isAgeVerified`、会員種別、userIdを権限根拠にしない。refresh情報はOS保護領域を使い、平文の汎用ストレージへ置かない。ログアウト・失効・再インストール・復帰競合を受入条件に含める。

### 認証レベル

| レベル | 到達条件 | 許可の例 | 禁止・注意 |
|---|---|---|---|
| L0 | 未認証 | サービス紹介、公開トレンディ | 投稿、個別データ、会員操作不可 |
| L1 | メール検証、規約同意 | プロフィール下書き、興味設定 | 投稿・個別交流不可 |
| L2 | SMS検証 + 18歳以上自己申告 | 投稿、コメント、スレッド、コミュニティ参加、マイフレ申請 | SMSは年齢確認ではない |
| L3 | 年齢確認成功 | 1対1メール、交換日記、出品、コミュニティ作成、風紀委員 | 証跡と事業者参照IDを最小保存 |
| L4 | 必要時の本人確認/eKYC | 企業管理、高リスク復帰など | 全員一律必須にしない |

## 3. 権限マトリクス

認証レベル、会員区分、ロール、アカウント状態を別々に評価する。許可は常に最小権限の積集合とし、停止・ブロック・レート制限を最後に適用する。

| 主体/状態 | 公開閲覧 | 投稿・コメント | スレッド/コミュニティ参加 | 個別交流 | 課金・保有物 | 運営操作 |
|---|---:|---:|---:|---:|---:|---:|
| L0 guest | ○ | × | × | × | × | × |
| L1 free | ○ | × | × | × | 自分の下書きのみ | × |
| L2 free | ○ | ○ | ○ | × | 購入導線のみ | × |
| L3 free | ○ | ○ | ○ | ○（関係性・上限内） | 購入、出品（条件内） | 風紀委員は定型注意札のみ |
| L3 paid | ○ | ○ | ○（有料上限） | ○ | 会員特典、購入、出品 | × |
| community manager | ○ | ○（権限範囲） | 管理対象のみ | × | コミュニティ範囲のみ | 設定・イベントのみ |
| staff/admin | ○ | 通常ユーザー権限と分離 | 審査対象のみ | × | 決済情報は必要最小限 | MFA、再認証、監査必須 |

状態による上書き:

| 状態 | 許可 | 拒否・制限 |
|---|---|---|
| `active` | 通常のレベル・会員・ロール評価 | 通常の上限は適用 |
| `ai_suspended` | ログイン、異議申立て、必要なサポート窓口 | 投稿・個別交流・課金特典の利用は承認済みポリシーに従い一時制限。AI単独の確定処分にしない |
| `suspended` | 異議申立て、退会・データ請求など法的に必要な窓口 | 通常利用、投稿、交流、出品、管理操作 |
| `banned` | 明示的に許可した法的窓口のみ | 全通常利用。永久状態の自動付与はしない |

ブロックは関係ごとの拒否として、プロフィール詳細、投稿相互作用、申請、メール、交換日記、通知を遮断する。通報はアクセス権を変更せず、案件化・証拠参照・審査キューへ送る。風紀委員は削除・停止・権限変更を行わない。

## 4. 責務境界

| 層 | 責務 | 保持しないもの |
|---|---|---|
| Expo/iOS | UI、入力補助、Auth SDKとのcallback、SecureStore、表示状態 | 権限の最終判断、会員状態、コイン残高、秘密鍵 |
| `packages/validation` | API入力・出力の形式検証 | 認証、DB書込み |
| `packages/domain` | 141文字、上限、状態遷移の純粋ルール | 現在ユーザーの権限、外部通信 |
| Hono/Workers | JWT検証、認証ID確定、認可、レート制限、API契約、監査イベント、冪等性 | 長期保存の直接責務、モデル秘密鍵のクライアント公開 |
| Supabase Auth | メール/SMS等の認証セッション、失効 | アプリ固有のL2/L3判定、投稿権限 |
| PostgreSQL/Drizzle | 正規化データ、制約、トランザクション、RLS、migration | 認証事業者の秘密情報、AIの自由なSQL |
| Queue/Jobs | 通知、期限処理、トレンディ、監査候補、AI補助 | 即時の最終停止判断 |
| 管理画面 | MFA付き審査、承認、復旧、監査閲覧 | 任意SQL、無制限の権限変更 |

HonoのAPI契約を`packages/api-client`へ型付きで公開し、Web/将来のクライアントも同じ契約を使う。Supabaseのservice roleや特権接続情報はExpoへ渡さない。

## 5. DB概念設計・セキュリティ

最初のmigration単位は、Auth IDに紐付く`profiles`、`user_verifications`、`user_settings`、`blocks`、`audit_logs`とする。次に`posts/comments/likes/notifications`、並行して`reports/moderation_cases/attention_cards`を追加する。その後にthreads、communities、friends、L3個別交流、subscriptions/coin ledger/lotsを依存順に追加する。

認証証跡（種類、検証時刻、状態、事業者参照ID、仕様version）と規約同意（版、時刻）を分離保存する。本人確認書類そのものは原則事業者側に置き、アプリは最小参照情報だけ保持する。投稿や監査イベントはactor、対象、時刻、案件ID、ルールversion、根拠参照、復旧操作を記録する。

重要書込みはHono API経由とし、DBのRLSを二段目の防御にする。所有者・関係者・スタッフの読み書きをポリシーで分け、service roleによる迂回を監査する。日次上限、重複like、コイン消費、停止遷移はサーバー時刻・unique制約・トランザクション・冪等性キーで守る。秘密情報、PII、認証トークンはログとクライアントへ出さない。

## 6. 次の実装Issue

詳細な補足は、[HEISEI-001調査保全](../audits/heisei-001-findings.md)、[iOS先行ADR](../adr/0001-ios-first-proposal.md)、[認証・権限マトリクス](../auth/verification-and-permission-matrix.md)、[セッション設計](../auth/session-and-account-lifecycle.md)、[信頼境界](../architecture/api-db-trust-boundaries.md)、[DB概念設計](../architecture/data-model-proposal.md)、[API契約](../api/auth-and-safety-contracts.md)、[テスト計画](../testing/auth-permission-test-plan.md)を参照する。

### HEISEI-003（P0）認証・権限基盤の縦断実装

対象: Expoのメールログインcallback、Auth adapter、Hono JWT middleware、L0〜L2プロフィール状態、最小profiles/verifications/settings migration。

受入条件:

1. 認証事業者をadapterの外側から差し替えられ、事業者名や本番秘密をコードへ固定しない。
2. L0/L1/L2の許可・拒否をAPI統合テストで確認し、端末由来のuserId・会員種別を信頼しない。
3. 失効token、別ユーザー、期限切れ、ログアウト後のAPIを拒否する。
4. migrationの適用・再適用、RLSの所有者拒否、監査イベント、ログの秘密値非出力をローカルで検証する。
5. iOS callback、SecureStore復帰、再インストール相当、ログアウトをExpo development buildで確認する。

### 後続Issue（順序のみ）

- HEISEI-004: 通報・ブロック・人間審査・復旧を含む安全基盤。投稿公開より先に受入する。
- HEISEI-005: L2投稿の縦断（検証→保存→一覧→ページング→上限・連投・可視性）。
- HEISEI-006: threads/communities/friends。コミュニティ作成条件の承認後に解放する。
- HEISEI-007: L3年齢確認と個別交流。事業者・法務承認後に着手する。
- HEISEI-008: iOS課金/IAP、subscription、coin ledger/lots。価格とストア規則確定後に着手する。
- HEISEI-009: AIはshadow modeの監査補助から開始。正式停止の自動実行は承認まで無効とする。

本書は設計案であり、正式仕様・課金・認証事業者・本番DBを変更しない。
