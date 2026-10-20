# GitHub 与日报

> [English](GITHUB.md)

接上 GitHub 后，Agent 能通过中台读到某个人在某段时间里做了什么：提交的 commit、开的和合并的 PR、review 过的 PR。最常见的用法是写日报：Agent 读你昨天的工作，对照日报里的项目和列起草，你确认后它替你填进 Lark 日报。

中台只**读** GitHub，不会改代码、不会评论。

## 1. 建一个 GitHub App（一次）

任何人都可以建，建好后由组织的 owner 批准安装。在 GitHub **Settings → Developer settings → GitHub Apps → New GitHub App**（个人账号或组织下都可以）：

| 项 | 填什么 |
|---|---|
| GitHub App name | 中台的名字，全 GitHub 唯一 |
| Homepage URL | `https://hub.example.com` |
| Redirect URI | `https://hub.example.com/auth/github/callback` |
| Expire user authorization tokens | 保持默认 |
| Request user authorization during installation / Device Flow | 不勾 |
| Webhook | 见下面第 3 步；不用就取消 **Active** |
| Repository permissions | **Contents**：Read-only；**Pull requests**：Read-only；Metadata 自动为 Read-only。其余都不开 |
| Organization / Account permissions | 都不开 |
| Where can this GitHub App be installed? | 建在个人账号下要选 **Any account**，否则装不到组织上 |

建好后：

1. 记下 **App ID** 和 **Client ID**。
2. **Generate a new client secret**，复制下来（只显示一次）。
3. 页面底部 **Generate a private key**，会下载一个 `.pem`。
4. 左侧 **Install App** → 选组织 → 仓库选 All repositories 或需要的仓库。不是 owner 的话，这一步是申请，等 owner 批准。

## 2. 配到中台

把 `.pem` 放到服务器的数据目录（Docker 部署时是容器里的 `/data`），在 `.env` 里写：

```
GITHUB_ORG=your-org
GITHUB_APP_ID=123456
GITHUB_CLIENT_ID=Iv23li...
GITHUB_CLIENT_SECRET=...
GITHUB_APP_PRIVATE_KEY=github-app.pem
```

重启中台。每个同事在「我的」页面点一次「连接 GitHub」，中台只记下他的 GitHub 用户名，不保留他的 GitHub 令牌。

## 3. 可选：让 GitHub 推送事件

GitHub 的 commit 搜索只覆盖默认分支。开了 PR 的分支没问题（中台会去 PR 里取 commit），但**只 push 到分支、还没开 PR 的工作**查不到。想把这部分也算进去：

1. 生成一串随机字符作为 secret（例如 `openssl rand -hex 32`），写进 `.env`：`GITHUB_WEBHOOK_SECRET=...`，重启中台。
2. 在 App 设置里勾上 Webhook **Active**，URL 填 `https://hub.example.com/hooks/github`，Secret 填同一串。
3. **Subscribe to events** 勾 **Push**、**Pull request**、**Pull request review**。

中台验签后保存每次 push 的 commit（保留 90 天），只能抓到开启之后的 push。commit 要用绑定了 GitHub 账号的邮箱提交，才能对应到人。

## 4. 日报

日报是 Lark 知识库里某个页面下、每天一篇的文档（例如「团队工作日报 1020」）。每个项目一张表，第一列 @ 到负责人，后面是「昨天完成 / 今天计划 / 卡点」之类的列。

- 管理员让 Agent 调一次 `set_daily_report`：给日报所在的知识库页面链接，以及标题格式，例如 `团队工作日报 {MM}{DD}`（可用 `{YYYY} {MM} {DD} {M} {D}`，按 `HUB_TIMEZONE` 取日期）。
- `get_daily_report` 读某天的日报：每张表、你自己的那几行、还有谁没填。
- `fill_daily_report` 以你本人的身份写你自己那几行。第一次写时会请你授权中台编辑 Lark 文档，对应 Lark 权限 `docx:document`（见 [LARK_SETUP](LARK_SETUP.zh-CN.md)）。
