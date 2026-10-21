import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { appUrl, config, paths } from './config.ts';
import { verifyToken } from './crypto.ts';
import { api } from './api.ts';
import { authRoutes } from './auth/routes.ts';
import { githubHook } from './github/hook.ts';
import { authenticateBearer, MCP_PATH, oauth, wwwAuthenticate } from './auth/oauth.ts';
import { seedDevUsers } from './auth/users.ts';
import { handleMcp } from './mcp.ts';
import { cleanupUploads, receiveUpload } from './uploads.ts';
import { skillFile } from './skills/service.ts';
import { sourceFile } from './apps/source.ts';
import { reconcileInterruptedBuilds } from './apps/service.ts';
import { requestLocale, tr } from './i18n/index.ts';
import { handleAppRequest, handleAppUpgrade, slugFromHost } from './gateway.ts';
import { startAlertScheduler } from './data/alerts.ts';
import { startCheckScheduler } from './data/checks.ts';
import { syncDirectory } from './lark/auth.ts';
import { startSnapshotRefresher } from './data/sources.ts';
import { run, now } from './db.ts';
import { pruneReads } from './cache.ts';

seedDevUsers();
reconcileInterruptedBuilds();

const app = new Hono();

app.route('/', oauth);
app.route('/', authRoutes);
app.route('/', githubHook);
app.route('/api', api);

app.all(MCP_PATH, async (c) => {
  const auth = authenticateBearer(c.req.header('authorization'));
  if (!auth) {
    const L = requestLocale((h) => c.req.header(h));
    return c.json({ error: 'unauthorized', error_description: tr(L, 'err.mcpUnauthorized') }, 401, { 'WWW-Authenticate': wwwAuthenticate() });
  }
  return handleMcp(c.req.raw, auth.user, auth.clientId, auth.token);
});

app.put('/upload/:id', async (c) => {
  const r = await receiveUpload(c.req.param('id'), c.req.query('t') ?? '', c.req.raw.body);
  if (!r.ok) return c.json({ error: r.error }, r.status as 400);
  return c.json({ ok: true, upload_id: c.req.param('id'), bytes: r.size });
});

app.get('/skills/:slug/:file{v[0-9]+\\.tgz}', (c) => {
  const slug = c.req.param('slug');
  const version = Number(c.req.param('file').slice(1, -4));
  if (!verifyToken(`skill:${slug}:${version}`, c.req.query('t') ?? '')) return c.text('download link expired, call install_skill again', 403);
  const file = skillFile(slug, version);
  if (!existsSync(file)) return c.notFound();
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    headers: { 'content-type': 'application/gzip', 'content-length': String(statSync(file).size) },
  });
});

// an app's source, for whoever looks after it (the link comes from get_app_source)
app.get('/apps-source/:slug/:file{v[0-9]+\\.tgz}', (c) => {
  const slug = c.req.param('slug');
  const version = Number(c.req.param('file').slice(1, -4));
  if (!verifyToken(`source:${slug}:${version}`, c.req.query('t') ?? '')) return c.text('download link expired, call get_app_source again', 403);
  const file = sourceFile(slug, version);
  if (!existsSync(file)) return c.notFound();
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    headers: { 'content-type': 'application/gzip', 'content-length': String(statSync(file).size) },
  });
});

app.get('/icons/:file', (c) => {
  const name = c.req.param('file');
  if (!/^[a-z0-9-]+-[A-Za-z0-9_-]+\.(svg|png)$/.test(name)) return c.notFound();
  const file = path.join(paths.icons, name);
  if (!existsSync(file)) return c.notFound();
  return c.body(readFileSync(file), 200, {
    'content-type': name.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
    'cache-control': 'public, max-age=31536000, immutable',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'x-content-type-options': 'nosniff',
  });
});

