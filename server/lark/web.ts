/**
 * Lark's own browser routes (lark/integration.ts): "connect Lark data" (the scopes each feature needs, asked for when
 * first used; Lark sends the person back to the shared sign-in callback, auth/routes.ts), an app's consent page for
 * its Lark access, and the short-lived links to files in messages and Drive.
 */
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { appUrl, config } from '../config.ts';
import { randomToken, signToken, verifyToken } from '../crypto.ts';
import { get, type App, type User } from '../db.ts';
import { escapeHtml, page } from '../html.ts';
import { tr, trHtml } from '../i18n/index.ts';
import { localeOf } from '../http.ts';
import { localize } from '../localized.ts';
import { canAccessApp } from '../apps/access.ts';
import { describeManifest, goPath, grantConsent, manifestOf, needsConnect } from '../apps/larkApi.ts';
import { mailboxName, mailConnectUrl } from '../mail.ts';
import { stateCookieOpts as cookieOpts } from '../auth/connect.ts';
import { HUB_COOKIE, STATE_COOKIE, safeReturnPath, sessionUser } from '../auth/session.ts';
import { larkAuthorizeUrl } from './auth.ts';
import { connection, DATA_SCOPES, WRITE_SCOPE } from './userToken.ts';
import { MAIL_SCOPES } from './mail.ts';
import { DOCS_SCOPES, SEARCH_SCOPE, WIKI_WRITE_SCOPE } from './docs.ts';
import { DRIVE_READ_SCOPE, DRIVE_WRITE_SCOPES, fetchDriveFile } from './files.ts';
import { TWIN_SCOPE, twinOn } from './twin.ts';
import { CALENDAR_SCOPE } from './calendar.ts';
import { SHEETS_SCOPE } from './sheets.ts';
import { FILE_SCOPE, MESSAGE_SCOPES, messagesOn } from './messages.ts';
import { fetchMessageFile, READ_SCOPES, readingOn } from './reading.ts';

export const larkWeb = new Hono();

/**
 * "Connect Lark data": asks the signed-in person for read access to their Base tables and OKRs, so the hub can show
 * that data to them (and only them). Separate from login, so login keeps working while the app's scopes are pending.
 * Uses the same callback as login; the state cookie says which flow it is.
 */
larkWeb.get('/auth/lark/connect', (c) => {
  const ret = safeReturnPath(c.req.query('return'));
  const L = localeOf(c);
  const user = sessionUser(getCookie(c, HUB_COOKIE));
  if (!user) return c.redirect(`/auth/login?return=${encodeURIComponent(`/auth/lark/connect?return=${encodeURIComponent(ret)}`)}`);
  if (!config.lark.enabled) {
    return c.html(page(tr(L, 'lark.connect.noApp.title'), `<h1>${escapeHtml(tr(L, 'lark.connect.noApp.title'))}</h1><p>${escapeHtml(tr(L, 'lark.connect.noApp.body'))}</p>
      <a class="btn" href="${escapeHtml(ret)}">${escapeHtml(tr(L, 'lark.connect.back'))}</a>`, L), 400);
  }
  const state = randomToken(16);
  setCookie(c, STATE_COOKIE, `${state}|${encodeURIComponent(ret)}|connect`, { ...cookieOpts, maxAge: 600 });
  // keep write, document, wiki, file, mail, calendar and search access when reconnecting someone who already granted it,
  // and sending and reading messages as them while they keep those on
  const had = connection(user.id).scopes ?? [];
  const write = c.req.query('write') === '1' || had.includes(WRITE_SCOPE);
  const docs = c.req.query('docs') === '1' || DOCS_SCOPES.some((s) => had.includes(s));
  const wiki = c.req.query('wiki') === '1' || had.includes(WIKI_WRITE_SCOPE);
  const mail = config.mailDrafts === 'lark' && (c.req.query('mail') === '1' || MAIL_SCOPES.every((s) => had.includes(s)));
  const sheets = c.req.query('sheets') === '1' || had.includes(SHEETS_SCOPE);
  const calendar = c.req.query('calendar') === '1' || had.includes(CALENDAR_SCOPE);
  const search = c.req.query('search') === '1' || had.includes(SEARCH_SCOPE);
  const upload = c.req.query('upload') === '1' || DRIVE_WRITE_SCOPES.every((s) => had.includes(s));
  const drive = !upload && (c.req.query('drive') === '1' || had.includes(DRIVE_READ_SCOPE));
  const messages = (c.req.query('messages') === '1' || MESSAGE_SCOPES.every((s) => had.includes(s))) && messagesOn(user.id);
  const files = messages && (c.req.query('files') === '1' || had.includes(FILE_SCOPE));
  const reading = (c.req.query('reading') === '1' || READ_SCOPES.every((s) => had.includes(s))) && readingOn(user.id);
  const twin = reading && (c.req.query('twin') === '1' || had.includes(TWIN_SCOPE)) && twinOn(user.id);
  const scopes = [...DATA_SCOPES, ...(write ? [WRITE_SCOPE] : []), ...(docs ? DOCS_SCOPES : []), ...(wiki ? [WIKI_WRITE_SCOPE] : []), ...(mail ? MAIL_SCOPES : []), ...(sheets ? [SHEETS_SCOPE] : []), ...(calendar ? [CALENDAR_SCOPE] : []), ...(search ? [SEARCH_SCOPE] : []), ...(drive ? [DRIVE_READ_SCOPE] : []), ...(upload ? DRIVE_WRITE_SCOPES : []), ...(messages ? MESSAGE_SCOPES : []), ...(files ? [FILE_SCOPE] : []), ...(reading ? READ_SCOPES : []), ...(twin ? [TWIN_SCOPE] : [])];
  return c.redirect(larkAuthorizeUrl(`${config.hubUrl}/auth/callback`, state, scopes.join(' ')));
});

