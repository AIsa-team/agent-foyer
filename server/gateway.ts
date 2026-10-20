/**
 * Serves every <slug>.<appsDomain> request: checks the visitor against the app's access rule,
 * then serves static files or proxies to the app container with the user's identity in headers.
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import { createProxyServer } from 'http-proxy-3';
import { config } from './config.ts';
import type { App, User } from './db.ts';
import { UserError } from './i18n/index.ts';
import { escapeHtml, page } from './html.ts';
import { requestLocale, tr, trHtml, type MessageKey } from './i18n/index.ts';
import { localize } from './localized.ts';
import { canAccessApp } from './apps/access.ts';
import { getApp, staticRoot } from './apps/service.ts';
import { handleAppLark, issueTicket } from './apps/larkApi.ts';
import { SDK_JS } from './apps/sdk.ts';
import { APP_COOKIE, appCookieHeader, createSession, deleteSession, parseCookies, safeReturnPath, sessionUser } from './auth/session.ts';
import { redeemLoginCode } from './auth/routes.ts';

const proxy = createProxyServer({ xfwd: true, ws: true, proxyTimeout: 120_000 });
proxy.on('error', (err, _req, res) => {
  console.error('[gateway] proxy error', err.message);
  if (res && 'writeHead' in res && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
    res.end(notice(_req as IncomingMessage, 'gw.noResponse.title', escapeHtml(tr(localeOf(_req as IncomingMessage), 'gw.noResponse.body'))));
  } else if (res && 'destroy' in res) res.destroy();
});

const localeOf = (req: IncomingMessage) => requestLocale((h) => {
  const v = req.headers[h];
  return Array.isArray(v) ? v[0] : v;
});

/** Simple message page in the visitor's language. */
function notice(req: IncomingMessage, title: MessageKey, body?: string, extra = ''): string {
  const L = localeOf(req);
  return page(tr(L, title), `<h1>${escapeHtml(tr(L, title))}</h1>${body ? `<p>${body}</p>` : ''}${extra}`, L);
}

export function slugFromHost(host: string | undefined): string | undefined {
  // the hub may itself live under the apps domain (hub.example.com next to <slug>.example.com)
  if (!host || host.toLowerCase() === config.hubHost.toLowerCase()) return undefined;
  const suffix = '.' + config.appsDomain;
  if (!host.endsWith(suffix)) return undefined;
  const slug = host.slice(0, -suffix.length);
  return /^[a-z0-9-]+$/.test(slug) ? slug : undefined;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf',
  '.zip': 'application/zip', '.crx': 'application/x-chrome-extension', '.xml': 'application/xml', '.map': 'application/json',
};

function send(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}

