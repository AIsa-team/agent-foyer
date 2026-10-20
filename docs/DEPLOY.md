# Deploying to a server

> [中文](DEPLOY.zh-CN.md)

The examples put the hub at `https://hub.example.com` and apps at `https://<slug>.example.net`. Read
[SECURITY.md](../SECURITY.md) first.

## 0. Choose the apps domain

Apps run arbitrary code. If they share a registrable domain with your other sites (`*.apps.example.com` next to
`www.example.com`), an app can set cookies for all of `example.com`. A separate domain for apps (`example.net`) avoids
that; a subdomain of your main domain also works if you accept the risk. Set it as `APPS_DOMAIN`.

## 1. Server

- 2 CPU / 4 GB to start (each container app is capped at 512 MB and 1 CPU by default, see `.env`).
- A recent Linux with Docker Engine 28 or later: `curl -fsSL https://get.docker.com | sh`
- Ports 80 and 443 open.
- Nothing else important on the same host: the hub holds the Docker socket.

## 2. DNS

| Type | Name | Value |
|---|---|---|
| A | `hub.example.com` | server IP |
| A | `example.net` | server IP |
| A | `*.example.net` | server IP |

Names under the apps domain that already have their own records shadow the wildcard; list them in `RESERVED_SLUGS`
so no app can claim them.

Behind Cloudflare's proxy (orange cloud), the free Universal SSL certificate covers `*.example.net` but not a
second-level wildcard such as `*.apps.example.com`; for that, turn the proxy off or use an advanced certificate.

## 3. Reverse proxy and certificates

Apps need a wildcard certificate, which takes a DNS challenge. Create an API token for your DNS provider (for
Cloudflare: `Zone → DNS → Edit` on the apps zone).

**nginx + certbot** (`deploy/nginx.conf`):

```bash
apt install nginx certbot python3-certbot-dns-cloudflare
printf 'dns_cloudflare_api_token = <token>\n' > /etc/letsencrypt/cloudflare.ini && chmod 600 /etc/letsencrypt/cloudflare.ini
certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d hub.example.com -d example.net -d '*.example.net' \
  --deploy-hook 'systemctl reload nginx'
cp deploy/nginx.conf /etc/nginx/sites-available/agent-hub   # edit the names, then:
ln -s /etc/nginx/sites-available/agent-hub /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

If `hub.example.com` and the apps domain are in different zones, issue two certificates and point each `server`
block at its own.

**Caddy** (`deploy/Caddyfile`) works too, but needs a build with a DNS module
(`https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com/caddy-dns/cloudflare`) and `CF_API_TOKEN` in
its environment.

## 4. The hub

```bash
git clone <repository> /srv/agent-hub && cd /srv/agent-hub
cp .env.example .env
# edit .env:
#   HUB_URL=https://hub.example.com
#   APPS_DOMAIN=example.net
#   HUB_SECRET=<openssl rand -base64 48>     never change it later: stored secrets would become unreadable
#   LARK_APP_ID / LARK_APP_SECRET            see docs/LARK_SETUP.md
#   HUB_ADMINS=you@example.com
#   HOST_DATA_DIR=/srv/agent-hub/data
#   COMPANY_NAME, HUB_ACCENT, HUB_BRAND_DIR … to make it yours
mkdir -p data
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
curl -s localhost:8090/healthz      # {"ok":true}
```

Open `https://hub.example.com` and sign in with Lark. The first person to sign in becomes an admin.

**Your own logo**: put `logo.svg`, `app-icon.svg` and `motif.svg` in `data/brand/` and set `HUB_BRAND_DIR=/data/brand`
(the path inside the container).

## 5. Connect an agent

On your own machine:

```bash
claude mcp add --transport http --scope user agent-hub https://hub.example.com/mcp
# in Claude Code run /mcp, pick agent-hub, sign in with Lark in the browser and allow
```

Then take a small project and say "publish this project to the company hub".

## Operations

- **Backups**: the whole `data/` folder. An online copy of the database:
  `docker exec agent-hub node -e "new (require('node:sqlite').DatabaseSync)('/data/hub.db').exec(\"VACUUM INTO '/data/backup.db'\")"`
- **Upgrades**: `git pull && docker compose --env-file .env -f deploy/docker-compose.yml up -d --build`. Running app
  containers are not affected. Back up `data/hub.db` first; migrations run on start.
- **Logs**: `docker logs -f agent-hub`; one app: `docker logs hub-app-<slug>`, or ask the agent to call
  `get_app_status`.
- **Old images**: each app keeps its current and previous image; older ones are removed. Prune the build cache now
  and then with `docker builder prune`.
