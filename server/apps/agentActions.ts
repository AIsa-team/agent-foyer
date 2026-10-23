/**
 * Apps that people's agents can use. An app says what an agent may do in it in hub-agent.json at the root of its
 * upload, in two parts:
 * - tables (any app): what an agent may do with the Lark tables the app declared (set_app_lark): find records, add
 *   records with the columns, required columns and defaults listed, change the columns listed. The hub runs these
 *   itself, as the person, after the same consent and access checks as the app's own SDK calls, and checks values
 *   against the real columns (a select takes only its options) so agents cannot write what the app would refuse.
 * - actions (container apps): HTTP requests to the app's own server for what needs its logic. The hub forwards an
 *   agent's call with the same X-Hub-User-* headers and X-Hub-Ticket a browser request gets (plus X-Hub-Agent).
 * The hub reads the file when a version is published and keeps it with that version. Only people who may open the
 * app see or call it, nothing undeclared is reachable this way, and the owner can turn it off.
 */
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config, appUrl } from '../config.ts';
import { all, get, now, run, type App, type User } from '../db.ts';
import { UserError, type Msg } from '../i18n/index.ts';
import { localize } from '../localized.ts';
import { canAccessApp, canManageApp } from './access.ts';
import { agentTable, issueTicket, manifestOf, type Table } from './larkApi.ts';
import { appendSheetRow, sheetFields, sheetRecords, updateSheetRow } from '../lark/sheets.ts';
import { createRecord, fetchRecords, listFields, updateRecord } from '../lark/base.ts';
import { FIELD, plainText, type Condition, type Field } from '../data/fields.ts';

export const MANIFEST_FILE = 'hub-agent.json';
const MANIFEST_MAX = 64 * 1024;
const RESPONSE_MAX = 2 * 1024 * 1024;
const TEXT_MAX = 20_000;
const TIMEOUT = 60_000;
const FIND_DEFAULT = 50;
const FIND_MAX = 500;

// ---------------------------------------------------------------- hub-agent.json
const action = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'lowercase letters, digits and _, starting with a letter'),
  description: z.string().min(1).max(1000),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  path: z.string().max(500).regex(/^\/(?!__hub(\/|$))[^?#\s]*$/, 'starts with /, no query string, not under /__hub'),
  /** JSON Schema of the arguments: {type: "object", properties, required} */
  input: z.object({
    type: z.literal('object').default('object'),
    properties: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    required: z.array(z.string()).default([]),
  }).passthrough().default({ type: 'object', properties: {}, required: [] }),
  /** changes something (a record, a message, a document); defaults to true for everything but GET */
  write: z.boolean().optional(),
});
const columns = z.array(z.string().min(1).max(100)).min(1).max(100);
/** a fixed value, or "$me" (the person; their name in a text column), "$me.id" (their hub id) or "$now" (the time of the call) */
const defaults = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).default({});
const tableRule = z.object({
  description: z.string().max(1000).optional(),
  find: z.union([z.boolean(), z.object({ fields: columns.optional() })]).optional(),
  /** unique: columns no two records share (an email, a link); a new record matching one is refused, naming the match */
  add: z.object({ fields: columns, required: z.array(z.string()).default([]), defaults, unique: z.array(z.string()).max(5).default([]) }).optional(),
  update: z.object({ fields: columns, defaults }).optional(),
});
const manifestSchema = z.object({
  tables: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/, 'a table alias from set_app_lark'), tableRule).optional(),
  actions: z.array(action).max(50).optional(),
}).superRefine((m, ctx) => {
  if (!Object.keys(m.tables ?? {}).length && !m.actions?.length) ctx.addIssue({ code: 'custom', path: [], message: 'needs tables or actions' });
  for (const [alias, t] of Object.entries(m.tables ?? {})) {
    if (!t.find && !t.add && !t.update) ctx.addIssue({ code: 'custom', path: ['tables', alias], message: 'needs find, add or update' });
    for (const r of t.add?.required ?? []) if (!t.add!.fields.includes(r)) ctx.addIssue({ code: 'custom', path: ['tables', alias, 'add', 'required'], message: `${r} is not in add.fields` });
    for (const u of t.add?.unique ?? []) if (!t.add!.fields.includes(u) && !(u in t.add!.defaults)) ctx.addIssue({ code: 'custom', path: ['tables', alias, 'add', 'unique'], message: `${u} is not in add.fields` });
  }
  const seen = new Set<string>();
  (m.actions ?? []).forEach((a, i) => {
    if (seen.has(a.name)) ctx.addIssue({ code: 'custom', path: ['actions', i, 'name'], message: `duplicate action ${a.name}` });
    seen.add(a.name);
    for (const p of pathParams(a.path)) {
      if (!a.input.properties[p]) ctx.addIssue({ code: 'custom', path: ['actions', i, 'path'], message: `{${p}} is not in input.properties` });
    }
  });
});
export type Action = z.infer<typeof action> & { write: boolean };
type TableRule = z.infer<typeof tableRule>;
interface AgentManifest { tables: Record<string, TableRule>; actions: Action[] }
type Op = 'find' | 'add' | 'update';

