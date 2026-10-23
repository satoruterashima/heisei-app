# HEISEI-003G: 本人プロフィールAPI（ローカル検証段階）

## 対象

- `GET /api/v1/profile`: 署名検証済JWTとDBのsubject→内部UUID対応付けで、ログインユーザー本人の安全なプロフィール項目のみ取得
- `PATCH /api/v1/profile`: 本人・L1以上・`active`限定、書込可能な項目は `displayName` と `bio` のみ

レスポンス形式は成功時 `{data:{profile:{userId,username,displayName,bio,favoriteGenres,avatarUrl,updatedAt}},requestId}`、失敗時 `{error:{code,message},requestId}`。
個人情報を含む成功レスポンスは `Cache-Control: no-store`。認証情報・roles_json・検証証跡・会員管理列を表示しない。

## 入力（当面のMVP上限）

- `Content-Type: application/json` 必須（charset付加可）
- リクエスト本文8 KiB以下。超過は413
- strict JSONオブジェクトかつ1項目以上。未知の列・`id`・`username`・`authLevel`・`membership`・`roles`等は拒否
- `displayName`: 空白trim後1～50文字、任意
- `bio`: 1000文字以内の文字列、または明示的に `null` で消去。任意
- 両項目とも省略時は現状維持
- 今回の1000文字上限はプロダクト正式決定ではなく、ローカルMVP暫定値

## DB認可と監査

- `heisei_app`を使いRLSで本人のSELECTのみ許可
- 変更は専用非owner・NOBYPASSRLSの`heisei_profile_writer`に限定
- SQLパラメータ化、内部UUIDによる対象制限、権限列は列単位GRANTで変更禁止
- 監査ログには本人UUID、requestId、変更した**列名のみ**、固定action・ruleVersionを記録し、変更前後の値やJWT・PIIを書き込まない
- UPDATEと監査INSERTは同じ信頼済みトランザクションで実施。監査に失敗すれば両方ROLLBACKし、更新成功を返さない

## 禁止・未実装

- 自分以外のプロフィール取得・編集、ユーザー名変更、画像アップロード、役割・会員区分変更
- 公開プロフィール閲覧、レート制限、追加の利用規約/コンテンツ審査、実ログイン、実本番データ接続、実監査長期保全は別の承認ゲート
- デフォルトWorkerアプリは認証/DBが未設定であり、本人の実更新に使用できない
- テスト用`pg`接続プールは本番Workerに含めない。共有・本番・ステージングDBへのマイグレーション禁止

## 受入検証

- ローカルisolated PostgreSQL上で本人読み書き、RLS、別ユーザー拒否、特権列拒否、監査失敗時のRollbackを検証
- GitHub ActionsでTypeScript、ESLint、Vitest、実JWT→Hono→PostgreSQL、Worker dry-runを検証
- 受入はローカル基盤の範囲。本番運用可能性の確認とは別
