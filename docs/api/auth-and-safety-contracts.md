# 認証・安全API契約案

## 最小エンドポイント

| Method | Path | 認証 | 監査 |
|---|---|---|---|
| GET | `/api/v1/session` | 任意 | session失敗のみ |
| POST | `/api/v1/auth/logout` | L1以上 | logout |
| GET/PATCH | `/api/v1/profile` | L1 / 自分 | profile変更 |
| GET | `/api/v1/access` | L0以上 | 拒否理由は機密を出さない |
| POST | `/api/v1/blocks` | L2 | block |
| DELETE | `/api/v1/blocks/:id` | L2 / 自分 | unblock |
| POST | `/api/v1/reports` | L2 | report |
| POST | `/api/v1/appeals` | 対象ユーザー | appeal |

## 形式

RequestはJSON、`Content-Type: application/json`、短いrequest idと冪等性keyを受け付ける。文字列、列挙値、長さ、ページcursorをZodで検証する。成功は`{data, requestId}`、エラーは`{error:{code,message,details?},requestId}`とし、detailsにtoken・PII・他人の存在を出さない。

## HTTPエラー

| status | code例 | 条件 |
|---:|---|---|
| 400 | `invalid_request` | JSON・形式・長さ不正 |
| 401 | `unauthenticated` / `invalid_session` | token欠落、署名不正、期限切れ、失効 |
| 403 | `forbidden` / `insufficient_level` / `blocked` | 認証済みだが権限・関係・状態で拒否 |
| 404 | `not_found` | 認可対象の存在を漏らさない設計 |
| 409 | `conflict` / `already_blocked` | unique、状態遷移、冪等key競合 |
| 422 | `validation_failed` | semantic validation不成立 |
| 429 | `rate_limited` | OTP、投稿、申請、通報等の上限超過 |
| 500 | `internal_error` | 内部失敗。秘密・stackは返さない |

JWT検証→actor確定→状態/level/role→block/関係→rate limit→domain/validation→transaction→auditの順に評価する。通報内容は最小保存し、AIや任意SQLへ直接渡さない。停止中は法的窓口と異議申立てだけを明示的に許可する。
