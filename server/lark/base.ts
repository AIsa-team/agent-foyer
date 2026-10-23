/**
 * Reading Lark Base (Bitable) tables as a person. Links may point at a Base directly (/base/<app_token>) or at a
 * Base inside a wiki (/wiki/<node_token>); both take ?table=<tbl…>&view=<vew…>.
 */
import type { User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { DENIED_CODES, LarkError, SCOPE_CODES } from './client.ts';
import { asUser } from './userToken.ts';
import type { Condition, Field } from '../data/fields.ts';

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

export async function listFields(user: User, app: string, table: string, view?: string): Promise<Field[]> {
  const r = await call<{ data: { items?: { field_id: string; field_name: string; type: number; ui_type?: string; property?: { options?: { name: string }[] } | null }[] } }>(
    user, `/bitable/v1/apps/${app}/tables/${table}/fields?page_size=100${view ? `&view_id=${view}` : ''}`);
  return (r.data.items ?? []).map((f) => ({
    id: f.field_id, name: f.field_name, type: f.type, uiType: f.ui_type,
    ...(f.property?.options?.length ? { options: f.property.options.map((o) => o.name) } : {}),
  }));
}


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
