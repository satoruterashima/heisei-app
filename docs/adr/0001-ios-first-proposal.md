# ADR-0001: iOS先行構成の提案

状態: DRAFT（CEO/仕様承認前）  
日付: 2026-10-22

## 背景

正式v2.0技術選定書はNext.js App Router + PWAを先行し、将来ネイティブを想定する。一方、現在の実装はReact Native + Expoの`apps/mobile`とHono APIである。今回の開発指示ではiOS先行が前提になったため、両者の差分を明示する。

## 提案

`apps/mobile`を先行クライアントとし、Expo/RNからHono APIを利用する。認証・ドメイン・検証・DB境界はクライアントから分離し、将来のWeb/PWAは同じAPIと`packages/domain`を利用する。Next.jsをExpoへ移植せず、Webアプリは別targetとして後から追加する。

## 理由・利点

- 現存コードと検証済み依存を活用できる。
- iOSの認証callback、SecureStore、実機の権限・復帰を早期に検証できる。
- API中心にすることでWeb/PWAの追加時に業務ルールを二重実装しない。

## 制約・リスク

- Expoのネイティブbuild、iOS実機、Apple審査・IAPはLinux Cloudだけでは完了できない。
- Web/PWAのSEO、Cookie/CSRF、PWA install、Stripe導線は別設計になる。
- 認証callback、push、SecureStore、IAPはExpo Goとdevelopment buildで挙動が異なる。
- 正式資料のWeb/PWA先行とロードマップが異なるため、公開順序の承認が必要。

## 将来のWeb展開

WebはNext.jsを別アプリとして追加し、HonoのBearer/JWT契約またはWeb用Cookie境界を明示する。Web側のHttpOnly Secure Cookie、CSRF/Origin、CSPはExpoのBearer認証と混同しない。UIは共通theme/domainを再利用するが、ナビゲーションと課金導線は各platformで設計する。

## 承認事項

これは実装指示ではない。iOS先行の正式採用、Web公開時期、認証事業者、年齢確認、iOS課金、会費、コミュニティ作成条件はDRAFTのままCEO/正式仕様の承認を待つ。
