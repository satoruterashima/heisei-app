# HEISEI-003I-A G3-PoC：Payload・冪等性・暗号化（DRAFT）

Status: **DRAFT / local PoC only**

この成果物は、CEO承認済みG3技術仕様の再利用可能なローカルモジュールと負例テストである。通報API、DB保存、migration、HTTP 202、スタッフ閲覧、本番Secret bindingは実装していない。

## 1. Phase 0根拠

- ベースmain: `5a266705548019d64851f0e46f4178ea456e1423`
- `AGENTS.md`、`.claude/rules/`、`packages/validation`を確認した。
- 既存の入力検証は投稿・本人profile向けで、通報payload・HMAC・AES暗号化の重複実装はなかった。
- 指示文で参照された `docs/security/HEISEI-003I-A-G3-payload-idempotency.md` は、この最新mainには存在しなかったため、今回のPoCはユーザー提供のG3-PoC承認仕様を根拠とした。
- PR #45の可視性実装はmainへ取り込まず、独立branchで実装した。

## 2. Payload canonicalization

`packages/validation/src/report-security.ts` の `parseAndValidateReportPayload` / `validateReportPayload` を使用する。

1. JSONをUTF-8 bytesとして測定し、8,192 bytesを超えたら拒否する。`Content-Length`は使用しない。
2. JSONをstrict UTF-8としてdecodeし、JSON object以外を拒否する。
3. 許可フィールドは `targetType`, `targetUserId`, `category`, `description` のみ。
4. `targetType`は`user`のみ、target UUIDは小文字へ正規化する。
5. descriptionは NFKC → CRLF/CRをLF化 → `trim()` → 制御文字検査 → `Array.from(...).length` の順で処理する。
6. 空文字・空白のみは拒否する。LF、CR正規化後のLF、TABは許可し、その他のC0/C1制御文字は拒否する。
7. Unicodeコードポイント500以下を許可する。結合文字はNFKC後の結果を計測し、サロゲートペア/絵文字は`Array.from`の1要素として扱う。
8. categoryは`category-v1`の6カテゴリへ限定する。

canonical payloadは次の固定順JSON配列である。

```text
[categoryVersion, targetType, normalizedTargetUserId, category, normalizedDescriptionOrNull]
```

キー順に依存するobject stringifyは使用しない。

## 3. Idempotency fingerprint

- Idempotency-KeyはUUID v4を厳密検証し、小文字へ正規化する。
- reporter UUIDもserver-side identity由来であることを前提に正規化する。
- `reporterScope`は `HMAC-SHA-256(scope-v1\0reporter\0key)`。
- `payloadFingerprint`は `HMAC-SHA-256(payload-v1\0canonicalPayload)`。
- HMAC schemeは`hmac-sha256-v1`、key versionは結果に保持する。
- 同一reporter・同一key・同一payloadは再現し、別reporter・別payload・別HMAC key versionは一致しない。
- 生のIdempotency-Keyはfingerprint結果へ含めず、通常ログ/監査へ渡さない。
- 比較は固定長化したconstant-time XOR比較を行う。
- 30日TTL、DB保存、pending一意制約、HTTP応答はG4/API統合へ残す。

## 4. AES-256-GCM

- Web Crypto APIのAES-GCM、256-bit key、96-bit random nonce、128-bit tagを使用する。
- 暗号化結果はalgorithm/version、AAD version、key version、nonce、ciphertextを保持する。
- AADは `aad-v1\0aes-256-gcm-v1\0reportId\0reporterUserId\0targetUserId` を固定形式で構成する。
- ciphertext、nonce、AAD、key versionの改ざん・取り違えは復号失敗とする。
- 平文、鍵、内部Web Crypto例外を通常エラーへ含めない。平文保存へのfallbackはない。
- HMAC keyとencryption keyは別API・別fixture keyとして生成する。

## 5. Key Provider・rotation

```typescript
interface ReportKeyProvider {
  getEncryptionKey(version: string): Promise<CryptoKey>;
  getFingerprintKey(version: string): Promise<CryptoKey>;
}
```

PoCではランダム生成したメモリfixture providerのみ実装する。新規暗号化は呼び出し側がactive versionを選択し、復号はenvelopeのversionを使う。

- 新version追加と旧version廃止を分離する。
- 保持期間内の旧ciphertext/fingerprint照合に必要な旧keyは、承認された保持期限までreader境界内で保持する。
- 旧key廃止後は該当ciphertextを復号不能にするため、先に対象レコードの削除・再暗号化・法的保全を確認する。
- 共有鍵の破棄は、そのkey versionに束縛された全レコードを一括して復号不能にする。レコード単位削除の代替ではない。
- 鍵欠落時は新keyへ自動置換せず、fail closedでエラーにする。
- Workers Secret binding adapter、実Secret名/値、rotation jobは未実装。

## 6. 保持・削除との整合性（DRAFT）

承認済み保持値は、審査終了後90日、監査365日、冪等性記録30日、バックアップ上限30日目標である。今回のPoCは保存や削除を実行しない。

- ciphertext削除はデータ消去、key破棄は同じversion全体の復号能力喪失であり別操作。
- バックアップ復元時は削除記録を再適用する仕組みが必要。
- 法的保全は対象・承認者・期限を記録した例外として扱う必要がある。
- 本番では復号権限を通報受付writerから分離し、スタッフ閲覧のMFA・scope・監査を別承認する必要がある。

## 7. G3判定と残存BLOCKED

**G3-PoC: PASS（ローカルfixtureのみ）。** 入力境界、canonicalization、HMAC fingerprint、AES-GCM、AAD、nonce、改ざん、key version、鍵不足の負例を検証した。

本番運用はBLOCKED。残存条件は、Secret bindingとkey lifecycle、G4 report writer/RLS/atomicity、G5 rate limit、HTTP非開示契約、監査・削除・復元運用、通報APIとの統合受入である。PoC PASSをもって通報API Phase Bを開始しない。
