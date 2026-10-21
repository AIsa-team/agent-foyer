/**
 * Reading Lark Base (Bitable) tables as a person. Links may point at a Base directly (/base/<app_token>) or at a
 * Base inside a wiki (/wiki/<node_token>); both take ?table=<tbl…>&view=<vew…>.
 */
import type { User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { DENIED_CODES, LarkError, SCOPE_CODES } from './client.ts';
import { asUser } from './userToken.ts';

export interface BaseRef { kind: 'base' | 'wiki'; token: string; table?: string; view?: string }

export function parseBaseUrl(raw: string): BaseRef {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new UserError('err.data.badUrl', { url: raw });
  }
  const m = u.pathname.match(/\/(base|wiki)\/([A-Za-z0-9]+)/);
  if (!m) throw new UserError('err.data.badUrl', { url: raw });
  return { kind: m[1] as 'base' | 'wiki', token: m[2], table: u.searchParams.get('table') ?? undefined, view: u.searchParams.get('view') ?? undefined };
}

/** Turns Lark's "no scope" / "no access" answers into messages the person can act on. */
async function call<T>(user: User, path: string, init?: RequestInit): Promise<T> {
  try {
    return await asUser<T>(user, path, init);
  } catch (e) {
    if (e instanceof LarkError && SCOPE_CODES.has(e.code)) throw new UserError('err.lark.scopeMissing', { detail: e.message });
    if (e instanceof LarkError && DENIED_CODES.has(e.code)) throw new UserError(init?.method && init.method !== 'GET' && !path.endsWith('/records/search') ? 'err.data.noEdit' : 'err.data.denied');
    throw e;
  }
}

/** The Base app token behind a link (wiki nodes are looked up). */
export async function resolveAppToken(user: User, ref: BaseRef): Promise<string> {
  if (ref.kind === 'base') return ref.token;
  const r = await call<{ data: { node: { obj_type: string; obj_token: string } } }>(user, `/wiki/v2/spaces/get_node?token=${encodeURIComponent(ref.token)}`);
  if (r.data.node.obj_type !== 'bitable') throw new UserError('err.data.notBase', { type: r.data.node.obj_type });
  return r.data.node.obj_token;
}

/** Whether the Base uses advanced permissions, where different people may see different rows. */
export async function isAdvanced(user: User, app: string): Promise<boolean> {
  const r = await call<{ data: { app?: { is_advanced?: boolean } } }>(user, `/bitable/v1/apps/${app}`);
  return !!r.data.app?.is_advanced;
}

export async function listTables(user: User, app: string) {
  const r = await call<{ data: { items?: { table_id: string; name: string }[] } }>(user, `/bitable/v1/apps/${app}/tables?page_size=100`);
  return (r.data.items ?? []).map((t) => ({ id: t.table_id, name: t.name }));
}

/** The table a link means: the one it names, or the only table in the Base; with several, the error lists them. */
export async function pickTable(user: User, app: string, table?: string): Promise<string> {
  if (table) return table;
  const tables = await listTables(user, app);
  if (tables.length === 1) return tables[0].id;
  throw new UserError('err.data.pickTable', { names: tables.map((t) => `${t.name} (?table=${t.id})`).join(', ') });
}

export interface Field { id: string; name: string; type: number; uiType?: string }

/** Lark field type numbers worth knowing when aggregating. */
export const FIELD = { text: 1, number: 2, select: 3, multi: 4, date: 5, checkbox: 7, person: 11, formula: 20, lookup: 19, created: 1001, modified: 1002, autoNumber: 1005 };
export const isDateField = (f: Field) => f.type === FIELD.date || f.type === FIELD.created || f.type === FIELD.modified || f.uiType === 'DateTime';

export async function listFields(user: User, app: string, table: string, view?: string): Promise<Field[]> {
  const r = await call<{ data: { items?: { field_id: string; field_name: string; type: number; ui_type?: string }[] } }>(
    user, `/bitable/v1/apps/${app}/tables/${table}/fields?page_size=100${view ? `&view_id=${view}` : ''}`);
  return (r.data.items ?? []).map((f) => ({ id: f.field_id, name: f.field_name, type: f.type, uiType: f.ui_type }));
}

export interface Condition { field: string; op: 'is' | 'isNot' | 'contains' | 'doesNotContain' | 'isEmpty' | 'isNotEmpty' | 'isGreater' | 'isLess'; value?: string | number }

type SearchOptions = { app: string; table: string; view?: string; fields?: string[]; where?: Condition[]; max?: number };

/** All matching records (up to `max`), with field values in their raw Lark shape. */
export async function searchRecords(user: User, o: SearchOptions) {
  return (await fetchRecords(user, o)).map((r) => r.fields);
}

