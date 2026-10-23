# HEISEI-003I-A G5：レート制限・乱用防止設計（DRAFT）

Status: **DRAFT / G5 CONDITIONAL、公開BLOCKED**  
Scope: report POSTの乱用・UUID探索・DB負荷を抑える設計比較。Workers設定、外部provider、secret、API実装は変更しない。

## 1. 保護対象

レート制限は成功した保存件数だけでなく、次の試行を数える必要がある。

- 未知・不可視UUIDへのPOST
- malformed payload、key衝突、認可失敗の反復
- 同じtargetへの大量の異なるkey
- 同一actorの並列POST
- 複数Workers instanceからの分散送信

counter keyはverified server-side identityを第一識別子とし、client任意headerだけでactor/IPを確定しない。IPは補助信号に限定し、共有NAT・IPv6・proxy・privacy relayによる誤検知を考慮する。

## 2. 方式比較

| 方式 | 分散整合性 | 実装難易度 | コスト/運用 | 判定 |
| --- | --- | --- | --- | --- |
| Workers in-memory | 低。instance間で分裂 | 低 | 低 | 単独採用不可 |
| Cloudflare edge rate limit | edgeで吸収しやすい | 中 | プラン・設定依存 | provider/契約確認待ち |
| PostgreSQL counter | 既存DB境界で原子的に管理可能 | 中〜高 | DB負荷・cleanup必要 | local MVP候補 |
| Durable Object等binding | actor単位の直列化に向く | 高 | 新binding・運用設計 | 初期採用は要承認 |
| actor＋IPの組み合わせ | 回避耐性を補助 | 中 | privacy/誤検知の運用負荷 | 補助候補 |

## 3. 閾値候補（未承認）

| 案 | actor単位 | IP補助 | 想定効果 | リスク |
| --- | --- | --- | --- | --- |
| A | 1時間3試行 | 10分20試行 | UUID探索を強く抑制 | 正常な再送・複数対象を阻害 |
| B | 1時間5試行 | 10分30試行 | 安全とUXの中間 | bot/共有IPで調整が必要 |
| C | 1時間10試行 | 10分50試行 | UXを優先 | 探索・DB負荷が増える |

A/B/Cは比較用であり、承認済み閾値ではない。初期値を勝手に固定しない。

## 4. 推奨構成

### local Phase B候補

fail-closedな`ReportRateLimiter`境界をAPIへ注入し、isolated PostgreSQLではactor単位のtransactional counterを使う。counterは次のような状態を候補とする。

- actor scope digest、window start、attempt count、last_attempt_at
- optional IP補助signalは生IPをreport/auditへ保存しない
- accepted、unknown、invisible、duplicate、key collision、validation failureのうち、探索に使える試行を承認定義どおり加算
- counter更新失敗、依存未設定、timeoutはfail-closedで503候補
- rate limitedは429候補。ただしtarget存在やkey衝突によって429を変えない

この方式はreport transactionと同一DBで原子化できるが、counterのincrement失敗時にreportを保存しない、または保存前後の順序を固定する必要がある。既存schemaにcounterを追加する場合はmigration・RLS・保持期限が別途必要である。

### edge/production候補

Cloudflare edge rate limitまたはDurable Object等を使う場合、全instanceで同じactor scopeを保つbinding・availability・費用・削除・failoverをレビューする。新規providerや有料機能を勝手に採用しない。edgeだけに依存せず、DB側の一意性・RLS・入力上限を維持する。

## 5. 情報非開示と障害境界

- unknown/invisible/accepted/pending duplicateの成功は同じ202 projection。
- 429が対象存在、可視性、既存report、key collisionに依存して分岐しない。
- rate limiter未設定・依存障害は、成功202へ変換しない。安全な503候補とする。
- 失敗理由、counter値、remaining、reset時刻をclientへ返さない候補。返す場合も対象存在と無関係な固定契約が必要。
- counter key、生IP、JWT、target UUID、descriptionを通常ログ・auditへ出さない。

## 6. 乱用・誤検知・コスト評価

- 同一actorが複数正当対象へ通報する利用者を過度に遮断しない。
- 共有IPを同一利用者とみなさない。IP制限単独は採用しない。
- attackerが未知UUIDで枠を消費することは、存在非開示とDB負荷抑制のトレードオフとして測定する。
- PostgreSQL counterは高頻度時にhot row・lock待ちを生むため、負荷試験とwindow cleanupが必要。
- edge/bindingは無料枠、storage、egress、運用監視、failover費用を確認する。

## 7. 受入テスト

- 1 actorの境界直前・超過、window rollover、同時POSTを実DBで確認。
- unknown/invisible/accepted/duplicate/key collisionが同じ成功投影になることを確認。
- limiter未設定、timeout、DB障害、counter transaction failureが503/ROLLBACKになることを確認。
- 複数actor、同一IP、異なるIP、proxy/IPv6形式の補助信号で誤結合しないことを確認。
- 同時Workersを模した複数executorで制限が分裂しないことを確認。
- counter値、remaining、reset、target、本文、keyがレスポンス/ログ/auditに漏れないことを確認。

## 8. 判定と承認事項

方式設計: **CONDITIONAL**。local DB counter＋注入可能fail-closed境界が第一候補。  
閾値: **BLOCKED/未承認**。A/B/Cの選択と正常利用者UX評価が必要。  
公開: **BLOCKED**。実運用binding、費用、監視、failoverが未検証。

CEO/運用承認が必要な事項：

1. actor/IPの閾値とwindow。
2. malformed・unknown・duplicateを試行数へ加える規則。
3. 429/503の固定レスポンス契約。
4. edge、PostgreSQL、Durable Objectの採用。
5. 正常利用者の解除・問い合わせフローと監視担当。