const pathParams = (p: string) => [...p.matchAll(/\{([A-Za-z_][\w]*)\}/g)].map((m) => m[1]);

/**
 * The hub-agent.json of an extracted upload (at its root, or in a static app's published folder), checked, or why it
 * was not taken. `lark` is the app's current Lark declaration, to point out tables it does not cover yet.
 */
export function readManifest(dir: string, kind: App['kind'], root: string | null, lark: string | null): { manifest: string | null; notes: Msg[] } {
  const file = [path.join(dir, MANIFEST_FILE), ...(root && root !== '.' ? [path.join(dir, root, MANIFEST_FILE)] : [])].find((f) => existsSync(f));
  if (!file) return { manifest: null, notes: [{ key: 'note.agentMissing', params: { file: MANIFEST_FILE } }] };
  try {
    if (statSync(file).size > MANIFEST_MAX) throw new Error('larger than 64 KB');
    const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) throw new Error(parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '/'}: ${i.message}`).join('; '));
    const notes: Msg[] = [];
    const m: AgentManifest = { tables: parsed.data.tables ?? {}, actions: (parsed.data.actions ?? []).map((a) => ({ ...a, write: a.write ?? a.method !== 'GET' })) };
    if (kind === 'static' && m.actions.length) {
      notes.push({ key: 'note.agentStatic', params: { file: MANIFEST_FILE } });
      m.actions = [];
    }
    const declared = manifestOf({ lark_manifest: lark })?.tables ?? [];
    const missing = Object.keys(m.tables).filter((a) => !declared.some((t) => t.name === a));
    if (lark && missing.length) notes.push({ key: 'note.agentTablesUndeclared', params: { tables: missing.join(', ') } });
    const names = offered(m).map((a) => a.name);
    if (!names.length) return { manifest: null, notes };
    notes.unshift({ key: 'note.agentActions', params: { n: names.length, names: names.join(', ') } });
    return { manifest: JSON.stringify(m), notes };
  } catch (e) {
    return { manifest: null, notes: [{ key: 'note.agentInvalid', params: { file: MANIFEST_FILE, error: (e as Error).message } }] };
  }
}

/** The declaration of the app's live version. */
function manifestOfApp(app: App): AgentManifest {
  const empty = { tables: {}, actions: [] };
  if (!app.current_release) return empty;
  const row = get<{ agent_manifest: string | null }>('SELECT agent_manifest FROM app_releases WHERE app_slug = ? AND version = ?', app.slug, app.current_release);
  try {
    const m = row?.agent_manifest ? JSON.parse(row.agent_manifest) as Partial<AgentManifest> : {};
    return { tables: m.tables ?? {}, actions: app.kind === 'container' ? m.actions ?? [] : [] };
  } catch {
    return empty;
  }
}

/** One thing an agent can do: a table operation (<alias>.find / .add / .update) or one of the app's own actions. */
interface Offered { name: string; write: boolean; table?: { alias: string; op: Op; description?: string; fields?: string[]; required?: string[]; unique?: string[] }; action?: Action }

/** What the declaration offers; with the app, only table operations its Lark declaration allows. */
function offered(m: AgentManifest, app?: App): Offered[] {
  const lark = app ? manifestOf(app) : null;
  const out: Offered[] = [];
  for (const [alias, t] of Object.entries(m.tables)) {
    const declared = lark?.tables.find((x) => x.name === alias);
    if (app && !declared) continue;
    const writable = !app || declared?.access === 'write';
    const find = t.find === true ? {} : t.find || null;
    if (find) out.push({ name: `${alias}.find`, write: false, table: { alias, op: 'find', description: t.description, fields: find.fields } });
    if (t.add && writable) out.push({ name: `${alias}.add`, write: true, table: { alias, op: 'add', description: t.description, fields: t.add.fields, required: t.add.required, unique: t.add.unique } });
    if (t.update && writable) out.push({ name: `${alias}.update`, write: true, table: { alias, op: 'update', description: t.description, fields: t.update.fields } });
  }
  for (const a of m.actions) out.push({ name: a.name, write: a.write, action: a });
  return out;
}

const offeredBy = (app: App) => offered(manifestOfApp(app), app);

/** What an agent reads about one operation. */
function describe(o: Offered): string {
  if (o.action) return o.action.description;
  const t = o.table!;
  const what = t.description ? `${t.description} (Lark table "${t.alias}")` : `Lark table "${t.alias}"`;
  if (t.op === 'find') return `Find records in ${what}: where [{field, op, value}] (ops: is, isNot, contains, doesNotContain, isEmpty, isNotEmpty, isGreater, isLess), max (default ${FIND_DEFAULT}). Returns each record's id and columns as text.`;
  if (t.op === 'add') return `Add a record to ${what}: fields {column: value} with ${t.fields!.join(', ')}${t.required?.length ? `; required: ${t.required.join(', ')}` : ''}.${t.unique?.length ? ` Refused when a record with the same ${t.unique.join(' or ')} exists (the error names it).` : ''} Returns its id.`;
  return `Change a record in ${what}: id (from find) and fields {column: value} with ${t.fields!.join(', ')}.`;
}

