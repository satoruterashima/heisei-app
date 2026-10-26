# HEISEI reconcile proof closeout

更新日: 2026-10-26

## 目的と範囲

この記録は、隔離された `RECONCILE-PROOF-12` の実証結果と、`RELEASE-CLOSEOUT-13` におけるproof機能の停止・通常リリースからの除外を記録する。実ユーザーデータ、production、既存stagingの状態変更は含まない。

## 完全一致applyの証跡

- synthetic actor: `40000000-0000-4000-8000-000000000011`
- 成功対象: `40000000-0000-4000-8000-000000000015`
- reservation: `a3f6bf04-347c-4e48-82eb-8c09555eca17`
- operation: `2ee7116e-9857-4d2c-8e18-b62bdb43bee6`
- DB commit後の応答喪失を隔離Workerで注入し、DOの `uncertain` 化を確認した。
- dry-run: `match_dry_run` / `stored`
- apply: `committed` / `stored`
- replay: `not_eligible` / `committed`。二重適用なし。
- 最終状態: DO reservation `committed`、DB operation `applied`、report 1件、監査記録あり。

候補のactor、reservation、request、key version、scope digest、payload fingerprint、report参照、監査証跡が一致した場合だけapplyされた。raw Idempotency-Key、平文、Secret、秘密鍵は記録していない。

## 未解決状態の保全

### proof環境: 2件

以下はproof環境の同一synthetic actorに属し、証拠情報が存在しないため判定不能として保持している。

| reservation | actor | status | evidence | 処置 |
|---|---|---|---|---|
| `84a816d1-c7a5-4310-9c76-2a610e4509ec` | `40000000-0000-4000-8000-000000000011` | `uncertain` | なし | 確定・解除・削除なし |
| `978321c3-3a39-4407-927a-19ff0f5817ab` | `40000000-0000-4000-8000-000000000011` | `uncertain` | なし | 確定・解除・削除なし |

作成時刻はDO inspectで取得済みだが、証拠欠落の状態を変えないため、この記録では機密でない識別情報と状態のみを正本とする。原因は、proof実証の初期段階で保存候補を結合する証拠が生成される前に作成された予約である。

### 既存staging: 4件

既存stagingの4件はproof環境の2件とは別管理であり、今回の操作でinspect、reconcile、状態更新、削除を行っていない。既存stagingのactor/reservation IDはこのcloseoutのローカル証跡に再現されていないため推測記載しない。通常のoperator inspectでactor単位・cursor単位に確認し、完全一致証拠がない限り保持する。

## proofリソース

proof用に作成したリソースは、未解決2件の保存状態を維持するため削除していない。

- Neon project: `crimson-art-20319312`
- Neon branch: `heisei-reconcile-proof` / `br-floral-moon-aom46984`
- database: `heisei_reconcile_proof`
- Worker: `heisei-reconcile-proof`
- operator Worker: `heisei-reconcile-proof-operator`
- proof Hyperdrive: `a549371b442c4db0a9a3e5e3ee685b80`
- Access application: `HEISEI Reconcile Proof` / `0898a28c-ecba-4bc9-a556-717a213c55e3`
- Access operator application: `HEISEI Reconcile Proof Operator` / `17ee05ac-bbf7-453f-8c2e-2709ce743c42`
- Access policy IDs: `75427572-869b-4b1c-9836-0fe68e3d660f`, `13684d25-57ad-4a78-a052-256804c36be5`

### 停止状況

- proof Workerは `HEISEI_PROOF_ACCEPTING=false` の新Version `951fc715-b939-460d-a2c8-f7d48a9285af` をデプロイ済み。
- proof operator Workerは `HEISEI_PROOF_ACTIVE=false` の新Version `a9703479-91ca-427e-ab24-05e6fc434270` をデプロイ済み。
- これによりproof受付とoperator実行入口をfail-closedで停止し、既存DO/DB状態を保持している。
- Accessの未認証入口はWorker応答ではなくAccessログイン応答となることを確認した。
- Neon branch、DB、DO namespace、Hyperdrive、Access application/policy、proof Secretは削除していない。

## 通常リリースへの封じ込め

proof専用Workerソース、proof専用Wrangler設定、proof専用operator設定をPRの通常ソースから削除した。通常の `operator-worker.ts` からもproof専用GET診断経路と証拠詳細の分岐を削除した。通常staging/productionのbundleにはproof Worker、fault injection、固定actor、テストJWT、proof設定を含めない。

## 料金・削除

Wranglerの認証済みアカウントとWorker操作権限は確認済み。Cloudflare Billingの契約額・利用量およびNeonの課金詳細は、この作業環境から契約情報として確認できていないため未確認とする。追加有料契約・プラン変更は行っていない。

未解決proof状態が2件残るため、proofリソースの完全削除は保留する。削除時はこの記録、DO状態、DB report/operation、監査証跡を保全したうえで、対象IDが既存stagingと共有されていないことを再確認する。
