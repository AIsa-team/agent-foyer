# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting ("Report a vulnerability" under the
repository's Security tab) and include steps to reproduce. We aim to reply within a week.

## What to know before you deploy

The hub runs code that its members and their agents write. Its threat model assumes everyone who can sign in is a
trusted member (of your company, team or community), not that their code is safe.

**The hub holds the host's Docker socket.** It builds and runs app containers through `/var/run/docker.sock`, which is
equivalent to root on the host. Anyone who takes over the hub process takes over the machine. Run the hub on a server
of its own, keep it updated, and do not put other important services on that host.

**Apps are arbitrary code.** Each container app gets:

- its own Docker network (also when the hub runs on the host), shared only with the hub, so apps cannot reach each
  other or bypass the gateway;
- memory, CPU and process limits (`APP_MEMORY_LIMIT`, `APP_CPU_LIMIT`, 512 processes);
- `--cap-drop ALL` and `no-new-privileges`;
- environment variables encrypted at rest with a key derived from `HUB_SECRET`, passed to Docker by name so the values
  never show in the host's process list.

Containers still have outbound network access, so an app can call any service on the internet or your internal network
that the host can reach. Restrict egress at the host or network level if that matters to you.

**Give apps a separate domain.** Apps are served at `<slug>.<APPS_DOMAIN>`. If that is a subdomain of your company's
domain (e.g. `apps.example.com`), any app can set cookies for `.example.com` and interfere with your other sites
(cookie tossing). The hub's own cookies use the `__Host-` prefix and are safe, but your other sites may not be. A
separate registrable domain (e.g. `example-apps.net`) avoids this.

**Between apps and the hub in the browser.** The hub's pages cannot be framed by an app or any other site, so nobody
can be tricked into clicking "Allow" on a hidden consent page. Because all apps share the visitor's cookie scope, the
gateway refuses writes and WebSockets to an app from any other origin (another app included); requests without an
origin, from other servers, pass. Paths the hub fetches from an app (data for pages, agents' actions) are always on
that app's own server: a path naming another host is refused.

**Identity headers.** The gateway strips any incoming `X-Hub-*` headers and sets `X-Hub-User-*` from the signed-in
visitor. Apps can trust these headers only because nothing but the hub can reach them; do not publish an app
container's port elsewhere.

**Other services through the hub.** For each service an admin adds with its own sign-in, every person authorises
their own account there; the hub keeps those tokens encrypted with `HUB_SECRET`, per person, and only ever calls the
service with the caller's own token, so nobody (admins included) can act through someone else's account. What a person can see or change is what
the service allows them. Calls are logged (who, which agent, which tool, whether it worked), not their arguments or
results. Admins can switch off tools they do not want reached this way.

**Shared keys.** A data connection (Metabase…), a shared MCP service and the AI provider each use one key for
everyone. Admins enter them on the admin page only; they are tried before being saved, kept encrypted with
`HUB_SECRET`, never shown again and never handed to agents or apps. Give them the least access that works: a Metabase
key outside the admin group, seeing only what members may read; a provider key with a spending limit.

- **Data connections.** Anyone may register an item or a read-only SQL query as their own data source; only they and
  admins see it until an admin shares it, and changing what it reads makes it private again. The hub accepts one
  `SELECT` (or `WITH … SELECT`) and nothing that writes, locks, exports or changes the session, but Metabase runs it
  with its own database login: make that login read-only, and limit what the key's group may query natively.
- **Shared MCP services** act with the connection's key for every member allowed to use them: switch off the tools
  that change things unless you mean everyone to have them.
- **AI resources.** Apps call the provider through `/__hub/ai` on their own domain, only for signed-in members (a public
  app's visitors get nothing), from the app's own origin or its server's ticket, within daily limits per app and per
  person. Every call is recorded (app, person, path, model, tokens), not its content. Admins can switch AI off per app.

**Agents using apps.** An agent reaches an app only through what the app declares in `hub-agent.json`, and only for
people who may open it. Table operations run in the hub with the person's own Lark access, after the same consent as
the app, writing only the columns listed and checking values against the table. Container actions are forwarded with
the same identity headers as a browser request plus `X-Hub-Agent`; undeclared paths are never forwarded. The owner can
turn agent calls off for an app.

**Lark data is read as the viewer.** Each person connects their own Lark account; their tokens are encrypted at rest.
Apps that use Lark declare which tables they read or write and whom they may message, each person consents to that
list, and changing the list asks again. Shared board snapshots are only served to people who can open the source
table themselves.

**Who can sign in.** With Lark, only members of your Lark tenant within the app's availability can. With OpenID
Connect, anyone your provider lets through can, so set `OIDC_ALLOWED_DOMAINS` (the hub refuses to start with Google
without it) or restrict the client to your organisation at the provider.

**Secrets.** `HUB_SECRET` signs links and encrypts stored secrets; keep it stable (changing it makes stored app
environment variables and Lark tokens unreadable) and keep it out of version control. The dev login (pick any user)
refuses to start when `HUB_URL` is https.