// ---------------------------------------------------------------- listing
/** What the app detail page shows: the operations, whether agents may use them, and (for managers) how often they did. */
export function describeActions(user: User, app: App) {
  const manage = canManageApp(app, user);
  return {
    enabled: !!app.agent_access,
    actions: offeredBy(app).map((o) => ({
      name: o.name, write: o.write,
      ...(o.action ? { description: o.action.description } : { table: { alias: o.table!.alias, op: o.table!.op, description: o.table!.description ?? null, fields: o.table!.fields ?? null } }),
    })),
    calls30: manage ? get<{ n: number }>('SELECT COUNT(*) AS n FROM app_agent_calls WHERE app_slug = ? AND at > ?', app.slug, now() - 30 * 86_400_000)?.n ?? 0 : undefined,
  };
}

/** Apps the user may open, with what their agent can do in each. With `slug`, that one app and its operations' arguments. */
export async function listUsableApps(user: User, locale: string, o: { query?: string; slug?: string } = {}) {
  const q = o.query?.trim().toLowerCase();
  const rows = (o.slug ? all<App>('SELECT * FROM apps WHERE slug = ?', o.slug.toLowerCase()) : all<App>('SELECT * FROM apps ORDER BY updated_at DESC'))
    .filter((a) => canAccessApp(a, user));
  if (o.slug && !rows.length) throw new UserError('err.appNotFound', { slug: o.slug });
  const out = await Promise.all(rows.map(async (a) => {
    const text = localize(a, a.i18n, locale);
    const ops = a.agent_access ? offeredBy(a) : [];
    return {
      slug: a.slug,
      name: text.name,
      description: text.description,
      url: appUrl(a.slug),
      online: a.status === 'online',
      agent: !a.agent_access ? 'turned off by the owner' : ops.length ? 'call_app' : 'none offered',
      actions: o.slug
        ? await Promise.all(ops.map(async (x) => ({ name: x.name, description: describe(x), write: x.write, input: await inputSchema(user, a, x) })))
        : ops.map((x) => ({ name: x.name, description: describe(x), write: x.write })),
    };
  }));
  return out.filter((a) => !q || o.slug || `${a.slug} ${a.name} ${a.description} ${a.actions.map((x) => `${x.name} ${x.description}`).join(' ')}`.toLowerCase().includes(q));
}

