# Sign-in with OpenID Connect

> [中文](OIDC_SETUP.zh-CN.md)

Without Lark, people sign in through any OpenID Connect provider: Google Workspace, Microsoft Entra ID, Okta,
Keycloak, Authentik, Authing… You get the core hub: the app square, the Skill market, agents over MCP, personal home
pages, the resources page, and data boards, data checks and alerts on [data apps](DATA_APPS.md).

What needs Lark is switched off and hidden: Lark Base data sources, OKRs, the synced directory (the Org page lists
people once they have signed in), alert messages (alerts show on home pages only) and apps acting in Lark.

## 1. Register the hub with your provider

Create an OAuth / OIDC **web application** (a confidential client) with:

| Setting | Value |
|---|---|
| Redirect URI | `https://hub.example.com/auth/callback` |
| Grant type | Authorization code (the hub uses PKCE) |
| Scopes | `openid profile email` |

Then put its details in `.env`:

```
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
OIDC_NAME=Google                       # "Sign in with Google" in the UI and agent prompts
OIDC_ALLOWED_DOMAINS=example.com       # only these email domains may sign in
HUB_ADMINS=you@example.com
```

Leave `LARK_APP_ID` empty (or set `AUTH_PROVIDER=oidc`). The hub reads the provider's endpoints from
`<OIDC_ISSUER>/.well-known/openid-configuration`, and who signed in from its userinfo endpoint.

### Provider notes

- **Google Workspace**: Google Cloud console → APIs & Services → Credentials → OAuth client ID → Web application;
  issuer `https://accounts.google.com`. Any Google account can use Google sign-in, so the hub refuses to start
  without `OIDC_ALLOWED_DOMAINS`.
- **Microsoft Entra ID**: App registrations → New registration (Web, redirect URI above) → Certificates & secrets;
  issuer `https://login.microsoftonline.com/<tenant id>/v2.0`. Single-tenant apps only let your organisation in.
- **Okta**: Applications → Create App Integration → OIDC, Web Application; issuer `https://<your domain>.okta.com`
  (or your custom authorization server). Assign the app to the people who should use the hub.
- **Keycloak**: a client with Client authentication on and Standard flow; issuer
  `https://<host>/realms/<realm>`.

## How people are identified

- A person is keyed by the provider's `sub`; name, email and picture come from userinfo and are refreshed at each
  sign-in. Switching providers later creates new accounts, so choose before people start publishing.
- An email the provider marks as unverified (`email_verified: false`) is ignored: it cannot match `HUB_ADMINS` or a
  colleague, and cannot pass `OIDC_ALLOWED_DOMAINS`.
- The first person to sign in becomes an admin, as do the emails in `HUB_ADMINS`.

## All settings

| Variable | Default | Meaning |
|---|---|---|
| `AUTH_PROVIDER` | inferred | `lark`, `oidc` or `dev`; inferred from `LARK_APP_ID`, then `OIDC_ISSUER` |
| `OIDC_ISSUER` | — | issuer URL (without `/.well-known/…`) |
| `OIDC_CLIENT_ID` | — | client id |
| `OIDC_CLIENT_SECRET` | — | client secret (sent with HTTP Basic) |
| `OIDC_SCOPES` | `openid profile email` | scopes to ask for |
| `OIDC_NAME` | `SSO` | the provider's name as people know it |
| `OIDC_ALLOWED_DOMAINS` | — | comma separated email domains allowed to sign in |
