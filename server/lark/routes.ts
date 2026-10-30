/**
 * The hub's API for what only exists when it signs in with Lark: each person's Lark connection, OKRs, their calendar,
 * apps' permission to use their Lark data, the Lark apps admins pin and the bot's group chats.
 * api.ts mounts this on a hub with Lark; on one without, the same paths answer that Lark is off (LARK_ONLY).
 */
import { Hono } from 'hono';
import { config } from '../config.ts';
import { all, get, run } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { safeReturnPath } from '../auth/session.ts';
import { cachedRead, forgetReads } from '../cache.ts';
import * as appLark from '../apps/larkApi.ts';
import { body, localeOf, requireAdmin, type HubEnv } from '../http.ts';
import { larkAppCatalog } from './appCatalog.ts';
import { connection, connectUrl, forgetTokens } from './userToken.ts';
import { userOkrs } from './okr.ts';
import * as okrBoard from './okrBoard.ts';
import { botChats } from './chats.ts';
import { calendarAppUrl, calendarEvents, today as calendarToday } from './calendar.ts';
import { messagesStatus, setMessagesOn } from './messages.ts';
import { readingStatus, setReadingOn } from './reading.ts';

export const larkApi = new Hono<HubEnv>();

/** Lark's part of the admin page's settings (empty values on a hub without Lark). */
export const larkAdminSettings = () => ({ okrOwner: config.lark.enabled ? okrBoard.companyOwner() : null });

/** Paths that answer "Lark is off" on a hub without Lark. */
export const LARK_ONLY = ['/lark/*', '/okr', '/okr/*', '/calendar', '/admin/okr-owner', '/admin/lark-chats', '/apps/:slug/lark-consent', '/lark-links', '/lark-links/*'];

export interface LarkLink { id: number; name: string; description: string; url: string; icon: string; sort: number; in_sidebar: number }
/** The Lark apps admins put on the Apps page (and the sidebar); none on a hub without Lark. */
export const larkLinks = () => (config.lark.enabled ? all<LarkLink>('SELECT * FROM lark_links ORDER BY sort, id') : []);

// ---- Lark data: each person's own connection, Base data for home modules, alerts ----
larkApi.get('/lark/status', (c) => c.json({ ...connection(c.get('user').id), connectUrl: connectUrl('/me'), available: true }));

larkApi.post('/lark/disconnect', (c) => {
  forgetTokens(c.get('user').id);
  // what was read with that access goes too
  forgetReads(`okr|${c.get('user').id}|`);
  forgetReads(`okr-board|${c.get('user').id}|`);
  forgetReads(`calendar|${c.get('user').id}|`);
  return c.json({ ok: true });
});

/** Sending Lark messages as the person from their agent: their own switch on the Me page, off until they turn it on. */
larkApi.get('/lark/messages', (c) => c.json(messagesStatus(c.get('user'))));
larkApi.post('/lark/messages', async (c) => {
  const b = await body<{ on?: boolean }>(c);
  setMessagesOn(c.get('user'), b.on === true);
  return c.json(messagesStatus(c.get('user')));
});
/** Reading Lark messages as the person, for their agent: also their own switch, off until they turn it on. */
larkApi.get('/lark/reading', (c) => c.json(readingStatus(c.get('user'))));
larkApi.post('/lark/reading', async (c) => {
  const b = await body<{ on?: boolean }>(c);
  setReadingOn(c.get('user'), b.on === true);
  return c.json(readingStatus(c.get('user')));
});

/** The company OKR page: everyone's objectives for a period, how they align, and the team's pace. */
larkApi.get('/okr/board', async (c) => c.json(await okrBoard.okrBoard(c.get('user'), localeOf(c), c.req.query('period') || undefined, c.req.query('fresh') === '1')));
larkApi.post('/admin/okr-owner', async (c) => {
  const b = await body<{ owner?: string | null }>(c);
  okrBoard.setCompanyOwner(c.get('user'), b.owner || null);
  return c.json({ ok: true });
});

