import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import * as tar from 'tar';
import { profileRadar } from './radar.ts';
import { homePulse } from './pulse.ts';
import { larkAppCatalog } from './lark/appCatalog.ts';
import { config, loginName } from './config.ts';
import { messenger } from './notify.ts';
import { mailboxName } from './mail.ts';
import { forgetGoogle, googleConnection, googleConnectUrl } from './google/auth.ts';
import { githubEnabled } from './github/app.ts';
import { githubConnectUrl, unlinkGitHub } from './github/link.ts';
import { contributions } from './github/contributions.ts';
import { all, get, now, run, type App, type User } from './db.ts';
import { HUB_COOKIE, sessionUser } from './auth/session.ts';
import { createPersonalToken, disconnectAgent, MCP_PATH } from './auth/oauth.ts';
import { syncDirectory } from './lark/auth.ts';
import * as apps from './apps/service.ts';
import * as skills from './skills/service.ts';
import * as lib from './library.ts';
import { pick } from './library.ts';
import * as homepage from './homepage.ts';
import * as dataSources from './data/sources.ts';
import * as connectors from './data/connectors/index.ts';
import { importBoard, importedBoards } from './data/importBoard.ts';
import * as alerts from './data/alerts.ts';
import { querySchema, CHART_KINDS } from './data/query.ts';
import { connection, connectUrl, forgetTokens } from './lark/userToken.ts';
import { userOkrs } from './lark/okr.ts';
import { cachedRead, forgetReads } from './cache.ts';
import * as okrBoard from './lark/okrBoard.ts';
import * as checks from './data/checks.ts';
import * as appLark from './apps/larkApi.ts';
import * as feedback from './feedback.ts';
import * as collab from './collab.ts';
import { usageDetail } from './apps/visits.ts';
import { describeActions } from './apps/agentActions.ts';
import { publicDecided } from './apps/approvals.ts';
import * as requests from './requests.ts';
import { botChats } from './lark/chats.ts';
import * as boards from './boards.ts';
import { organisation, search } from './directory.ts';
import { isSupportedLocale, requestLocale, tr, UserError } from './i18n/index.ts';

type Env = { Variables: { user: User } };
export const api = new Hono<Env>();

api.use('*', async (c, next) => {
  const user = sessionUser(getCookie(c, HUB_COOKIE));
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  if (c.req.method !== 'GET') {
    const origin = c.req.header('origin');
    if (origin && origin !== config.hubUrl) return c.json({ error: 'bad origin' }, 403);
    if (!(c.req.header('content-type') ?? '').includes('application/json')) return c.json({ error: 'JSON only' }, 415);
  }
  // "last seen" feeds who used the hub today; written at most every ten minutes per person
  if (!user.last_seen_at || now() - user.last_seen_at > 600_000) run('UPDATE users SET last_seen_at = ? WHERE id = ?', now(), user.id);
  c.set('user', user);
  await next();
});

const localeOf = (c: Context) => requestLocale((h) => c.req.header(h));

// what only exists when the hub signs in with Lark
for (const p of ['/lark/*', '/okr', '/okr/*', '/admin/okr-owner', '/admin/sync-directory', '/apps/:slug/lark-consent', '/lark-links', '/lark-links/*']) {
  api.use(p, async (_c, next) => {
    if (!config.lark.enabled) throw new UserError('err.lark.disabled');
    await next();
  });
}

api.onError((e, c) => {
  // `code` lets the UI react to specific cases, e.g. offer the "connect Lark data" button
  if (e instanceof UserError) return c.json({ error: e.localized(localeOf(c)), code: e.key, params: e.params }, 400);
  console.error('[api]', e);
  return c.json({ error: tr(localeOf(c), 'err.internal', { message: e.message }) }, 500);
});

const body = async <T>(c: Context) => (await c.req.json().catch(() => ({}))) as T;
const requireAdmin = (u: User) => {
  if (u.role !== 'admin') throw new UserError('err.adminOnly');
};

