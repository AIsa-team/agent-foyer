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

// ---------------------------------------------------------------- layout schema (also the MCP tool schema agents see)
const text = () => z.record(z.string(), z.string().max(400)).describe(`text per hub language (${localeCodes().join(', ')})`);
const width = z.enum(['full', 'half', 'third']).optional().describe('grid width; default full');
const source = z.object({
  app: z.string().describe('slug of a hub app the viewer can open'),
  path: z.string().startsWith('/').describe('path on that app returning JSON, e.g. /api/metrics or /data.json'),
  pick: z.string().optional().describe('dot path into the JSON, e.g. "revenue.total"'),
}).describe('live data from one of the company apps, fetched as the viewer');
const baseSource = z.object({
  data: z.string().describe('id of a Lark Base data source (see list_data_sources / save_data_source)'),
  query: querySchema,
}).describe('live numbers from a Lark Base table, read with the viewer\'s own Lark access (people only see what they can open in Lark)');
const anySource = z.union([source, baseSource]);
const format = z.object({ style: z.enum(['decimal', 'percent', 'currency']).optional(), currency: z.string().optional(), unit: z.string().optional(), decimals: z.number().int().min(0).max(4).optional() }).optional();

const moduleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('apps'), width, title: text().optional(),
    pinned: z.array(z.string()).max(24).optional().describe('app slugs (or "lark:<id>" for Lark shortcuts) shown first, in this order'),
    hidden: z.array(z.string()).max(48).optional().describe('app slugs or "lark:<id>" never shown here'),
    limit: z.number().int().min(1).max(24).optional(),
  }).describe('common apps: hub apps the viewer can open plus Lark shortcuts'),
  z.object({
    type: z.literal('stats'), width, title: text().optional(),
    items: z.array(z.object({
      label: text(), value: z.union([z.number(), z.string()]).optional(), format,
      delta: z.number().optional().describe('change as a fraction, e.g. 0.12 = +12%'), period: text().optional().describe('what the delta compares to, shown after a "vs": write "last month" / "上月", not "vs last month" / "较上月"'),
      goodWhenUp: z.boolean().optional(), trend: z.array(z.number()).max(24).optional(),
      source: anySource.optional().describe('value comes from here instead of `value`; with a Base source and query.date, the tile also gets the trend and the change from the previous bucket'),
    })).min(1).max(6),
  }).describe('a row of KPI tiles'),
  z.object({
    type: z.literal('chart'), width, title: text().optional(), subtitle: text().optional(),
    kind: z.enum(['bar', 'line', 'area', 'donut', 'ring', 'rank', 'funnel', 'waffle', 'progress', 'segment', 'slope', 'diverging', 'gantt', 'calendar']),
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
    source: anySource.optional().describe('the JSON at this source is used as `data`; Base sources work with kinds bar, line, area, donut, rank, funnel, waffle, segment, calendar (date.bucket "day" for calendar)'),
    format, height: z.number().int().min(120).max(480).optional(),
  }).describe('one chart following the hub\'s data-viz rules'),
  z.object({
    type: z.literal('links'), width, title: text().optional(),
    items: z.array(z.object({ label: text(), url: z.string().url(), icon: z.string().max(8).optional().describe('one emoji') })).min(1).max(16),
  }).describe('a list of links'),
  z.object({ type: z.literal('note'), width, title: text().optional(), body: text() }).describe('a text card (plain text, line breaks kept)'),
  z.object({
    type: z.literal('image'), width, url: z.string().url().describe('https image URL'), alt: text().optional(),
    height: z.number().int().min(80).max(600).optional(), fit: z.enum(['cover', 'contain']).optional(),
  }).describe('a picture, e.g. a team photo or anything the person likes'),
  z.object({ type: z.literal('skills'), width, title: text().optional() }).describe('Skill updates and the newest Skills'),
  z.object({ type: z.literal('resources'), width, title: text().optional() }).describe('quick links from the resources page'),
  z.object({ type: z.literal('issues'), width, title: text().optional() })
    .describe('data issues assigned to the viewer (records they need to fix), from the data checks'),
  z.object({
    type: z.literal('okr'), width, title: text().optional(),
    user: z.string().optional().describe('whose OKRs: an email or open_id; default = whoever views the page (so one department/company layout shows each person their own)'),
  }).describe('Lark OKR for the current period as a pace card (progress vs time passed) plus objectives and key results'),
  z.object({ type: z.literal('alerts'), width, title: text().optional(), showOk: z.boolean().optional().describe('also list rules that are fine (default: only firing / failing ones)') })
    .describe('alert rules on Lark Base data that the viewer owns or is told about'),
]);

export const layoutSchema = z.object({ modules: z.array(moduleSchema).max(24) });
export type Layout = z.infer<typeof layoutSchema>;

export const DEFAULT_LAYOUT: Layout = { modules: [{ type: 'apps' }, { type: 'skills', width: 'half' }, { type: 'resources', width: 'half' }] };

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
      throw new UserError('err.home.badLayout', { details: `modules.${i}.kind: "${m.kind}" cannot use a Base source (use ${CHART_KINDS.join(', ')})` });
    }
  });
  return r.data;
}

// ---------------------------------------------------------------- read / write
interface Row { scope: string; owner_id: string; layout: string; updated_at: number }

/** The home page `user` sees, and where it comes from. */
export function resolveHome(user: User, locale: string, previewToken?: string) {
  if (previewToken) {
    const p = get<{ layout: string; scope: string; owner_id: string; created_by: string; expires_at: number }>(
      'SELECT * FROM homepage_previews WHERE token_hash = ?', sha256(previewToken),
    );
    if (p && p.created_by === user.id && p.expires_at > now()) return { layout: JSON.parse(p.layout) as Layout, from: 'preview' as const, previewOf: p.scope };
  }
  const own = get<Row>("SELECT * FROM homepages WHERE scope = 'user' AND owner_id = ?", user.id);
  if (own) return { layout: JSON.parse(own.layout) as Layout, from: 'user' as const };
  for (const d of userDepartments(user, locale)) {
    const dep = get<Row>("SELECT * FROM homepages WHERE scope = 'department' AND owner_id = ?", d.id);
    if (dep) return { layout: JSON.parse(dep.layout) as Layout, from: 'department' as const, department: d.name };
  }
  const company = get<Row>("SELECT * FROM homepages WHERE scope = 'company' AND owner_id = 'company'");
  if (company) return { layout: JSON.parse(company.layout) as Layout, from: 'company' as const };
  return { layout: DEFAULT_LAYOUT, from: 'default' as const };
}

export function getHomeLayout(user: User, scope: Scope, departmentId?: string) {
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

export function saveHome(user: User, scope: Scope, layoutRaw: unknown, departmentId?: string) {
  const t = target(user, scope, departmentId);
  const layout = parseLayout(layoutRaw);
  run(`INSERT INTO homepages (scope, owner_id, layout, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, owner_id) DO UPDATE SET layout = excluded.layout, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    t.scope, t.owner, JSON.stringify(layout), user.id, now());
  return { saved: true, homeUrl: config.hubUrl };
}

export function resetHome(user: User, scope: Scope, departmentId?: string) {
  const t = target(user, scope, departmentId);
  run('DELETE FROM homepages WHERE scope = ? AND owner_id = ?', t.scope, t.owner);
  return { reset: true };
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
