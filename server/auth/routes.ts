import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { appUrl, config } from '../config.ts';
import { randomToken, sha256, signToken, verifyToken } from '../crypto.ts';
import { all, get, now, run, type App, type User } from '../db.ts';
import { escapeHtml, page } from '../html.ts';
import { requestLocale, tr, trHtml } from '../i18n/index.ts';
import { localize } from '../localized.ts';
import { canAccessApp } from '../apps/access.ts';
import { describeManifest, grantConsent, manifestOf, needsConnect } from '../apps/larkApi.ts';
import { exchangeCode, larkAuthorizeUrl, upsertUser } from './lark.ts';
import { connection, DATA_SCOPES, WRITE_SCOPE, saveTokens } from '../lark/userToken.ts';
import { HUB_COOKIE, STATE_COOKIE, createSession, deleteSession, safeReturnPath, sessionUser } from './session.ts';

export const authRoutes = new Hono();

const cookieOpts = { path: '/', httpOnly: true, sameSite: 'Lax' as const, secure: config.secure };

const localeOf = (c: Context) => requestLocale((h) => c.req.header(h));

authRoutes.get('/auth/login', (c) => {
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
  setCookie(c, STATE_COOKIE, `${state}|${ret}`, { ...cookieOpts, maxAge: 600 });
  return c.redirect(larkAuthorizeUrl(`${config.hubUrl}/auth/callback`, state));
});

/**
 * "Connect Lark data": asks the signed-in person for read access to their Base tables and OKRs, so the hub can show
 * that data to them (and only them). Separate from login, so login keeps working while the app's scopes are pending.
 * Uses the same callback as login; the state cookie says which flow it is.
 */
authRoutes.get('/auth/lark/connect', (c) => {
  const ret = safeReturnPath(c.req.query('return'));
  const L = localeOf(c);
  const user = sessionUser(getCookie(c, HUB_COOKIE));
  if (!user) return c.redirect(`/auth/login?return=${encodeURIComponent(`/auth/lark/connect?return=${encodeURIComponent(ret)}`)}`);
  if (!config.lark.appId) {
    return c.html(page(tr(L, 'lark.connect.noApp.title'), `<h1>${escapeHtml(tr(L, 'lark.connect.noApp.title'))}</h1><p>${escapeHtml(tr(L, 'lark.connect.noApp.body'))}</p>
      <a class="btn" href="${escapeHtml(ret)}">${escapeHtml(tr(L, 'lark.connect.back'))}</a>`, L), 400);
  }
  const state = randomToken(16);
  setCookie(c, STATE_COOKIE, `${state}|${encodeURIComponent(ret)}|connect`, { ...cookieOpts, maxAge: 600 });
  // keep write access when reconnecting someone who already granted it
  const write = c.req.query('write') === '1' || !!connection(user.id).scopes?.includes(WRITE_SCOPE);
  const scopes = write ? [...DATA_SCOPES, WRITE_SCOPE] : DATA_SCOPES;
  return c.redirect(larkAuthorizeUrl(`${config.hubUrl}/auth/callback`, state, scopes.join(' ')));
});

/**
 * Consent for an app's Lark access (apps/larkApi.ts): lists what the app will do as the person, then records the
 * agreement and, if needed, sends them through "connect Lark data" (with write access when a table is writable).
 */
authRoutes.get('/auth/app-lark', (c) => {
  const L = localeOf(c);
  const slug = c.req.query('app') ?? '';
  const ret = safeReturnPath(c.req.query('return'));
  const user = sessionUser(getCookie(c, HUB_COOKIE));
  if (!user) return c.redirect(`/auth/login?return=${encodeURIComponent(`/auth/app-lark?app=${slug}&return=${encodeURIComponent(ret)}`)}`);
  const app = get<App>('SELECT * FROM apps WHERE slug = ?', slug);
  if (!app || !canAccessApp(app, user)) return c.html(page(tr(L, 'gw.appMissing.title'), `<h1>${escapeHtml(tr(L, 'gw.appMissing.title'))}</h1>`, L), 404);
  const d = describeManifest(user, app);
  const name = localize(app, app.i18n, L).name;
  if (!d) return c.html(page(name, `<h1>${escapeHtml(tr(L, 'appLark.consent.none'))}</h1><a class="btn" href="${escapeHtml(appUrl(slug) + ret)}">${escapeHtml(tr(L, 'lark.connect.back'))}</a>`, L));
  const owner = get<User>('SELECT * FROM users WHERE id = ?', app.owner_id);
  const items = [
    ...d.tables.map((t) => `<li>${trHtml(L, t.access === 'write' ? 'appLark.consent.write' : 'appLark.consent.read', { name: t.name })} <a href="${escapeHtml(t.url)}" target="_blank" rel="noreferrer">${escapeHtml(tr(L, 'appLark.consent.openTable'))}</a></li>`),
    ...(d.notify.people.length || d.notify.chats.length ? [`<li>${trHtml(L, 'appLark.consent.notify', { who: [...d.notify.people, ...d.notify.chats].join(L.startsWith('zh') ? '、' : ', ') })}</li>`] : []),
  ];
  const csrf = signToken(`app-lark|${user.id}|${slug}`, 10 * 60_000);
  return c.html(page(tr(L, 'appLark.consent.title', { app: name }), `
    <h1>${escapeHtml(tr(L, 'appLark.consent.title', { app: name }))}</h1>
    <p>${trHtml(L, 'appLark.consent.intro', { owner: owner?.name ?? '', app: name })}</p>
    <ul>${items.join('')}</ul>
    <p class="muted" style="margin-top:18px">${escapeHtml(tr(L, 'appLark.consent.note'))}</p>
    <form method="post" action="/auth/app-lark">
      <input type="hidden" name="app" value="${escapeHtml(slug)}"><input type="hidden" name="return" value="${escapeHtml(ret)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button class="btn primary" name="decision" value="allow">${escapeHtml(tr(L, 'appLark.consent.allow'))}</button>
      <button class="btn" name="decision" value="deny">${escapeHtml(tr(L, 'appLark.consent.deny'))}</button>
    </form>`, L));
});