api.get('/me', (c) => {
  const u = c.get('user');
  return c.json({
    user: { id: u.id, name: u.name, email: u.email, avatar: u.avatar, role: u.role, locale: u.locale },
    hub: {
      url: config.hubUrl, mcpUrl: config.hubUrl + MCP_PATH, mcpName: config.mcpName, appsDomain: config.appsDomain, companyName: config.companyName,
      accent: config.accent || null, devLogin: config.devLogin, login: loginName,
      // lark: Base data, OKRs, directory, apps acting in Lark; messages: alerts can reach people outside the hub
      features: { lark: config.lark.enabled, messages: !!messenger, github: githubEnabled() },
      /** where apps save email drafts ("Gmail", "Lark Mail"), or null */
      mailbox: mailboxName() || null,
    },
    // Lark apps an admin pinned under the sidebar navigation (e.g. Approval)
    sidebarLinks: larkLinks().filter((l) => l.in_sidebar).map((l) => ({ id: l.id, name: l.name, url: l.url, icon: l.icon })),
  });
});

/** The language picked in the web UI; MCP replies to this person's agents use it too. */
api.post('/me/locale', async (c) => {
  const b = await body<{ locale?: string }>(c);
  if (!isSupportedLocale(b.locale)) return c.json({ error: 'unsupported locale' }, 400);
  run('UPDATE users SET locale = ? WHERE id = ?', b.locale, c.get('user').id);
  return c.json({ ok: true });
});

api.get('/profile', (c) => {
  const u = c.get('user');
  const allApps = apps.listAppsFor(u, localeOf(c));
  // what they look after: their own and what they collaborate on
  const mySkills = skills.listSkills(u, localeOf(c)).filter((s) => s.myRole);
  const agents = all<{ client_id: string; client_name: string; connected_at: number; last_used_at: number }>(
    'SELECT client_id, client_name, connected_at, last_used_at FROM agent_connections WHERE user_id = ? ORDER BY last_used_at DESC', u.id,
  );
  const installed = get<{ n: number }>('SELECT COUNT(*) AS n FROM skill_installs WHERE user_id = ?', u.id)!.n;
  return c.json({
    apps: allApps.filter((a) => a.myRole),
    skills: mySkills,
    installedSkills: installed,
    agents: agents.map((a) => ({ id: a.client_id, name: a.client_name, connectedAt: a.connected_at, lastUsedAt: a.last_used_at })),
    radar: profileRadar(u.id),
  });
});

api.get('/home', async (c) => {
  const u = c.get('user');
  const L = localeOf(c);
  const resolved = homepage.resolveHome(u, L, c.req.query('preview'));
  const home = { ...resolved, layout: { modules: await homepage.forViewer(u, resolved.layout.modules) } };
  const visible = apps.listAppsFor(u, L).filter((a) => a.canOpen && a.status === 'online');
  const allSkills = skills.listSkills(u, L);
  const policies = lib.library(L).sections.find((x) => x.section === 'policies')?.groups.flatMap((g) => g.items) ?? [];
  return c.json({
    ...home,
    apps: visible,
    larkLinks: larkLinks(),
    skillUpdates: allSkills.filter((s) => s.hasUpdate),
    newSkills: allSkills.filter((s) => s.listed).slice(0, 4),
    resources: policies.slice(0, 6),
    myDepartments: homepage.userDepartments(u, L),
    editableDepartments: homepage.editableDepartments(u, L),
    pulse: homePulse(u, L),
  });
});

// a person's own changes to the shared home page, made on the page itself
api.post('/home/adjust', async (c) => {
  const b = await body<{ hide?: string; show?: string; width?: { id: string; width: 'full' | 'half' | 'third' }; order?: string[]; remove?: string }>(c);
  if (b.width && !['full', 'half', 'third'].includes(b.width.width)) throw new UserError('err.home.badLayout', { details: 'width' });
  homepage.adjustHome(c.get('user'), localeOf(c), {
    hide: b.hide, show: b.show, width: b.width, remove: b.remove,
    order: Array.isArray(b.order) ? b.order.map(String).slice(0, 48) : undefined,
  });
  return c.json({ ok: true });
});
api.delete('/home/adjust', (c) => c.json(homepage.resetHome(c.get('user'), 'me')));

