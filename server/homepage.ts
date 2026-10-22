/**
 * Agent-built home pages. Each person's home is a list of modules; it falls back to their department's default,
 * then the company default, then the built-in one. Agents write layouts through MCP: preview first, then save.
 */
import { z } from 'zod';
import { appUrl, config } from './config.ts';
import { randomToken, sha256 } from './crypto.ts';
import { all, get, now, run, type App, type User } from './db.ts';
import { UserError } from './i18n/index.ts';
import { localeCodes } from './localized.ts';
import { canAccessApp } from './apps/access.ts';
import { fetchFromApp } from './gateway.ts';
import { pick as pickText } from './library.ts';
import { CHART_KINDS, querySchema } from './data/query.ts';
import { githubEnabled } from './github/app.ts';
import { canReadSource, type SourceRow } from './data/sources.ts';
import { connection } from './lark/userToken.ts';

// ---------------------------------------------------------------- layout schema (also the MCP tool schema agents see)
const text = () => z.record(z.string(), z.string().max(400)).describe(`text per hub language (${localeCodes().join(', ')})`);
/** longer text per language, for notes (e.g. how numbers are counted) */
export const NOTE_MAX = 4000;
const longText = () => z.record(z.string(), z.string().max(NOTE_MAX)).describe(`text per hub language (${localeCodes().join(', ')}), up to ${NOTE_MAX} characters`);
const width = z.enum(['full', 'half', 'third']).optional().describe('grid width; default full');
const moduleId = z.string().regex(/^[\w-]{1,40}$/).optional()
  .describe('stable id of the module; keep the ids get_homepage returns so personal adjustments (hidden, width, order) stay attached. New modules get one when saved');
const source = z.object({
  app: z.string().describe('slug of a hub app the viewer can open'),
  path: z.string().startsWith('/').describe('path on that app returning JSON, e.g. /api/metrics or /data.json'),
  pick: z.string().optional().describe('dot path into the JSON, e.g. "revenue.total"'),
}).describe('live data from one of the company apps, fetched as the viewer');
const baseSource = z.object({
  data: z.string().describe('id of a registered data source (see list_data_sources / save_data_source)'),
  query: querySchema,
}).describe('live numbers from a registered data source (a Lark Base table or a data app), read as the viewer (people only see what they may open)');
const anySource = z.union([source, baseSource]);
const format = z.object({ style: z.enum(['decimal', 'percent', 'currency']).optional(), currency: z.string().optional(), unit: z.string().optional(), decimals: z.number().int().min(0).max(4).optional() }).optional();

const moduleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('apps'), id: moduleId, width, title: text().optional(),
    pinned: z.array(z.string()).max(24).optional().describe('app slugs (or "lark:<id>" for Lark shortcuts) shown first, in this order'),
    hidden: z.array(z.string()).max(48).optional().describe('app slugs or "lark:<id>" never shown here'),
    limit: z.number().int().min(1).max(24).optional(),
  }).describe('common apps: hub apps the viewer can open plus Lark shortcuts'),
  z.object({
    type: z.literal('stats'), id: moduleId, width, title: text().optional(),
    items: z.array(z.object({
      label: text(), value: z.union([z.number(), z.string()]).optional(), format,
      delta: z.number().optional().describe('change as a fraction, e.g. 0.12 = +12%'), period: text().optional().describe('what the delta compares to, shown after a "vs": write "last month" / "上月", not "vs last month" / "较上月"'),
      goodWhenUp: z.boolean().optional(), trend: z.array(z.number()).max(24).optional(),
      source: anySource.optional().describe('value comes from here instead of `value`; with a data source and query.date, the tile also gets the trend and the change from the previous bucket'),
    })).min(1).max(6),
  }).describe('a row of KPI tiles'),
  z.object({
    type: z.literal('chart'), id: moduleId, width, title: text().optional(), subtitle: text().optional(),
    kind: z.enum(['bar', 'line', 'area', 'donut', 'ring', 'rank', 'funnel', 'waffle', 'progress', 'segment', 'slope', 'diverging', 'gantt', 'calendar']),
    stacked: z.boolean().optional().describe('bar / area with several series: stack them, so each bar shows the total'),
    data: z.record(z.string(), z.unknown()).optional().describe([
      'chart config by kind:',
      'bar {categories, series:[{name,values}], stacked?, orientation?, plan?:[...], target?, accent?:"last"};',
      'line/area {labels, series:[{name,values,forecastFrom?}], target?};',
      'donut {items:[{name,value}]}; ring {items:[{label,value,max,sub}]} (row of KPI rings);',
      'rank {items:[{name,sub,value}], highlight:"top"}; funnel {stages:[{name,value}]}; waffle {items:[{name,value}], total};',
      'progress {items:[{label,value,target}]} (key results); segment {items:[{name,value}]}; slope {startLabel,endLabel,series:[{name,start,end}]};',
      'diverging {categories, values}; gantt {tasks:[{name,owner,start,end,progress,milestone?}], today}; calendar {data:[{date,value}], start, end}.',
      'Charts are ink by default with orange for the highlight; follow the data-viz rules (no rainbow, ≤ 8 series).',
    ].join(' ')),
    source: anySource.optional().describe('the JSON at this source is used as `data`; data sources work with kinds bar, line, area, donut, rank, funnel, waffle, segment, calendar (date.bucket "day" for calendar)'),
    format, height: z.number().int().min(120).max(480).optional(),
  }).describe('one chart following the hub\'s data-viz rules'),
  z.object({
    type: z.literal('links'), id: moduleId, width, title: text().optional(),
    items: z.array(z.object({ label: text(), url: z.string().url(), icon: z.string().max(8).optional().describe('one emoji') })).min(1).max(16),
  }).describe('a list of links'),
  z.object({ type: z.literal('note'), id: moduleId, width, title: text().optional(), body: longText() }).describe('a text card (plain text, line breaks kept)'),
  z.object({
    type: z.literal('image'), id: moduleId, width, url: z.string().url().describe('https image URL'), alt: text().optional(),
    height: z.number().int().min(80).max(600).optional(), fit: z.enum(['cover', 'contain']).optional(),
  }).describe('a picture, e.g. a team photo or anything the person likes'),
  z.object({ type: z.literal('skills'), id: moduleId, width, title: text().optional() }).describe('Skill updates and the newest Skills'),
  z.object({ type: z.literal('resources'), id: moduleId, width, title: text().optional() }).describe('quick links from the resources page'),
  z.object({ type: z.literal('issues'), id: moduleId, width, title: text().optional() })
    .describe('data issues assigned to the viewer (records they need to fix), from the data checks'),
  z.object({ type: z.literal('requests'), id: moduleId, width, title: text().optional(), limit: z.number().int().min(1).max(10).optional().describe('requests shown (default 5)') })
    .describe('app requests (需求) waiting for someone: the pool, and invitations to the viewer, with a way to ask for an app'),
  z.object({
    type: z.literal('okr'), id: moduleId, width, title: text().optional(),
    user: z.string().optional().describe('whose OKRs: an email or open_id; default = whoever views the page (so one department/company layout shows each person their own)'),
  }).describe('Lark OKR for the current period as a pace card (progress vs time passed) plus objectives and key results'),
  z.object({ type: z.literal('alerts'), id: moduleId, width, title: text().optional(), showOk: z.boolean().optional().describe('also list rules that are fine (default: only firing / failing ones)') })
    .describe('alert rules on data sources that the viewer owns or is told about'),
  z.object({
    type: z.literal('table'), id: moduleId, width, title: text().optional(),
    source: z.object({
      data: z.string().describe('id of a registered data source'),
      where: querySchema.shape.where,
      sort: z.object({ field: z.string(), desc: z.boolean().optional() }).optional(),
      fields: z.array(z.string()).max(12).optional().describe('columns to show, in order (default: all)'),
    }),
    limit: z.number().int().min(1).max(50).optional().describe('rows shown (default 10); the whole table is a click away'),
  }).describe('a table of a data source\'s records, read as the viewer, linking to all of them'),
  z.object({
    type: z.literal('github'), id: moduleId, width, title: text().optional(),
    weeks: z.number().int().min(4).max(53).optional().describe('how far back the calendar goes; default 52 (a year)'),
  }).describe('the viewer\'s own GitHub contributions in the company organisation: a calendar heatmap with commits, pull requests, reviews, streak and top repositories (each person sees their own; asks them to connect GitHub if they have not)'),
]);

