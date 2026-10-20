# Agent Hub

> 占位名。[English](README.md)

基于 [Lark](https://www.larksuite.com)（飞书也可以）或任意 OpenID Connect 登录（Google Workspace、Microsoft Entra ID、Okta 等）的 Agent 原生公司中台。大家登录后，自己的编程 Agent（Claude Code、Codex、Cursor 等）通过 MCP 接入，具体的事都由 Agent 来做：发布 vibe coding 出来的小工具、分享 Skill、给公司数据做图表、设指标提醒。中台替代 Lark 工作台，成为大家的入口。

- **应用广场**：对 Agent 说「把这个项目发布到公司服务器」，静态网站或容器就会部署到 `https://<名字>.<应用域名>`，要用 Lark 登录才能打开。可见范围四档：只有自己 / 指定同事 / 全公司 / 所有人（公开需要管理员审批）。
- **Skill 市场**：分享和安装 Skill，带版本号；装过的人在有新版本时会收到提醒。
- **多人协作**：应用和 Skill 可以加协作者，和负责人一起发布、修改；删除、增减协作者和转交只有负责人（或管理员）能做。
- **给作者反馈**：同事可以在中台页面、每个应用右下角的「反馈」按钮（作者可以关掉），或者让自己的 Agent 代发，把应用或 Skill 的问题告诉作者；作者的 Agent 逐条处理，处理完提意见的人会收到通知。
- **千人千面的首页**：每个人的 Agent 都可以用模块（图表、OKR、提醒、链接）重新搭自己的首页。
- **数据**：Lark 多维表格，以及应用提供的行数据（Metabase、数据库、CRM 通过一个小应用接进来，见 [docs/DATA_APPS.zh-CN.md](docs/DATA_APPS.zh-CN.md)）。共享数据看板、由 Lark 机器人发送的指标提醒，以及把有问题的行分给负责人的异常项检查。
- **OKR**：个人的和公司的，读自 Lark OKR。
- **资料和组织**：按主题分组的制度、SOP 链接，Lark 通讯录，以及覆盖以上全部内容的 ⌘K 搜索。
- **基于 Lark 的应用**：应用声明它要读写哪些多维表格、可以给谁发消息；每个人同意一次后，应用就能通过一个小 SDK 以这个人的身份调用 Lark。

**用不用 Lark 都可以。** 用 Lark 登录能用全部功能。用 OpenID Connect 登录能用核心功能：应用、Skill、Agent 接入、首页、资料，以及基于数据应用的看板、异常项和指标提醒；多维表格、OKR、通讯录同步、Lark 消息和应用调用 Lark 会关闭（见 [docs/OIDC_SETUP.zh-CN.md](docs/OIDC_SETUP.zh-CN.md)）。

用户能看到的内容，在中台支持的每种语言里都有（目前是中文和英文；新增一种语言只需加一个词条文件，见 [CONTRIBUTING.md](CONTRIBUTING.md)）。

## 架构

```
                  ┌─────────────────────────── 中台（一个 Node 进程）────────────────────────────┐
 hub.example.com ►│ Web 界面 (React)   /api   /auth (Lark / OIDC)  /oauth + /mcp (Agent)         │
                  │                                                                              │
 *.example.net  ─►│ 网关：校验 Lark 身份和应用权限 ─► 静态文件 或 应用容器                       │
                  └───────────────────────────────────┬──────────────────────────────────────────┘
                                                      │ docker.sock
                         hub-app-<slug> 容器，每个应用一个私有网络，只有中台能访问
```

- **一个进程，按 Host 分流**：中台域名走 Hono 应用，应用子域名走网关。反向代理只负责 TLS，增删应用不用改它的配置。
- **存储**：SQLite（`data/hub.db`），加上 `data/` 下的应用文件、Skill 包和图标。
- **应用怎么登录**：网关把访客送到中台，中台校验身份和权限后，把一次性 code 交回应用子域名，换成只属于这个子域名的 Cookie。每次请求都重新检查权限，撤销立即生效。应用从请求头 `X-Hub-User-Id`、`X-Hub-User-Name`（URI 编码）、`X-Hub-User-Email` 拿到当前访客；纯前端应用可以 `fetch('/__hub/me')`。
- **两类应用**：`static`（构建产物，支持 SPA 路由）和 `container`（用项目自己的 Dockerfile，Node 和 Python 项目会自动生成）。容器有内存、CPU、进程数上限，去掉了所有 capabilities，持久目录是 `/data`，环境变量加密保存。
- **Agent 接入**：标准 MCP OAuth 2.1（发现元数据、动态注册、PKCE、refresh token）。不支持 OAuth 的 Agent 可以在「我的」页面生成个人令牌。
- **Lark 数据以查看者本人的身份读取**：每个人连接一次自己的 Lark；在 Lark 里打不开的表，在中台也看不到。
- **边界可替换**：登录可以是 Lark、OIDC 或本地开发登录（`server/auth/`）；发消息走同一个接口（`server/notify.ts`）；Lark 相关的代码都在 `server/lark/` 和 `server/apps/larkApi.ts`。

## 本地运行

需要 Node ≥ 22.18（直接运行 TypeScript，不用编译）和 pnpm。

```bash
pnpm install
pnpm build          # 构建 Web 界面
pnpm dev            # http://localhost:8080，没配 LARK_APP_ID 时用开发登录（3 个测试账号）
pnpm dev:web        # 可选：Vite 热更新 http://localhost:5173，接口代理到 8080
```

应用地址是 `http://<slug>.apps.localhost:8080`（Chrome 和 curl 能直接解析 `*.localhost`）。容器应用需要 Docker，本地通过 `127.0.0.1` 的随机端口访问。

接入 Agent：

```bash
claude mcp add --transport http agent-hub http://localhost:8080/mcp
```

## 测试

```bash
pnpm test           # 类型检查 + 用假的 Lark 和假的 OIDC 服务做端到端测试（会自己启动中台）
pnpm smoke          # 对正在运行的中台做核心端到端测试：pnpm smoke -- http://localhost:8080 [--docker]
```

## 部署

见 [docs/DEPLOY.zh-CN.md](docs/DEPLOY.zh-CN.md)，然后是 [docs/LARK_SETUP.zh-CN.md](docs/LARK_SETUP.zh-CN.md) 或 [docs/OIDC_SETUP.zh-CN.md](docs/OIDC_SETUP.zh-CN.md)。请先读 [SECURITY.md](SECURITY.md)：中台会运行同事写的代码，并且持有宿主机的 Docker socket。

## 换成自己公司的

都在 `.env` 里（见 [.env.example](.env.example)）：

| 配置 | 作用 |
|---|---|
| `COMPANY_NAME` | 界面和消息里的「Acme 中台」 |
| `HUB_BRAND_DIR` | 放自己 `logo.svg`、`app-icon.svg`、`motif.svg` 的目录 |
| `HUB_ACCENT` | 品牌色：按钮、高亮和图表里强调的那条数据 |
| `HUB_DESIGN_SKILLS` | 存放公司设计规范的 Skill；Agent 做界面前会先安装 |
| `HUB_MCP_NAME` | Agent 注册中台 MCP 时用的名字 |
| `HUB_TIMEZONE` | 免打扰时段、汇总消息和图表里周 / 月的分界 |

默认主题、字体和图表库来自 [AIsa](https://aisa.one) 设计系统（`web/src/brand/`）。

## 许可证

[Apache-2.0](LICENSE)。内置字体（Inter、JetBrains Mono、Plus Jakarta Sans）使用 SIL Open Font License 1.1，见 `web/src/brand/`。
