# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting ("Report a vulnerability" under the
repository's Security tab) and include steps to reproduce. We aim to reply within a week.

## What to know before you deploy

The hub runs code that your colleagues and their agents write. Its threat model assumes everyone who can sign in is an
employee, not that their code is safe.

**The hub holds the host's Docker socket.** It builds and runs app containers through `/var/run/docker.sock`, which is
equivalent to root on the host. Anyone who takes over the hub process takes over the machine. Run the hub on a server
of its own, keep it updated, and do not put other important services on that host.

**Apps are arbitrary code.** Each container app gets:

- its own Docker network, shared only with the hub, so apps cannot reach each other or bypass the gateway;
- memory, CPU and process limits (`APP_MEMORY_LIMIT`, `APP_CPU_LIMIT`, 512 processes);
- `--cap-drop ALL` and `no-new-privileges`;
- environment variables encrypted at rest with a key derived from `HUB_SECRET`.

Containers still have outbound network access, so an app can call any service on the internet or your internal network
that the host can reach. Restrict egress at the host or network level if that matters to you.

**Give apps a separate domain.** Apps are served at `<slug>.<APPS_DOMAIN>`. If that is a subdomain of your company's
domain (e.g. `apps.example.com`), any app can set cookies for `.example.com` and interfere with your other sites
(cookie tossing). The hub's own cookies use the `__Host-` prefix and are safe, but your other sites may not be. A
separate registrable domain (e.g. `example-apps.net`) avoids this.

**Identity headers.** The gateway strips any incoming `X-Hub-*` headers and sets `X-Hub-User-*` from the signed-in
visitor. Apps can trust these headers only because nothing but the hub can reach them; do not publish an app
container's port elsewhere.

**Lark data is read as the viewer.** Each person connects their own Lark account; their tokens are encrypted at rest.
Apps that use Lark declare which tables they read or write and whom they may message, each person consents to that
list, and changing the list asks again. Shared board snapshots are only served to people who can open the source
table themselves.

**Secrets.** `HUB_SECRET` signs links and encrypts stored secrets; keep it stable (changing it makes stored app
environment variables and Lark tokens unreadable) and keep it out of version control. The dev login (pick any user)
refuses to start when `HUB_URL` is https.
