# 技術設計ルール

一次情報源は `資料/V2/HEISEI_技術選定書_v2.0.docx`。

## 1. 採用技術（正式第一候補）

Next.js（App Router）+ TypeScript + Hono + Cloudflare Workers + Supabase PostgreSQL/Auth/Realtime + Drizzle ORM + Cloudflare R2 + Cloudflare Queues/Cron Triggers + Gemini API + Stripe + PWA。TypeScriptで統一する。

| 領域 | 採用 |
|---|---|
| Web | Next.js App Router / TypeScript / PWA |
| UI | Tailwind CSS / shadcn/ui を基盤に独自デザイン（詳細は `design.md`） |
| API | Hono / Cloudflare Workers |
| DB | Supabase PostgreSQL（詳細は `database.md`） |
| 認証 | Supabase Auth（メール）＋ SMS OTPプロバイダー |
| ORM | Drizzle ORM |
| Realtime | Supabase Realtime（通知のみに限定） |
| Storage | Cloudflare R2 |
| Queue/Cron | Cloudflare Queues / Cron Triggers |
| AI | Gemini API（無料枠から開始） |
| 決済 | Stripe Checkout / Billing |
| 監視 | Sentry / Cloudflare Logs |
| テスト | Vitest / Playwright |

## 2. アーキテクチャ方針

* フロント・API・ドメインロジック・ジョブ・DBを分離する。
* 将来のReact Native/Flutterから同じAPIを利用できるようにする。
* 課金、コイン、認証、通報、処分はAPI経由かつ監査可能にする。クライアント側で上限判定・コイン消費・会員特典を決定しない。
* 初期は単一PostgreSQLを中心にし、Redisや検索エンジンは必要になってから追加する（採用しない技術を参照）。

## 3. モノレポ構成

```
apps/web       - Next.js フロントエンド
apps/api       - Hono API (Cloudflare Workers)
apps/admin     - 管理画面
apps/jobs      - Queues/Cron ジョブ（AI連携含む）
packages/domain     - ビジネスルール（上限判定・XP・コイン・スレッド時間等）
packages/database   - Drizzleスキーマ・マイグレーション
packages/validation - Zodスキーマ
packages/api-client - API型付きクライアント
packages/ui         - UIコンポーネント
packages/theme      - デザイントークン・着せ替えテーマ
packages/testing    - テストユーティリティ
```

## 4. API・ドメイン設計

* 入出力はZodで検証する。
* ドメインルール（上限判定、コイン消費、会員特典、XP計算、スレッド消滅判定等）は `packages/domain` に集約し、APIとジョブの両方から再利用する。
* API領域の例：`/auth`, `/verification`, `/users`, `/profiles`, `/settings`, `/blocks`, `/posts`, `/comments`, `/likes`, `/threads`, `/responses`, `/ksk`, `/communities`, `/events`, `/xp`, `/friend-requests`, `/friends`, `/mails`, `/diaries`, `/subscriptions`, `/coins`, `/items`, `/reports`, `/moderation`, `/admin`。

## 5. 非同期処理

* R2保存対象：プロフィール、アバター、テーマ、フレーム、コミュニティ背景。
* Queues対象：AI監視、トレンディ生成、通知、アイテム審査、XP集計、Stripe反映。
* Cron対象：スレッド終了判定、日次上限リセット、コイン期限、休眠処理、トレンディ生成。
* 本人確認書類は原則外部事業者側で保持し、アプリ側は状態・参照IDのみを持つ。

## 6. AI（Gemini）

* 本日のトレンディ：1日1回、信頼できる元データから構造化生成しDB保存。事実を創作させない。
* スレッド分類・投稿監視（ルール判定で候補を絞り複数件をバッチ判定）・通報要約（重大度・カテゴリ・要約をJSON出力）・目安箱の定期集計・問い合わせFAQ回答案に利用する。
* モデル名は環境変数化し、プロバイダー交換可能にする。無料枠から開始し、上限監視とコストアラートを設定する。AIの判定だけでアカウントを永久停止しない。

## 7. 決済・広告

* Stripe Billingで月315円のサブスクリプション、Checkoutでコイン購入。Webhook署名検証と冪等性を必須とする。Webhookを正とし、決済成功画面の表示だけで会員状態を変更しない。
* 広告は初期Web版でGoogle AdSenseを第一候補、将来ネイティブ版はAdMobを検討。有料会員は原則非表示。
* 投稿ページはad_safe/ad_limited/ad_blockedを判定し、危険ページには広告を出さない。表示頻度の具体的数値は `project.md` の要確認事項を参照し、確定後に実装する。

## 8. セキュリティ

* HttpOnly Secure Cookie、CSRF/Origin検証、CSP、レート制限。
* SMS OTPは試行回数・送信回数・IP/端末単位で制限する。
* 管理画面はMFA必須、最上位操作は再認証を要求する。
* PIIは暗号化し、秘密情報は環境変数／Secretsで管理する（値をコード・ログ・コミットに残さない）。
* 重要操作は監査ログ・冪等性キー・トランザクションを使用する。

## 9. テスト・監視

| 種別 | 重点 |
|---|---|
| Unit | 上限判定、スレッド時間、XP、コイン、権限 |
| Integration | Auth、Stripe、SMS、Queues、DBトランザクション |
| E2E | 登録、投稿、課金、着せ替え、年齢確認、退会 |
| Security | 権限昇格、Webhook偽装、レート制限、個人情報 |
| Monitoring | エラー率、API時間、DB容量、AI/SMS/メール費用 |

## 10. 採用しない技術

初期マイクロサービス、Kubernetes、GraphQL、自前WebSocket、Elasticsearch、Redis、MongoDB、自作eKYC、自作決済。理由：1,000人規模には過剰で、障害点・運用費・開発負荷が増えるため。必要が生じた場合は理由を明記した上でユーザーに確認してから採用する。

## 11. 費用目安

1,000ユーザー規模で固定費目標は月1,000〜5,000円程度（変動費除く）。コスト増を伴う技術選定・サービス追加は事前にユーザーへ確認する。
