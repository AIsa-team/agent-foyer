# 部署到服务器

> [English](DEPLOY.md)

下文以中台在 `https://hub.example.com`、应用在 `https://<slug>.example.net` 为例。请先读 [SECURITY.md](../SECURITY.md)。

## 0. 先定应用域名

应用跑的是任意代码。如果应用和公司其它站点在同一个注册域名下（`*.apps.example.com` 和 `www.example.com`），应用可以给整个 `example.com` 写 Cookie。给应用单独用一个域名（`example.net`）可以避免；接受这个风险的话，用主域名的子域名也能工作。填到 `APPS_DOMAIN`。

## 1. 服务器

- 2 核 4G 起步（每个容器应用默认上限 512 MB 内存、1 核 CPU，可以在 `.env` 调整）。
- 较新的 Linux，装好 Docker Engine 28 或更高版本：`curl -fsSL https://get.docker.com | sh`
- 开放 80 和 443 端口。
- 同一台机器上不要跑其它重要服务：中台持有 Docker socket。

## 2. DNS

| 类型 | 名称 | 值 |
|---|---|---|
| A | `hub.example.com` | 服务器 IP |
| A | `example.net` | 服务器 IP |
| A | `*.example.net` | 服务器 IP |

应用域名下已经有自己记录的名字会覆盖通配记录，把它们写进 `RESERVED_SLUGS`，应用就不能占用。

如果开了 Cloudflare 代理（橙色云），免费的 Universal SSL 证书覆盖 `*.example.net`，但不覆盖 `*.apps.example.com` 这样的二级通配；这种情况要关掉代理，或者用高级证书。

## 3. 反向代理和证书

应用需要通配证书，要走 DNS 验证。先在 DNS 服务商那里建一个 API Token（Cloudflare 是应用域名那个 zone 的 `Zone → DNS → Edit`）。

**nginx + certbot**（`deploy/nginx.conf`）：

```bash
apt install nginx certbot python3-certbot-dns-cloudflare
printf 'dns_cloudflare_api_token = <token>\n' > /etc/letsencrypt/cloudflare.ini && chmod 600 /etc/letsencrypt/cloudflare.ini
certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d hub.example.com -d example.net -d '*.example.net' \
  --deploy-hook 'systemctl reload nginx'
cp deploy/nginx.conf /etc/nginx/sites-available/agent-hub   # 改好域名，然后：
ln -s /etc/nginx/sites-available/agent-hub /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

如果 `hub.example.com` 和应用域名不在同一个 zone，就签两张证书，两个 `server` 块各用各的。

**Caddy**（`deploy/Caddyfile`）也可以，但需要带 DNS 插件的版本（`https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com/caddy-dns/cloudflare`），并在环境变量里设置 `CF_API_TOKEN`。

## 4. 中台

```bash
git clone <仓库地址> /srv/agent-hub && cd /srv/agent-hub
cp .env.example .env
# 编辑 .env：
#   HUB_URL=https://hub.example.com
#   APPS_DOMAIN=example.net
#   HUB_SECRET=<openssl rand -base64 48>     定下后不要改，改了已保存的密钥就解不开了
#   LARK_APP_ID / LARK_APP_SECRET            见 docs/LARK_SETUP.zh-CN.md（或 OIDC_*，见 docs/OIDC_SETUP.zh-CN.md）
#   HUB_ADMINS=you@example.com
#   HOST_DATA_DIR=/srv/agent-hub/data
#   COMPANY_NAME、HUB_ACCENT、HUB_BRAND_DIR 等，换成自己公司的
mkdir -p data
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
curl -s localhost:8090/healthz      # {"ok":true}
```

打开 `https://hub.example.com` 登录。第一个登录的人自动成为管理员。

**用自己的 Logo**：把 `logo.svg`、`app-icon.svg`、`motif.svg` 放进 `data/brand/`，设置 `HUB_BRAND_DIR=/data/brand`（容器里的路径）。

## 5. 接入 Agent

在自己电脑上：

```bash
claude mcp add --transport http --scope user agent-hub https://hub.example.com/mcp
# 进入 Claude Code，输入 /mcp，选 agent-hub，在浏览器里登录后点「允许」
```

然后找个小项目，说「把这个项目发布到公司中台」，跑通一遍。

## 运维

- **备份**：整个 `data/` 目录。数据库在线备份：
  `docker exec agent-hub node -e "new (require('node:sqlite').DatabaseSync)('/data/hub.db').exec(\"VACUUM INTO '/data/backup.db'\")"`
- **升级**：`git pull && docker compose --env-file .env -f deploy/docker-compose.yml up -d --build`。已经在跑的应用容器不受影响。先备份 `data/hub.db`，启动时会自动迁移。
- **看日志**：`docker logs -f agent-hub`；单个应用：`docker logs hub-app-<slug>`，或者让 Agent 调 `get_app_status`。
- **旧镜像**：每个应用只保留当前和上一个版本的镜像，更早的自动删除。构建缓存可以定期 `docker builder prune` 清理。