authRoutes.post('/auth/app-lark', async (c) => {
  const L = localeOf(c);
  const origin = c.req.header('origin');
  if (origin && origin !== config.hubUrl) return c.text('bad origin', 403);
  const form = await c.req.parseBody();
  const slug = String(form.app ?? '');
  const ret = safeReturnPath(String(form.return ?? '/'));
  const user = sessionUser(getCookie(c, HUB_COOKIE));
  if (!user || !verifyToken(`app-lark|${user.id}|${slug}`, String(form.csrf ?? ''))) return c.text('expired, go back and try again', 403);
  const app = get<App>('SELECT * FROM apps WHERE slug = ?', slug);
  const m = app && manifestOf(app);
  if (!app || !m || !canAccessApp(app, user)) return c.text('not found', 404);
  if (form.decision !== 'allow') {
    return c.html(page(tr(L, 'appLark.consent.deniedTitle'), `<h1>${escapeHtml(tr(L, 'appLark.consent.deniedTitle'))}</h1><p>${escapeHtml(tr(L, 'appLark.consent.deniedBody'))}</p>
      <a class="btn" href="${escapeHtml(appUrl(slug) + ret)}">${escapeHtml(tr(L, 'lark.connect.back'))}</a>`, L));
  }
  grantConsent(user, app);
  const need = needsConnect(user, m);
  const go = `/auth/app-lark/go?app=${encodeURIComponent(slug)}&return=${encodeURIComponent(ret)}`;
  if (need) return c.redirect(`/auth/lark/connect?return=${encodeURIComponent(go)}${need.write ? '&write=1' : ''}`);
  return c.redirect(go);
});

/** Back to the app after consent (and after connecting Lark data, whose return path must stay on the hub). */
authRoutes.get('/auth/app-lark/go', (c) => {
  const slug = c.req.query('app') ?? '';
  if (!get('SELECT 1 FROM apps WHERE slug = ?', slug)) return c.redirect('/apps');
  return c.redirect(appUrl(slug) + safeReturnPath(c.req.query('return')));
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
  const [expected, rawRet, mode] = (getCookie(c, STATE_COOKIE) ?? '').split('|');
  const ret = mode === 'connect' ? safeReturnPath(decodeURIComponent(rawRet ?? '')) : rawRet;
  deleteCookie(c, STATE_COOKIE, { path: '/', secure: config.secure });
  const code = c.req.query('code');
  const L = localeOf(c);
  const failed = (reason: string, status: 400 | 500) => c.html(page(tr(L, 'login.failed.title'),
    `<h1>${escapeHtml(tr(L, 'login.failed.title'))}</h1><p>${escapeHtml(reason)}</p><a class="btn primary" href="/auth/login">${escapeHtml(tr(L, 'login.retry'))}</a>`, L), status);
  if (!code || !expected || c.req.query('state') !== expected) return failed(tr(L, 'login.failed.expired'), 400);
  try {
    const { info, tokens } = await exchangeCode(code, `${config.hubUrl}/auth/callback`);
    if (mode === 'connect') {
      const current = sessionUser(getCookie(c, HUB_COOKIE));
      if (!current) return failed(tr(L, 'login.failed.expired'), 400);
      // the Lark account that granted access must be the person signed in to the hub
      if (current.id !== info.open_id) return failed(tr(L, 'lark.connect.otherAccount'), 400);
      saveTokens(current.id, tokens);
      return c.redirect(safeReturnPath(ret));
    }
    const user = upsertUser(info);
    setCookie(c, HUB_COOKIE, createSession(user.id), { ...cookieOpts, maxAge: 30 * 86400 });
    return c.redirect(safeReturnPath(ret));
  } catch (e) {
    console.error('[auth] lark callback failed', e);
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
