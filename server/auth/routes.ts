import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { appUrl, config } from '../config.ts';
import { randomToken, sha256, signToken, verifyToken } from '../crypto.ts';
import { all, get, now, run, type App, type User } from '../db.ts';
import { escapeHtml, page } from '../html.ts';
import { requestLocale, tr, trHtml, UserError } from '../i18n/index.ts';
import { localize } from '../localized.ts';
import { exchangeCode, larkAuthorizeUrl } from '../lark/auth.ts';
import { oidcAuthorize, oidcExchange } from './oidc.ts';
import { upsertUser } from './users.ts';
import { connection, DATA_SCOPES, WRITE_SCOPE, saveTokens } from '../lark/userToken.ts';
import { finishConnect, startConnect } from '../services/index.ts';
import { canAccessApp } from '../apps/access.ts';
import { HUB_COOKIE, STATE_COOKIE, createSession, deleteSession, safeReturnPath, sessionUser } from './session.ts';

export const authRoutes = new Hono();

const cookieOpts = { path: '/', httpOnly: true, sameSite: 'Lax' as const, secure: config.secure };

const localeOf = (c: Context) => requestLocale((h) => c.req.header(h));

authRoutes.get('/auth/login', async (c) => {
  const ret = safeReturnPath(c.req.query('return'));
  if (config.devLogin) {
    const L = localeOf(c);
    const users = all<User>('SELECT * FROM users ORDER BY created_at');
    return c.html(page(tr(L, 'login.dev.title'), `
      <h1>${escapeHtml(tr(L, 'login.dev.title'))}</h1>
      <p>${escapeHtml(tr(L, 'login.dev.body'))}</p>
      <form method="post" action="/auth/dev-login"><input type="hidden" name="return" value="${escapeHtml(ret)}"><ul>
      ${users.map((u) => `<li><button name="user" value="${escapeHtml(u.id)}" style="width:100%;text-align:left">${escapeHtml(u.name)} · ${escapeHtml(u.email ?? '')}${u.role === 'admin' ? ` · ${escapeHtml(tr(L, 'login.dev.admin'))}` : ''}</button></li>`).join('')}
      </ul></form>`, L));
  }
  const state = randomToken(16);
  const callback = `${config.hubUrl}/auth/callback`;
  if (config.auth.provider === 'oidc') {
    const { url, verifier } = await oidcAuthorize(callback, state);
    setCookie(c, STATE_COOKIE, `${state}|${encodeURIComponent(ret)}|login|${verifier}`, { ...cookieOpts, maxAge: 600 });
    return c.redirect(url);
  }
  setCookie(c, STATE_COOKIE, `${state}|${encodeURIComponent(ret)}|login`, { ...cookieOpts, maxAge: 600 });
  return c.redirect(larkAuthorizeUrl(callback, state));
});

/** Connect the signed-in person's account in another service whose MCP server the hub reaches (services/). */
authRoutes.get('/auth/services/:id/connect', async (c) => {
  const L = localeOf(c);
  const ret = safeReturnPath(c.req.query('return'));
  const user = sessionUser(getCookie(c, HUB_COOKIE));
  if (!user) return c.redirect(`/auth/login?return=${encodeURIComponent(`/auth/services/${c.req.param('id')}/connect?return=${encodeURIComponent(ret)}`)}`);
  try {
    const go = await startConnect(user, c.req.param('id'));
    setCookie(c, STATE_COOKIE, `services|${encodeURIComponent(ret)}`, { ...cookieOpts, maxAge: 1800 });
    return c.redirect(go ?? ret);
  } catch (e) {
    const msg = e instanceof UserError ? e.localized(L) : (e as Error).message;
    return c.html(page(tr(L, 'services.connect.failed'), `<h1>${escapeHtml(tr(L, 'services.connect.failed'))}</h1><p>${escapeHtml(msg)}</p>`, L), 400);
  }
});

authRoutes.get('/auth/services/callback', async (c) => {
  const L = localeOf(c);
  const [mode, rawRet] = (getCookie(c, STATE_COOKIE) ?? '').split('|');
  deleteCookie(c, STATE_COOKIE, { path: '/', secure: config.secure });
  const ret = safeReturnPath(decodeURIComponent(rawRet ?? ''));
  const user = sessionUser(getCookie(c, HUB_COOKIE));
  const failed = (reason: string, status: 400 | 500) => c.html(page(tr(L, 'services.connect.failed'), `<h1>${escapeHtml(tr(L, 'services.connect.failed'))}</h1><p>${escapeHtml(reason)}</p><a class="btn primary" href="${escapeHtml(ret)}">${escapeHtml(tr(L, 'login.retry'))}</a>`, L), status);
  if (c.req.query('error')) return c.redirect(ret);
  const state = c.req.query('state'), code = c.req.query('code');
  if (!user || mode !== 'services' || !state || !code) return failed(tr(L, 'login.failed.expired'), 400);
  try {
    await finishConnect(user, state, code);
    return c.redirect(ret);
  } catch (e) {
    if (e instanceof UserError) return failed(e.localized(L), 400);
    console.error('[auth] service connect failed', e);
    return failed((e as Error).message, 500);
  }
});

