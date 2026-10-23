/**
 * Named data sources for home pages, boards, metric alerts and data checks. Three kinds:
 *
 * - base: a Lark Base table, always read with the viewer's own Lark access, so people only see rows they could open
 *   in Lark.
 * - app: rows served by one of the company's hub apps (anything an agent built: a Metabase question, a database
 *   query, a CRM export…). The app answers GET <path> with { rows: [...] } (or a bare array) of plain JSON objects;
 *   optional `_id` and `_url` on a row identify it and link back to where it lives. The hub requests it as the viewer
 *   (the same identity headers a browser request gets), and only for people allowed to open the app.
 *
 * - connector: an item in another system read through a connection an admin set up (a Metabase question, a
 *   read-only SQL query…), with one shared key. Anyone may register one; the hub decides who may read it: admins,
 *   whoever registered it, plus its audience (the company, chosen people, departments), which only admins set.
 *   See ./connectors.
 *
 * - combined: two other sources joined on matching fields or stacked into one (when an admin turned combining on).
 *   Each part is read as the viewer, so a combined source never shows anyone more than its parts would.
 *
 * All kinds come out as fields + rows, so queries, charts, alerts and checks treat them alike.
 */
import { existsSync, readFileSync, rmSync, writeFile } from 'node:fs';
import { inspectSheet, parseSheetUrl, resolveSpreadsheet, wikiObject } from '../lark/sheets.ts';
import path from 'node:path';
import { gunzipSync, gzip } from 'node:zlib';
import { appUrl, config, paths } from '../config.ts';
import { get, all, now, run, type App, type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { pick } from '../library.ts';
import { localeCodes } from '../localized.ts';
import { canAccessApp } from '../apps/access.ts';
import { fetchFromApp } from '../gateway.ts';
import { filterRows, runQuery, toChart, toStat, type DataChartKind, type Query, type Result } from './query.ts';
import { connectionConfig } from './connectors/index.ts';
import { z } from 'zod';
import { fetchRecords, isAdvanced, listFields, listTables, parseBaseUrl, pickTable, resolveAppToken, searchRecords } from '../lark/base.ts';
import { FIELD, isDateField, plainText, type Field, type Condition } from './fields.ts';

export interface SourceRow {
  id: string; title_i18n: string; url: string; kind: 'base' | 'app' | 'connector' | 'combined'; app_token: string; table_id: string; view_id: string | null;
  app_slug: string | null; app_path: string | null; connection_id: string | null; item: string | null; audience: string | null;
  description_i18n: string | null; description_manual: number;
  owner_id: string; created_at: number; updated_at: number;
}
const descriptionOf = (s: Pick<SourceRow, 'description_i18n'>, locale: string) => (s.description_i18n ? pick(JSON.parse(s.description_i18n), locale) || undefined : undefined);
/** Who besides admins may read a connector source. Nothing set = admins only. */
export const audienceSchema = z.object({
  company: z.boolean().optional().describe('everyone in the company'),
  people: z.array(z.string()).max(200).optional().describe('colleagues (email, name or open_id)'),
  departments: z.array(z.string()).max(50).optional().describe('department ids'),
});
export type Audience = { company?: boolean; people?: string[]; departments?: string[] };
const audienceOf = (s: SourceRow): Audience => (s.audience ? JSON.parse(s.audience) as Audience : {});
export interface Row { id: string; url?: string; fields: Record<string, unknown> }
export interface Table { fields: Field[]; rows: Row[] }

const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;

// ---------------------------------------------------------------- combined sources (hub-wide switch, off by default)
export function combineEnabled(): boolean {
  return get<{ value: string }>("SELECT value FROM settings WHERE key = 'data.combine'")?.value === 'on';
}
export function setCombineEnabled(user: User, on: boolean) {
  if (user.role !== 'admin') throw new UserError('err.adminOnly');
  run(`INSERT INTO settings (key, value, updated_at) VALUES ('data.combine', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, on ? 'on' : 'off', now());
  for (const c of all<{ id: string }>("SELECT id FROM data_sources WHERE kind = 'combined'")) clearCache(c.id);
}

export const combineSchema = z.object({
  sources: z.array(z.string()).length(2).describe('ids of the two data sources: [left, right]'),
  mode: z.enum(['join', 'union']).describe('join: put the right source\'s fields next to each left row with matching values; union: rows of both, one under the other'),
  on: z.array(z.object({ left: z.string(), right: z.string() })).min(1).max(3).optional().describe('join: field pairs that must match (compared as text, ignoring case and surrounding spaces)'),
  how: z.enum(['left', 'inner']).optional().describe('join: left keeps left rows without a match (default), inner drops them'),
  label: z.string().max(40).optional().describe('union: name of the added field saying which source a row came from (default "source")'),
});
export type Combine = z.infer<typeof combineSchema>;
const MAX_COMBINED_ROWS = 100_000;

const combineOf = (s: SourceRow): Combine => JSON.parse(s.item ?? '{}') as Combine;

/** Checks a definition against the two sources as they are now, read by `user`. */
async function checkCombine(user: User, c: Combine, id: string) {
  const parts = c.sources.map((sid) => {
    if (sid === id) throw new UserError('err.data.combineSelf');
    const src = getSource(sid);
    if (src.kind === 'combined') throw new UserError('err.data.combineNested', { id: sid });
    return src;
  });
  if (c.mode === 'join' && !c.on?.length) throw new UserError('err.data.combineOn');
  const [a, b] = await Promise.all(parts.map((src) => loadTable(user, src)));
  for (const pair of c.mode === 'join' ? c.on ?? [] : []) {
    if (!a.fields.some((f) => f.name === pair.left)) throw new UserError('err.data.noField', { field: pair.left, role: 'on.left', fields: a.fields.map((f) => f.name).join(', ') });
    if (!b.fields.some((f) => f.name === pair.right)) throw new UserError('err.data.noField', { field: pair.right, role: 'on.right', fields: b.fields.map((f) => f.name).join(', ') });
  }
  return combineTables(c, parts, a, b);
}

/** The two tables made into one: joined on the `on` fields, or stacked. */
function combineTables(c: Combine, parts: SourceRow[], a: Table, b: Table): Table {
  const keyOf = (t: Table, names: string[]) => {
    const fs = names.map((n) => t.fields.find((f) => f.name === n));
    return (r: Row) => fs.map((f) => (f ? String(plainText(r.fields[f.name], f) ?? '').trim().toLowerCase() : '')).join('\u0000');
  };
  if (c.mode === 'union') {
    const label = c.label?.trim() || 'source';
    const titleOf = (src: SourceRow) => pick(JSON.parse(src.title_i18n), config.defaultLocale) || src.id;
    const fields: Field[] = [...a.fields];
    for (const f of b.fields) if (!fields.some((x) => x.name === f.name)) fields.push(f);
    if (!fields.some((f) => f.name === label)) fields.push({ id: label, name: label, type: FIELD.text, uiType: 'Text' });
    const rows = [
      ...a.rows.map((r) => ({ ...r, id: r.id ? `a:${r.id}` : '', fields: { ...r.fields, [label]: titleOf(parts[0]) } })),
      ...b.rows.map((r) => ({ ...r, id: r.id ? `b:${r.id}` : '', fields: { ...r.fields, [label]: titleOf(parts[1]) } })),
    ];
    if (rows.length > MAX_COMBINED_ROWS) throw new UserError('err.data.combineTooBig', { n: MAX_COMBINED_ROWS });
    return { fields, rows };
  }
  const on = c.on ?? [];
  const rightKeys = new Set(on.map((p) => p.right));
  // right fields that clash with a left one are named after their source: "amount (crm-orders)"
  const rename = new Map(b.fields.filter((f) => !rightKeys.has(f.name)).map((f) => [f.name, a.fields.some((x) => x.name === f.name) ? `${f.name} (${parts[1].id})` : f.name]));
  const fields: Field[] = [...a.fields, ...b.fields.filter((f) => rename.has(f.name)).map((f) => ({ ...f, id: rename.get(f.name)!, name: rename.get(f.name)! }))];
  const leftKey = keyOf(a, on.map((p) => p.left)), rightKey = keyOf(b, on.map((p) => p.right));
  const index = new Map<string, Row[]>();
  for (const r of b.rows) {
    const k = rightKey(r);
    if (!k.replace(/\u0000/g, '')) continue;
    index.set(k, [...(index.get(k) ?? []), r]);
  }
  const rows: Row[] = [];
  for (const l of a.rows) {
    const k = leftKey(l);
    const matches = k.replace(/\u0000/g, '') ? index.get(k) ?? [] : [];
    if (!matches.length && c.how !== 'inner') rows.push(l);
    for (const m of matches) {
      rows.push({ id: l.id && m.id ? `${l.id}|${m.id}` : l.id, url: l.url ?? m.url, fields: { ...l.fields, ...Object.fromEntries([...rename].map(([from, to]) => [to, m.fields[from]])) } });
    }
    if (rows.length > MAX_COMBINED_ROWS) throw new UserError('err.data.combineTooBig', { n: MAX_COMBINED_ROWS });
  }
  return { fields, rows };
}

async function combinedTable(user: User, s: SourceRow, fresh: boolean): Promise<Table> {
  if (!combineEnabled()) throw new UserError('err.data.combineOff');
  const c = combineOf(s);
  const parts = c.sources.map((sid) => getSource(sid));
  const [a, b] = await Promise.all(parts.map((src) => loadTable(user, src, fresh)));
  return combineTables(c, parts, a, b);
}

export function getSource(id: string): SourceRow {
  const s = get<SourceRow>('SELECT * FROM data_sources WHERE id = ?', id);
  if (!s) throw new UserError('err.data.sourceNotFound', { id });
  return s;
}

const canEdit = (u: User, s: SourceRow) => u.role === 'admin' || s.owner_id === u.id;

/**
 * The sources registered in the hub. Connector sources the person may not read are left out (whether someone can
 * open a Lark table or an app is checked when it is read).
 */
export function listSources(locale: string, viewer?: User) {
  return all<SourceRow & { owner_name: string; owner_role: string }>('SELECT d.*, u.name AS owner_name, u.role AS owner_role FROM data_sources d JOIN users u ON u.id = d.owner_id ORDER BY d.created_at')
    .filter((s) => !viewer || s.kind !== 'connector' || mayReadConnector(viewer, s))
    .map((s) => ({
      id: s.id, title: pick(JSON.parse(s.title_i18n), locale), kind: s.kind, url: s.url, owner: s.owner_name,
      // a member's own connector source is also theirs to read
      ...(s.kind === 'connector' && s.owner_role !== 'admin' ? { ownerReads: true } : {}),
      ...(descriptionOf(s, locale) ? { description: descriptionOf(s, locale) } : {}),
      ...(s.kind === 'app' ? { app: s.app_slug, path: s.app_path }
        : s.kind === 'connector' ? { connection: s.connection_id, item: s.item, audience: describeAudience(audienceOf(s)) }
        : s.kind === 'combined' ? { combine: combineOf(s) }
        : { table: s.table_id, view: s.view_id }),
    }));
}

/** Audience with people and departments named, for lists. */
function describeAudience(a: Audience) {
  return {
    company: !!a.company,
    people: (a.people ?? []).map((id) => ({ id, name: get<{ name: string }>('SELECT name FROM users WHERE id = ?', id)?.name ?? id })),
    departments: (a.departments ?? []).map((id) => ({ id, name: get<{ name: string }>('SELECT name FROM departments WHERE id = ?', id)?.name ?? id })),
  };
}

/** Admins, whoever registered it, and its audience. */
export function mayReadConnector(user: User, s: SourceRow): boolean {
  if (user.role === 'admin' || s.owner_id === user.id) return true;
  const a = audienceOf(s);
  if (a.company) return true;
  if (a.people?.includes(user.id)) return true;
  if (a.departments?.length) {
    const mine = all<{ department_id: string }>('SELECT department_id FROM user_departments WHERE user_id = ?', user.id).map((r) => r.department_id);
    if (a.departments.some((d) => mine.includes(d))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- rows through a connection (one shared key)
const SHARED_TTL = config.connectorRefreshMs;
const shared = new Map<string, { at: number; value: Promise<Table> }>();

/**
 * Everyone allowed gets the same rows, so they are fetched once for all of them. Some questions take minutes in the
 * other system: pages get the last rows at once and a refresh runs in the background once they are a few minutes
 * old (checks and alerts, which ask for fresh rows, wait for it).
 */
const refreshingShared = new Map<string, Promise<Table>>();
function connectorTable(s: SourceRow, fresh: boolean): Promise<Table> {
  const hit = shared.get(s.id);
  const refresh = () => {
    const running = refreshingShared.get(s.id);
    if (running) return running;
    const value = (async () => {
      const { connector, cfg } = connectionConfig(s.connection_id ?? '');
      const got = await connector.fetch(cfg, s.item ?? '');
      return normalizeAppRows({ rows: got.rows, fields: got.fields });
    })();
    refreshingShared.set(s.id, value);
    // a failed refresh keeps serving the last good rows
    value.then((t) => {
      shared.set(s.id, { at: Date.now(), value: Promise.resolve(t) });
      gzip(JSON.stringify({ at: Date.now(), table: t }), (err, buf) => { if (!err) writeFile(snapshotFile(`conn-${s.id}`), buf, { mode: 0o600 }, () => {}); });
    }, () => {}).finally(() => refreshingShared.delete(s.id));
    return value;
  };
  // after a restart, the copy on disk (up to a day old) is served while a fresh one is fetched
  if (!hit && existsSync(snapshotFile(`conn-${s.id}`))) {
    try {
      const { at, table } = JSON.parse(gunzipSync(readFileSync(snapshotFile(`conn-${s.id}`))).toString()) as { at: number; table: Table };
      if (Date.now() - at < 86_400_000) {
        shared.set(s.id, { at, value: Promise.resolve(table) });
        if (!fresh) { void refresh().catch(() => {}); return Promise.resolve(table); }
      }
    } catch { /* fetch it instead */ }
  }
  if (!hit) return refresh();
  if (fresh) return refresh();
  if (Date.now() - hit.at > SHARED_TTL) void refresh().catch(() => {});
  return hit.value;
}

// ---------------------------------------------------------------- rows from an app
const appOf = (s: Pick<SourceRow, 'app_slug'>) => {
  const app = get<App>('SELECT * FROM apps WHERE slug = ?', s.app_slug ?? '');
  if (!app) throw new UserError('err.appNotFound', { slug: s.app_slug ?? '' });
  return app;
};

/** Field types from what the app declared, or from the values themselves. */
function fieldType(values: unknown[], declared?: string): { type: number; uiType: string } {
  const named: Record<string, [number, string]> = {
    text: [FIELD.text, 'Text'], number: [FIELD.number, 'Number'], date: [FIELD.date, 'DateTime'], person: [FIELD.person, 'User'],
    select: [FIELD.select, 'SingleSelect'], multi: [FIELD.multi, 'MultiSelect'], checkbox: [FIELD.checkbox, 'Checkbox'],
  };
  if (declared && named[declared]) return { type: named[declared][0], uiType: named[declared][1] };
  const xs = values.filter((v) => v !== null && v !== undefined && v !== '');
  if (!xs.length) return { type: FIELD.text, uiType: 'Text' };
  if (xs.every((v) => typeof v === 'number')) return { type: FIELD.number, uiType: 'Number' };
  if (xs.every((v) => typeof v === 'boolean')) return { type: FIELD.checkbox, uiType: 'Checkbox' };
  if (xs.every((v) => Array.isArray(v))) return { type: FIELD.multi, uiType: 'MultiSelect' };
  if (xs.every((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v))) return { type: FIELD.date, uiType: 'DateTime' };
  return { type: FIELD.text, uiType: 'Text' };
}

export function normalizeAppRows(json: unknown): Table {
  const body = json as { rows?: unknown; fields?: unknown } | unknown[];
  const list = Array.isArray(body) ? body : Array.isArray(body?.rows) ? (body.rows as unknown[]) : null;
  if (!list) throw new UserError('err.data.appFormat');
  const declared = new Map((!Array.isArray(body) && Array.isArray(body?.fields) ? (body.fields as { name?: string; type?: string }[]) : [])
    .filter((f) => typeof f?.name === 'string').map((f) => [f.name!, f.type]));
  const rows: Row[] = list.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r)).slice(0, 50_000).map((r) => ({
    id: r._id === undefined || r._id === null ? '' : String(r._id),
    url: typeof r._url === 'string' && /^https?:\/\//.test(r._url) ? r._url : undefined,
    fields: Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_'))),
  }));
  const names = [...new Set([...declared.keys(), ...rows.slice(0, 500).flatMap((r) => Object.keys(r.fields))])];
  const fields: Field[] = names.map((name) => ({ id: name, name, ...fieldType(rows.slice(0, 500).map((r) => r.fields[name]), declared.get(name)) }));
  return { fields, rows };
}

async function appTable(user: User, s: Pick<SourceRow, 'app_slug' | 'app_path'>): Promise<Table> {
  const app = appOf(s);
  if (!canAccessApp(app, user)) throw new UserError('err.data.appDenied', { app: app.slug });
  if (app.status !== 'online') throw new UserError('err.home.sourceOffline', { app: app.slug });
  return normalizeAppRows(await fetchFromApp(app, s.app_path ?? '/', user, { limit: 25 * 1024 * 1024, timeoutMs: 30_000 }));
}

// ---------------------------------------------------------------- inspecting and registering
/** What an agent needs to configure charts: tables in the Base, and for the chosen table its fields and a few rows. */
export async function inspect(user: User, url: string, table?: string) {
  if (!config.lark.enabled) throw new UserError('err.lark.disabled');
  // a spreadsheet (directly or inside a wiki): its sheets, columns and last rows
  const sheetRef = parseSheetUrl(url);
  if (sheetRef && (sheetRef.kind === 'sheets' || (await wikiObject(user, sheetRef.token)).type === 'sheet')) {
    return inspectSheet(user, (await resolveSpreadsheet(user, sheetRef))!, table ?? sheetRef.sheet);
  }
  const ref = parseBaseUrl(url);
  const app = await resolveAppToken(user, ref);
  const tables = await listTables(user, app);
  const tableId = table ?? ref.table ?? (tables.length === 1 ? tables[0].id : undefined);
  if (!tableId) return { tables, hint: 'pick a table id and call again' };
  const fields = await listFields(user, app, tableId, ref.view);
  const rows = await searchRecords(user, { app, table: tableId, view: ref.view, max: 5 });
  return {
    tables,
    table: tableId,
    view: ref.view ?? null,
    fields: fields.map((f) => ({ name: f.name, type: f.uiType ?? f.type })),
    sample: rows.map((r) => Object.fromEntries(fields.map((f) => [f.name, plainText(r[f.name], f)]))),
  };
}

/** The same for rows served by an app, as the user would get them. */
export async function inspectApp(user: User, slug: string, path: string) {
  const t = await appTable(user, { app_slug: slug, app_path: path });
  return {
    rows: t.rows.length,
    withIds: t.rows.filter((r) => r.id).length,
    withLinks: t.rows.filter((r) => r.url).length,
    fields: t.fields.map((f) => ({ name: f.name, type: f.uiType ?? f.type })),
    sample: t.rows.slice(0, 5).map((r) => ({ ...(r.id ? { _id: r.id } : {}), ...Object.fromEntries(t.fields.map((f) => [f.name, plainText(r.fields[f.name], f)])) })),
  };
}

export async function saveSource(user: User, input: { id: string; title: Record<string, string>; url?: string; table?: string; app?: string; path?: string; connection?: string; item?: string; sql?: string; database?: string; combine?: Combine; audience?: Audience; description?: Record<string, string> }) {
  if (!SLUG.test(input.id)) throw new UserError('err.data.badId', { id: input.id });
  if (!Object.values(input.title).some((t) => t.trim())) throw new UserError('err.data.titleRequired');
  const existing = get<SourceRow>('SELECT * FROM data_sources WHERE id = ?', input.id);
  if (existing && !canEdit(user, existing)) throw new UserError('err.data.notOwner', { id: input.id });
  let row: Pick<SourceRow, 'kind' | 'url' | 'app_token' | 'table_id' | 'view_id' | 'app_slug' | 'app_path'> & Partial<Pick<SourceRow, 'connection_id' | 'item' | 'audience'>>;
  if (input.combine) {
    if (!combineEnabled()) throw new UserError('err.data.combineOff');
    const c = combineSchema.parse(input.combine);
    // reading it once proves both parts can be read and the fields exist
    await checkCombine(user, c, input.id);
    row = { kind: 'combined', url: `${config.hubUrl}/data/source/${input.id}`, app_token: '', table_id: '', view_id: null, app_slug: null, app_path: null, item: JSON.stringify(c) };
  } else if (input.connection) {
    // anyone may read through the key for themselves; only admins decide who else sees what it reads
    const admin = user.role === 'admin';
    if (!admin && input.audience && Object.keys(cleanAudience(input.audience)).length) throw new UserError('err.data.shareAdminOnly');
    const { connector, cfg } = connectionConfig(input.connection);
    let item = String(input.item ?? '').trim();
    if (input.sql !== undefined) {
      if (!connector.sqlItem) throw new UserError('err.conn.noSql', { name: connector.label });
      item = connector.sqlItem(String(input.database ?? ''), input.sql);
    }
    if (!item) throw new UserError('err.conn.itemRequired');
    normalizeAppRows(await connector.fetch(cfg, item));
    const before = existing?.audience ? (JSON.parse(existing.audience) as Audience) : {};
    // what an admin shared stays shared only while it reads the same thing
    const audience = admin ? input.audience ?? before : existing && existing.item === item && existing.connection_id === input.connection ? before : {};
    row = { kind: 'connector', url: connector.link(cfg, item), app_token: '', table_id: '', view_id: null, app_slug: null, app_path: null,
      connection_id: input.connection, item, audience: JSON.stringify(cleanAudience(audience)) };
  } else if (input.app) {
    const path = input.path && input.path.startsWith('/') ? input.path : '/';
    // reading it once proves the person may open the app and that it answers in the expected shape
    await appTable(user, { app_slug: input.app, app_path: path });
    row = { kind: 'app', url: appUrl(input.app) + path, app_token: '', table_id: '', view_id: null, app_slug: input.app, app_path: path };
  } else {
    if (!config.lark.enabled) throw new UserError('err.lark.disabled');
    if (!input.url) throw new UserError('err.data.badUrl', { url: '' });
    const ref = parseBaseUrl(input.url);
    const app = await resolveAppToken(user, ref);
    const table = await pickTable(user, app, input.table ?? ref.table);
    // reading the fields proves the person can open it, and that the ids are right
    await listFields(user, app, table, ref.view);
    row = { kind: 'base', url: input.url, app_token: app, table_id: table, view_id: ref.view ?? null, app_slug: null, app_path: null };
  }
  run(`INSERT INTO data_sources (id, title_i18n, url, kind, app_token, table_id, view_id, app_slug, app_path, connection_id, item, audience, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title_i18n = excluded.title_i18n, url = excluded.url, kind = excluded.kind, app_token = excluded.app_token,
         table_id = excluded.table_id, view_id = excluded.view_id, app_slug = excluded.app_slug, app_path = excluded.app_path,
         connection_id = excluded.connection_id, item = excluded.item, audience = excluded.audience, updated_at = excluded.updated_at`,
    input.id, JSON.stringify(input.title), row.url, row.kind, row.app_token, row.table_id, row.view_id, row.app_slug, row.app_path,
    row.connection_id ?? null, row.item ?? null, row.audience ?? null, existing?.owner_id ?? user.id, existing?.created_at ?? now(), now());
  clearCache(input.id);
  if (input.description) await setDescription(user, input.id, input.description);
  else if (row.kind === 'connector') await refreshDescription(input.id);
  return { id: input.id, saved: true };
}

/** Only ids of people and departments the hub knows are kept. */
function cleanAudience(a: Audience): Audience {
  const people = [...new Set(a.people ?? [])].filter((id) => get('SELECT 1 FROM users WHERE id = ?', id));
  const departments = [...new Set(a.departments ?? [])].filter((id) => get('SELECT 1 FROM departments WHERE id = ?', id));
  return { ...(a.company ? { company: true } : {}), ...(people.length ? { people } : {}), ...(departments.length ? { departments } : {}) };
}

/** Who besides admins may read a connector source; admins only. */
export function setAudience(user: User, id: string, audience: Audience) {
  if (user.role !== 'admin') throw new UserError('err.adminOnly');
  const s = getSource(id);
  if (s.kind !== 'connector') throw new UserError('err.data.audienceConnectorOnly');
  const clean = cleanAudience(audience);
  run('UPDATE data_sources SET audience = ?, updated_at = ? WHERE id = ?', JSON.stringify(clean), now(), id);
  clearCache(id);
  return { id, audience: describeAudience(clean) };
}

/**
 * What a source counts, from the other system (a Metabase question's description), unless someone wrote it in the
 * hub: that one is kept. Called when a connector source is saved or its dashboard synced.
 */
export async function refreshDescription(id: string) {
  const s = getSource(id);
  if (s.kind !== 'connector' || s.description_manual) return;
  const { connector, cfg } = connectionConfig(s.connection_id ?? '');
  if (!connector.info) return;
  const text = (await connector.info(cfg, s.item ?? '').catch(() => undefined))?.description?.slice(0, 2000);
  run('UPDATE data_sources SET description_i18n = ? WHERE id = ?', text ? JSON.stringify(Object.fromEntries(localeCodes().map((l) => [l, text]))) : null, id);
}

/** What a source counts, written in the hub (per language); nothing goes back to what the other system says. */
export async function setDescription(user: User, id: string, description: Record<string, string> | null) {
  const s = getSource(id);
  if (!canEdit(user, s)) throw new UserError('err.data.notOwner', { id });
  const clean = description ? Object.fromEntries(Object.entries(description).map(([k, v]) => [k, String(v).trim().slice(0, 2000)]).filter(([, v]) => v)) : {};
  if (Object.keys(clean).length) run('UPDATE data_sources SET description_i18n = ?, description_manual = 1, updated_at = ? WHERE id = ?', JSON.stringify(clean), now(), id);
  else {
    run('UPDATE data_sources SET description_i18n = NULL, description_manual = 0, updated_at = ? WHERE id = ?', now(), id);
    await refreshDescription(id);
  }
  return { id, description: descriptionOf(getSource(id), user.locale ?? config.defaultLocale) ?? null };
}

export function deleteSource(user: User, id: string) {
  const s = getSource(id);
  if (!canEdit(user, s)) throw new UserError('err.data.notOwner', { id });
  const usedBy = all<SourceRow>("SELECT * FROM data_sources WHERE kind = 'combined'").find((c) => combineOf(c).sources.includes(id));
  if (usedBy) throw new UserError('err.data.usedByCombined', { id: usedBy.id });
  run('DELETE FROM data_sources WHERE id = ?', id);
  clearCache(id);
  return { deleted: true };
}

// ---------------------------------------------------------------- reading, with caches (per viewer: access differs)
const TTL = 60_000;
const cache = new Map<string, { at: number; value: Promise<Result> }>();
const tables = new Map<string, { at: number; value: Promise<Table> }>();
function clearCache(id: string) {
  snapshots.delete(id);
  shared.delete(id);
  refreshingShared.delete(id);
  rmSync(snapshotFile(`conn-${id}`), { force: true });
  rmSync(snapshotFile(id), { force: true });
  for (const m of [cache, tables, readable]) for (const k of m.keys()) if (k.startsWith(`${id}\u0000`)) m.delete(k);
}

/**
 * Big Base tables take Lark a while to page through (12k rows ≈ 20 s), so pages use a shared snapshot of each Base
 * source, read with its owner's access and refreshed in the background every few minutes. That is only safe when
 * every reader sees the same rows: the Base must not use advanced (row-level) permissions, and the viewer must be
 * able to open the table themselves (checked with their own Lark access). Otherwise rows are read as the viewer.
 * App sources are not shared: an app may answer each person differently.
 */
const SNAPSHOT_TTL = 5 * 60_000;
const snapshots = new Map<string, { at: number; advanced: boolean; value: Promise<Row[]> }>();

// Snapshots are also kept on disk (gzipped JSON in the data folder). After a restart the last copy is served at once,
// marked as old so it is refreshed in the background; one older than a day is not used.
const snapshotFile = (id: string) => path.join(paths.snapshots, `${id.replace(/[^\w-]/g, '_')}.json.gz`);
function saveSnapshot(id: string, at: number, rows: Row[]) {
  gzip(JSON.stringify({ at, rows }), (err, buf) => {
    if (err) return console.warn('[data] could not save snapshot', id, err.message);
    writeFile(snapshotFile(id), buf, { mode: 0o600 }, (e) => e && console.warn('[data] could not save snapshot', id, e.message));
  });
}
function loadSnapshot(id: string) {
  if (snapshots.has(id) || !existsSync(snapshotFile(id))) return;
  try {
    const { at, rows } = JSON.parse(gunzipSync(readFileSync(snapshotFile(id))).toString()) as { at: number; rows: Row[] };
    if (Date.now() - at < 86_400_000) snapshots.set(id, { at, advanced: false, value: Promise.resolve(rows) });
  } catch (e) {
    console.warn('[data] could not read snapshot', id, (e as Error).message);
  }
}
const readable = new Map<string, { at: number; ok: Promise<boolean> }>();

/**
 * Whether this person may read the source: open the Base table in Lark, or open the app. The Lark answer is kept
 * for 5 minutes (asking Lark on every chart would be slow), so access removed in Lark takes up to that long to apply.
 */
export function canReadSource(user: User, s: SourceRow): Promise<boolean> {
  if (s.kind === 'connector') return Promise.resolve(mayReadConnector(user, s));
  if (s.kind === 'combined') {
    if (!combineEnabled()) return Promise.resolve(false);
    return Promise.all(combineOf(s).sources.map((id) => get<SourceRow>('SELECT * FROM data_sources WHERE id = ?', id)).map((p) => (p ? canReadSource(user, p) : Promise.resolve(false)))).then((ok) => ok.every(Boolean));
  }
  if (s.kind === 'app') {
    const app = get<App>('SELECT * FROM apps WHERE slug = ?', s.app_slug ?? '');
    return Promise.resolve(!!app && canAccessApp(app, user));
  }
  const key = `${s.id}\u0000${user.id}`;
  const hit = readable.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.ok;
  const ok = listFields(user, s.app_token, s.table_id, s.view_id ?? undefined).then(() => true, () => false);
  readable.set(key, { at: Date.now(), ok });
  return ok;
}

const baseRows = (user: User, s: SourceRow) => fetchRecords(user, { app: s.app_token, table: s.table_id, view: s.view_id ?? undefined, max: 50_000 });
const refreshing = new Set<string>();

/** Reads a Base source as its owner into the snapshot. Until a first read lands, callers wait for it; later reads swap in quietly. */
function takeSnapshot(s: SourceRow) {
  const owner = get<User>('SELECT * FROM users WHERE id = ?', s.owner_id);
  if (!owner || refreshing.has(s.id)) return;
  refreshing.add(s.id);
  const prev = snapshots.get(s.id);
  const value = (async () => {
    if (await isAdvanced(owner, s.app_token)) throw Object.assign(new Error('advanced'), { advanced: true });
    return baseRows(owner, s);
  })();
  const entry = { at: Date.now(), advanced: false, value };
  if (!prev) snapshots.set(s.id, entry);
  value.then(
    (rows) => { snapshots.set(s.id, entry); saveSnapshot(s.id, entry.at, rows); },
    (e: { advanced?: boolean }) => {
      if (e.advanced) snapshots.set(s.id, { ...entry, advanced: true });
      else if (!prev) snapshots.delete(s.id); // a failed refresh keeps serving the last good snapshot
    },
  ).finally(() => refreshing.delete(s.id));
}

/** Keeps every Base source's snapshot fresh, so nobody waits for a cold read (a 12k-row table is ~26 Lark pages per refresh). */
export function startSnapshotRefresher() {
  const tick = () => {
    for (const src of all<SourceRow>("SELECT * FROM data_sources WHERE kind = 'base'")) {
      loadSnapshot(src.id);
      const snap = snapshots.get(src.id);
      if (!snap || (!snap.advanced && Date.now() - snap.at > SNAPSHOT_TTL)) takeSnapshot(src);
    }
  };
  setTimeout(tick, 2_000);
  return setInterval(tick, 60_000);
}

async function sharedRows(user: User, s: SourceRow): Promise<Row[] | null> {
  loadSnapshot(s.id);
  let snap = snapshots.get(s.id);
  if (snap?.advanced) return null;
  if (!(await canReadSource(user, s))) return null;
  if (!snap) {
    takeSnapshot(s);
    snap = snapshots.get(s.id);
  } else if (Date.now() - snap.at > SNAPSHOT_TTL) takeSnapshot(s); // refresh in the background, serve the current one
  if (!snap) return null;
  try {
    return await snap.value;
  } catch {
    return null;
  }
}

/**
 * A source's fields and rows as one person sees them. Pages share a one-minute cache; `fresh` (checks and alerts,
 * which run as their owner) always reads live.
 */
export function loadTable(user: User, s: SourceRow, fresh = false): Promise<Table> {
  const key = `${s.id}\u0000${user.id}`;
  const hit = tables.get(key);
  if (hit && !fresh && Date.now() - hit.at < TTL) return hit.value;
  const value = s.kind === 'combined'
    ? combinedTable(user, s, fresh)
    : s.kind === 'connector'
    ? (mayReadConnector(user, s) ? connectorTable(s, fresh) : Promise.reject(new UserError('err.data.audienceDenied')))
    : s.kind === 'app'
    ? appTable(user, s)
    : (async () => {
      // a Base source saved while the hub still signed in with Lark
      if (!config.lark.enabled) throw new UserError('err.lark.disabled');
      const fields = await listFields(user, s.app_token, s.table_id, s.view_id ?? undefined);
      const rows = (!fresh && (await sharedRows(user, s))) || (await baseRows(user, s));
      return { fields, rows };
    })();
  tables.set(key, { at: Date.now(), value });
  value.catch(() => tables.delete(key));
  for (const [k, v] of tables) if (Date.now() - v.at > TTL) tables.delete(k);
  return value;
}

export function query(user: User, id: string, q: Query, fresh = false): Promise<Result> {
  const s = getSource(id);
  const key = `${id}\u0000${user.id}\u0000${JSON.stringify(q)}`;
  const hit = cache.get(key);
  if (hit && !fresh && Date.now() - hit.at < TTL) return hit.value;
  const value = loadTable(user, s, fresh).then((t) => runQuery(q, { fields: t.fields, rows: t.rows.map((r) => r.fields) }));
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return value;
}

/**
 * The rows themselves, for agents answering questions ("who paid for the first time last week"), read with the
 * person's own access like everything else: matching rows as plain text, newest or largest first when sorted, at
 * most `limit`.
 */
export async function readRows(user: User, id: string, o: { where?: Condition[]; fields?: string[]; sort?: { field: string; desc?: boolean }; limit?: number }) {
  const t = await loadTable(user, getSource(id));
  const matched = filterRows(t.fields, t.rows, o.where, (r) => r.fields);
  const show = o.fields?.length ? o.fields.map((n) => {
    const f = t.fields.find((x) => x.name === n);
    if (!f) throw new UserError('err.data.noField', { field: n, role: 'fields', fields: t.fields.map((x) => x.name).join(', ') });
    return f;
  }) : t.fields;
  if (o.sort) {
    const f = t.fields.find((x) => x.name === o.sort!.field);
    if (!f) throw new UserError('err.data.noField', { field: o.sort.field, role: 'sort', fields: t.fields.map((x) => x.name).join(', ') });
    const key = (r: Row) => { const v = r.fields[f.name]; const n = typeof v === 'number' ? v : Date.parse(String(v)); return Number.isFinite(n) ? n : String(plainText(v, f)); };
    matched.sort((a, b) => { const x = key(a), y = key(b); const c = x < y ? -1 : x > y ? 1 : 0; return o.sort!.desc ? -c : c; });
  }
  const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
  return {
    total: t.rows.length,
    matched: matched.length,
    fields: show.map((f) => ({ name: f.name, type: f.uiType ?? f.type })),
    rows: matched.slice(0, limit).map((r) => ({ ...Object.fromEntries(show.map((f) => [f.name, plainText(r.fields[f.name], f)])), ...(r.url ? { _url: r.url } : {}) })),
    ...(matched.length > limit ? { note: `showing ${limit} of ${matched.length}; narrow it with where or raise limit (max 200)` } : {}),
  };
}

/**
 * For the detail page of a source: its name, where it lives (for an "open in …" link), and its fields sorted into
 * dates, numbers and the rest, read with the viewer's access (so it fails the same way their charts would).
 */
export async function describeSource(user: User, id: string, locale: string) {
  const s = getSource(id);
  const t = await loadTable(user, s);
  const kindOf = (f: Field): 'date' | 'number' | 'text' => isDateField(f) ? 'date' : f.type === FIELD.number || f.uiType === 'Number' || f.uiType === 'Currency' ? 'number' : 'text';
  const where = s.kind === 'combined'
    ? { label: 'combined', url: '', parts: combineOf(s).sources.map((sid) => ({ id: sid, title: pick(JSON.parse(getSource(sid).title_i18n), locale) })), mode: combineOf(s).mode }
    : s.kind === 'connector' ? { label: get<{ type: string }>('SELECT type FROM connections WHERE id = ?', s.connection_id ?? '')?.type ?? '', url: s.url }
    : s.kind === 'app' ? { label: s.app_slug ?? '', url: `${config.hubUrl}/apps/${s.app_slug}` }
    : { label: 'lark', url: s.url };
  // how far back each date field goes, so the page does not draw days the source has no data for as zeros
  const span = (f: Field) => {
    let lo = Infinity, hi = -Infinity;
    for (const r of t.rows) {
      const v = r.fields[f.name];
      const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
      if (Number.isFinite(ms)) { lo = Math.min(lo, ms); hi = Math.max(hi, ms); }
    }
    return Number.isFinite(lo) ? { from: lo, to: hi } : {};
  };
  return {
    id: s.id, title: pick(JSON.parse(s.title_i18n), locale), description: descriptionOf(s, locale) ?? null, kind: s.kind, item: s.item, where, records: t.rows.length,
    fields: t.fields.map((f) => ({ name: f.name, kind: kindOf(f), ...(kindOf(f) === 'date' ? span(f) : {}) })),
  };
}

/** Data for one home module: chart config for a chart, or { value, trend, delta } for a KPI tile. */
export async function forModule(user: User, id: string, q: Query, kind: DataChartKind | 'stat', locale: string) {
  let r: Result;
  // a tile shows one number: the first measure
  if (kind === 'stat' && q.also) q = { ...q, also: undefined };
  try {
    r = await query(user, id, q);
  } catch (e) {
    // say where the data lives, so the page can link to it (Lark offers "request access"; an app page shows its owner)
    if (e instanceof UserError && (e.key === 'err.data.denied' || e.key === 'err.data.appDenied' || e.key === 'err.data.audienceDenied')) {
      const s = getSource(id);
      // a connector source has nothing to request access to: an admin decides
      throw new UserError('err.data.deniedSource', { url: s.kind === 'app' ? `${config.hubUrl}/apps/${s.app_slug}` : s.kind === 'connector' ? '' : s.url });
    }
    throw e;
  }
  if (kind === 'stat') return toStat(r);
  return toChart(kind, r, pick(JSON.parse(getSource(id).title_i18n), locale));
}
