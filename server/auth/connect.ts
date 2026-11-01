/**
 * Linking a person's account in an outside service, the same way for each (integration.ts `connect`): /auth/<id>/connect
 * sends the signed-in person there with a state (and a PKCE verifier when the service uses one) kept in a short-lived
 * cookie; /auth/<id>/callback checks it, lets the service finish, and returns to where the person came from.
 */
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { config } from '../config.ts';
import { randomToken } from '../crypto.ts';
import { escapeHtml, page } from '../html.ts';
import { tr, UserError, type MessageKey } from '../i18n/index.ts';
import { localeOf } from '../http.ts';
import type { Integration } from '../integration.ts';
import { HUB_COOKIE, STATE_COOKIE, safeReturnPath, sessionUser } from './session.ts';

export const stateCookieOpts = { path: '/', httpOnly: true, sameSite: 'Lax' as const, secure: config.secure };

export function connectRoutes(r: Hono, integrations: Integration[]) {
  for (const i of integrations) {
    const link = i.connect;
    if (!link) continue;
    const key = (k: string) => `${i.id}.connect.${k}` as MessageKey;

    r.get(`/auth/${i.id}/connect`, (c) => {
      const L = localeOf(c);
      const ret = safeReturnPath(c.req.query('return'));
      const user = sessionUser(getCookie(c, HUB_COOKIE));
      if (!user) return c.redirect(`/auth/login?return=${encodeURIComponent(`/auth/${i.id}/connect?return=${encodeURIComponent(ret)}`)}`);
      if (!link.available()) return c.html(page(tr(L, key('title')), `<h1>${escapeHtml(tr(L, key('title')))}</h1><p>${escapeHtml(tr(L, key('noApp')))}</p>`, L), 400);
      const state = randomToken(16);
      const { url, verifier } = link.authorize(user, state);
      setCookie(c, STATE_COOKIE, [state, encodeURIComponent(ret), i.id, ...(verifier ? [verifier] : [])].join('|'), { ...stateCookieOpts, maxAge: (link.minutes ?? 10) * 60 });
      return c.redirect(url);
    });

    r.get(`/auth/${i.id}/callback`, async (c: Context) => {
      const L = localeOf(c);
      const [expected, rawRet, mode, verifier] = (getCookie(c, STATE_COOKIE) ?? '').split('|');
      deleteCookie(c, STATE_COOKIE, { path: '/', secure: config.secure });
      const ret = safeReturnPath(decodeURIComponent(rawRet ?? ''));
      const user = sessionUser(getCookie(c, HUB_COOKIE));
      const failed = (reason: string, status: 400 | 500) => c.html(page(tr(L, key('failed')),
        `<h1>${escapeHtml(tr(L, key('failed')))}</h1><p>${escapeHtml(reason)}</p><a class="btn primary" href="/auth/${i.id}/connect?return=${encodeURIComponent(ret)}">${escapeHtml(tr(L, 'login.retry'))}</a>`, L), status);
      const code = c.req.query('code');
      if (c.req.query('error')) {
        if (link.denied === 'return') return c.redirect(ret);
        if (link.denied && c.req.query('error') === 'access_denied') return failed(tr(L, link.denied), 400);
      }
      if (!user || mode !== i.id || !expected || c.req.query('state') !== expected || !code) return failed(tr(L, 'login.failed.expired'), 400);
      try {
        await link.finish(user, code, verifier || undefined);
        return c.redirect(ret);
      } catch (e) {
        if (e instanceof UserError) return failed(e.localized(L), 400);
        console.error(`[auth] ${i.id} connect failed`, e);
        return failed((e as Error).message, 500);
      }
    });
  }
}
