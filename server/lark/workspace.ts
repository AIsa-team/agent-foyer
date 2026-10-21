/**
 * Lark storage an app's agent sets up: a new Base with the tables and columns the app needs, extra columns on a table
 * the user named, and sharing those with the app's audience. Everything runs as the person (their Lark access), so
 * what is created is theirs. Business records live there, never only inside the app.
 */
import type { User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { DENIED_CODES, LarkError, SCOPE_CODES } from './client.ts';
import { asUser } from './userToken.ts';
import { listFields, parseBaseUrl, pickTable, resolveAppToken } from './base.ts';
import { cellText, columnName, parseSheetUrl, pickSheet, resolveSpreadsheet, wikiObject } from './sheets.ts';

async function call<T>(user: User, path: string, init?: RequestInit): Promise<T> {
  try {
    return await asUser<T>(user, path, init);
  } catch (e) {
    if (e instanceof LarkError && SCOPE_CODES.has(e.code)) throw new UserError('err.lark.scopeMissing', { detail: e.message });
    if (e instanceof LarkError && DENIED_CODES.has(e.code)) throw new UserError(init?.method && init.method !== 'GET' ? 'err.data.noEdit' : 'err.data.denied');
    throw e;
  }
}

/** Column kinds an agent can ask for, and how Lark Base stores them. */
export const COLUMN_TYPES = ['text', 'number', 'select', 'multi', 'date', 'checkbox', 'person', 'url', 'attachment'] as const;
export type ColumnType = typeof COLUMN_TYPES[number];
export interface Column { name: string; type: ColumnType; options?: string[] }

function larkField(c: Column) {
  switch (c.type) {
    case 'number': return { field_name: c.name, type: 2 };
    case 'select': return { field_name: c.name, type: 3, property: { options: (c.options ?? []).map((name) => ({ name })) } };
    case 'multi': return { field_name: c.name, type: 4, property: { options: (c.options ?? []).map((name) => ({ name })) } };
    case 'date': return { field_name: c.name, type: 5, property: { date_formatter: 'yyyy/MM/dd' } };
    case 'checkbox': return { field_name: c.name, type: 7 };
    case 'person': return { field_name: c.name, type: 11, property: { multiple: false } };
    case 'url': return { field_name: c.name, type: 15 };
    case 'attachment': return { field_name: c.name, type: 17 };
    default: return { field_name: c.name, type: 1 };
  }
}

function checkColumns(cols: Column[]) {
  const seen = new Set<string>();
  for (const c of cols) {
    if (!c.name.trim()) throw new UserError('err.workspace.columnName');
    if (seen.has(c.name)) throw new UserError('err.workspace.duplicateColumn', { name: c.name });
    seen.add(c.name);
  }
}

/**
 * A new Base in the person's space with the given tables (the first column of each is its title column, so make it
 * a text one such as the name). Returns links with ?table= ready for set_app_lark.
 */
export async function createBase(user: User, input: { name: string; tables: { name: string; columns: Column[] }[]; folder?: string }) {
  const name = input.name.trim().slice(0, 100);
  if (!name) throw new UserError('err.workspace.noName');
  if (!input.tables.length) throw new UserError('err.workspace.noTables');
  for (const t of input.tables) {
    if (!t.columns.length) throw new UserError('err.workspace.noColumns', { table: t.name });
    checkColumns(t.columns);
  }
  const made = await call<{ data: { app: { app_token: string; default_table_id?: string; url: string } } }>(user, '/bitable/v1/apps', {
    method: 'POST', body: JSON.stringify({ name, ...(input.folder ? { folder_token: input.folder } : {}) }),
  });
  const app = made.data.app.app_token;
  const tables: { name: string; id: string; url: string }[] = [];
  for (const t of input.tables) {
    const r = await call<{ data: { table_id: string } }>(user, `/bitable/v1/apps/${app}/tables`, {
      method: 'POST', body: JSON.stringify({ table: { name: t.name.slice(0, 100), default_view_name: t.name.slice(0, 100), fields: t.columns.map(larkField) } }),
    });
    tables.push({ name: t.name, id: r.data.table_id, url: `${made.data.app.url}?table=${r.data.table_id}` });
  }
  // the empty table every new Base starts with
  if (made.data.app.default_table_id) {
    await call(user, `/bitable/v1/apps/${app}/tables/${made.data.app.default_table_id}`, { method: 'DELETE' }).catch(() => {});
  }
  return { token: app, url: made.data.app.url, tables };
}

/**
 * Adds columns to a table the user named (Base or spreadsheet), after the existing ones. Existing columns are never
 * renamed, removed or changed; names that already exist are skipped.
 */
export async function addColumns(user: User, url: string, columns: Column[]) {
  checkColumns(columns);
  const sheetRef = parseSheetUrl(url);
  const spreadsheet = sheetRef && (sheetRef.kind === 'sheets' || (await wikiObject(user, sheetRef.token)).type === 'sheet')
    ? await resolveSpreadsheet(user, sheetRef) : undefined;
  if (spreadsheet) {
    const sheet = await pickSheet(user, spreadsheet, sheetRef!.sheet);
    const r = await call<{ data: { valueRange?: { values?: unknown[][] } } }>(user,
      `/sheets/v2/spreadsheets/${spreadsheet}/values/${encodeURIComponent(`${sheet.id}!A1:${columnName(Math.max(sheet.cols, 1))}1`)}?valueRenderOption=ToString`);
    const head = (r.data.valueRange?.values?.[0] ?? []).map((v) => cellText(v).trim());
    const have = new Set(head.filter(Boolean));
    const add = columns.filter((c) => !have.has(c.name));
    if (!add.length) return { added: [], skipped: columns.map((c) => c.name) };
    let last = head.length;
    while (last > 0 && !head[last - 1]) last--;
    const from = columnName(last + 1);
    const to = columnName(last + add.length);
    // a sheet only grows as wide as its grid: make room first
    if (last + add.length > sheet.cols) {
      await call(user, `/sheets/v2/spreadsheets/${spreadsheet}/dimension_range`, {
        method: 'POST', body: JSON.stringify({ dimension: { sheetId: sheet.id, majorDimension: 'COLUMNS', length: last + add.length - sheet.cols } }),
      });
    }
    await call(user, `/sheets/v2/spreadsheets/${spreadsheet}/values`, {
      method: 'PUT', body: JSON.stringify({ valueRange: { range: `${sheet.id}!${from}1:${to}1`, values: [add.map((c) => c.name)] } }),
    });
    return { added: add.map((c) => c.name), skipped: columns.filter((c) => have.has(c.name)).map((c) => c.name) };
  }
  const ref = parseBaseUrl(url);
  const app = await resolveAppToken(user, ref);
  const table = await pickTable(user, app, ref.table);
  const have = new Set((await listFields(user, app, table)).map((f) => f.name));
  const added: string[] = [];
  for (const c of columns) {
    if (have.has(c.name)) continue;
    await call(user, `/bitable/v1/apps/${app}/tables/${table}/fields`, { method: 'POST', body: JSON.stringify(larkField(c)) });
    added.push(c.name);
  }
  return { added, skipped: columns.filter((c) => have.has(c.name)).map((c) => c.name) };
}

export type DriveKind = 'bitable' | 'docx' | 'sheet' | 'folder';

/**
 * Who may open what an app keeps in Lark follows who may open the app: the whole company (or public) → everyone in
 * the company; chosen colleagues → each of them; only the owner → nobody else. `perm` is what they may do (edit by
 * default). Returns the people it could not add (e.g. no Lark account).
 */
export async function shareWithAudience(user: User, kind: DriveKind, token: string, audience: { visibility: string; members: string[] }, perm: 'edit' | 'view' = 'edit') {
  const everyone = audience.visibility === 'company' || audience.visibility === 'public';
  await call(user, `/drive/v2/permissions/${token}/public?type=${kind}`, {
    method: 'PATCH', body: JSON.stringify({ link_share_entity: everyone ? (perm === 'edit' ? 'tenant_editable' : 'tenant_readable') : 'closed' }),
  });
  const failed: string[] = [];
  if (audience.visibility === 'members') {
    for (const id of audience.members.filter((m) => m !== user.id)) {
      try {
        await call(user, `/drive/v1/permissions/${token}/members?type=${kind}&need_notification=false`, {
          method: 'POST', body: JSON.stringify({ member_type: 'openid', member_id: id, perm }),
        });
      } catch {
        failed.push(id);
      }
    }
  }
  return { failed };
}