/** Someone's OKRs (default: the viewer's own), read with the viewer's Lark access. `user` is an open_id or email. */
larkApi.get('/okr', async (c) => {
  const ref = c.req.query('user');
  const target = ref ? get<{ id: string }>('SELECT id FROM users WHERE id = ? OR lower(email) = lower(?)', ref, ref)?.id : undefined;
  if (ref && !target) throw new UserError('err.colleagueNotFound', { query: ref });
  const u = c.get('user'), period = c.req.query('period') || undefined, L = localeOf(c);
  // the home page's OKR card: served at once from the last read, refreshed in the background after 5 minutes
  return c.json(await cachedRead(`okr|${u.id}|${target ?? u.id}|${period ?? ''}|${L}`, { fresh: 300_000, keep: 7 * 86_400_000 },
    () => userOkrs(u, { userId: target, periodId: period, locale: L })));
});

/**
 * The viewer's own Lark calendar for the home page's agenda: a whole month (`month=YYYY-MM`, or `month=current`),
 * or `days` days (1-7) from today.
 */
larkApi.get('/calendar', async (c) => {
  const u = c.get('user');
  const today = calendarToday();
  const month = c.req.query('month') === 'current' ? today.slice(0, 7) : c.req.query('month');
  let from = today, to = today;
  if (month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new UserError('err.calendar.badRange');
    const [y, mo] = month.split('-').map(Number);
    from = `${month}-01`;
    to = `${month}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
  } else {
    const days = Math.min(7, Math.max(1, Number(c.req.query('days')) || 1));
    to = new Date(Date.parse(`${from}T00:00:00Z`) + (days - 1) * 86_400_000).toISOString().slice(0, 10);
  }
  const back = safeReturnPath(c.req.query('return'));
  // served at once from the last read, refreshed in the background after a minute
  const events = await cachedRead(`calendar|${u.id}|${from}|${to}`, { fresh: 60_000, keep: 86_400_000 }, () => calendarEvents(u, from, to, back));
  return c.json({ today, from, to, timezone: config.timezone, openUrl: calendarAppUrl(), events });
});

/** Take back an app's permission to use your Lark data. */
larkApi.delete('/apps/:slug/lark-consent', (c) => {
  appLark.revokeConsent(c.get('user'), c.req.param('slug'));
  return c.json({ ok: true });
});

larkApi.post('/lark-links', async (c) => {
  requireAdmin(c.get('user'));
  const b = await body<Partial<LarkLink>>(c);
  if (!b.name || !b.url || !/^https?:\/\//.test(b.url)) throw new UserError('err.larkLinkInvalid');
  run('INSERT INTO lark_links (name, description, url, icon, sort) VALUES (?, ?, ?, ?, ?)', b.name, b.description ?? '', b.url, b.icon ?? '', b.sort ?? 0);
  return c.json({ ok: true });
});

/** For the admin's picker: Lark's own features and the apps installed in the company. */
larkApi.get('/lark-links/catalog', async (c) => {
  requireAdmin(c.get('user'));
  return c.json(await larkAppCatalog(localeOf(c)));
});

larkApi.post('/lark-links/:id/sidebar', async (c) => {
  requireAdmin(c.get('user'));
  const b = await body<{ on?: boolean }>(c);
  run('UPDATE lark_links SET in_sidebar = ? WHERE id = ?', b.on ? 1 : 0, Number(c.req.param('id')));
  return c.json({ ok: true });
});

larkApi.delete('/lark-links/:id', (c) => {
  requireAdmin(c.get('user'));
  run('DELETE FROM lark_links WHERE id = ?', Number(c.req.param('id')));
  return c.json({ ok: true });
});

larkApi.get('/admin/lark-chats', async (c) => {
  requireAdmin(c.get('user'));
  return c.json({ chats: await botChats() });
});
