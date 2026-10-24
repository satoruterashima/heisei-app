# HEISEI-003I-A G4-B Preflight（DRAFT）

Status: **DRAFT / isolated integration only**

## 統合対象

- PR #45: G2 visibility
- PR #46: G3 crypto / validation
- PR #47: G4-A report schema / roles / RLS

統合ブランチではmigration番号の衝突を解消するため、G4-Aのローカルmigrationを
`0002_report_foundation_g4a.sql`へ変更した。各元PRのブランチ、PR、mainは変更していない。

適用順は次のとおり。

1. `0000_baseline_profiles.sql`
2. `0000_auth_foundation.sql`
3. `roles.sql`
4. `0001_profile_visibility.sql`
5. `0002_report_foundation_g4a.sql`
6. `roles.sql`（再適用）

## 契約確認

- G2はserver-side actor、active、公開target、双方向blockなしを根拠とし、deny/unavailableを保存許可に変換しない。
- G3は正規化本文を保存せず、暗号化envelopeと32-byte fingerprintを使用する。本文なしはNULL envelopeとする。
- G4-Aはactor-bound RLS、pending一意制約、専用report writer、TTL専用writerを提供する。
- `heisei_report_writer`と`heisei_visibility_reader`の相互書込み権限はない。TTL writerはreports/auditへアクセスできない。

## TOCTOU検証

隔離PostgreSQLで、visibility readerがtargetをpublicとして判定した後、targetをprivateへ変更し、別transactionでreport INSERTを実行した。INSERTは成功した。

これはG4-Aがvisibility判定を保存処理へ強制接続していないことを示す境界テストであり、統合不備をPASSとは扱わない。

比較結果：

- 保存直前のSELECTのみ：不十分。判定後の変更を防げない。
- SERIALIZABLE：visibility判定と保存を同一transactionにし、状態変更側も協調する必要がある。分離transactionでは解決しない。
- 明示的row lock：visibility対象とblock関係の更新経路が同じlock順序を採用する必要がある。現行の全更新経路での協調は未検証。
- 推奨：G4-B RepositoryがG2判定、G3生成、report INSERT、監査INSERTを同一transaction境界で扱い、承認済みのlock/分離レベル契約を追加検証する。

## 監査原子性

現行G4-Aではreport writerの監査なし直接INSERTが可能である。Repository方式は実装の一貫性を担保しやすいが、DB直接経路を完全には塞がない。triggerまたは限定関数方式は強制力がある一方、既存role/RLS設計との整合性とmigration影響を追加レビューする必要がある。

G4-Bで、監査強制方式、G2 commit時再検証、G3 key provider接続、HTTP契約を確定するまで、通報APIの実装開始はBLOCKEDとする。
