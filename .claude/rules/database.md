# DB関連ルール

一次情報源は `資料/V2/HEISEI_企画要件定義_基本設計書_v2.0.docx`（12. データモデル）と `資料/V2/HEISEI_技術選定書_v2.0.docx`（5. DB・認証）。

## 1. 基本方針

* DB本体はSupabase PostgreSQL、スキーマ管理・マイグレーションはDrizzle ORM経由で行う。
* RLS（Row Level Security）は防御の二段目として設定する。重要な書き込みは必ずHono API経由で行い、クライアントからの直接書き込みに依存しない。
* コインは残高を直接書き換えず、**台帳＋ロット方式**で管理する（購入コイン・配布コインは別台帳）。
* 個人情報と本人確認情報は分離して保存し、必要最小限のみ保持する。本人確認書類そのものは原則外部事業者側に保持し、アプリ側は状態・参照IDのみを持つ。
* 電話番号は正規化・暗号化またはハッシュ索引を併用し、1電話番号1アカウントを制御する。

## 2. 主要テーブル領域

| 領域 | 主要テーブル |
|---|---|
| 認証 | profiles, user_verifications, user_settings, blocks |
| 投稿 | posts, comments, likes, notifications |
| スレッド | threads, thread_responses, thread_ksk_events |
| コミュニティ | communities, community_members, community_xp_events, events |
| マイフレ | friend_requests, friendships, footprints |
| 個別交流 | mails, mail_tickets, exchange_diaries, diary_entries |
| 課金 | subscriptions, coin_ledger, coin_lots, purchases |
| アイテム | items, item_variants, user_inventory, equipped_items |
| 安全 | reports, moderation_cases, attention_cards, audit_logs |

テーブル名・カラム定義の詳細（ER図、型定義、インデックス方針）は実装前に `packages/database` にDrizzleスキーマとして起こし、基本設計書と齟齬がないかレビューする。

## 3. 運用ルール（共通ルールの再掲・プロジェクト適用）

* ユーザーの明示的な許可がない限り、本番環境に対してマイグレーション実行・データ削除・データ修正・スキーマ変更・初期化・シード投入・バックアップ削除を行わない。
* ローカル環境でも既存データを削除する操作は、影響範囲を説明してから行う。
* 日次バックアップ、障害復旧手順、コストアラートを整備する（本体実装時に忘れず組み込む）。
* 休眠・退会に伴うデータ処理（休眠：最終ログインから1年／完全削除：休眠から3か月）は、個人情報削除・関係解除・コイン失効を伴う破壊的操作のため、バッチ実行前に必ず対象件数を確認できる設計にする。
* 決済・不正対策等の法定記録は、必要な保持期間のみ他データと分離して保管する。

## 4. 非機能要件との関係

* 重要操作（課金、コイン消費、処分等）には冪等性キーとトランザクションを使用する。
* 99.5%以上の月間稼働率を初期目標とし、DB容量・API応答時間を監視対象に含める。
