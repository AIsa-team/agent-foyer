# Agent Foyer

[中文说明](README.zh-CN.md)

**A place where agents work.** Your agents (Claude Code, Codex, Cursor, a hosted agent, …) connect over MCP and get
the five things they need to do real work for the people they work with: **identity, context, a place to ship,
resources and guardrails.** People decide; agents do the rest.

It is for anyone who works together and has agents: a company, a team, a community, an open-source project.

## What that looks like

> "Make a small tool for screening creators. Keep the list in our Lark table and look up their follower counts."

A few minutes later the agent has published it at `creators.<your apps domain>`, with sign-in and only the people
you chose let in. It looks the numbers up through the hub's AI resources, with no API key in the app. Colleagues'
agents can add creators to it (`call_app`), your home page shows this week's new ones, and the person a messy record
belongs to is told to fix it. Nobody filled in a form or clicked through an admin page: each step was a sentence to
an agent, and the web pages are where people look and decide.

## The five things

### Identity: every agent acts as its person
- People sign in with Lark or any OpenID Connect provider (Google Workspace, Microsoft Entra ID, Okta…). Agents
  connect with standard MCP OAuth 2.1, or a personal token when they cannot do OAuth.
- Whatever an agent reads or changes (Lark, Linear, GitHub, the calendar), it does with that person's own account and
  access; apps save mail drafts in the person's own mailbox. An agent never sees more than its person could.
- People see each of their agents with the device it was added from and a name they give it, and disconnect any of them.

### Context: what the agent needs to know
- **Data**: Lark Base tables, Metabase questions or read-only SQL, rows served by apps, and (when admins turn it on)
  sources combined from two others; agents count, chart and read rows (`query_data`, `read_data_rows`).
- **Documents**: search, read, edit and create Lark documents and wiki pages.
- **Goals and time**: OKRs, the person's calendar, Linear projects and issues, GitHub activity.
- **Know-how as Skills**: a Skill market with versions and update notices; agents that cannot install Skills read and
  follow them (`read_skill`), so a scheduled task always uses the latest version.
- **People**: the directory, departments and their pages, app requests from colleagues.

### A place to ship: what agents build, people and agents use
- **Apps**: "publish this" deploys a static site or a container to its own subdomain, behind sign-in, visible to
  only you, chosen people, everyone signed in, or the public (an admin approves). Apps keep their records in Lark
  tables the people using them can see and edit.
- **Apps for agents too**: an app says in `hub-agent.json` what other agents may do in it (find, add and change
  records, call its own actions); they find it with `list_apps` and act as their person with `call_app`.
- **Pages**: agents build home pages (personal, per department, for everyone) and data boards (your own, shared,
  per department) from charts, numbers, tables, OKRs, the calendar and more.
- **Watching data**: metric alerts and data checks that hand each problem row to the person who owns it.
- **Working together**: collaborators on apps and Skills, feedback to their authors, and a pool of app requests.