/** Like searchRecords, keeping each record's id (to link to it and to remember it between runs). */
export async function fetchRecords(user: User, o: SearchOptions) {
  const out: { id: string; fields: Record<string, unknown> }[] = [];
  const max = o.max ?? 10_000;
  let pageToken = '';
  do {
    const body: Record<string, unknown> = { automatic_fields: false };
    if (o.view) body.view_id = o.view;
    if (o.fields?.length) body.field_names = o.fields;
    if (o.where?.length) {
      body.filter = { conjunction: 'and', conditions: o.where.map((c) => ({ field_name: c.field, operator: c.op, value: c.value === undefined ? [] : [String(c.value)] })) };
    }
    const r = await call<{ data: { items?: { record_id: string; fields: Record<string, unknown> }[]; has_more: boolean; page_token?: string } }>(
      user, `/bitable/v1/apps/${o.app}/tables/${o.table}/records/search?page_size=500${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`,
      { method: 'POST', body: JSON.stringify(body) });
    for (const it of r.data.items ?? []) out.push({ id: it.record_id, fields: it.fields ?? {} });
    pageToken = r.data.has_more && out.length < max ? r.data.page_token ?? '' : '';
  } while (pageToken);
  return out.slice(0, max);
}

/** Adds a record (needs the bitable:app scope). `fields` are in Lark's write format. */
export async function createRecord(user: User, app: string, table: string, fields: Record<string, unknown>) {
  const r = await call<{ data: { record: { record_id: string; fields: Record<string, unknown> } } }>(
    user, `/bitable/v1/apps/${app}/tables/${table}/records`, { method: 'POST', body: JSON.stringify({ fields }) });
  return { id: r.data.record.record_id, fields: r.data.record.fields };
}

export async function updateRecord(user: User, app: string, table: string, record: string, fields: Record<string, unknown>) {
  const r = await call<{ data: { record: { record_id: string; fields: Record<string, unknown> } } }>(
    user, `/bitable/v1/apps/${app}/tables/${table}/records/${encodeURIComponent(record)}`, { method: 'PUT', body: JSON.stringify({ fields }) });
  return { id: r.data.record.record_id, fields: r.data.record.fields };
}

// ---------------------------------------------------------------- plain values out of Lark's cell shapes
type Plain = string | number | boolean | null;

/** One cell as a list of plain values: text segments joined, people by name, formulas unwrapped, options as-is. */
export function plainValues(v: unknown): Plain[] {
  if (v === null || v === undefined) return [];
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return [v];
  if (Array.isArray(v)) {
    // rich text: [{type:'text', text:'…'}, {type:'mention', text:'@…'}] is one value
    if (v.length && v.every((x) => x && typeof x === 'object' && 'text' in x && !('id' in x && 'name' in x))) {
      return [v.map((x) => String((x as { text: unknown }).text ?? '')).join('')];
    }
    return v.flatMap((x) => plainValues(x));
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('value' in o && 'type' in o) return plainValues(o.value); // formula / lookup
    if ('name' in o && typeof o.name === 'string') return [o.name]; // person, group, created by
    if ('text' in o && typeof o.text === 'string') return [o.text]; // hyperlink, text segment
    if (Array.isArray(o.link_record_ids)) return [o.link_record_ids.length]; // linked records: how many
    if ('full_address' in o) return [String(o.full_address)];
  }
  return [];
}

/** People in a person / created-by cell, with their open_ids. */
export function people(v: unknown): { id: string; name: string }[] {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
  return list.filter((x): x is { id: string; name?: string } => !!x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string')
    .map((x) => ({ id: x.id, name: x.name ?? '' }));
}

/**
 * A moment in time from a cell: Lark date fields (ms), text holding an ISO date ("2026-07-20T06:32:29Z",
 * "2026-07-20"), or a number that is a ms / s timestamp. Tables synced from other systems often store dates as text.
 */
export function timeOf(v: unknown): number | null {
  for (const x of plainValues(v)) {
    if (typeof x === 'number' && Number.isFinite(x)) return x > 1e11 ? x : x > 1e9 ? x * 1000 : null;
    if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x.trim())) {
      const t = Date.parse(x.trim().length === 10 ? `${x.trim()}T00:00:00Z` : x.trim());
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

export function plainNumber(v: unknown): number | null {
  for (const x of plainValues(v)) {
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    if (typeof x === 'string') {
      const n = Number(x.replace(/[,\s%¥$€]/g, ''));
      if (x.trim() && Number.isFinite(n)) return n;
    }
    if (typeof x === 'boolean') return x ? 1 : 0;
  }
  return null;
}

/** A cell shown as text, e.g. for agents inspecting a table. */
export function plainText(v: unknown, f?: Field): string {
  const vals = plainValues(v);
  if (f && isDateField(f)) return vals.map((x) => (typeof x === 'number' ? new Date(x).toISOString().slice(0, 10) : String(x))).join(', ');
  return vals.map((x) => String(x)).join(', ');
}
