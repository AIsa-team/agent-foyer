# Gmail 草稿（Google Workspace）

> [English](GOOGLE_MAIL.md)

中台上的应用可以替使用者准备一封邮件（比如给客户的合作确认函，抄送相关同事），存成**这个人自己邮箱里的草稿**。他检查后自己发送；中台永远不会替人发邮件。公司邮箱在 Google Workspace 上时，草稿存进 Gmail；用 Lark 邮箱且没有配置 Google 时，存进 Lark 邮箱（由 `MAIL_DRAFTS` 决定）。

整个公司只需要管理员配置一次。其他同事只在第一次有应用要存草稿时，点一下「连接 Google」。

## 1. 建 OAuth 客户端（一次，大约 10 分钟）

用 Workspace 管理员账号登录 [Google Cloud 控制台](https://console.cloud.google.com/)：

1. 新建一个项目（比如「Agent Foyer」），或者用已有的。
2. **API 和服务 → 库**：启用 **Gmail API**。
3. **API 和服务 → OAuth 同意屏幕**（Google Auth Platform → 品牌 / 目标对象）：
   - 用户类型选 **内部**：只有你们 Workspace 里的账号能用，也不需要 Google 审核。
   - 应用名称填中台的名字，支持邮箱填你的。
   - 范围（数据访问）：添加 `.../auth/gmail.compose`，以及 `openid`、`email`。
4. **API 和服务 → 凭据 → 创建凭据 → OAuth 客户端 ID**：
   - 应用类型选 **Web 应用**。
   - 已获授权的重定向 URI：`https://hub.example.com/auth/google/callback`。
5. 把客户端 ID 和密钥填进服务器的 `.env`，重启中台：

   ```
   GOOGLE_CLIENT_ID=1234567890-xxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxx
   ```

配置了 `GOOGLE_CLIENT_ID` 后，`MAIL_DRAFTS` 默认就是 `google`。

## 2. 大家看到的

- 第一次有应用要替某人存草稿时，中台的同意页会写「在你的 Gmail 里存邮件草稿（不会替你发送）」。点「允许」后，Google 会请他授权草稿权限，然后回到应用。
- 「我的」页面会显示 Google 连接状态，可以随时断开。
- 中台只接受和这个人中台账号同一个邮箱域名的 Google 账号，保证草稿进的是工作邮箱。

## 说明

- `gmail.compose` 权限允许创建草稿和发送邮件；中台只调用「创建草稿」。
- 令牌加密保存（和 Lark 令牌一样），自动刷新。如果有人在 Google 账号里撤销了中台的权限，下次存草稿时会请他重新连接。