function serveStatic(app: App, req: IncomingMessage, res: ServerResponse) {
  const root = staticRoot(app);
  if (!root) return send(res, 503, notice(req, 'gw.filesMissing.title', escapeHtml(tr(localeOf(req), 'gw.filesMissing.body'))));
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    return send(res, 400, notice(req, 'gw.badPath'));
  }
  let file = path.resolve(root, '.' + urlPath);
  if (file !== root && !file.startsWith(root + path.sep)) return send(res, 400, 'bad path');
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!existsSync(file)) {
    // single page apps: unknown paths without an extension fall back to index.html
    if (path.extname(urlPath) === '' && existsSync(path.join(root, 'index.html'))) file = path.join(root, 'index.html');
    else return send(res, 404, notice(req, 'gw.notFound'));
  }
  const ext = path.extname(file).toLowerCase();
  const st = statSync(file);
  // Revalidate every load so a republish shows up at once (304 when unchanged), and keep files that
  // sit behind a login out of shared caches such as Cloudflare.
  const etag = `"${app.current_release ?? 0}-${st.size}-${Math.round(st.mtimeMs)}"`;
  const headers = { 'cache-control': 'private, no-cache', etag, 'x-content-type-options': 'nosniff' };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, {
    ...headers,
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': String(st.size),
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

/** Removes hub cookies and spoofable identity headers, then adds the real identity. */
function prepareForwardHeaders(req: IncomingMessage, user: User | undefined, slug: string) {
  for (const h of Object.keys(req.headers)) if (h.startsWith('x-hub-')) delete req.headers[h];
  const cookies = (req.headers.cookie ?? '').split(';').filter((c) => !c.trim().startsWith(APP_COOKIE + '='));
  if (cookies.join('').trim()) req.headers.cookie = cookies.join(';');
  else delete req.headers.cookie;
  if (user) {
    req.headers['x-hub-user-id'] = user.id;
    req.headers['x-hub-user-name'] = encodeURIComponent(user.name);
    req.headers['x-hub-user-email'] = user.email ?? '';
    req.headers['x-hub-user-avatar'] = user.avatar ?? '';
    // the language this person picked in the hub, so apps can follow it
    req.headers['x-hub-user-locale'] = user.locale ?? config.defaultLocale;
    // lets the app's server call /__hub/lark… and /__hub/notify as this person (see apps/larkApi.ts)
    req.headers['x-hub-ticket'] = issueTicket(slug, user.id);
  }
}

type Resolved = { kind: 'ok'; app: App; user: User | undefined } | { kind: 'login' } | { kind: 'deny'; app: App } | { kind: 'missing' } | { kind: 'down'; app: App };

function resolve(slug: string, req: IncomingMessage): Resolved {
  const app = getApp(slug);
  if (!app) return { kind: 'missing' };
  const user = sessionUser(parseCookies(req.headers.cookie)[APP_COOKIE], slug);
  if (!canAccessApp(app, user)) return user ? { kind: 'deny', app } : { kind: 'login' };
  if (app.status !== 'online' || !app.current_release) return { kind: 'down', app };
  return { kind: 'ok', app, user };
}

export function handleAppRequest(slug: string, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const cookies = parseCookies(req.headers.cookie);

  if (url.pathname === '/__hub/callback') {
    const userId = redeemLoginCode(url.searchParams.get('code') ?? '', slug);
    if (!userId) return send(res, 400, notice(req, 'gw.loginExpired.title', escapeHtml(tr(localeOf(req), 'gw.loginExpired.body'))));
    res.writeHead(302, {
      'set-cookie': appCookieHeader(createSession(userId, slug)),
      location: safeReturnPath(url.searchParams.get('return')),
    });
    return res.end();
  }
  if (url.pathname === '/__hub/me') {
    const user = sessionUser(cookies[APP_COOKIE], slug);
    res.writeHead(user ? 200 : 401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(user ? { id: user.id, name: user.name, email: user.email, avatar: user.avatar, locale: user.locale ?? config.defaultLocale } : { error: 'unauthenticated' }));
  }
  if (url.pathname === '/__hub/sdk.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, no-cache' });
    return res.end(SDK_JS);
  }
  if (url.pathname === '/__hub/lark' || url.pathname.startsWith('/__hub/lark/') || url.pathname === '/__hub/notify') {
    if (!config.lark.enabled) return send(res, 404, 'this hub is not connected to Lark');
    const app = getApp(slug);
    if (!app) return send(res, 404, 'not found');
    const user = sessionUser(cookies[APP_COOKIE], slug);
    // the ticket path is checked inside; a session must still be allowed to open the app
    if (user && !canAccessApp(app, user)) return send(res, 403, 'forbidden');
    void handleAppLark(app, user, req, res, localeOf(req)).catch((e) => {
      console.error('[app-lark]', e);
      if (!res.headersSent) send(res, 500, 'error');
    });
    return;
  }
  if (url.pathname === '/__hub/logout') {
    deleteSession(cookies[APP_COOKIE]);
    res.writeHead(302, { 'set-cookie': appCookieHeader('', 0), location: config.hubUrl });
    return res.end();
  }

  const r = resolve(slug, req);
  switch (r.kind) {
    case 'missing':
      return send(res, 404, notice(req, 'gw.appMissing.title', trHtml(localeOf(req), 'gw.appMissing.body', { slug }), `<a class="btn" href="${config.hubUrl}/apps">${escapeHtml(tr(localeOf(req), 'gw.goToApps'))}</a>`));
    case 'login': {
      const target = `${config.hubUrl}/auth/app?app=${slug}&return=${encodeURIComponent(url.pathname + url.search)}`;
      res.writeHead(302, { location: target });
      return res.end();
    }
    case 'deny': {
      const L = localeOf(req);
      return send(res, 403, page(tr(L, 'gw.denied.title'), `<h1>${escapeHtml(tr(L, 'gw.denied.heading', { app: localize(r.app, r.app.i18n, L).name }))}</h1><p>${trHtml(L, 'gw.denied.body', { owner: tr(L, 'gw.denied.ownerFallback') })}</p><a class="btn" href="${config.hubUrl}/apps">${escapeHtml(tr(L, 'gw.goToApps'))}</a>`, L));
    }
    case 'down': {
      const L = localeOf(req);
      const msg = r.app.status === 'online' ? '' : tr(L, `gw.down.${r.app.status}` as MessageKey);
      const name = localize(r.app, r.app.i18n, L).name;
      return send(res, 503, page(name, `<h1>${escapeHtml(name)}</h1><p>${escapeHtml(msg)}</p>`, L), { 'retry-after': '10' });
    }
    case 'ok':
      if (r.app.kind === 'static') return serveStatic(r.app, req, res);
      prepareForwardHeaders(req, r.user, slug);
      return proxy.web(req, res, { target: r.app.upstream! });
  }
}