/** JSON Schema of an operation's arguments; for tables, from the real columns when the person can read them now. */
async function inputSchema(user: User, app: App, o: Offered): Promise<unknown> {
  if (o.action) return o.action.input;
  const t = o.table!;
  if (t.op === 'find') {
    return { type: 'object', properties: {
      where: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, op: { type: 'string' }, value: {} }, required: ['field', 'op'] } },
      max: { type: 'integer', maximum: FIND_MAX },
    } };
  }
  let cols: Field[] | null = null;
  let note: string | undefined;
  try {
    cols = await columnsOf(user, agentTable(user, app, t.alias, false));
  } catch (e) {
    note = e instanceof UserError ? e.localized(user.locale ?? config.defaultLocale) : (e as Error).message;
  }
  const fields = {
    type: 'object',
    properties: Object.fromEntries(t.fields!.map((name) => [name, columnSchema(cols?.find((c) => c.name === name))])),
    ...(t.op === 'add' && t.required?.length ? { required: t.required } : {}),
    additionalProperties: false,
  };
  return {
    type: 'object',
    properties: t.op === 'add' ? { fields } : { id: { type: 'string', description: 'record id from find' }, fields },
    required: t.op === 'add' ? ['fields'] : ['id', 'fields'],
    ...(note ? { note } : {}),
  };
}

function columnSchema(f: Field | undefined): Record<string, unknown> {
  if (!f) return {};
  switch (f.type) {
    case FIELD.number: return { type: 'number' };
    case FIELD.checkbox: return { type: 'boolean' };
    case FIELD.date: return { type: 'string', description: 'date or date-time, e.g. 2026-10-22 or 2026-10-22T15:00:00+08:00' };
    case FIELD.select: return { type: 'string', ...(f.options ? { enum: f.options } : {}) };
    case FIELD.multi: return { type: 'array', items: { type: 'string', ...(f.options ? { enum: f.options } : {}) } };
    case FIELD.person: return { type: 'array', items: { type: 'string' }, description: 'colleagues by name or email' };
    case URL_FIELD: return { type: 'string', description: 'https link' };
    default: return { type: 'string' };
  }
}

// ---------------------------------------------------------------- calling
/** Calls one operation as `user` and returns the result. */
export async function callAction(user: User, slug: string, name: string, input: Record<string, unknown>, agent: string) {
  const app = get<App>('SELECT * FROM apps WHERE slug = ?', slug.toLowerCase());
  if (!app || !canAccessApp(app, user)) throw new UserError('err.appNotFound', { slug });
  if (!app.agent_access) throw new UserError('err.agent.off', { app: app.slug });
  const ops = offeredBy(app);
  const op = ops.find((a) => a.name === name);
  if (!op) throw new UserError('err.agent.noAction', { app: app.slug, action: name, actions: ops.map((a) => a.name).join(', ') || '-' });
  if (op.table) {
    const result = await tableCall(user, app, op, input);
    log(app, user, agent, op.name, 200);
    return { app: app.slug, action: op.name, ok: true, write: op.write, result };
  }
  return httpCall(user, app, op.action!, input, agent);
}