export const layoutSchema = z.object({ modules: z.array(moduleSchema).max(24) });
export type Layout = z.infer<typeof layoutSchema>;

export const DEFAULT_LAYOUT: Layout = { modules: [{ type: 'apps', id: 'apps' }, { type: 'skills', id: 'skills', width: 'half' }, { type: 'resources', id: 'resources', width: 'half' }] };
type Module = Layout['modules'][number];

/** Modules saved before ids existed get one from their place, so they stay the same until the layout changes. */
const withIds = (l: Layout): Layout => ({ modules: l.modules.map((m, i) => ({ ...m, id: m.id ?? `${m.type}-${i}` })) });

/** Ids for modules that have none, unique within the layout, kept from then on. */
function assignIds(l: Layout): Layout {
  const used = new Set(l.modules.map((m) => m.id).filter(Boolean));
  return {
    modules: l.modules.map((m) => {
      if (m.id && used.has(m.id) && l.modules.filter((x) => x.id === m.id).length === 1) return m;
      let id: string;
      do id = `${m.type}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, '')}`; while (used.has(id));
      used.add(id);
      return { ...m, id };
    }),
  };
}

// ---------------------------------------------------------------- departments & permissions
export interface Dept { id: string; name: string; name_i18n: string | null; leader_ids: string | null }

export function userDepartments(user: User, locale: string) {
  return all<Dept>('SELECT d.* FROM user_departments ud JOIN departments d ON d.id = ud.department_id WHERE ud.user_id = ? ORDER BY d.name', user.id)
    .map((d) => ({ id: d.id, name: deptName(d, locale), canEdit: canEditDepartment(user, d) }));
}

/** Departments a person can configure: the ones they lead, or every one for admins. */
export function editableDepartments(user: User, locale: string) {
  const rows = all<Dept>('SELECT * FROM departments ORDER BY name');
  return rows.filter((d) => canEditDepartment(user, d)).map((d) => ({ id: d.id, name: deptName(d, locale) }));
}

function deptName(d: Dept, locale: string) {
  const i18n = d.name_i18n ? (JSON.parse(d.name_i18n) as Record<string, string>) : {};
  return pickText(i18n, locale) || d.name;
}

export function canEditDepartment(user: User, d: Dept) {
  if (user.role === 'admin') return true;
  const leaders = d.leader_ids ? (JSON.parse(d.leader_ids) as string[]) : [];
  return leaders.includes(user.id);
}

export type Scope = 'me' | 'department' | 'company';

function target(user: User, scope: Scope, departmentId?: string): { scope: 'user' | 'department' | 'company'; owner: string } {
  if (scope === 'me') return { scope: 'user', owner: user.id };
  if (scope === 'company') {
    if (user.role !== 'admin') throw new UserError('err.adminOnly');
    return { scope: 'company', owner: 'company' };
  }
  const d = get<Dept>('SELECT * FROM departments WHERE id = ?', departmentId ?? '');
  if (!d) throw new UserError('err.home.departmentNotFound', { id: departmentId ?? '' });
  if (!canEditDepartment(user, d)) throw new UserError('err.home.notDepartmentLeader', { name: d.name });
  return { scope: 'department', owner: d.id };
}

