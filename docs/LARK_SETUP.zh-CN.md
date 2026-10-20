# Lark 后台配置

> [English](LARK_SETUP.md)

需要一个 Lark **企业自建应用**，用来登录中台、读取通讯录。整个过程大约 15 分钟，需要 Lark 企业管理员权限（最后一步要审核上线）。

下面的菜单名以英文界面为准，括号里是中文界面的叫法。Lark 后台改版时名字可能有出入，按意思找就行。

## 1. 创建应用

1. 打开 <https://open.larksuite.com/app>，点 **Create Custom App（创建企业自建应用）**。
2. 名称填中台的名字（比如「Acme 中台」），描述填「公司应用与 Skill 中台」，上传一个图标（可以用 `web/public/brand/app-icon.svg` 或自己的）。
3. 进入应用后，在 **Credentials & Basic Info（凭证与基础信息）** 里复制 **App ID** 和 **App Secret**，填进服务器的 `.env`：

   ```
   LARK_APP_ID=cli_xxxxxxxx
   LARK_APP_SECRET=xxxxxxxx
   LARK_DOMAIN=larksuite.com
   ```

## 2. 开启网页应用

**Features（应用能力）→ Web App（网页应用）**，开启后填：

| 项 | 值 |
|---|---|
| Desktop homepage（桌面端主页） | `https://hub.example.com` |
| Mobile homepage（移动端主页） | `https://hub.example.com` |

## 3. 安全设置

**Security Settings（安全设置）**：

- **Redirect URLs（重定向 URL）**：添加 `https://hub.example.com/auth/callback`
- **H5 Trusted Domains（H5 可信域名）**：添加 `https://hub.example.com`

## 4. 权限

**Permissions & Scopes（权限管理）** 里开通下面这些。搜索权限的代码名最快：

| 权限 | 用途 |
|---|---|
| `contact:user.base:readonly`（获取用户基本信息） | 登录后拿到姓名、头像 |
| `contact:user.email:readonly`（获取用户邮箱信息） | 拿到邮箱，用于管理员配置和按邮箱指定同事 |
| `contact:contact.base:readonly`（获取通讯录基本信息） | 管理页「同步 Lark 通讯录」：遍历部门和成员。没有它会报 99991672 |

开通时 Lark 会问这个权限能访问的数据范围，选**与应用的可用范围一致**即可：可用范围外的人本来就登录不了中台。同步通讯录时，中台只读取这个范围内的部门和成员，这样还没登录过的同事也能被选进「指定同事」名单。

### Lark 数据（多维表格、OKR、指标提醒）

首页图表、OKR、指标提醒和 Agent 读 Lark 数据时，用的是**每个人自己的 Lark 权限**：大家在中台「我的」页面点一次「连接 Lark 数据」，在 Lark 里同意即可，你在 Lark 里打不开的表，在中台也看不到。这一步和登录分开，所以下面的权限还没审核通过时，登录照常可用。

再开通这些（都是**用户身份**的权限，即 user_access_token）：

| 权限 | 用途 |
|---|---|
| `offline_access` | 让中台拿到刷新令牌，不用每两小时重新授权 |
| `bitable:app:readonly`（查看、评论和导出多维表格） | 读多维表格的表、字段和记录 |
| `wiki:wiki:readonly`（查看知识库） | 多维表格放在知识库里时，把知识库链接换成表格 |
| `bitable:app`（查看、评论、编辑和管理多维表格）**可选** | 只有同事做的应用要**写**多维表格时才需要（例如开票助手写一条申请）。只在用到写入的应用里、由使用者本人在授权页同意时才会请求 |
| `okr:okr:readonly`（获取 OKR 信息） | 首页「我的 OKR」和 Agent 读 OKR：读的是当前这个人在 Lark OKR 里能看到的 |

指标提醒要由中台机器人在 Lark 里发消息：

1. **Features（应用功能）→ Bot（机器人）**，开启机器人。
2. 再开通 `im:message:send_as_bot`（以应用的身份发消息，**应用身份**的权限）。
3. 想让提醒发到群里：把中台的机器人拉进那个群，把群 ID（`oc_` 开头）告诉 Agent 即可。

提醒消息有这些限制，避免打扰：同一条规则 6 小时内最多一条（数值来回波动会合并），晚上 10 点到早上 9 点不发、攒到早上合成一条，同一个人多条提醒合成一条，谁都能在首页点「不再提醒我」。**默认只发给中台管理员**，其他收件人只在首页看到；管理员可以在「管理」页改成发给所有收件人。时间窗口可用环境变量 `ALERT_COOLDOWN_MINUTES`、`ALERT_QUIET_HOURS`（如 `22-9`）调整。

回调地址不用新加：连接 Lark 数据和登录用的是同一个 `https://hub.example.com/auth/callback`。

## 5. 发布

1. **App Versions（版本管理与发布）→ Create Version（创建版本）**。
2. **Availability（可用范围）** 选全公司。
3. 提交后，Lark 管理员在 **Lark Admin（管理后台）→ Workplace（工作台）→ App Review（应用审核）** 里通过。

## 6. 把中台放进工作台

- 最简单的做法：在 **Lark Admin → Workplace → Workplace Settings（工作台设置）** 里，把中台应用加到所有人的常用应用，并置顶。
- 参考方案里是用中台直接替换 Lark 工作台：如果你们的 Lark 套餐支持自定义工作台（Customized Workplace / 定制工作台），在里面选「使用网页作为工作台」并填 `https://hub.example.com`。不同套餐的入口不一样，找不到的话问 Lark 客户成功经理。

## 7. 收尾

1. 在 `.env` 的 `HUB_ADMINS` 里写上管理员的 Lark 邮箱，重启中台。
2. 管理员第一次登录后，到「管理 → 同步 Lark 通讯录」点一次（之后每 6 小时自动同步）。
3. 在「管理 → Lark 应用入口」里把审批、Base、假勤这些常用 Lark 应用加进来，链接可以从 Lark 管理后台复制 AppLink。