api.get('/home/source', async (c) => {
  const app = c.req.query('app') ?? '';
  const path = c.req.query('path') ?? '';
  if (!path.startsWith('/')) throw new UserError('err.home.sourceMissing', { path });
  return c.json(await homepage.readSource(c.get('user'), { app, path, pick: c.req.query('pick') || undefined }));
});

// ---- Lark data: each person's own connection, Base data for home modules, alerts ----
api.get('/lark/status', (c) => c.json({ ...connection(c.get('user').id), connectUrl: connectUrl('/me'), available: true }));
// ---- GitHub: who each person is on GitHub ----
api.get('/github/status', (c) => {
  const u = c.get('user');
  return c.json({ available: githubEnabled(), org: config.github.org, login: u.github_login ?? null, connectUrl: githubConnectUrl('/me') });
});
// the viewer's own contribution calendar (home module); never someone else's, since the hub reads every repository
api.get('/github/contributions', async (c) => {
  const u = c.get('user');
  if (!githubEnabled()) throw new UserError('err.github.disabled');
  if (!u.github_login) return c.json({ linked: false, connectUrl: githubConnectUrl('/') });
  const weeks = Math.min(53, Math.max(4, Number(c.req.query('weeks') ?? 52) || 52));
  return c.json({ linked: true, ...(await contributions(u, weeks)) });
});
api.post('/github/disconnect', (c) => {
  unlinkGitHub(c.get('user'));
  return c.json({ ok: true });
});

