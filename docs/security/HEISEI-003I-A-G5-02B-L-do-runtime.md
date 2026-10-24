# HEISEI-003I-A G5-02B-L：Durable Objects Local Runtime（DRAFT）

Status: **DRAFT / local runtime only**

基点: G5-02A PR #53 / `06c66862909da92449826a9b8b14e1c4d15a078e`

## 1. Runtime構成

以下を追加した。

- `apps/api/src/quota-do-worker.ts`: `QuotaActor` Durable Object
- `apps/api/wrangler.do-local.json`: local-only binding/migration
- `vitest.do.config.mts`: `@cloudflare/vitest-pool-workers`設定
- `tests/durable-object-runtime.test.ts`: workerd/Miniflare実行テスト

actor UUIDは`idFromName(canonicalActorUuid)`で固定instanceを選択する。現在のローカル
Workers runtimeではnamespaceの`getByName`メソッドを使用せず、公式namespaceの基本API
である`idFromName`と`get`を使用した。

quota操作をWorkerのfetch routeへ公開せず、DO RPCメソッドからのみ実行する。RPC入力は
server-side identity境界で生成されたactor objectを前提とし、client申告のactor/roleを
認可根拠にしない。今回のテストWorkerは外部HTTP APIを持たない。

## 2. Cloudflare契約との照合

Cloudflare Durable Objectsの設計契約として、次を採用した。

- 同じ名前から同じDO instanceを選択する。
- DO内のRPC input gateをactor単位の排他的turnとして利用する。
- 重要状態はメモリだけに置かずStorageへ保存する。
- constructorの初期化専用処理以外で`blockConcurrencyWhile`を常用しない。
- 複数Storage書込みが必要になった場合はStorage transactionを使用する。
- 今回はstate blob 1件の`put`で保存するため、保存成功前に結果を返さない。

作業環境にインストール済みの実行基盤は次の通りである。

- `wrangler`: 3.77.0（Workers pool依存）
- `workerd`: 1.20240909.0 / 1.20250718.0（依存解決結果）
- `@cloudflare/vitest-pool-workers`: 0.4.31
- `vitest`: 1.5.3（poolの対応範囲に合わせたlocal test用更新）

Cloudflare公式の現行Web資料はこの環境からHTTPS取得するとproxy 403となったため、
liveページの内容を推測して補完していない。上記の実行基盤の型・設定・pool実装と、
Cloudflare Durable Objects skillが示すStorage/input-gate契約を照合した。実運用へ進む
前に公式料金・API仕様のreviewer確認が必要である。

## 3. 検証結果

実workerd/Miniflare runtimeで次を検証した。

- 同一actorの並列requestが一つのDO turnで直列化されること
- 同一reservationの並列予約が一件に収束すること
- 別actorのStorageが分離されること
- 新しいstub取得後もStorage状態が復元されること
- version 1、未知構造、予約件数超過がfail closedになること
- `in_flight`期限超過が`uncertain`となり、Storageに残ること
- `unknown` reconciliationでuncertainを解放しないこと

`runInDurableObject`によるfixture投入は、公開APIではなくlocal test専用の障害・状態
検証境界である。実runtimeから任意の本番stateを自動初期化する経路は設けていない。

## 4. 障害注入の境界

実DO runtimeで確認できるのは、Storage永続化、input gate、再取得、破損state、
`in_flight`/`uncertain`復元である。Storage応答喪失、DOプロセス強制停止、COMMIT後の
外部DB通信断はこのpoolから確実には注入できない。これらはG5-02Aのfixture fault
injectionと、将来の統合環境で別途検証する。

## 5. 容量・運用指標

local fixtureの`maxStoredReservations`は4で、これは本番閾値ではない。上限到達時は
破損/超過stateとしてfail closedする。terminal tombstoneはretention後にprune可能だが、
uncertainは自動削除・自動取消しない。

次工程で計測する指標:

- actorごとのstate blob bytes
- reservation総数と`reserved`/`in_flight`/`uncertain`数
- state load/save latency
- DO invocation数、Storage read/write回数
- lock/input-gate待機時間
- state validation failure数
- 長期uncertainの経過時間とactor数
- 容量上限到達率、再conciliation待ち件数

これらからDO invocation、Storage operation、state肥大化、長期uncertainの運用費を試算
する。実課金設定やnamespace作成は行っていない。

## 6. 判定と残存条件

**G5-02B-L local runtime：PASS候補**。実workerd/MiniflareでStorage、RPC/input gate、
並列処理、復元、fail-closedを確認した。

次に残る条件:

- Cloudflare公式の現行料金・Storage/transaction仕様のレビュー確認
- 実DO runtimeでの強制停止・eviction相当の運用試験
- G4 read-only reconciliationとの接続契約
- uncertainの監視・上限・手動対応
- 本番閾値、費用上限、namespace/binding、Secret運用のCEO承認

本工程ではG4 Repository、通報API、実Secret、remote deploy、production bindingを
変更していない。
