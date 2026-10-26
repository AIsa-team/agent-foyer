# Contributing

Thanks for helping. Issues and pull requests are welcome; for anything larger than a fix, open an issue first so we
can agree on the approach.

## Setup

```bash
pnpm install
pnpm build
pnpm dev        # http://localhost:8080 with the dev login
pnpm test       # typecheck + data features end to end; run before every pull request
```

`pnpm smoke http://localhost:8080 --docker` also covers container apps if Docker is available.

## Principles

- **Agents are the main users.** Every feature should be reachable through an MCP tool in `server/mcp.ts` (or a
  channel's `tools.ts`), with an input schema that explains itself; the web UI is for looking and deciding, and where
  people would change something it gives them the sentence to send their agent.
- **Act as the person.** Read and write other systems with the person's own account, and never widen what someone can
  see. Shared keys (a data connection, a shared MCP service, the AI provider) are entered by admins, kept encrypted,
  never shown again and never handed to agents or apps; admins decide who may use what they read.
- **The core stays generic.** Platforms come in as channels, other systems as connectors, MCP services or the AI
  provider (below); the core knows them only through those interfaces. The hub must work with no platform at all
  (`pnpm smoke:oidc`).
- **Never hard-code a language.** Every string people see goes through the catalogues
  (`server/i18n/locales/*.ts`, `web/src/i18n/locales/*.ts`). Content people publish (app and Skill listings, home
  modules, boards) is stored per language.
- Match the surrounding code: small modules, comments that say why, no new dependencies without a good reason.

## Where things plug in

- **A platform** (the place people already work: Lark today) is a channel, listed in `server/channels.ts`. It can bring
  - a directory: `DirectoryProvider.read()` returns people, departments and members; the core writes them and
    schedules the sync (`server/directory.ts`);
  - kinds of data source read as each viewer: a `SourceKind` (`server/data/kinds.ts`) recognises a link, checks it,
    reads fields and rows as the viewer, and can keep shared copies fresh (Lark Base: `server/lark/baseSource.ts`);
  - its own agent tools and API routes, registered only when it is on (Lark: `server/lark/tools.ts`, `routes.ts`).
  Sign-in providers live in `server/auth/`, message senders behind `server/notify.ts`.
- **A system read with one shared key** (Metabase today) is a connector in `server/data/connectors/`: test the key,
  browse items, fetch rows; optionally dashboards to import, read-only SQL, and its own MCP server.
- **Another tool's MCP server** needs no code: admins add it on the admin page (each person's own OAuth, or a data
  connection's key for everyone) and agents reach it with `list_connected_tools` / `call_connected_tool`.
- **An AI provider** is a preset in `server/ai.ts` (an OpenAI-compatible address, optionally data APIs); apps reach it
  through `/__hub/ai` on their own domain.
- **Anything else** can come in as an app that serves rows to the hub ([docs/DATA_APPS.md](docs/DATA_APPS.md)).

## Adding a language

1. Copy `web/src/i18n/locales/en.ts` and `server/i18n/locales/en.ts` to `<code>.ts` (a BCP 47 tag, e.g. `ja`) and
   translate. Keys you leave out fall back to English.
2. List the new file in `LOCALES` in `web/src/i18n/locales/index.ts` and `server/i18n/index.ts`.
3. Run `pnpm test`.

## Database changes

Add a migration at the end of the list in `server/db.ts`; never edit one that has shipped.

## License

By contributing you agree that your contributions are licensed under the [Apache-2.0](LICENSE) license.
