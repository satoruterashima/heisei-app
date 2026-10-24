# HEISEI-003I-A G5-02A：Durable Objects Persistence Adapter（DRAFT）

Status: **DRAFT / local only**

基点: PR #52 / `63862775af2fc9aaa279516c6d508b1c846bceaf`

## 1. 実装範囲

`packages/domain/src/durable-quota-store.ts` に、Quota Coreの`QuotaStore`と互換な
DO Storage Adapterとローカルシミュレータを追加した。実DO binding、namespace作成、
Worker deploy、G4 PostgreSQL接続は行っていない。

- `DurableObjectQuotaStore`: 検証済みactorに固定された永続Store。
- `DurableQuotaStorageLike`: DO Storageの`get`/`put`に必要な最小境界。
- `DurableQuotaTurn`: DO RPC/input gateを表す排他的turn境界。
- `LocalDurableObjectStorage`: durable Map、clone、queued turn、障害注入を持つfixture。
- `LocalDurableQuotaNamespace`: actor UUIDをcanonical nameにした決定的なnamespace fixture。

実DOでは`getByName(canonicalActorUuid)`で同一actorを同一インスタンスへルーティングし、
RPCメソッドの入力ターンを`DurableQuotaTurn`としてAdapterへ渡す。Adapter自身の正しさを
メモリlockに依存しない。ローカルfixtureのqueueはこのDO input-gate契約を再現する。

## 2. 永続化と復元

保存キーは`quota-state-v2`の1件だけで、本文、target、JWT、role、生のIdempotency-Key、
暗号鍵、HMAC digestは保存しない。保存前後にcloneするため、呼出し側が返却オブジェクトを
変更して永続状態を汚染できない。

`load`/`save`はactor一致、version 2、予約ID UUID v4、status、時刻、counter、未知
フィールド、予約actor、保存件数上限を検証する。不整合は例外としてCoordinatorの
`unavailable`へ投影し、自動初期化やquota復活を行わない。

`QuotaCoordinator`のload→transition→saveは同じ`DurableQuotaTurn`内で実行する。
save成功前に遷移結果を返さず、保存応答が失われても永続化済み状態を再起動後に復元する。

## 3. 状態整合性

受理するのはversion 2だけである。次をfail closedにする。

- actor UUIDの不一致
- window/count/createdAt/expiresAtの不正値・時刻逆行
- `reserved`/`in_flight`/`uncertain` counterの不一致
- reservation IDとMap keyの不一致
- 未知status、未知フィールド、予約actorの不一致
- `maxStoredReservations`超過

期限超過した`in_flight`は`uncertain`へ移し、`uncertain`はTTLだけで解放・削除しない。
terminal tombstoneのみ既存のretention規則で削除可能とする。

## 4. 障害・クラッシュ契約

| 停止地点 | 復元後の扱い |
| --- | --- |
| load前/中 | `unavailable`。stateを初期化しない |
| transition前/後 | 保存されていなければ直前の永続stateを維持 |
| save前/中の失敗 | `unavailable`。部分的な許可を返さない |
| save後・応答前 | 再起動後に保存済みstateをloadし、同一予約を再照合 |
| `beginSave`後 | `in_flight`を保持。TTL超過は`uncertain` |
| PostgreSQL処理中想定 | quotaを自動解放しない |
| `unknown_commit`後 | `uncertain`を保持し、read-only reconciliation対象 |
| reconciliation中 | `unavailable`/`unknown`/`key_missing`なら`uncertain`維持 |

ローカルfixtureでは`load`、`put_before`、`put_after`を注入し、保存成功後の応答喪失を
含めて検証した。G4への実照合は本工程の範囲外である。

## 5. Reconciliation境界

`QuotaCoordinator.reconcile`は内部状態遷移のみを担当する。`stored`だけが committedへ、
`not_stored`だけが取消候補へ進める。`unavailable`、`unknown`、`key_missing`は
`uncertain`を維持する。検索結果0件だけでは`not_stored`と判定しない。

reconciliation権限は将来の内部G4照合Repositoryに限定し、HTTPやclient入力から直接
呼び出さない。今回、実PostgreSQL・実鍵・実DO bindingは未接続である。

## 6. 検証結果と残存条件

追加fixtureは、永続復元、actor分離、並列turn、破損state、version不一致、未知字段、
counter不整合、予約件数上限、load/save障害、応答喪失、in-flight/uncertain復元、window
切替、tombstone保持・削除、reconciliation結果を対象とする。

G5-02Aのlocal adapter受入には、実DO runtimeでのinput gate/storage契約確認、Durable
Object namespace/binding、運用閾値、G4 read-only reconciliation、監視・費用上限の
承認が残る。これらが未確定のため、本番runtimeへの移行はBLOCKEDとする。
