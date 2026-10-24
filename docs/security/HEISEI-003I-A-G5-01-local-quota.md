# HEISEI-003I-A G5-01：ローカルQuota Core（DRAFT）

Status: **DRAFT / local fixture only**

基点: PR #51 / `7b76a91ca9cc640a3f4a85749e9cdeda6c13bfe4`

## 1. 実装範囲

`packages/domain/src/quota.ts` に、Durable Objectsへ後接続できるdriver-neutralな
quota coreを追加した。実DO binding、Worker runtime、公開通報API、DB/Secret接続は
追加していない。

- `QuotaEngine`: 純粋な状態遷移。時計・ネットワーク・保存へ依存しない。
- `QuotaStore`: actor単位のload/save/排他turn抽象。
- `QuotaCoordinator`: verified actorからstore境界を呼び、障害をunavailableへ投影。
- `InMemoryFixtureStore`: 並列fixtureと状態復元を検証するローカル実装。
- `QuotaConfig`: 閾値と保持期間を外部設定する構造。本番値は含まない。

`VerifiedQuotaActor`はserver-side identity loaderからのみ生成する境界型であり、HTTP
bodyやJWT申告actorをこのcoreへ直接渡さない。fixture専用factoryはテスト以外で使用
しない。

## 2. 状態と遷移

```text
                reserve
     +------------------------------+
     |                              v
  (none) ---> reserved -------> committed
                |  ^               |
       timeout |  | accepted       | replay
                v  |               v
             expired          committed
                |
       denied/duplicate/conflict/unavailable
                v
             cancelled

  reserved --unknown_commit--> uncertain --any retry--> uncertain
                                      
  uncertainはTTLで自動解放しない。read-only reconciliationで
  G4のactor/key状態を確認するまでquotaを保持する。
```

同一reservation IDの再送は、reservedならreplayed、uncertainなら新規予約ではなく
idempotency_conflictとして扱う。committed/cancelled/expiredのID再利用も拒否する。
IDはサーバー生成UUID v4であり、生のIdempotency-Keyをstate、ログ、fixture storeへ
保存しない。

## 3. 2種類の制限

### Request load limit

`recordRequest`はacceptedだけでなく、replayed、duplicate、denied、invalid入力を
含めて受付前の呼出し負荷を数える想定である。本coreでは呼出しが到達した回数を短期
window/長期windowへ加算し、上限超過を`rate_limited`とする。G3の暗号処理やG4の
DB保存より前に呼び出す。

### New admission quota

`reserveAdmission`は新規保存候補だけのquotaを予約する。予約を確定するのは
ReportRepositoryの結果が`accepted`の場合だけである。

| Repository結果 | quota処理 |
| --- | --- |
| `accepted` | committed、quota消費を維持 |
| `replayed` / `duplicate` / `denied` / `idempotency_conflict` | cancelled、予約分を解放 |
| `unavailable` | cancelled候補。再試行と誤解放の運用は統合時に再確認 |
| `unknown_commit` | uncertain、無条件解放・再予約・再INSERTをしない |

`unknown_commit`をcancel扱いしないことが、本coreの最重要安全契約である。

## 4. Durable Objects接続契約

将来のDO adapterは、actor UUIDをcanonical keyとして同じactorの全操作を一つの直列
turnへ入れる必要がある。`QuotaStore.withActorLock`はその最小契約を表す。

DO storageへ保存する最小状態は、version、actor UUID、各windowの開始時刻とcount、
admission count、reservation ID/status/createdAt/expiresAtである。本文、target UUID、
JWT、role、raw Idempotency-Key、暗号文、HMAC digestは保存しない。

インスタンス再生成後はstorageからstateを読み、versionを検証してから遷移する。
未知version、壊れたstate、load/save失敗、clock不正はunavailableへfail closedする。
saveは一つのactor turn内で原子的に行い、途中のstateを外部へ返さない。

DOとPostgreSQL間には分散transactionがないため、次の順序を候補とする。

1. server identityを確定する。
2. request load quotaを予約する。
3. new admission quotaを予約する。
4. G3 validation/cryptoとG4 Repositoryを実行する。
5. Repositoryの内部結果に応じてquotaをfinalizeする。
6. `unknown_commit`または通信断ならuncertainのままreconciliation対象にする。

quota予約成功後にG4が失敗した場合の予約返却、DO再起動、reconciliationのretry回数、
監視通知はCEO承認が必要である。quota状態をPostgreSQL監査ログへ毎回書き込む設計は
DoSを増幅するため採用しない。

## 5. Fixture設定と承認候補

テストでは短い窓と小さい上限を設定し、時間をfixture clockで進める。本番値は設定
ファイルやmigrationへ入れていない。

CEOが承認すべき候補:

- actor短期request limit/window
- actor長期request limit/window
- new admission quota/window
- reservation TTL
- max active reservations
- terminal state retention
- replay/duplicate/denied/invalidを各budgetへ算入する規則
- quota超過後の再送・再予約ポリシー

## 6. セキュリティ保証

- actor stateはverified server identityのUUIDに束縛する。
- actor間のstate/予約操作を分離する。
- internal reservation IDはUUID v4を必須にし、推測可能な連番を拒否する。
- reservation数に上限を設け、期限切れ・terminal tombstoneを保持期間後にpruneする。
- uncertain tombstoneは自動削除・自動解放せず、再送による二重確定を防ぐ。
- Store障害、state破損、version不一致はunavailableとする。
- quota coreは通報本文、target情報、JWT、暗号鍵を扱わない。

## 7. 検証結果と残存条件

追加したfixtureテストは、quota内、短期/長期超過、reserve/commit/cancel/expiry、
同一ID再送、別actor拒否、並列request/reservation、replay/duplicate/denied/conflict、
unknown commit、state復元、clock境界、Store障害、state肥大化防御を対象とする。

G5-01のローカルcoreは、実DO・実HTTP・G4本番統合なしで検証する。残存条件は、
CEO承認済み閾値、DO binding/namespace、永続化・再起動・reconciliationの実装、
負荷試験、429/503/Retry-After契約、費用上限、G4-B2本番Secret/HTTP統合である。

**判定: G5-01 local core PASS候補 / G5 runtime BLOCKED。**
