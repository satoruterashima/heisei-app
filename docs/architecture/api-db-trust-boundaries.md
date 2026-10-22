# API・DB信頼境界

```text
Expo/iOS --Bearer JWT--> Hono/Workers --認可・監査--> Supabase/PostgreSQL
     |                         |                         |
 SecureStore              Queue/Jobs                 RLS/制約/transaction
```

ExpoはUI、callback、入力補助、SecureStore、表示だけを担当する。HonoはJWT検証、subject確定、L0〜L4・会員・role・状態・block・rate limitの認可、入力検証呼出し、audit event、冪等性を担当する。Supabase Authは認証セッションと失効を担当し、アプリの会員権限を決定しない。

PostgreSQLは正規化データ、unique/FK/check、transaction、RLSを担当する。Drizzleはschemaとmigrationの生成・適用境界であり、任意SQLをAIやクライアントへ公開しない。service roleはHonoのサーバー側だけに限定し、RLSを迂回する処理をauditする。

監査ログは認証、権限変更、通報、停止、復旧、課金状態のactor/target/action/reason/version/timeを記録する。PII・token・秘密値をログ、mobile bundle、エラー応答に含めない。本人確認書類は原則外部事業者保持、アプリは状態と最小参照IDのみ保持する。保存期間と削除は未決定である。

Web導入時はCookie/CSRF/Origin/CSPを別境界として追加し、ExpoのBearer設計と混同しない。CORSは認証・認可の代替ではない。
