# HEISEI-003I-A G4-B1：atomic boundary（DRAFT）

Status: **DRAFT / isolated PostgreSQL only**

## 実装した境界

`0003_report_atomic_boundary_g4b1.sql` に、専用 `heisei_report_tx_writer`
所有の `report_create_atomic(uuid, varchar, varchar, varchar)` を追加した。

- actorはtransaction-localな検証済み `app.user_id` から取得する。
- actorはactiveかつL2以上、targetはactiveかつpublicの場合だけ許可する。
- actor→target、target→actorのblockを両方向検証する。
- actor/targetのaccount statusとL2条件をDB projectionで検証する。
- G2判定、report INSERT、`report.create`監査INSERTを同一関数呼出し・同一transaction境界で行う。
- 監査失敗、制約失敗、RLS失敗はreportとともにrollbackする。
- actor/targetをUUIDとして正規化し、辞書順に両方のtransaction-level advisory lockを取得する。
- 関数は `NOLOGIN/NOSUPERUSER/NOBYPASSRLS` role所有、固定search_path、PUBLIC EXECUTEなしとする。

関数は内部の隔離検証用であり、通報API・本番Repositoryではない。

## 競合制御の評価

|方式|評価|
|---|---|
|保存直前SELECT|不十分。判定後のvisibility/block/status変更を防げない。|
|SERIALIZABLE|同一transactionで判定・保存し、更新側も同じ分離契約に参加する必要がある。|
|profile row lock|新規block INSERTを防げず、profileだけでは不十分。|
|advisory lock|actor/target pairを同一の正規化・固定順で取得すれば、協調するreport/block経路を直列化できる。|
|更新経路との明示的協調|最も強い候補。ただし既存block/profile status更新経路のlock契約変更が必要。|

block mutation storeのINSERT/DELETE経路にも同じactor/target pair lockを追加したため、実装済みblock更新経路は受付と協調する。block ID指定DELETEも対象特定後にpair lockを取得してから削除する。profile_visibility変更APIとaccount_status変更APIは現時点で未実装であり、高権限SQLによる直接変更は通常運用の保証範囲から除外する。したがってG4-B1の完全PASSには、将来のprofile/status更新経路への同一契約適用が残る。

## 監査原子性

同一関数境界では監査失敗時のrollbackを実証できた。G4-B1 closureでは、
`heisei_report_writer`のreports/audit_logs直接INSERT権限を撤去し、
`report_create_atomic`のEXECUTEだけを残した。冪等性記録の権限は維持している。

## テスト結果

- public/active/L2 targetの保存：成功
- private target：保存なし
- actor→target / target→actor block：保存なし
- audit INSERT失敗：report rollback
- pending一意性、同一key、TTL並列、migration再適用：既存回帰PASS
- advisory lockのバリア付き並列受付：2 transactionを直列化してPASS
- visibility判定後のprivate化後に直接INSERTが成功するTOCTOU負例：再現

## 残存条件

G4-B2へ進む前に、以下を承認・実装・検証する必要がある。

1. profile status/visibility更新経路が未実装のため、実運用経路としてのlock協調を追加検証
2. G3 ciphertext/idempotencyを同一保存境界へ接続
3. commit失敗・timeout・deadlock時のRepository安全動作

