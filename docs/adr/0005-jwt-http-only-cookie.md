# ADR-0005: JWTをHttpOnly Cookieで管理

- Status: Accepted
- Date: 2026-07-11
- Area: Security
- Related Notion Task: なし（移行済みNotion ADRを参照）
- Legacy Source: https://app.notion.com/p/39a06467984f81a3ade4c95cfb9c7079

## Context

Web公開でXSSによるToken窃取を抑え、端末単位でSessionを失効させる。

## Decision

- Access JWT／Refresh TokenをHttpOnly Cookieへ保存する。
- Secure、適切なSameSite、Path／Domainを設定する。
- Refresh Token RotationとReuse Detectionを実施する。
- DBにはRefresh Token HashとFamilyを保存する。
- Logout、Password変更、退会時にSessionを失効する。
- MutationへCSRF TokenとOrigin検証を適用する。

## Alternatives

- localStorage: XSS時のToken窃取リスクが高い。
- Server Sessionのみ: 実現可能だが今回のJWT要求と異なる。

## Consequences

- localStorageを避けられる一方、CSRF、Origin、CORS、Cookie設定が重要になる。

## Implementation

- Cross-origin構成、Server Component呼出し、Cookie転送を統合Testする。

## Review Trigger

- Frontend／APIのOrigin構成または認証方式を変更する場合。