const log = (app: App, user: User, agent: string, action: string, status: number) =>
  run('INSERT INTO app_agent_calls (app_slug, user_id, agent, action, status, at) VALUES (?, ?, ?, ?, ?, ?)', app.slug, user.id, agent, action, status, now());

const URL_FIELD = 15;
const READ_ONLY = new Set([FIELD.formula, FIELD.lookup, FIELD.created, FIELD.modified, FIELD.autoNumber, 1003, 1004]);

const columnsOf = (user: User, t: Table): Promise<Field[]> => t.kind === 'sheet'
  ? sheetFields(user, t.app, t.table).then((cs) => cs.map((c) => ({ id: c.name, name: c.name, type: FIELD.text })))
  : listFields(user, t.app, t.table, t.view ?? undefined);

async function tableCall(user: User, app: App, o: Offered, input: Record<string, unknown>) {
  const t = o.table!;
  const table = agentTable(user, app, t.alias, t.op !== 'find');
  const cols = await columnsOf(user, table);
  if (t.op === 'find') {
    const where = input.where === undefined ? undefined : Array.isArray(input.where) ? input.where as Condition[] : null;
    if (where === null) throw new UserError('err.agent.badValue', { field: 'where', expected: '[{field, op, value}]' });
    const max = Math.min(FIND_MAX, Math.max(1, Number(input.max ?? FIND_DEFAULT) || FIND_DEFAULT));
    const show = cols.filter((c) => !t.fields || t.fields.includes(c.name));
    if (table.kind === 'sheet') {
      const rows = await sheetRecords(user, table.app, table.table, { where, max });
      return { records: rows.map((r) => ({ id: r.id, ...Object.fromEntries(show.map((c) => [c.name, r.text[c.name] ?? ''])) })) };
    }
    const rows = await fetchRecords(user, { app: table.app, table: table.table, view: table.view ?? undefined, where, max });
    return { records: rows.map((r) => ({ id: r.id, ...Object.fromEntries(show.map((c) => [c.name, plainText(r.fields[c.name], c)])) })) };
  }

  const given = input.fields && typeof input.fields === 'object' && !Array.isArray(input.fields) ? input.fields as Record<string, unknown> : null;
  if (!given) throw new UserError('err.agent.missing', { fields: 'fields' });
  const rule = manifestOfApp(app).tables[t.alias][t.op]!;
  const extra = Object.keys(given).filter((k) => !t.fields!.includes(k));
  if (extra.length) throw new UserError('err.agent.fieldNotAllowed', { fields: extra.join(', '), allowed: t.fields!.join(', ') });
  const values: Record<string, unknown> = { ...rule.defaults, ...given };
  if (t.op === 'add') {
    const missing = (t.required ?? []).filter((k) => values[k] === undefined || values[k] === null || values[k] === '' || (Array.isArray(values[k]) && !(values[k] as unknown[]).length));
    if (missing.length) throw new UserError('err.agent.missing', { fields: missing.join(', ') });
  }
  const fields: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(values)) {
    const col = cols.find((c) => c.name === name);
    if (!col) throw new UserError('err.agent.noColumn', { field: name, table: t.alias });
    fields[name] = coerce(user, col, v, table.kind === 'sheet');
  }
  if (t.op === 'add') {
    for (const name of t.unique ?? []) await refuseDuplicate(user, table, cols, t, name, fields[name]);
    const r = table.kind === 'sheet' ? await appendSheetRow(user, table.app, table.table, fields) : await createRecord(user, table.app, table.table, fields);
    return { id: (r as { id: string }).id, written: Object.keys(fields) };
  }
  const id = String(input.id ?? '');
  if (!id) throw new UserError('err.agent.missing', { fields: 'id' });
  const r = table.kind === 'sheet' ? await updateSheetRow(user, table.app, table.table, id, fields) : await updateRecord(user, table.app, table.table, id, fields);
  return { id: (r as { id?: string }).id ?? id, written: Object.keys(fields) };
}

