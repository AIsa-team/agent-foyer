# 用 OpenID Connect 登录

> [English](OIDC_SETUP.md)

不用 Lark 时，可以用任意 OpenID Connect 登录：Google Workspace、Microsoft Entra ID、Okta、Keycloak、Authentik、Authing 等。这样能用中台的核心功能：应用广场、Skill 市场、Agent 通过 MCP 接入、个人首页、资料页，以及基于[数据应用](DATA_APPS.zh-CN.md)的数据看板、异常项和指标提醒。

需要 Lark 的部分会关闭并隐藏：多维表格数据源、OKR、通讯录同步（组织页只列出登录过的人）、提醒消息（提醒只在首页显示），以及应用调用 Lark。

## 1. 在登录服务里登记中台

建一个 OAuth / OIDC **Web 应用**（机密客户端）：

| 项 | 值 |
|---|---|
| 重定向 URI | `https://hub.example.com/auth/callback` |
| 授权方式 | 授权码（中台使用 PKCE） |
| Scope | `openid profile email` |

然后写进 `.env`：

```
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
OIDC_NAME=Google                       # 界面和 Agent 提示里显示「用 Google 登录」
OIDC_ALLOWED_DOMAINS=example.com       # 只允许这些邮箱域名登录
HUB_ADMINS=you@example.com
```

`LARK_APP_ID` 留空（或设置 `AUTH_PROVIDER=oidc`）。中台从 `<OIDC_ISSUER>/.well-known/openid-configuration` 读取各个地址，从 userinfo 接口读取登录的人。

### 各家说明

- **Google Workspace**：Google Cloud 控制台 → API 和服务 → 凭据 → OAuth 客户端 ID → Web 应用；issuer 是 `https://accounts.google.com`。任何 Google 账号都能用 Google 登录，所以没配 `OIDC_ALLOWED_DOMAINS` 时中台会拒绝启动。
- **Microsoft Entra ID**：应用注册 → 新注册（Web，填上面的重定向 URI）→ 证书和密码；issuer 是 `https://login.microsoftonline.com/<租户 ID>/v2.0`。单租户应用只允许本组织的人登录。
- **Okta**：Applications → Create App Integration → OIDC、Web Application；issuer 是 `https://<你的域名>.okta.com`（或自定义的授权服务器）。把应用分配给要用中台的人。
- **Keycloak**：建一个开启 Client authentication 和 Standard flow 的客户端；issuer 是 `https://<主机>/realms/<realm>`。

## 怎么识别一个人

- 用登录服务给的 `sub` 作为这个人的唯一标识；姓名、邮箱、头像来自 userinfo，每次登录都会更新。以后换登录服务会产生新账号，所以请在大家开始发布内容之前定下来。
- 登录服务标记为未验证（`email_verified: false`）的邮箱会被忽略：不能匹配 `HUB_ADMINS` 或同事，也过不了 `OIDC_ALLOWED_DOMAINS`。
- 第一个登录的人是管理员，`HUB_ADMINS` 里的邮箱也是。

## 全部配置

| 变量 | 默认值 | 含义 |
|---|---|---|
| `AUTH_PROVIDER` | 自动判断 | `lark`、`oidc` 或 `dev`；依次看 `LARK_APP_ID`、`OIDC_ISSUER` |
| `OIDC_ISSUER` | — | issuer 地址（不带 `/.well-known/…`） |
| `OIDC_CLIENT_ID` | — | 客户端 ID |
| `OIDC_CLIENT_SECRET` | — | 客户端密钥（用 HTTP Basic 发送） |
| `OIDC_SCOPES` | `openid profile email` | 申请的 scope |
| `OIDC_NAME` | `SSO` | 大家熟悉的登录服务名字 |
| `OIDC_ALLOWED_DOMAINS` | — | 允许登录的邮箱域名，逗号分隔 |