export function parseLayout(raw: unknown): Layout {
  const r = layoutSchema.safeParse(raw);
  if (!r.success) throw new UserError('err.home.badLayout', { details: r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  r.data.modules.forEach((m, i) => {
    if (m.type === 'chart' && m.source && 'data' in m.source && !(CHART_KINDS as readonly string[]).includes(m.kind)) {
      throw new UserError('err.home.badLayout', { details: `modules.${i}.kind: "${m.kind}" cannot use a data source (use ${CHART_KINDS.join(', ')})` });
    }
    if (m.type === 'okr' && !config.lark.enabled) throw new UserError('err.lark.disabled');
    if (m.type === 'github' && !githubEnabled()) throw new UserError('err.github.disabled');
  });
  return r.data;
}

// ---------------------------------------------------------------- read / write
interface Row { scope: string; owner_id: string; layout: string; updated_at: number }

/** The home page `user` sees, and where it comes from. */
/** What a person's page builds on: their department's layout, else the company's, else the built-in one. */
export function baseHome(user: User, locale: string) {
  for (const d of userDepartments(user, locale)) {
    const dep = get<Row>("SELECT * FROM homepages WHERE scope = 'department' AND owner_id = ?", d.id);
    if (dep) return { layout: withIds(JSON.parse(dep.layout) as Layout), from: 'department' as const, department: d.name };
  }
  const company = get<Row>("SELECT * FROM homepages WHERE scope = 'company' AND owner_id = 'company'");
  if (company) return { layout: withIds(JSON.parse(company.layout) as Layout), from: 'company' as const };
  return { layout: DEFAULT_LAYOUT, from: 'default' as const };
}

/**
 * A person's own changes on top of the shared layout: modules hidden, widths, the order, and modules of their own.
 * The shared layout stays underneath, so what the company or department adds later shows up for them too.
 */
export interface Adjustments { hidden: string[]; widths: Record<string, Module['width']>; order: string[]; extra: Module[] }
interface AdjRow { user_id: string; hidden: string; widths: string; order_ids: string; extra: string; updated_at: number }

export function adjustmentsOf(user: User): Adjustments | null {
  const r = get<AdjRow>('SELECT * FROM home_adjustments WHERE user_id = ?', user.id);
  return r ? { hidden: JSON.parse(r.hidden), widths: JSON.parse(r.widths), order: JSON.parse(r.order_ids), extra: JSON.parse(r.extra) } : null;
}

function saveAdjustments(user: User, a: Adjustments) {
  run(`INSERT INTO home_adjustments (user_id, hidden, widths, order_ids, extra, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET hidden = excluded.hidden, widths = excluded.widths, order_ids = excluded.order_ids, extra = excluded.extra, updated_at = excluded.updated_at`,
    user.id, JSON.stringify(a.hidden), JSON.stringify(a.widths), JSON.stringify(a.order), JSON.stringify(a.extra), now());
}

/** The shared layout with a person's changes applied. Shared modules missing from their order go after the one before them. */
export function applyAdjustments(base: Layout, a: Adjustments | null) {
  const shared = base.modules;
  if (!a) return { modules: shared.map((m) => ({ ...m, own: false })), hidden: [] as Module[] };
  const byId = new Map<string, Module>([...shared, ...a.extra].map((m) => [m.id!, m]));
  const order = a.order.filter((id) => byId.has(id));
  shared.forEach((m, i) => {
    if (order.includes(m.id!)) return;
    const prev = shared.slice(0, i).reverse().find((x) => order.includes(x.id!));
    order.splice(prev ? order.indexOf(prev.id!) + 1 : 0, 0, m.id!);
  });
  for (const m of a.extra) if (!order.includes(m.id!)) order.push(m.id!);
  const own = new Set(a.extra.map((m) => m.id));
  const hidden = new Set(a.hidden);
  return {
    modules: order.filter((id) => !hidden.has(id)).map((id) => ({ ...byId.get(id)!, width: a.widths[id] ?? byId.get(id)!.width, own: own.has(id) })),
    hidden: shared.filter((m) => hidden.has(m.id!)),
  };
}

export function resolveHome(user: User, locale: string, previewToken?: string) {
  if (previewToken) {
    const p = get<{ layout: string; scope: string; owner_id: string; created_by: string; expires_at: number }>(
      'SELECT * FROM homepage_previews WHERE token_hash = ?', sha256(previewToken),
    );
    if (p && p.created_by === user.id && p.expires_at > now()) return { layout: JSON.parse(p.layout) as Layout, from: 'preview' as const, previewOf: p.scope, hidden: [] as Module[], adjusted: false };
  }
  // a whole page of their own, saved before personal adjustments existed
  const own = get<Row>("SELECT * FROM homepages WHERE scope = 'user' AND owner_id = ?", user.id);
  if (own) return { layout: withIds(JSON.parse(own.layout) as Layout), from: 'user' as const, hidden: [] as Module[], adjusted: true };
  const base = baseHome(user, locale);
  const adj = adjustmentsOf(user);
  const r = applyAdjustments(base.layout, adj);
  return { ...base, layout: { modules: r.modules }, hidden: r.hidden, adjusted: !!adj };
}

/**
 * Turns a whole layout a person (or their agent) wants into adjustments of the shared one: shared modules they left
 * out are hidden, changed widths kept, everything else (new modules, or shared ones they changed) is their own.
 */
function toAdjustments(base: Layout, wanted: Layout): Adjustments {
  const shared = new Map(base.modules.map((m) => [m.id!, m]));
  // compared without width and regardless of key order (layouts come back from the parser with keys in schema order)
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).filter(([k, x]) => x !== undefined && k !== 'width' && k !== 'own').sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)])) : v;
  const same = (a: Module, b: Module) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  const mods = wanted.modules.map((m) => {
    const s = m.id ? shared.get(m.id) : undefined;
    // a shared module they changed becomes theirs (the shared one is then hidden)
    return s && !same(s, m) ? { ...m, id: undefined } : m;
  });
  const withNew = assignIds({ modules: mods }).modules;
  const kept = new Set(withNew.map((m) => m.id));
  const widths: Adjustments['widths'] = {};
  for (const m of withNew) {
    const s = shared.get(m.id!);
    if (s && (m.width ?? 'full') !== (s.width ?? 'full')) widths[m.id!] = m.width ?? 'full';
  }
  return {
    hidden: [...shared.keys()].filter((id) => !kept.has(id)),
    widths,
    order: withNew.map((m) => m.id!),
    extra: withNew.filter((m) => !shared.has(m.id!)),
  };
}

