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

`pnpm smoke -- http://localhost:8080 --docker` also covers container apps if Docker is available.

## Principles

- **The core stays generic.** The hub talks to Lark and Docker, nothing else. Integrations with other systems
  (Metabase, a database, a CRM) belong in apps that serve rows to the hub ([docs/DATA_APPS.md](docs/DATA_APPS.md)),
  not in `server/`.
- **Agents are the main users.** Every feature should be reachable through an MCP tool in `server/mcp.ts`, with an
  input schema that explains itself; the web UI is for looking and approving.
- **Never hard-code a language.** Every string people see goes through the catalogues
  (`server/i18n/locales/*.ts`, `web/src/i18n/locales/*.ts`). Content people publish (app and Skill listings, home
  modules, boards) is stored per language.
- **Permissions follow Lark.** Read Lark data with the viewer's own token; never widen what someone can see.
- Match the surrounding code: small modules, comments that say why, no new dependencies without a good reason.

## Adding a language

1. Copy `web/src/i18n/locales/en.ts` and `server/i18n/locales/en.ts` to `<code>.ts` (a BCP 47 tag, e.g. `ja`) and
   translate. Keys you leave out fall back to English.
2. List the new file in `LOCALES` in `web/src/i18n/locales/index.ts` and `server/i18n/index.ts`.
3. Run `pnpm test`.

## Database changes

Add a migration at the end of the list in `server/db.ts`; never edit one that has shipped.

## License

By contributing you agree that your contributions are licensed under the [Apache-2.0](LICENSE) license.
