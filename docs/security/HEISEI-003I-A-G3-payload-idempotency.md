# HEISEI-003I-A G3：Payload・冪等性・自由記述保護（DRAFT）

Status: **DRAFT / G3 BLOCKED（payload設計はCONDITIONAL）**  
Scope: user-only report request design. No API, encryption implementation, secret, or provider is added.

## 1. CEO承認事項と技術提案の境界

### 承認済み

- targetはuserのみ、添付は禁止。
- reporterは検証済みJWTからDB identityへ解決されたactive/L2以上。
- categoryは`harassment`、`spam`、`impersonation`、`inappropriate_content`、`fraud`、`other`の6種。
- descriptionは任意、最大500文字。
- Idempotency-Keyは必須。
- 同一reporter/targetのpendingは統合し、既存category/本文を上書きしない。
- 同一key・同一内容の再送は202、異なる内容は安全な拒否。

### 追加レビューが必要な技術詳細

- `targetType`を固定値としてbodyに必須化するか、省略してserver-side user-onlyにするか。
- Unicode 500文字の定義、正規化、空白・制御文字の扱い。
- Idempotency-KeyのUUID v4固定、大小文字正規化、最大長。
- payload canonicalization、fingerprintのversion、key TTLの最終使用定義。
- 8KiB body上限と413/422境界。
- category versionと将来のカテゴリ廃止時の再送互換性。

これらは事業仕様を変えない実装契約としてレビュー記録に固定する必要がある。

## 2. 推奨payload案

候補リクエスト：

```json
{
  "targetType": "user",
  "targetUserId": "00000000-0000-4000-8000-000000000002",
  "category": "spam",
  "description": "任意の説明"
}
```

推奨検証：

1. JSON objectのみ、未知フィールド拒否、`targetType`は`user`のみ。
2. `targetUserId`はstrict UUID、server-sideで小文字へ正規化。client actorは受け付けない。
3. categoryは6種のexact enum、空文字・大小文字違い・未知値を拒否。
4. descriptionは省略可能。文字列ならUnicodeコードポイント数で500以下を候補とする。Web UI/APIで同じ定義を採用するまで確定しない。
5. 空白のみは空値として扱い拒否またはnull化をレビューで固定。制御文字、改行、絵文字は保存目的とUI表示を確認してから許可。
6. JSON UTF-8 byte sizeは8KiBを第一候補とし、Content-Lengthを信頼せずstream読取でも上限を再確認する。
7. Content-Type不正は415候補、malformed JSON/size/type不正は400/413/422候補。target存在の有無でコードを変えない。

## 3. 冪等性設計

### データ単位

`Idempotency-Key`はactorごとのnamespaceにする。生keyは保存せず、正規化済みkeyのversion付きdigestを保存する。payload fingerprintは、UUID正規化、category version、descriptionのUnicode正規化後にcanonical JSON化して計算する候補とする。生本文・生key・fingerprint入力をauditへ記録しない。

同じactor+keyについて、次の状態を区別する。

| 状態 | 処理 |
| --- | --- |
| keyなし | 安全な入力エラー。DBのtarget判定前に終了 |
| keyあり・同じfingerprint | 既存のaccepted投影を202。新規report/auditなし |
| keyあり・異なるfingerprint | actor+keyだけで衝突を確認できた場合に安全な固定エラー。target判定を行わない |
| keyの別actor使用 | actor namespaceが異なるため、別記録。既存keyの存在を返さない |
| key期限切れ | 30日ルールの承認後に新規記録。pending一意性とは別に扱う |

key記録はunknown/invisible targetを含むaccepted受付で同一形状に作成する。key記録を対象存在時だけ作る実装は禁止する。異なるkeyで同一reporter/targetのpendingへ到達した場合は、DB一意制約で既存行を維持し、202を返す。

### 並列

- 同一actor+keyはdigest uniqueとtransactionで一行。
- 異なるkeyの同一actor/target pendingはpartial unique indexで一行。
- 別actorの同一targetは独立行を許可する。
- key衝突エラーは対象存在・可視性・既存reportを参照しない。

## 4. 自由記述保護

### 保存禁止事項

- plaintextを通常DB、audit、application log、metrics、error responseへ保存しない。
- AI、外部provider、staff GETへ自動送信しない。
- request bodyを例外、SQLログ、CI出力へ出さない。
- target UUIDやreport IDをclient responseへ出さない。

### 暗号化候補

| 案 | 内容 | 評価 |
| --- | --- | --- |
| A | Worker Web Crypto AES-GCM、versioned key、nonce per record | Workersとの適合性が高いが、secret binding、rotation、復号権限、backup消去の運用設計が必須 |
| B | DB側暗号化 extension/KMS | DB集中管理は可能だが、provider・鍵管理・RLS境界の追加承認が必要 |
| C | 外部暗号化サービス | 分離は強いが、新規provider・費用・通信・秘密管理が必要。初期対象外 |
| D | 本文を保存しない | 最も安全で実装容易だが、CEO承認済み「任意description」を満たさない |

### 推奨候補

Aを第一候補とする。ただし、鍵はソース、GitHub、D1、通常ログへ置かず、環境のsecret bindingからのみ取得する。key version、AES-GCM nonce、ciphertext、auth tag、created_atを分離して保存し、rotation時はversionで復号する。staff復号権限、期限後の鍵破棄、backup内暗号文の扱いが決まるまで実装・本番接続はBLOCKED。

この環境からCloudflare公式best-practicesページを取得したところHTTP 403となったため、Workers API仕様をこの文書だけで最終確定しない。実装時は公式の現行仕様、wrangler設定、secret bindingを別途確認する。

## 5. 受入テスト

- 6カテゴリ、UUID大小文字、未知フィールド、空/空白/制御文字、絵文字、改行、Unicode境界、501文字を検証する。
- UTF-16 code unit、Unicode code point、grapheme clusterの差をfixture化し、採用定義を確認する。
- 8KiB境界、Content-Length偽装、chunked body、malformed JSONを確認する。
- 同一key同一内容、同一key異内容、別actor同一key、期限境界、並列keyを確認する。
- unknown/invisible/accepted/pending duplicateのstatus、stable body、headers、key記録を比較する。
- plaintext、raw key、JWT、SQL/stack、不要PIIがログ/auditにないことを確認する。
- AES-GCM採用時はnonce再利用なし、改ざんciphertext拒否、version rotation、復号権限、期限後削除を確認する。

## 6. 判定と追加承認

Payload部分: **CONDITIONAL**。技術詳細のレビュー後に固定可能。  
自由記述保護: **BLOCKED**。secret binding、rotation、復号・削除・backup境界が未確定。  
G3全体: **BLOCKED**。平文保存で代替してはならない。

追加判断：Unicode定義、key形式/TTL、body上限、AES-GCM鍵運用、自由記述を含むローカル保存可否。