export function handleAppUpgrade(slug: string, req: IncomingMessage, socket: Duplex, head: Buffer) {
  const r = resolve(slug, req);
  if (r.kind !== 'ok' || r.app.kind !== 'container') {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  prepareForwardHeaders(req, r.user, slug);
  proxy.ws(req, socket, head, { target: r.app.upstream! });
}

/**
 * Reads JSON from an app on behalf of `user` (home page data sources). Static apps: a .json file inside the
 * published folder. Container apps: a GET to the app with the same identity headers a browser request gets.
 */
export async function fetchFromApp(app: App, appPath: string, user: User, opts: { limit?: number; timeoutMs?: number } = {}): Promise<unknown> {
  const LIMIT = opts.limit ?? 1024 * 1024;
  const url = new URL(appPath, 'http://x');
  if (app.kind === 'static') {
    const root = staticRoot(app);
    if (!root) throw new UserError('err.home.sourceOffline', { app: app.slug });
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep) || !file.endsWith('.json') || !existsSync(file)) throw new UserError('err.home.sourceMissing', { path: appPath });
    if (statSync(file).size > LIMIT) throw new UserError('err.home.sourceTooLarge');
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  const target = new URL(url.pathname + url.search, app.upstream!);
  return new Promise((resolve, reject) => {
    const req = http.get(target, {
      timeout: opts.timeoutMs ?? 5000,
      headers: {
        accept: 'application/json',
        'x-hub-user-id': user.id,
        'x-hub-user-name': encodeURIComponent(user.name),
        'x-hub-user-email': user.email ?? '',
        'x-hub-user-locale': user.locale ?? config.defaultLocale,
      },
    }, (res) => {
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => {
        size += d.length;
        if (size > LIMIT) req.destroy(new UserError('err.home.sourceTooLarge'));
        else chunks.push(d);
      });
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 400) return reject(new UserError('err.home.sourceStatus', { status: res.statusCode ?? 0, path: appPath }));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new UserError('err.home.sourceNotJson', { path: appPath }));
        }
      });
    });
    req.on('timeout', () => req.destroy(new UserError('err.home.sourceTimeout', { app: app.slug, s: Math.round((opts.timeoutMs ?? 5000) / 1000) })));
    req.on('error', (e) => reject(e instanceof UserError ? e : new UserError('err.home.sourceOffline', { app: app.slug })));
  });
}