/** The same value written another way: case and spaces, and for links the scheme, www, query and trailing slash. */
function sameKey(v: string): string {
  const s = v.trim().toLowerCase();
  const email = /^[^\s@/]+@[^\s@/]+\.[a-z]{2,}$/.test(s);
  return !email && /^(https?:\/\/)?(www\.)?[^\s/@]+\.[a-z]{2,}(\/|$)/.test(s)
    ? s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '')
    : s;
}

/** Refuses a new record when one already has this value in a unique column, naming the records found. */
async function refuseDuplicate(user: User, table: Table, cols: Field[], t: NonNullable<Offered['table']>, name: string, value: unknown) {
  const raw = value && typeof value === 'object' && 'link' in value ? String((value as { link: unknown }).link) : Array.isArray(value) || value === null || value === undefined ? '' : String(value);
  const key = sameKey(raw);
  if (!key) return;
  const where: Condition[] = [{ field: name, op: 'contains', value: key }];
  const col = cols.find((c) => c.name === name)!;
  const shown = cols.filter((c) => c.name !== name && ((t.required ?? []).includes(c.name))).slice(0, 3);
  const hits = table.kind === 'sheet'
    ? (await sheetRecords(user, table.app, table.table, { where, max: 50 })).map((r) => ({ id: r.id, text: (c: Field) => r.text[c.name] ?? '' }))
    : (await fetchRecords(user, { app: table.app, table: table.table, view: table.view ?? undefined, where, max: 50 })).map((r) => ({ id: r.id, text: (c: Field) => plainText(r.fields[c.name], c) }));
  const same = hits.filter((h) => h.text(col).split(/,\s*/).some((x) => sameKey(x) === key));
  if (!same.length) return;
  const records = same.slice(0, 3).map((h) => `${h.id}${shown.length ? ` (${shown.map((c) => `${c.name}: ${h.text(c) || '-'}`).join('; ')})` : ''}`).join(', ');
  throw new UserError('err.agent.duplicate', { field: name, value: raw, records });
}