/** Small changes from the page itself: hide or show a shared module, change a width, move, remove one of their own. */
export function adjustHome(user: User, locale: string, change: { hide?: string; show?: string; width?: { id: string; width: Module['width'] }; order?: string[]; remove?: string }) {
  const own = get<Row>("SELECT * FROM homepages WHERE scope = 'user' AND owner_id = ?", user.id);
  const base = baseHome(user, locale).layout;
  // an old whole page of their own becomes adjustments first
  const a: Adjustments = own ? toAdjustments(base, withIds(JSON.parse(own.layout) as Layout)) : adjustmentsOf(user) ?? { hidden: [], widths: {}, order: base.modules.map((m) => m.id!), extra: [] };
  if (own) run("DELETE FROM homepages WHERE scope = 'user' AND owner_id = ?", user.id);
  const known = new Set([...base.modules, ...a.extra].map((m) => m.id));
  const check = (id?: string) => { if (id && !known.has(id)) throw new UserError('err.home.noModule', { id }); };
  check(change.hide); check(change.show); check(change.width?.id); check(change.remove);
  if (change.hide) {
    if (a.extra.some((m) => m.id === change.hide)) a.extra = a.extra.filter((m) => m.id !== change.hide);
    else if (!a.hidden.includes(change.hide)) a.hidden.push(change.hide);
  }
  if (change.show) a.hidden = a.hidden.filter((id) => id !== change.show);
  if (change.width) a.widths[change.width.id] = change.width.width;
  if (change.order) a.order = change.order.filter((id) => known.has(id));
  if (change.remove) a.extra = a.extra.filter((m) => m.id !== change.remove);
  saveAdjustments(user, a);
  return resolveHome(user, locale);
}

export function getHomeLayout(user: User, scope: Scope, departmentId?: string, locale = config.defaultLocale) {
  if (scope === 'me') {
    // their page as they see it: shared modules (own: false) with their changes, and their own modules
    const r = resolveHome(user, locale);
    return { scope, layout: r.layout, builtOn: r.from, hiddenShared: r.hidden.map((m) => ({ id: m.id, type: m.type })), adjusted: r.adjusted };
  }
  const t = target(user, scope, departmentId);
  const row = get<Row>('SELECT * FROM homepages WHERE scope = ? AND owner_id = ?', t.scope, t.owner);
  return { scope, departmentId, layout: row ? (JSON.parse(row.layout) as Layout) : null, updatedAt: row?.updated_at ?? null };
}