### Resources: models, data APIs and tools
- **AI for apps**: apps call models (`/__hub/ai/v1/…`, OpenAI-compatible, streaming included) and data APIs
  (`/__hub/ai/apis/v1/…`) through the hub on your own key. With [AIsa](https://aisa.one), one key covers 100+ models
  and thousands of data APIs (web search, scraping, social, finance, SEO…); any OpenAI-compatible provider works for
  models.
- **Other tools' MCP servers** (Linear, Metabase, …): each person connects their own account, or a shared key is
  used for everyone, and agents reach them through the hub (`list_connected_tools`, `call_connected_tool`).
- **Data connections** (Metabase today): read with one key, shared only as admins decide.

### Guardrails: why it is safe to let agents act
- Access is checked as the person on every read, and every app request is re-checked, so revoking access takes effect at once.
- An app asks each person once before it acts in Lark as them; agents are told to confirm before tools that change things.
- Keys are entered on the admin page only, kept encrypted and never shown again, never handed to agents or apps.
- AI calls have daily limits per app and per person, are recorded with their tokens, and need a signed-in person:
  a public app cannot spend your credit for strangers. SQL from agents can only read.
- Apps run in their own containers with memory, CPU and process limits and no capabilities. Admins can switch
  tools, apps' AI use and whole services off.

## Works with what you already use

Platforms come in as **channels** (`server/channels.ts`). Lark is the first: sign-in, directory, Base tables, OKRs,
documents, calendar and bot messages. Without it, sign in with OpenID Connect and you keep the core: apps, Skills,
agents, pages, data apps and connections, checks, alerts and AI resources
([docs/OIDC_SETUP.md](docs/OIDC_SETUP.md)). A new platform is a new channel: its directory and its kinds of data
source behind two small interfaces (see [CONTRIBUTING.md](CONTRIBUTING.md)).

Everything people see exists in every language the hub ships (English and Chinese today; a new one is a catalogue file).

## How it works

```
                  ┌─────────────────────────── hub (one Node process) ──────────────────────────┐
 hub.example.com ►│ web UI (React)   /api   /auth (Lark / OIDC)  /oauth + /mcp (agents)          │
                  │                                                                              │
 *.example.net  ─►│ gateway: checks identity and app access ─► static files or app container     │
                  │          /__hub/… on each app: who is signed in, Lark as them, AI resources  │
                  └───────────────────────────────────┬──────────────────────────────────────────┘
                                                      │ docker.sock
                         hub-app-<slug> containers, each on a private network only the hub can reach
```

- **One process, routed by Host.** The hub's own domain goes to the Hono app; app subdomains go to the gateway. The
  reverse proxy only terminates TLS, so adding an app never touches its config.
- **Storage**: SQLite (`data/hub.db`) plus app files, Skill packages and icons under `data/`.
- **App sign-in**: the gateway sends visitors to the hub, which checks who they are and hands a one-time code back to
  the app's subdomain, exchanged for a cookie scoped to that subdomain only. Apps read the person from the
  `X-Hub-User-*` headers, or `fetch('/__hub/me')` in the browser; an app's server calls the hub with the
  `X-Hub-Ticket` of the person's request.
- **Two kinds of app**: `static` (built files, SPA routing supported) and `container` (its own Dockerfile, or one
  generated for Node and Python projects), with a persistent `/data` and encrypted environment variables.
- **Agents** get the hub's tools and instructions over MCP and are told when the hub changed since they connected.

## Quick start (local)

Needs Node ≥ 22.18 (TypeScript runs directly, no compile step) and pnpm.

```bash
pnpm install
pnpm build          # build the web UI
pnpm dev            # http://localhost:8080 — without sign-in settings you get a dev login with three test users
pnpm dev:web        # optional: Vite hot reload on http://localhost:5173, API proxied to 8080
```

Connect an agent:

```bash
claude mcp add --transport http agent-foyer http://localhost:8080/mcp
```

Give apps models and data APIs: on the admin page, under **AI resources**, pick AIsa and paste a key from
[console.aisa.one](https://console.aisa.one/api-keys) (or any OpenAI-compatible provider's address and key).

Apps run at `http://<slug>.apps.localhost:8080` (Chrome and curl resolve `*.localhost`). Container apps need Docker.

## Tests

```bash
pnpm test           # typecheck + end-to-end tests against a fake Lark, Metabase, Linear, AIsa and OIDC provider
pnpm smoke          # core end-to-end test against a running hub: pnpm smoke http://localhost:8080 [--docker]
```

## Deploying

See [docs/DEPLOY.md](docs/DEPLOY.md), then [docs/LARK_SETUP.md](docs/LARK_SETUP.md) or
[docs/OIDC_SETUP.md](docs/OIDC_SETUP.md). Read [SECURITY.md](SECURITY.md) first: the hub runs code people's agents
write and holds the host's Docker socket.

## Making it yours

All in `.env` (see [.env.example](.env.example)); the AI provider and data connections are set on the admin page.

| Setting | What it changes |
|---|---|
| `COMPANY_NAME` | the name in the UI and in messages |
| `HUB_BRAND_DIR` | a folder with your `logo.svg`, `app-icon.svg` and `motif.svg` |
| `HUB_ACCENT` | the colour of buttons, highlights and the emphasised chart series |
| `HUB_DESIGN_SKILLS` | Skills holding your design system; agents install them before building UI |
| `HUB_MCP_NAME` | the name agents register the MCP server under |
| `HUB_TIMEZONE` | dates, quiet hours, digests and week/month boundaries in charts |
| `DEFAULT_LOCALE` | the language for people who have not picked one |

The default theme (tokens, components, charts and fonts in `web/src/brand/`) comes from the
[AIsa](https://aisa.one) design system: a complete design system out of the box, which agents follow when they build
pages and apps. Recolour it with `HUB_ACCENT` and put your own marks in `HUB_BRAND_DIR`.

## Layout

```
server/
  index.ts            entry: HTTP server, routing by Host, uploads, downloads, background jobs
  config.ts, db.ts    configuration, SQLite schema and migrations
  channels.ts         the platforms a hub works with (Lark: lark/channel.ts)
  auth/               sign-in (Lark, OIDC, dev), people, sessions, the OAuth server for agents
  apps/               publishing, access, Docker runtime, hub-agent.json, apps calling Lark
  skills/             Skill publishing, installs, update checks, reading a Skill
  data/               data sources and their kinds, connectors (Metabase), queries, alerts, checks, boards import
  ai.ts               AI resources: the provider, the /__hub/ai proxy, limits and usage
  services/           other tools' MCP servers reached through the hub
  lark/, linear/, github/, google/   each platform's own code
  mcp.ts              the MCP tools and the instructions agents get
  gateway.ts          the app subdomain gateway
  api.ts              REST API for the web UI
  i18n/               server-side message catalogues
web/src/              React UI; i18n/locales/ holds the UI catalogues
scripts/              admin CLI and end-to-end tests
skills/               Skills that go with the hub (e.g. daily-report), to publish to its Skill market
deploy/               docker-compose.yml, nginx.conf, Caddyfile
docs/                 deployment, Lark or OIDC setup, data apps, GitHub, Gmail
```

## License

[Apache-2.0](LICENSE). Bundled fonts (Inter, JetBrains Mono, Plus Jakarta Sans) are under the SIL Open Font License
1.1, see `web/src/brand/`.
