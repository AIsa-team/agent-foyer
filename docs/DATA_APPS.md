# Data apps: bringing non-Lark data into the hub

> [中文](DATA_APPS.zh-CN.md)

The hub reads two kinds of data directly: **Lark Base tables**, and **rows served by an app on the hub**. Metabase, a
database, a CRM or an ad platform comes in through a small app that whoever needs the data asks their agent to write,
publish to the hub and register as a data source. From then on it works like a Base table: charts and stat tiles on
home pages and boards, metric alerts and data checks.

The hub core has no code for any particular system. What to connect and how lives in the app, and so do the
credentials (in the app's own environment variables).

## The contract

The app serves a `GET` endpoint (any path, e.g. `/rows`) that returns:

```json
{
  "rows": [
    { "_id": "250652", "_url": "https://metabase.example.com/question/169", "email": "a@b.com", "country": "US",
      "registered_at": "2026-07-20T06:32:29Z", "paid_usd": 2.5, "owner": "cynthia@example.com" }
  ],
  "fields": [{ "name": "owner", "type": "person" }]
}
```

- `rows`: one flat object per row (a bare array works too). Dates as ISO strings or millisecond timestamps, numbers
  as numbers.
- `_id` (optional): a stable unique id for the row. **Data checks need it** to remember each issue.
- `_url` (optional): a link to the row in the source system; data checks link to it.
- `fields` (optional): declare a type where inference gets it wrong: `text` / `number` / `date` / `person` / `select`
  / `multi` / `checkbox`.
- Owners: a plain field with a name, English name or email; the hub matches it to colleagues to assign data-check
  issues.
- Size: up to 50,000 rows and 25 MB; the request times out after 30 s. The hub caches each person's read for a
  minute. The app should cache the upstream result for a few minutes too, rather than hit the database or Metabase on
  every request.

**Who sees the data = who can open the app.** The hub makes the request as the viewer (with the `X-Hub-User-Id` /
`X-Hub-User-Email` headers and so on) and only for people who can open the app. Set the app to "only me" and only you
see the data; or return different rows depending on the person in the headers.

## Registering it

Tell your agent:

> Register the /rows endpoint of the app metabase-users as a data source "Sign-ups (Metabase)" in the hub, then add a
> chart of weekly sign-ups to the data board.

The agent looks at the fields and a sample with `inspect_app_data`, then calls `save_data_source` with `app` and
`path`.

## Example: wrapping a Metabase question

1. A Metabase admin creates an API key under **Admin settings → Authentication → API keys** and puts it in a group
   that can only see the data needed.
2. Ask the agent to publish a container app and store the address and key as the app's environment variables
   (`set_app_env`: `METABASE_URL`, `METABASE_API_KEY`), **not in the code**.
3. The app is roughly (Node, no dependencies):

```js
import http from 'node:http';

const { METABASE_URL, METABASE_API_KEY, PORT = 3000 } = process.env;
const QUESTION = 169;          // the Metabase question to serve
let cached = { at: 0, rows: [] };

async function rows() {
  if (Date.now() - cached.at < 5 * 60_000) return cached.rows;        // cache for 5 minutes
  const res = await fetch(`${METABASE_URL}/api/card/${QUESTION}/query/json`, {
    method: 'POST', headers: { 'x-api-key': METABASE_API_KEY },
  });
  if (!res.ok) throw new Error(`Metabase ${res.status}`);
  const data = await res.json();                                      // one object per row, keyed by column name
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

A database works the same way: swap the fetch for an SQL query and keep the connection string in an environment
variable. Static apps work too: if the data is a file exported on a schedule, publish a static app containing
`rows.json`.