export function previewHome(user: User, scope: Scope, layoutRaw: unknown, departmentId?: string) {
  const t = target(user, scope, departmentId);
  const layout = parseLayout(layoutRaw);
  const token = randomToken(18);
  run('DELETE FROM homepage_previews WHERE expires_at < ?', now());
  run('INSERT INTO homepage_previews (token_hash, scope, owner_id, layout, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    sha256(token), t.scope, t.owner, JSON.stringify(layout), user.id, now() + 24 * 3600 * 1000);
  return { previewUrl: `${config.hubUrl}/?preview=${token}`, modules: layout.modules.length };
}

export function saveHome(user: User, scope: Scope, layoutRaw: unknown, departmentId?: string, locale = config.defaultLocale) {
  const t = target(user, scope, departmentId);
  if (scope === 'me') {
    saveAdjustments(user, toAdjustments(baseHome(user, locale).layout, parseLayout(layoutRaw)));
    run("DELETE FROM homepages WHERE scope = 'user' AND owner_id = ?", user.id);
    return { saved: true, homeUrl: config.hubUrl };
  }
  const layout = assignIds(parseLayout(layoutRaw));
  run(`INSERT INTO homepages (scope, owner_id, layout, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, owner_id) DO UPDATE SET layout = excluded.layout, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    t.scope, t.owner, JSON.stringify(layout), user.id, now());
  return { saved: true, homeUrl: config.hubUrl };
}

export function resetHome(user: User, scope: Scope, departmentId?: string) {
  const t = target(user, scope, departmentId);
  if (scope === 'me') run('DELETE FROM home_adjustments WHERE user_id = ?', user.id);
  run('DELETE FROM homepages WHERE scope = ? AND owner_id = ?', t.scope, t.owner);
  return { reset: true };
}

// ---------------------------------------------------------------- what this viewer may see
/**
 * Leaves out shared modules (and KPI tiles) whose data the viewer may not read, so one company or department layout
 * suits everyone: those who may see revenue get the revenue row, others simply do not. Their own modules stay, with
 * the usual "no access" note. Lark tables are only checked once the person has connected Lark (before that the
 * module asks them to connect).
 */
export async function forViewer<M extends Module & { own?: boolean }>(user: User, modules: M[]): Promise<M[]> {
  const larkConnected = connection(user.id).connected;
  const memo = new Map<string, Promise<boolean>>();
  const readable = (src: unknown): Promise<boolean> => {
    if (!src || typeof src !== 'object') return Promise.resolve(true);
    if ('app' in src) {
      const app = get<App>('SELECT * FROM apps WHERE slug = ?', String((src as { app: string }).app));
      return Promise.resolve(!!app && canAccessApp(app, user));
    }
    const id = String((src as { data?: string }).data ?? '');
    if (!memo.has(id)) {
      const s = get<SourceRow>('SELECT * FROM data_sources WHERE id = ?', id);
      memo.set(id, !s ? Promise.resolve(false) : s.kind === 'base' && !larkConnected ? Promise.resolve(true) : canReadSource(user, s));
    }
    return memo.get(id)!;
  };
  const out = await Promise.all(modules.map(async (m) => {
    if (m.own) return m;
    if (m.type === 'chart' || m.type === 'table') return (await readable(m.source)) ? m : null;
    if (m.type === 'stats') {
      const items = (await Promise.all(m.items.map(async (it) => ((await readable(it.source)) ? it : null)))).filter((x) => x !== null);
      return items.length ? { ...m, items } : null;
    }
    return m;
  }));
  return out.filter((m): m is NonNullable<typeof m> => m !== null) as M[];
}

// ---------------------------------------------------------------- live data from apps
function pickPath(json: unknown, path?: string): unknown {
  if (!path) return json;
  return path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), json);
}

/** Fetches JSON from an app the viewer can open, as the viewer. */
export async function readSource(user: User, src: { app: string; path: string; pick?: string }) {
  const app = get<App>('SELECT * FROM apps WHERE slug = ?', src.app);
  if (!app || !canAccessApp(app, user)) throw new UserError('err.home.sourceDenied', { app: src.app });
  if (app.status !== 'online') throw new UserError('err.home.sourceOffline', { app: src.app });
  const json = await fetchFromApp(app, src.path, user);
  return { value: pickPath(json, src.pick), from: `${appUrl(app.slug)}${src.path}` };
}