authRoutes.post('/auth/dev-login', async (c) => {
  if (!config.devLogin) return c.notFound();
  const form = await c.req.parseBody();
  const user = get<User>('SELECT * FROM users WHERE id = ?', String(form.user));
  if (!user) return c.text('unknown user', 400);
  run('UPDATE users SET last_seen_at = ? WHERE id = ?', now(), user.id);
  setCookie(c, HUB_COOKIE, createSession(user.id), { ...cookieOpts, maxAge: 30 * 86400 });
  return c.redirect(safeReturnPath(String(form.return)));
});

authRoutes.get('/auth/callback', async (c) => {
  const [expected, rawRet, mode, verifier] = (getCookie(c, STATE_COOKIE) ?? '').split('|');
  const ret = safeReturnPath(decodeURIComponent(rawRet ?? ''));
  deleteCookie(c, STATE_COOKIE, { path: '/', secure: config.secure });
  const code = c.req.query('code');
  const L = localeOf(c);
  const failed = (reason: string, status: 400 | 500) => c.html(page(tr(L, 'login.failed.title'),
    `<h1>${escapeHtml(tr(L, 'login.failed.title'))}</h1><p>${escapeHtml(reason)}</p><a class="btn primary" href="/auth/login">${escapeHtml(tr(L, 'login.retry'))}</a>`, L), status);
  if (!code || !expected || c.req.query('state') !== expected) return failed(tr(L, 'login.failed.expired'), 400);
  const callback = `${config.hubUrl}/auth/callback`;
  try {
    if (config.auth.provider === 'oidc') {
      if (mode !== 'login' || !verifier) return failed(tr(L, 'login.failed.expired'), 400);
      const user = upsertUser(await oidcExchange(code, callback, verifier));
      setCookie(c, HUB_COOKIE, createSession(user.id), { ...cookieOpts, maxAge: 30 * 86400 });
      return c.redirect(ret);
    }
    const { identity, tokens } = await exchangeCode(code, callback);
    if (mode === 'connect') {
      const current = sessionUser(getCookie(c, HUB_COOKIE));
      if (!current) return failed(tr(L, 'login.failed.expired'), 400);
      // the Lark account that granted access must be the person signed in to the hub
      if (current.id !== identity.id) return failed(tr(L, 'lark.connect.otherAccount'), 400);
      saveTokens(current.id, tokens);
      return c.redirect(ret);
    }
    const user = upsertUser(identity);
    setCookie(c, HUB_COOKIE, createSession(user.id), { ...cookieOpts, maxAge: 30 * 86400 });
    return c.redirect(ret);
  } catch (e) {
    if (e instanceof UserError) return failed(e.localized(L), 400);
    console.error('[auth] sign-in callback failed', e);
    return failed((e as Error).message, 500);
  }
});

authRoutes.post('/auth/logout', (c) => {
  const origin = c.req.header('origin');
  if (origin && origin !== config.hubUrl) return c.json({ error: 'bad origin' }, 403);
  deleteSession(getCookie(c, HUB_COOKIE));
  deleteCookie(c, HUB_COOKIE, { path: '/', secure: config.secure });
  return c.json({ ok: true });
});

/**
 * An app subdomain sends unauthenticated visitors here. We check the hub session and the app's access rule,
 * then hand a one-time code back to the app subdomain, which turns it into a cookie scoped to that subdomain only.
 */
authRoutes.get('/auth/app', (c) => {
  const slug = c.req.query('app') ?? '';
  const ret = safeReturnPath(c.req.query('return'));
  const app = get<App>('SELECT * FROM apps WHERE slug = ?', slug);
  const L = localeOf(c);
  if (!app) {
    return c.html(page(tr(L, 'gw.appMissing.title'), `<h1>${escapeHtml(tr(L, 'gw.appMissing.title'))}</h1><p>${trHtml(L, 'gw.appMissing.body', { slug })}</p>
      <a class="btn" href="/apps">${escapeHtml(tr(L, 'gw.goToApps'))}</a>`, L), 404);
  }
  const user = sessionUser(getCookie(c, HUB_COOKIE));
  if (!user) return c.redirect(`/auth/login?return=${encodeURIComponent(`/auth/app?app=${slug}&return=${encodeURIComponent(ret)}`)}`);
  if (!canAccessApp(app, user)) {
    const owner = get<User>('SELECT * FROM users WHERE id = ?', app.owner_id);
    return c.html(page(tr(L, 'gw.denied.title'), `<h1>${escapeHtml(tr(L, 'gw.denied.heading', { app: localize(app, app.i18n, L).name }))}</h1>
      <p>${trHtml(L, 'gw.denied.body', { owner: owner?.name ?? tr(L, 'gw.denied.ownerFallback') })}</p>
      <a class="btn" href="/apps">${escapeHtml(tr(L, 'gw.goToApps'))}</a>`, L), 403);
  }
  const code = randomToken();
  run('INSERT INTO login_codes (code_hash, user_id, app_slug, expires_at) VALUES (?, ?, ?, ?)', sha256(code), user.id, slug, now() + 60_000);
  return c.redirect(`${appUrl(slug)}/__hub/callback?code=${code}&return=${encodeURIComponent(ret)}`);
});

export function redeemLoginCode(code: string, slug: string): string | undefined {
  const row = get<{ user_id: string; app_slug: string; expires_at: number }>('SELECT * FROM login_codes WHERE code_hash = ?', sha256(code));
  run('DELETE FROM login_codes WHERE code_hash = ? OR expires_at < ?', sha256(code), now());
  if (!row || row.app_slug !== slug || row.expires_at < now()) return undefined;
  return row.user_id;
}