/** A value as the column takes it, refusing what the column would not hold (an unknown option, a non-date…). */
function coerce(user: User, col: Field, v: unknown, sheet: boolean): unknown {
  const bad = (expected: string) => new UserError('err.agent.badValue', { field: col.name, expected });
  if (v === '$me') v = sheet || col.type !== FIELD.person ? user.name : [user.id];
  if (v === '$me.id') v = !sheet && col.type === FIELD.person ? [user.id] : user.id;
  if (v === '$now') v = sheet || col.type !== FIELD.date ? new Date().toISOString() : Date.now();
  if (v === null || v === '') return null;
  if (sheet) return typeof v === 'object' ? JSON.stringify(v) : v;
  if (READ_ONLY.has(col.type)) throw bad('nothing: this column is computed by Lark');
  switch (col.type) {
    case FIELD.number: {
      const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
      if (!Number.isFinite(n)) throw bad('a number');
      return n;
    }
    case FIELD.checkbox:
      if (typeof v !== 'boolean') throw bad('true or false');
      return v;
    case FIELD.date: {
      const ms = typeof v === 'number' ? v : Date.parse(String(v));
      if (!Number.isFinite(ms)) throw bad('a date such as 2026-10-22');
      return ms;
    }
    case FIELD.select:
      if (typeof v !== 'string' || (col.options && !col.options.includes(v))) throw bad(col.options ? `one of: ${col.options.join(', ')}` : 'text');
      return v;
    case FIELD.multi: {
      const xs = (Array.isArray(v) ? v : [v]).map(String);
      const wrong = col.options ? xs.filter((x) => !col.options!.includes(x)) : [];
      if (wrong.length) throw bad(`values from: ${col.options!.join(', ')}`);
      return xs;
    }
    case FIELD.person:
      return (Array.isArray(v) ? v : [v]).map((x) => {
        const s = String(x).trim();
        const hit = all<{ id: string }>('SELECT id FROM users WHERE id = ? OR lower(email) = ? OR name = ? OR en_name = ?', s, s.toLowerCase(), s, s);
        if (hit.length !== 1) throw new UserError(hit.length ? 'err.colleagueAmbiguous' : 'err.colleagueNotFound', { query: s });
        return { id: hit[0].id };
      });
    case URL_FIELD:
      if (typeof v === 'string' && /^https?:\/\//.test(v)) return { text: v, link: v };
      if (v && typeof v === 'object' && 'link' in v) return v;
      throw bad('an http(s) link');
    default:
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}

/** An app's own action: one request to its server, as the person. */
async function httpCall(user: User, app: App, act: Action, input: Record<string, unknown>, agent: string) {
  if (app.status !== 'online' || !app.upstream) throw new UserError('err.home.sourceOffline', { app: app.slug });
  const missing = act.input.required.filter((k) => input[k] === undefined || input[k] === null || input[k] === '');
  if (missing.length) throw new UserError('err.agent.missing', { fields: missing.join(', ') });

  // {name} in the path from the arguments; the rest go into the query string (GET, DELETE) or a JSON body
  const rest: Record<string, unknown> = { ...input };
  const target = act.path.replace(/\{([A-Za-z_][\w]*)\}/g, (_, k: string) => {
    const v = rest[k];
    delete rest[k];
    if (typeof v !== 'string' && typeof v !== 'number') throw new UserError('err.agent.missing', { fields: k });
    return encodeURIComponent(String(v));
  });
  const url = new URL(target, app.upstream);
  let body: Buffer | undefined;
  if (act.method === 'GET' || act.method === 'DELETE') {
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined || v === null) continue;
      for (const x of Array.isArray(v) ? v : [v]) url.searchParams.append(k, typeof x === 'object' ? JSON.stringify(x) : String(x));
    }
  } else {
    body = Buffer.from(JSON.stringify(rest));
  }

  const res = await new Promise<{ status: number; type: string; data: Buffer }>((resolve, reject) => {
    const req = http.request(url, {
      method: act.method,
      timeout: TIMEOUT,
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}),
        'x-hub-user-id': user.id,
        'x-hub-user-name': encodeURIComponent(user.name),
        'x-hub-user-email': user.email ?? '',
        'x-hub-user-avatar': user.avatar ?? '',
        'x-hub-user-locale': user.locale ?? config.defaultLocale,
        'x-hub-ticket': issueTicket(app.slug, user.id),
        // which agent is acting for the person, so the app can say so on what it records
        'x-hub-agent': encodeURIComponent(agent),
      },
    }, (r) => {
      const chunks: Buffer[] = [];
      let size = 0;
      r.on('data', (d: Buffer) => {
        size += d.length;
        if (size > RESPONSE_MAX) req.destroy(new UserError('err.agent.tooLarge'));
        else chunks.push(d);
      });
      r.on('end', () => resolve({ status: r.statusCode ?? 502, type: String(r.headers['content-type'] ?? ''), data: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new UserError('err.agent.timeout', { app: app.slug, s: TIMEOUT / 1000 })));
    req.on('error', (e) => reject(e instanceof UserError ? e : new UserError('err.home.sourceOffline', { app: app.slug })));
    req.end(body);
  });

  log(app, user, agent, act.name, res.status);
  const text = res.data.toString('utf8');
  let data: unknown = text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) + '…' : text;
  if (/json/i.test(res.type) || /^\s*[[{]/.test(text)) {
    try {
      data = JSON.parse(text);
    } catch { /* keep the text */ }
  }
  return { app: app.slug, action: act.name, ok: res.status < 400, status: res.status, write: act.write, result: data };
}
