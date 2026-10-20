/**
 * Named data sources for home pages, boards, metric alerts and data checks. Two kinds:
 *
 * - base: a Lark Base table, always read with the viewer's own Lark access, so people only see rows they could open
 *   in Lark.
 * - app: rows served by one of the company's hub apps (anything an agent built: a Metabase question, a database
 *   query, a CRM export…). The app answers GET <path> with { rows: [...] } (or a bare array) of plain JSON objects;
 *   optional `_id` and `_url` on a row identify it and link back to where it lives. The hub requests it as the viewer
 *   (the same identity headers a browser request gets), and only for people allowed to open the app.
 *
 * Both kinds come out as fields + rows, so queries, charts, alerts and checks treat them alike.
 */
import { appUrl, config } from '../config.ts';
import { get, all, now, run, type App, type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { pick } from '../library.ts';
import { canAccessApp } from '../apps/access.ts';
import { fetchFromApp } from '../gateway.ts';
import { FIELD, fetchRecords, isAdvanced, listFields, listTables, parseBaseUrl, plainText, resolveAppToken, searchRecords, type Field } from '../lark/base.ts';
import { runQuery, toChart, toStat, type DataChartKind, type Query, type Result } from './query.ts';

export interface SourceRow {
  id: string; title_i18n: string; url: string; kind: 'base' | 'app'; app_token: string; table_id: string; view_id: string | null;
  app_slug: string | null; app_path: string | null; owner_id: string; created_at: number; updated_at: number;
}
export interface Row { id: string; url?: string; fields: Record<string, unknown> }
export interface Table { fields: Field[]; rows: Row[] }

const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;

export function getSource(id: string): SourceRow {
  const s = get<SourceRow>('SELECT * FROM data_sources WHERE id = ?', id);
  if (!s) throw new UserError('err.data.sourceNotFound', { id });
  return s;
}

const canEdit = (u: User, s: SourceRow) => u.role === 'admin' || s.owner_id === u.id;

export function listSources(locale: string) {
  return all<SourceRow & { owner_name: string }>('SELECT d.*, u.name AS owner_name FROM data_sources d JOIN users u ON u.id = d.owner_id ORDER BY d.created_at')
    .map((s) => ({
      id: s.id, title: pick(JSON.parse(s.title_i18n), locale), kind: s.kind, url: s.url, owner: s.owner_name,
      ...(s.kind === 'app' ? { app: s.app_slug, path: s.app_path } : { table: s.table_id, view: s.view_id }),
    }));
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

export async function saveSource(user: User, input: { id: string; title: Record<string, string>; url?: string; table?: string; app?: string; path?: string }) {
  if (!SLUG.test(input.id)) throw new UserError('err.data.badId', { id: input.id });
  if (!Object.values(input.title).some((t) => t.trim())) throw new UserError('err.data.titleRequired');
  const existing = get<SourceRow>('SELECT * FROM data_sources WHERE id = ?', input.id);
  if (existing && !canEdit(user, existing)) throw new UserError('err.data.notOwner', { id: input.id });
  let row: Pick<SourceRow, 'kind' | 'url' | 'app_token' | 'table_id' | 'view_id' | 'app_slug' | 'app_path'>;
  if (input.app) {
    const path = input.path && input.path.startsWith('/') ? input.path : '/';
    // reading it once proves the person may open the app and that it answers in the expected shape
    await appTable(user, { app_slug: input.app, app_path: path });
    row = { kind: 'app', url: appUrl(input.app) + path, app_token: '', table_id: '', view_id: null, app_slug: input.app, app_path: path };
  } else {
    if (!input.url) throw new UserError('err.data.badUrl', { url: '' });
    const ref = parseBaseUrl(input.url);
    const app = await resolveAppToken(user, ref);
    const table = input.table ?? ref.table;
    if (!table) throw new UserError('err.data.tableRequired');
    // reading the fields proves the person can open it, and that the ids are right
    await listFields(user, app, table, ref.view);
    row = { kind: 'base', url: input.url, app_token: app, table_id: table, view_id: ref.view ?? null, app_slug: null, app_path: null };
  }
  run(`INSERT INTO data_sources (id, title_i18n, url, kind, app_token, table_id, view_id, app_slug, app_path, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title_i18n = excluded.title_i18n, url = excluded.url, kind = excluded.kind, app_token = excluded.app_token,
         table_id = excluded.table_id, view_id = excluded.view_id, app_slug = excluded.app_slug, app_path = excluded.app_path, updated_at = excluded.updated_at`,
    input.id, JSON.stringify(input.title), row.url, row.kind, row.app_token, row.table_id, row.view_id, row.app_slug, row.app_path,
    existing?.owner_id ?? user.id, existing?.created_at ?? now(), now());
  clearCache(input.id);
  return { id: input.id, saved: true };
}

export function deleteSource(user: User, id: string) {
  const s = getSource(id);
  if (!canEdit(user, s)) throw new UserError('err.data.notOwner', { id });
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
const readable = new Map<string, { at: number; ok: Promise<boolean> }>();

/**
 * Whether this person may read the source: open the Base table in Lark, or open the app. The Lark answer is kept
 * for 5 minutes (asking Lark on every chart would be slow), so access removed in Lark takes up to that long to apply.
 */
export function canReadSource(user: User, s: SourceRow): Promise<boolean> {
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
    () => snapshots.set(s.id, entry),
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
      const snap = snapshots.get(src.id);
      if (!snap || (!snap.advanced && Date.now() - snap.at > SNAPSHOT_TTL)) takeSnapshot(src);
    }
  };
  setTimeout(tick, 20_000);
  return setInterval(tick, 60_000);
}

async function sharedRows(user: User, s: SourceRow): Promise<Row[] | null> {
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
  const value = s.kind === 'app'
    ? appTable(user, s)
    : (async () => {
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

/** Data for one home module: chart config for a chart, or { value, trend, delta } for a KPI tile. */
export async function forModule(user: User, id: string, q: Query, kind: DataChartKind | 'stat', locale: string) {
  let r: Result;
  try {
    r = await query(user, id, q);
  } catch (e) {
    // say where the data lives, so the page can link to it (Lark offers "request access"; an app page shows its owner)
    if (e instanceof UserError && (e.key === 'err.data.denied' || e.key === 'err.data.appDenied')) {
      const s = getSource(id);
      throw new UserError('err.data.deniedSource', { url: s.kind === 'app' ? `${config.hubUrl}/apps/${s.app_slug}` : s.url });
    }
    throw e;
  }
  if (kind === 'stat') return toStat(r);
  return toChart(kind, r, pick(JSON.parse(getSource(id).title_i18n), locale));
}
