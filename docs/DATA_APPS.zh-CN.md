# 数据应用：把 Lark 以外的数据接进中台

> [English](DATA_APPS.md)

中台能直接读的数据只有两种：**Lark 多维表格**，和**中台里的应用提供的行数据**。Metabase、数据库、CRM、广告后台这类数据，由需要它的同事让自己的 Agent 写一个小应用，发布到中台，再登记成数据源。之后它和多维表格一样，能做首页和数据看板的图表、指标卡、指标提醒和异常项。

中台核心不为任何具体系统写代码，接什么、怎么接都在应用里，密钥也存在应用自己的环境变量里。

## 约定

应用提供一个 `GET` 接口（路径随意，例如 `/rows`），返回：

```json
{
  "rows": [
    { "_id": "250652", "_url": "https://metabase.example.com/question/169", "email": "a@b.com", "country": "US",
      "registered_at": "2026-07-20T06:32:29Z", "paid_usd": 2.5, "owner": "cynthia@example.com" }
  ],
  "fields": [{ "name": "owner", "type": "person" }]
}
```

- `rows`：每行一个扁平对象（也可以直接返回数组）。日期用 ISO 字符串或毫秒时间戳，数字用数字。
- `_id`（可选）：这一行的唯一编号，必须稳定。**异常项需要它**，用来记住每一条问题。
- `_url`（可选）：这一行在原系统里的链接，异常项会链接过去。
- `fields`（可选）：字段类型推断不准时声明一下：`text` / `number` / `date` / `person` / `select` / `multi` / `checkbox`。
- 负责人：放一个普通字段，写姓名、英文名或邮箱，中台按同事匹配，用于异常项分配。
- 大小：建议 5 万行以内。中台每个人的读取会缓存 1 分钟。应用自己最好也缓存上游结果几分钟，别每次都去查数据库或 Metabase。

**谁能看到数据 = 谁能打开这个应用。** 中台以查看者的身份去请求（带上 `X-Hub-User-Id` / `X-Hub-User-Email` 等请求头），而且只替能打开这个应用的人请求。应用设成「只有自己」，数据就只有自己能看；也可以按请求头里的人，返回不同的行。

## 登记

在 Agent 里说：

> 用中台把应用 metabase-users 的 /rows 登记成数据源「注册用户（Metabase）」，再在数据页加一个每周新注册的图。

Agent 会先用 `inspect_app_data` 看看字段和样例，再 `save_data_source`（填 `app` 和 `path`）。

## 示例：把一个 Metabase 问题包装成数据应用

1. Metabase 管理员在 **Admin settings → Authentication → API keys** 建一个 API Key，给它分一个只能看到所需数据的分组。
2. 让 Agent 发布一个容器应用，把地址和 Key 存进应用的环境变量（`set_app_env`：`METABASE_URL`、`METABASE_API_KEY`），**不要写进代码**。
3. 应用代码大致如下（Node，无依赖）：

```js
import http from 'node:http';

const { METABASE_URL, METABASE_API_KEY, PORT = 3000 } = process.env;
const QUESTION = 169;          // 要接的 Metabase 问题编号
let cached = { at: 0, rows: [] };

async function rows() {
  if (Date.now() - cached.at < 5 * 60_000) return cached.rows;        // 缓存 5 分钟
  const res = await fetch(`${METABASE_URL}/api/card/${QUESTION}/query/json`, {
    method: 'POST', headers: { 'x-api-key': METABASE_API_KEY },
  });
  if (!res.ok) throw new Error(`Metabase ${res.status}`);
  const data = await res.json();                                      // 每行一个对象，键是列名
  cached = {
    at: Date.now(),
    rows: data.map((r) => ({ _id: String(r.user_id), _url: `${METABASE_URL}/question/${QUESTION}`, ...r })),
  };
  return cached.rows;
}

http.createServer(async (req, res) => {
  if (req.url !== '/rows') return res.writeHead(404).end();
  try {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ rows: await rows() }));
  } catch (e) {
    res.writeHead(502).end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, '0.0.0.0');
```

数据库同理：把查询换成 SQL 查询，连接串放进环境变量。静态应用也可以：如果数据是定时导出的文件，直接发布一个包含 `rows.json` 的静态应用即可。