/**
 * Consent for an app's Lark access (apps/larkApi.ts): lists what the app will do as the person, then records the
 * agreement and, if needed, sends them through "connect Lark data" (with write access when a table is writable).
 */
larkWeb.get('/auth/app-lark', (c) => {
  if (!config.lark.enabled) return c.notFound();
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
    ...(d.notify.appUsers ? [`<li>${escapeHtml(tr(L, 'appLark.consent.notifyUsers'))}</li>`] : []),
    ...(d.mailDrafts ? [`<li>${escapeHtml(tr(L, 'appLark.consent.mail', { mailbox: mailboxName() }))}</li>`] : []),
    ...(d.docs ? [`<li>${escapeHtml(tr(L, d.docs.parent ? 'appLark.consent.docsUnder' : 'appLark.consent.docs'))}${d.docs.share === 'view' || d.docs.share === 'edit' ? escapeHtml(tr(L, `appLark.consent.docsShare.${d.docs.share}`)) : ''}${d.docs.parent ? ` <a href="${escapeHtml(d.docs.parent)}" target="_blank" rel="noreferrer">${escapeHtml(tr(L, 'appLark.consent.openTable'))}</a>` : ''}</li>`] : []),
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

larkWeb.post('/auth/app-lark', async (c) => {
  if (!config.lark.enabled) return c.notFound();
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
  return c.redirect(goPath(slug, ret));
});

/**
 * Back to the app after consent. On the way it sends the person to whatever connection the app still needs (Lark
 * data with write or mail access, Google for Gmail drafts), each returning here, so one "Allow" covers all of it.
 */
larkWeb.get('/auth/app-lark/go', (c) => {
  const slug = c.req.query('app') ?? '';
  const ret = safeReturnPath(c.req.query('return'));
  const app = get<App>('SELECT * FROM apps WHERE slug = ?', slug);
  if (!app) return c.redirect('/apps');
  const user = sessionUser(getCookie(c, HUB_COOKIE));
  const m = manifestOf(app);
  if (user && m && config.lark.enabled) {
    const here = goPath(slug, ret);
    const need = needsConnect(user, m);
    if (need) return c.redirect(`/auth/lark/connect?return=${encodeURIComponent(here)}${need.write ? '&write=1' : ''}${need.mail ? '&mail=1' : ''}${need.sheets ? '&sheets=1' : ''}${need.docs ? '&docs=1' : ''}${need.wiki ? '&wiki=1' : ''}`);
    const google = m.mailDrafts ? mailConnectUrl(user, here) : null;
    if (google) return c.redirect(google);
  }
  return c.redirect(appUrl(slug) + ret);
});

larkWeb.get('/lark-file/:message/:key', (c) => fetchMessageFile(c.req.param('message'), c.req.param('key'), new URL(c.req.url).searchParams));
larkWeb.get('/lark-drive-file/:token', (c) => fetchDriveFile(c.req.param('token'), new URL(c.req.url).searchParams));