/** The company's own logo, app icon and motif (HUB_BRAND_DIR); without them the built-in neutral ones in web/dist/brand. */
app.get('/brand/:file', (c, next) => {
  const name = c.req.param('file');
  if (!config.brandDir || !['logo.svg', 'app-icon.svg', 'motif.svg'].includes(name)) return next();
  const file = path.join(config.brandDir, name);
  if (!existsSync(file)) return next();
  return c.body(readFileSync(file), 200, {
    'content-type': 'image/svg+xml', 'cache-control': 'no-cache',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff',
  });
});

app.get('/healthz', (c) => c.json({ ok: true }));

// /__hub/… (the SDK, /__hub/me, Lark calls) lives on each app's own domain; say so instead of serving the web UI
app.all('/__hub/*', (c) => c.text(`Not here: /__hub/… is served on each app's own domain, e.g. ${appUrl('<slug>').replace(/\/$/, '')}${new URL(c.req.url).pathname}`, 404));

// The web UI (built by vite into web/dist). Everything else falls back to index.html for client-side routing.
const webDist = path.resolve(import.meta.dirname, '../web/dist');
app.get('*', (c) => {
  const p = path.resolve(webDist, '.' + decodeURIComponent(new URL(c.req.url).pathname));
  if (p.startsWith(webDist + path.sep) && existsSync(p) && statSync(p).isFile()) {
    const ext = path.extname(p);
    const type = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }[ext] ?? 'application/octet-stream';
    return c.body(readFileSync(p), 200, { 'content-type': type, 'cache-control': p.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
  }
  const index = path.join(webDist, 'index.html');
  if (!existsSync(index)) return c.text('Web UI not built yet: run `pnpm build`, or use `pnpm dev:web` during development.', 503);
  return c.html(readFileSync(index, 'utf8'), 200, { 'cache-control': 'no-cache' });
});

const hubListener = getRequestListener(app.fetch);

const server = createServer((req, res) => {
  const slug = slugFromHost(req.headers.host);
  if (!slug) return hubListener(req, res);
  try {
    handleAppRequest(slug, req, res);
  } catch (e) {
    console.error('[gateway]', e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Internal error');
  }
});
server.on('upgrade', (req, socket, head) => {
  const slug = slugFromHost(req.headers.host);
  try {
    if (slug) return handleAppUpgrade(slug, req, socket, head);
  } catch (e) {
    console.error('[gateway] upgrade', e);
  }
  socket.destroy();
});
// last line of defence: a bad request must never take the whole hub down
process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled rejection]', e));
server.requestTimeout = 0; // large uploads
// Keep idle connections open longer than the reverse proxy's pool (Caddy keeps them ~2 min); with Node's 5 s default
// the proxy can reuse a socket Node is just closing, and the request fails with a 502.
server.keepAliveTimeout = 125_000;
server.headersTimeout = 130_000;
server.listen(config.port, () => {
  console.log(`${config.companyName} hub listening on :${config.port}`);
  console.log(`  hub:  ${config.hubUrl}`);
  console.log(`  apps: ${config.appsProtocol}://<slug>.${config.appsDomain}`);
  console.log(`  login: ${config.devLogin ? 'DEV' : config.auth.provider === 'lark' ? 'Lark ' + config.lark.domain : 'OIDC ' + config.oidc.issuer}`);
});

// alerts and data checks also run on data apps; Lark only adds Base snapshots, bot messages and the directory
startAlertScheduler().unref();
startCheckScheduler().unref();
if (config.lark.enabled) {
  startSnapshotRefresher().unref();
  // keep departments and colleagues in step with Lark (the admin page can still sync on demand)
  const sync = () => syncDirectory().catch((e) => console.warn('[lark] directory sync failed', (e as Error).message));
  setTimeout(sync, 60_000).unref();
  setInterval(sync, 6 * 3600_000).unref();
}

setInterval(() => {
  cleanupUploads();
  run('DELETE FROM sessions WHERE expires_at < ?', now());
  run('DELETE FROM oauth_codes WHERE expires_at < ?', now());
  run('DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at < ?', now());
  pruneReads(7 * 86_400_000);
}, 3600_000).unref();
