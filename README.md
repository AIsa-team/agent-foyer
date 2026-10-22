# Agent Hub

> Placeholder name. [中文说明](README.zh-CN.md)

An agent-native company hub on [Lark](https://www.larksuite.com) (Feishu works too), or on any OpenID Connect sign-in
(Google Workspace, Microsoft Entra ID, Okta…). People sign in, and their
coding agents (Claude Code, Codex, Cursor, …) connect over MCP and do the work: publish the tools they vibe-coded,
share Skills, build charts over company data, set alerts. The hub replaces the Lark workplace as everyone's entry
point.

- **App square**: "publish this project to the company server" deploys a static site or a container to
  `https://<name>.<apps domain>`, behind Lark sign-in. Four visibility levels: only me / chosen colleagues / the
  company / everyone (public needs an admin's approval).
- **Skill market**: share and install Skills with versions; people who installed one are told when it updates.
- **App requests**: ask a colleague to build an app, or leave it in a pool (posted to a Lark group) for whoever has time;
  others add "I need this too". The builder's agent picks it up (`get_app_request`) and publishing with `request_id`
  marks it live and makes the requester a collaborator.
- **Working together**: an app or Skill can have collaborators who publish and change it with the owner; only the
  owner (or an admin) deletes it, picks the collaborators or hands it over.
- **Feedback to authors**: colleagues tell an app's or Skill's owner what is wrong, from the hub page, a button inside
  every app (owners can turn it off) or their own agent; the owner's agent works through it and the sender is told.
- **Personal home pages**: everyone's agent can rebuild their home page from modules (charts, OKRs, alerts, links).
- **Data**: Lark Base tables, and rows served by apps (so Metabase, a database or a CRM come in through a small app,
  see [docs/DATA_APPS.md](docs/DATA_APPS.md)). Shared boards, metric alerts sent by the Lark bot, and data checks that
  assign problem rows to their owners.
- **OKRs**: the person's own and the company's, read from Lark OKR.
- **Other services through the hub**: admins add other tools' MCP servers (e.g. Linear); each person connects their own
  account once, and their agents use those tools through the hub (`list_connected_tools` / `call_connected_tool`).
- **Projects**: the company's Linear projects (progress, health, milestones, latest updates, issues), read with each
  person's own Linear account so they see what they can see there.
- **Resources and org**: policy and SOP links grouped by topic, the Lark directory, and a ⌘K search over all of it.
- **Apps on top of Lark**: an app declares which Base tables it reads or writes and whom it may message; each person
  consents once, then the app calls Lark as them through a small SDK.
- **Agents use apps**: an app lists in `hub-agent.json` what a person's agent may do in it: find, add (with required and
  unique columns) and change records in its Lark tables, which the hub runs and checks itself, and, for container apps,
  calls to its own server. Agents find them with `list_apps` and act as the person with `call_app`.

**With Lark or without.** Signing in with Lark gives the whole hub. With OpenID Connect you get the core: apps, Skills,
agents, home pages, resources, and boards, checks and alerts on data apps; Base tables, OKRs, the directory sync, Lark
messages and apps acting in Lark are switched off ([docs/OIDC_SETUP.md](docs/OIDC_SETUP.md)).

Everything people see exists in every language the hub ships (English and Chinese today; adding one is a catalogue
file, see [CONTRIBUTING.md](CONTRIBUTING.md)).

## How it works

```
                  ┌─────────────────────────── hub (one Node process) ──────────────────────────┐
 hub.example.com ►│ web UI (React)   /api   /auth (Lark / OIDC)  /oauth + /mcp (agents)          │
                  │                                                                              │
 *.example.net  ─►│ gateway: checks Lark identity and app access ─► static files or app container │
                  └───────────────────────────────────┬──────────────────────────────────────────┘
                                                      │ docker.sock
                         hub-app-<slug> containers, each on a private network only the hub can reach
```

- **One process, routed by Host.** The hub's own domain goes to the Hono app; app subdomains go to the gateway. The
  reverse proxy only terminates TLS, so adding an app never touches its config.
- **Storage**: SQLite (`data/hub.db`) plus app files, Skill packages and icons under `data/`.
- **App sign-in**: the gateway sends visitors to the hub, which checks who they are and their access and hands a one-time
  code back to the app's subdomain, exchanged for a cookie scoped to that subdomain only. Access is re-checked on every
  request, so revoking it takes effect at once. Apps read the visitor from the `X-Hub-User-Id`, `X-Hub-User-Name`
  (URI-encoded) and `X-Hub-User-Email` headers; front-end-only apps can `fetch('/__hub/me')`.
- **Two kinds of app**: `static` (built files, SPA routing supported) and `container` (its own Dockerfile, or one
  generated for Node and Python projects). Containers get memory, CPU and process limits, no capabilities, a
  persistent `/data` and encrypted environment variables.
- **Agents** connect with standard MCP OAuth 2.1 (discovery, dynamic client registration, PKCE, refresh tokens).
  Agents without OAuth support can use a personal token from the "Me" page.
- **Lark data is read as the viewer.** Each person connects their own Lark once; nobody sees a table in the hub that
  they couldn't open in Lark.
- **Pluggable edges**: sign-in is Lark, OIDC or a local dev login (`server/auth/`); messages go through one interface
  (`server/notify.ts`); everything Lark-specific lives in `server/lark/` and `server/apps/larkApi.ts`.

## Quick start (local)

Needs Node ≥ 22.18 (TypeScript runs directly, no compile step) and pnpm.

```bash
pnpm install
pnpm build          # build the web UI
pnpm dev            # http://localhost:8080 — without LARK_APP_ID you get a dev login with three test users
pnpm dev:web        # optional: Vite hot reload on http://localhost:5173, API proxied to 8080
```

Apps run at `http://<slug>.apps.localhost:8080` (Chrome and curl resolve `*.localhost`). Container apps need Docker;
locally they are reached through a random `127.0.0.1` port.

Connect an agent:

```bash
claude mcp add --transport http agent-hub http://localhost:8080/mcp
```

## Tests

```bash
pnpm test           # typecheck + end-to-end tests against a fake Lark and a fake OIDC provider (they start their own hub)
pnpm smoke          # core end-to-end test against a running hub: pnpm smoke -- http://localhost:8080 [--docker]
```

## Deploying

See [docs/DEPLOY.md](docs/DEPLOY.md), then [docs/LARK_SETUP.md](docs/LARK_SETUP.md) or
[docs/OIDC_SETUP.md](docs/OIDC_SETUP.md). Read [SECURITY.md](SECURITY.md)
first: the hub runs code your colleagues write and holds the host's Docker socket.

## Making it yours

All in `.env` (see [.env.example](.env.example)):

| Setting | What it changes |
|---|---|
| `COMPANY_NAME` | "Acme Hub" in the UI and in messages |
| `HUB_BRAND_DIR` | a folder with your `logo.svg`, `app-icon.svg` and `motif.svg` |
| `HUB_ACCENT` | brand colour for buttons, highlights and the emphasised chart series |
| `HUB_DESIGN_SKILLS` | Skills holding your design system; agents install them before building UI |
| `HUB_MCP_NAME` | the name agents register the MCP server under |
| `HUB_TIMEZONE` | quiet hours, digests and week/month boundaries in charts |

The default theme, fonts and chart library come from the [AIsa](https://aisa.one) design system
(`web/src/brand/`).

## Layout

```
server/
  index.ts            entry: HTTP server, routing by Host, uploads, downloads, icons, brand files
  config.ts, db.ts    configuration, SQLite schema and migrations
  auth/               sign-in (OIDC, dev), people, sessions, the OAuth server for agents
  apps/               publishing, access, Docker runtime, apps calling Lark
  skills/             Skill publishing, installs, update checks
  data/               data sources, queries, alerts, data checks
  lark/               everything Lark: sign-in, directory, Base, OKR, bot messages
  notify.ts           how the hub messages people (Lark today)
  mcp.ts              the MCP tools and the instructions agents get
  gateway.ts          the app subdomain gateway
  api.ts              REST API for the web UI
  i18n/               server-side message catalogues
web/src/              React UI; i18n/locales/ holds the UI catalogues
scripts/              admin CLI and end-to-end tests
skills/               Skills that go with the hub (e.g. daily-report), to publish to its Skill market
deploy/               docker-compose.yml, nginx.conf, Caddyfile
docs/                 deployment, Lark or OIDC setup, data apps
```

## License

[Apache-2.0](LICENSE). Bundled fonts (Inter, JetBrains Mono, Plus Jakarta Sans) are under the SIL Open Font License
1.1, see `web/src/brand/`.