// ---- Google: each person's own connection, for apps that save Gmail drafts ----
api.get('/google/status', (c) => c.json({ ...googleConnection(c.get('user').id), available: config.mailDrafts === 'google', connectUrl: googleConnectUrl('/me') }));
api.post('/google/disconnect', (c) => {
  forgetGoogle(c.get('user').id);
  return c.json({ ok: true });
});
api.post('/lark/disconnect', (c) => {
  forgetTokens(c.get('user').id);
  // what was read with that access goes too
  forgetReads(`okr|${c.get('user').id}|`);
  forgetReads(`okr-board|${c.get('user').id}|`);
  return c.json({ ok: true });
});
api.get('/data/sources', (c) => c.json({ sources: dataSources.listSources(localeOf(c), c.get('user')) }));
api.post('/data/module', async (c) => {
  const b = await body<{ source?: string; query?: unknown; kind?: string }>(c);
  const kind = b.kind === 'stat' || (CHART_KINDS as readonly string[]).includes(b.kind ?? '') ? (b.kind as 'stat') : undefined;
  if (!b.source || !kind) return c.json({ error: 'source and kind required' }, 400);
  const q = querySchema.safeParse(b.query);
  if (!q.success) return c.json({ error: q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
  return c.json({ value: await dataSources.forModule(c.get('user'), b.source, q.data, kind, localeOf(c)) });
});
// the detail page of a data source: what it is, and its records (both read as the viewer)
api.post('/data/sources/:id/description', async (c) => {
  const b = await body<{ description?: Record<string, string> | null }>(c);
  return c.json(await dataSources.setDescription(c.get('user'), c.req.param('id'), b.description ?? null));
});
api.get('/data/sources/:id', async (c) => c.json(await dataSources.describeSource(c.get('user'), c.req.param('id'), localeOf(c))));
api.post('/data/rows', async (c) => {
  const b = await body<{ source?: string; where?: unknown; sort?: { field: string; desc?: boolean }; limit?: number }>(c);
  const where = querySchema.shape.where.safeParse(b.where);
  if (!b.source || !where.success) return c.json({ error: 'source required; where as in queries' }, 400);
  return c.json(await dataSources.readRows(c.get('user'), b.source, { where: where.data, sort: b.sort?.field ? { field: String(b.sort.field), desc: !!b.sort.desc } : undefined, limit: Math.min(Number(b.limit) || 200, 200) }));
});
api.get('/alerts', (c) => c.json({ alerts: alerts.rulesFor(c.get('user'), localeOf(c)) }));
api.post('/alerts/:id/mute', async (c) => {
  const b = await body<{ muted?: boolean }>(c);
  return c.json(alerts.muteRule(c.get('user'), Number(c.req.param('id')), b.muted !== false));
});
// ---- data boards, organisation, search ----
api.get('/boards', async (c) => {
  const u = c.get('user');
  // a board shows each person only the numbers they may see
  const list = await Promise.all(boards.boardsFor(u, localeOf(c)).map(async (b) => ({ ...b, layout: { modules: await homepage.forViewer(u, b.layout.modules) } })));
  return c.json({ boards: list, canEditCompany: u.role === 'admin', editableDepartments: homepage.editableDepartments(u, localeOf(c)) });
});
api.get('/org', (c) => c.json(organisation(localeOf(c))));
api.get('/search', (c) => c.json(search(c.get('user'), c.req.query('q') ?? '', localeOf(c))));

// ---- data checks ("异常项") ----
api.get('/issues', async (c) => c.json(await checks.issuesFor(c.get('user'), localeOf(c))));
/** Just what the home page shows: per check, how many open issues are the viewer's (the full list is large). */
api.get('/issues/mine', async (c) => {
  const all = await checks.issuesFor(c.get('user'), localeOf(c));
  return c.json({
    lastRun: all.lastRun,
    checks: all.checks.map((k) => ({ id: k.id, title: k.title, level: k.level, mine: k.rows.filter((r) => r.mine && !r.exception).length })).filter((k) => k.mine),
  });
});
/** "Check again": runs every check now; a run that finished in the last minute is reused. */
api.post('/issues/run', async (c) => {
  const last = checks.lastRun();
  if (!last || Date.now() - (last.at + last.ms) > 60_000) await checks.runAll();
  return c.json(await checks.issuesFor(c.get('user'), localeOf(c)));
});
api.post('/issues/exception', async (c) => {
  const b = await body<{ check?: number; record?: string; on?: boolean; reason?: string }>(c);
  return c.json(checks.setException(c.get('user'), Number(b.check), String(b.record ?? ''), b.on !== false, b.reason));
});

/** The company OKR page: everyone's objectives for a period, how they align, and the team's pace. */
api.get('/okr/board', async (c) => c.json(await okrBoard.okrBoard(c.get('user'), localeOf(c), c.req.query('period') || undefined, c.req.query('fresh') === '1')));
api.post('/admin/okr-owner', async (c) => {
  const b = await body<{ owner?: string | null }>(c);
  okrBoard.setCompanyOwner(c.get('user'), b.owner || null);
  return c.json({ ok: true });
});

/** Someone's OKRs (default: the viewer's own), read with the viewer's Lark access. `user` is an open_id or email. */
api.get('/okr', async (c) => {
  const ref = c.req.query('user');
  const target = ref ? get<{ id: string }>('SELECT id FROM users WHERE id = ? OR lower(email) = lower(?)', ref, ref)?.id : undefined;
  if (ref && !target) throw new UserError('err.colleagueNotFound', { query: ref });
  const u = c.get('user'), period = c.req.query('period') || undefined, L = localeOf(c);
  // the home page's OKR card: served at once from the last read, refreshed in the background after 5 minutes
  return c.json(await cachedRead(`okr|${u.id}|${target ?? u.id}|${period ?? ''}|${L}`, { fresh: 300_000, keep: 7 * 86_400_000 },
    () => userOkrs(u, { userId: target, periodId: period, locale: L })));
});

// ---- apps ----
api.get('/apps', (c) => c.json({ apps: apps.listAppsFor(c.get('user'), localeOf(c)), larkLinks: larkLinks(), requestsWaiting: requests.waitingCount(c.get('user')) }));

api.get('/apps/:slug', (c) => {
  const u = c.get('user');
  const app = apps.getApp(c.req.param('slug'));
  if (!app) return c.json({ error: tr(localeOf(c), 'err.appNotFound', { slug: c.req.param('slug') }) }, 404);
  const data = apps.serializeApp(app, u, localeOf(c));
  if (!data.canOpen && !data.canManage) return c.json({ error: tr(localeOf(c), 'err.noPermission') }, 403);
  const releases = data.canManage
    ? all<{ version: number; status: string; created_at: number; created_by_name: string; kind: string }>(
      `SELECT r.version, r.status, r.created_at, r.kind, u.name AS created_by_name FROM app_releases r JOIN users u ON u.id = r.created_by
       WHERE r.app_slug = ? ORDER BY r.version DESC LIMIT 20`, app.slug)
    : [];
  return c.json({
    app: data, releases, lark: config.lark.enabled ? appLark.describeManifest(u, app) : null, larkConsentUrl: appLark.consentUrl(app.slug, '/'),
    feedback: feedback.feedbackFor(u, 'app', app.slug),
    usage: data.canManage ? usageDetail(app) : null,
    agent: describeActions(u, app),
  });
});

api.post('/apps/:slug/feedback', async (c) => {
  const b = await body<{ body?: string }>(c);
  return c.json(await feedback.addFeedback(c.get('user'), 'app', c.req.param('slug'), { body: String(b.body ?? '') }));
});
api.post('/skills/:slug/feedback', async (c) => {
  const b = await body<{ body?: string }>(c);
  return c.json(await feedback.addFeedback(c.get('user'), 'skill', c.req.param('slug'), { body: String(b.body ?? '') }));
});
api.post('/feedback/:id', async (c) => {
  const b = await body<{ status?: string; reply?: string }>(c);
  const status = b.status === 'done' || b.status === 'declined' ? b.status : 'open';
  return c.json(await feedback.resolveFeedback(c.get('user'), Number(c.req.param('id')), status, b.reply));
});

/** Take back an app's permission to use your Lark data. */
api.delete('/apps/:slug/lark-consent', (c) => {
  appLark.revokeConsent(c.get('user'), c.req.param('slug'));
  return c.json({ ok: true });
});

api.get('/apps/:slug/releases/:version/log', (c) => {
  apps.requireManageable(c.req.param('slug'), c.get('user'));
  const r = get<{ log: string }>('SELECT log FROM app_releases WHERE app_slug = ? AND version = ?', c.req.param('slug'), Number(c.req.param('version')));
  return c.json({ log: r?.log ?? '' });
});

api.patch('/apps/:slug', async (c) => {
  const b = await body<{ name?: string; description?: string; localized?: Record<string, { name?: string; description?: string }>; iconSvg?: string; iconPngBase64?: string; removeIcon?: boolean; feedbackButton?: boolean; agentAccess?: boolean }>(c);
  return c.json({ ok: true, ...apps.updateApp(c.get('user'), c.req.param('slug'), b) });
});

api.post('/apps/:slug/access', async (c) => {
  const b = await body<{ visibility: apps.Visibility; memberIds?: string[] }>(c);
  apps.setVisibility(c.get('user'), c.req.param('slug'), b.visibility, b.memberIds);
  return c.json({ ok: true });
});

api.post('/apps/:slug/running', async (c) => {
  const b = await body<{ running: boolean }>(c);
  await apps.setRunning(c.get('user'), c.req.param('slug'), !!b.running);
  return c.json({ ok: true });
});

// collaborators: { add?: userIds, remove?: userIds }; anyone may remove themselves
for (const kind of ['app', 'skill'] as const) {
  api.post(`/${kind}s/:slug/collaborators`, async (c) => {
    const b = await body<{ add?: string[]; remove?: string[] }>(c);
    return c.json({ collaborators: collab.setCollaborators(c.get('user'), kind, c.req.param('slug'), { add: b.add, remove: b.remove }) });
  });
}
api.post('/skills/:slug/transfer', async (c) => {
  const b = await body<{ userId: string }>(c);
  return c.json({ collaborators: collab.transferOwnership(c.get('user'), 'skill', c.req.param('slug'), b.userId) });
});

api.post('/apps/:slug/transfer', async (c) => {
  const b = await body<{ userId: string }>(c);
  apps.transferApp(c.get('user'), c.req.param('slug'), b.userId);
  return c.json({ ok: true });
});

api.delete('/apps/:slug', async (c) => {
  const b = await body<{ confirm: string }>(c);
  if (b.confirm !== c.req.param('slug')) throw new UserError('err.confirmMismatch');
  await apps.deleteApp(c.get('user'), c.req.param('slug'));
  return c.json({ ok: true });
});

// ---- resources page ----
api.get('/library', (c) => c.json(lib.library(localeOf(c), c.get('user').role === 'admin')));
api.put('/library/culture', async (c) => c.json(lib.setCulture(c.get('user'), await body(c))));
api.post('/library/groups', async (c) => c.json({ id: lib.upsertGroup(c.get('user'), await body(c)) }));
api.patch('/library/groups/:id', async (c) => c.json({ id: lib.upsertGroup(c.get('user'), { ...(await body<object>(c)), id: Number(c.req.param('id')) } as Parameters<typeof lib.upsertGroup>[1]) }));
api.delete('/library/groups/:id', (c) => {
  lib.deleteGroup(c.get('user'), Number(c.req.param('id')));
  return c.json({ ok: true });
});
api.post('/library/resources', async (c) => c.json({ id: lib.upsertResource(c.get('user'), await body(c)) }));
api.patch('/library/resources/:id', async (c) => c.json({ id: lib.upsertResource(c.get('user'), { ...(await body<object>(c)), id: Number(c.req.param('id')) } as Parameters<typeof lib.upsertResource>[1]) }));
api.delete('/library/resources/:id', (c) => {
  lib.deleteResource(c.get('user'), Number(c.req.param('id')));
  return c.json({ ok: true });
});

// ---- people ----
api.get('/users', (c) => {
  const q = `%${c.req.query('q') ?? ''}%`;
  return c.json(all('SELECT id, name, en_name, email, avatar FROM users WHERE name LIKE ? OR en_name LIKE ? OR email LIKE ? ORDER BY name LIMIT 30', q, q, q));
});

// ---- skills ----
api.get('/skills', (c) => c.json({ skills: skills.listSkills(c.get('user'), localeOf(c)) }));

api.get('/skills/:slug', async (c) => {
  const s = skills.listSkills(c.get('user'), localeOf(c)).find((x) => x.slug === c.req.param('slug'));
  if (!s) return c.json({ error: tr(localeOf(c), 'err.skill.notFound', { slug: c.req.param('slug') }) }, 404);
  let readme = '';
  await tar.t({
    file: skills.skillFile(s.slug, s.version),
    onReadEntry: (entry) => {
      if (entry.path.replace(/^\.\//, '') === 'SKILL.md') entry.on('data', (d: Buffer) => (readme += d.toString()));
      else entry.resume();
    },
  });
  return c.json({ skill: s, versions: skills.skillVersions(s.slug), readme, feedback: feedback.feedbackFor(c.get('user'), 'skill', s.slug) });
});

api.patch('/skills/:slug', async (c) => {
  return c.json({ ok: true, ...skills.updateSkill(c.get('user'), c.req.param('slug'), await body(c)) });
});

api.delete('/skills/:slug', (c) => {
  skills.deleteSkill(c.get('user'), c.req.param('slug'));
  return c.json({ ok: true });
});

// ---- agents ----
api.post('/tokens', async (c) => {
  const b = await body<{ name?: string }>(c);
  const name = (b.name ?? '').trim().slice(0, 40) || 'Agent';
  return c.json({ token: createPersonalToken(c.get('user').id, name) });
});

api.delete('/agents/:id', (c) => {
  disconnectAgent(c.get('user').id, c.req.param('id'));
  return c.json({ ok: true });
});

// ---- Lark native app shortcuts ----
interface LarkLink { id: number; name: string; description: string; url: string; icon: string; sort: number; in_sidebar: number }
const larkLinks = () => (config.lark.enabled ? all<LarkLink>('SELECT * FROM lark_links ORDER BY sort, id') : []);

api.post('/lark-links', async (c) => {
  requireAdmin(c.get('user'));
  const b = await body<Partial<LarkLink>>(c);
  if (!b.name || !b.url || !/^https?:\/\//.test(b.url)) throw new UserError('err.larkLinkInvalid');
  run('INSERT INTO lark_links (name, description, url, icon, sort) VALUES (?, ?, ?, ?, ?)', b.name, b.description ?? '', b.url, b.icon ?? '', b.sort ?? 0);
  return c.json({ ok: true });
});

/** For the admin's picker: Lark's own features and the apps installed in the company. */
api.get('/lark-links/catalog', async (c) => {
  requireAdmin(c.get('user'));
  return c.json(await larkAppCatalog(localeOf(c)));
});

api.post('/lark-links/:id/sidebar', async (c) => {
  requireAdmin(c.get('user'));
  const b = await body<{ on?: boolean }>(c);
  run('UPDATE lark_links SET in_sidebar = ? WHERE id = ?', b.on ? 1 : 0, Number(c.req.param('id')));
  return c.json({ ok: true });
});

api.delete('/lark-links/:id', (c) => {
  requireAdmin(c.get('user'));
  run('DELETE FROM lark_links WHERE id = ?', Number(c.req.param('id')));
  return c.json({ ok: true });
});

// ---- app requests (需求)
api.get('/requests', (c) => {
  const u = c.get('user');
  const status = c.req.query('status') as requests.Status | 'all' | undefined;
  return c.json({ requests: requests.listRequests(u, localeOf(c), { status, mine: c.req.query('mine') === '1', waiting: c.req.query('waiting') === '1', query: c.req.query('q') }), waiting: requests.waitingCount(u) });
});
api.get('/requests/:id', (c) => c.json(requests.getRequest(c.get('user'), Number(c.req.param('id')), localeOf(c))));
api.post('/requests', async (c) => {
  const b = await body<{ title?: string; body?: string; due?: string | null; invite?: string | null }>(c);
  return c.json(await requests.createRequest(c.get('user'), { title: String(b.title ?? ''), body: String(b.body ?? ''), due: b.due ?? null, invite: b.invite ?? null }, localeOf(c)));
});
api.post('/requests/:id', async (c) => {
  const b = await body<requests.Action>(c);
  return c.json(await requests.actOn(c.get('user'), Number(c.req.param('id')), b, localeOf(c)));
});

// ---- admin ----
api.get('/admin', (c) => {
  requireAdmin(c.get('user'));
  const u = c.get('user');
  const pending = all<App>("SELECT * FROM apps WHERE visibility = 'public' AND public_status = 'pending'").map((a) => apps.serializeApp(a, u, localeOf(c)));
  const users = all<User>('SELECT id, name, email, avatar, role, last_seen_at FROM users ORDER BY last_seen_at DESC NULLS LAST, name');
  return c.json({ pending, users, larkLinks: larkLinks(), devLogin: config.devLogin, alertNotify: alerts.notifyMode(), okrOwner: config.lark.enabled ? okrBoard.companyOwner() : null, requestsChat: requests.requestsChat() });
});

// ---- data connections (Metabase…) and the sources read through them; admins only
api.get('/admin/connections', (c) => {
  requireAdmin(c.get('user'));
  return c.json({
    connectors: connectors.CONNECTORS.map((x) => ({ type: x.type, label: x.label, identity: x.identity, fields: x.fields, boards: !!x.board })),
    connections: connectors.listConnections().map((cn) => ({
      ...cn, imported: importedBoards(cn.id).map((b) => ({ id: b.id, title: pick(b.titles, localeOf(c)), board: b.origin.board, url: b.origin.url, updatedAt: b.updatedAt })),
    })),
    sources: dataSources.listSources(localeOf(c)).filter((s) => s.kind === 'connector'),
    departments: all<{ id: string; name: string }>('SELECT id, name FROM departments ORDER BY name'),
  });
});
api.post('/admin/connections', async (c) => {
  const b = await body<{ id?: string; type: string; config: Record<string, string> }>(c);
  return c.json(await connectors.saveConnection(c.get('user'), { id: b.id, type: String(b.type ?? ''), config: b.config ?? {} }));
});
api.post('/admin/connections/:id/test', async (c) => c.json(await connectors.testConnection(c.get('user'), c.req.param('id'))));
api.delete('/admin/connections/:id', (c) => c.json(connectors.deleteConnection(c.get('user'), c.req.param('id'))));
api.get('/admin/connections/:id/browse', async (c) => c.json(await connectors.browseConnection(c.get('user'), c.req.param('id'), c.req.query('q'))));
api.get('/admin/connections/:id/boards', async (c) => c.json(await connectors.browseBoards(c.get('user'), c.req.param('id'), c.req.query('q'))));
api.post('/admin/connections/:id/import', async (c) => {
  const b = await body<{ board: string; audience?: dataSources.Audience }>(c);
  return c.json(await importBoard(c.get('user'), c.req.param('id'), String(b.board ?? ''), { audience: b.audience, locale: localeOf(c) }));
});
api.post('/admin/data-sources', async (c) => {
  const b = await body<{ id: string; title: Record<string, string>; connection: string; item: string; audience?: dataSources.Audience }>(c);
  requireAdmin(c.get('user'));
  return c.json(await dataSources.saveSource(c.get('user'), { id: String(b.id ?? ''), title: b.title ?? {}, connection: b.connection, item: b.item, audience: b.audience }));
});
api.post('/admin/data-sources/:id/audience', async (c) => {
  const b = await body<{ audience: dataSources.Audience }>(c);
  return c.json(dataSources.setAudience(c.get('user'), c.req.param('id'), b.audience ?? {}));
});
api.delete('/admin/data-sources/:id', (c) => {
  requireAdmin(c.get('user'));
  return c.json(dataSources.deleteSource(c.get('user'), c.req.param('id')));
});

api.get('/admin/lark-chats', async (c) => {
  requireAdmin(c.get('user'));
  return c.json({ chats: config.lark.enabled ? await botChats() : [] });
});
api.post('/admin/requests-chat', async (c) => {
  const b = await body<{ chat?: { id: string; name: string; locale?: string } | null }>(c);
  requests.setRequestsChat(c.get('user'), b.chat ? { id: String(b.chat.id ?? '').trim(), name: String(b.chat.name ?? ''), locale: b.chat.locale } : null);
  return c.json({ ok: true, requestsChat: requests.requestsChat() });
});

api.post('/admin/alerts', async (c) => {
  const b = await body<{ notify?: string }>(c);
  alerts.setNotifyMode(c.get('user'), b.notify === 'everyone' ? 'everyone' : 'admins');
  return c.json({ ok: true });
});

api.post('/admin/apps/:slug/public', async (c) => {
  requireAdmin(c.get('user'));
  const b = await body<{ approve: boolean }>(c);
  const changed = run("UPDATE apps SET public_status = ?, visibility = CASE WHEN ? THEN 'public' ELSE 'company' END, updated_at = ? WHERE slug = ? AND visibility = 'public'",
    b.approve ? 'approved' : 'rejected', b.approve ? 1 : 0, now(), c.req.param('slug'));
  if (changed.changes) publicDecided(c.req.param('slug'), !!b.approve, c.get('user'));
  return c.json({ ok: true });
});

api.post('/admin/users/:id/role', async (c) => {
  const me = c.get('user');
  requireAdmin(me);
  const b = await body<{ role: 'admin' | 'member' }>(c);
  if (c.req.param('id') === me.id) throw new UserError('err.cannotChangeOwnRole');
  run('UPDATE users SET role = ? WHERE id = ?', b.role === 'admin' ? 'admin' : 'member', c.req.param('id'));
  return c.json({ ok: true });
});

api.post('/admin/sync-directory', async (c) => {
  requireAdmin(c.get('user'));
  return c.json({ synced: await syncDirectory() });
});
