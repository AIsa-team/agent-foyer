/**
 * Lark spreadsheets (Sheets) as tables, so apps and agents can use them like a Base: the first row holds the column
 * names, every row below is a record (id `row<N>`, N = the row number in the sheet). Links point at the spreadsheet
 * (/sheets/<token>?sheet=<id>) or at a spreadsheet inside a wiki (/wiki/<node>?sheet=<id>). Read and written as the
 * person, with their sheets:spreadsheet scope; when it is missing they are sent to connect it.
 */
import { config } from '../config.ts';
import type { User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { DENIED_CODES, LarkError, SCOPE_CODES } from './client.ts';
import { asUser, connection } from './userToken.ts';
import type { Condition } from '../data/fields.ts';

export const SHEETS_SCOPE = 'sheets:spreadsheet';
export const sheetsConnectUrl = (returnPath = '/me') => `${config.hubUrl}/auth/lark/connect?sheets=1&return=${encodeURIComponent(returnPath)}`;

export interface SheetRef { kind: 'sheets' | 'wiki'; token: string; sheet?: string }

/** A /sheets/ link, or undefined when the link is something else (wiki links are told apart by looking them up). */
export function parseSheetUrl(raw: string): SheetRef | undefined {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  const m = u.pathname.match(/\/(sheets|wiki)\/([A-Za-z0-9]+)/);
  return m ? { kind: m[1] as 'sheets' | 'wiki', token: m[2], sheet: u.searchParams.get('sheet') ?? undefined } : undefined;
}

async function call<T>(user: User, path: string, init?: RequestInit): Promise<T> {
  try {
    return await asUser<T>(user, path, init);
  } catch (e) {
    if (e instanceof LarkError && SCOPE_CODES.has(e.code)) {
      // the hub's Lark app has the scope but this person's grant predates it: one more consent fixes it
      if (!connection(user.id).scopes?.includes(SHEETS_SCOPE)) throw new UserError('err.sheets.connect', { url: sheetsConnectUrl() });
      throw new UserError('err.lark.scopeMissing', { detail: e.message });
    }
    if (e instanceof LarkError && DENIED_CODES.has(e.code)) throw new UserError(init?.method && init.method !== 'GET' ? 'err.data.noEdit' : 'err.data.denied');
    throw e;
  }
}

/** What a wiki node holds: 'sheet', 'bitable', 'docx', … and its object token. */
export async function wikiObject(user: User, node: string) {
  const r = await call<{ data: { node: { obj_type: string; obj_token: string } } }>(user, `/wiki/v2/spaces/get_node?token=${encodeURIComponent(node)}`);
  return { type: r.data.node.obj_type, token: r.data.node.obj_token };
}

/** The spreadsheet token behind a link, or undefined when the link is not a spreadsheet. */
export async function resolveSpreadsheet(user: User, ref: SheetRef): Promise<string | undefined> {
  if (ref.kind === 'sheets') return ref.token;
  const o = await wikiObject(user, ref.token);
  return o.type === 'sheet' ? o.token : undefined;
}

export interface SheetInfo { id: string; title: string; rows: number; cols: number }

export async function listSheets(user: User, spreadsheet: string): Promise<SheetInfo[]> {
  const r = await call<{ data: { sheets?: { sheet_id: string; title: string; grid_properties?: { row_count?: number; column_count?: number } }[] } }>(
    user, `/sheets/v3/spreadsheets/${spreadsheet}/sheets/query`);
  return (r.data.sheets ?? []).map((s) => ({ id: s.sheet_id, title: s.title, rows: s.grid_properties?.row_count ?? 0, cols: s.grid_properties?.column_count ?? 0 }));
}

/** The sheet a link means: the one it names, or the only sheet in the spreadsheet; with several, the error lists them. */
export async function pickSheet(user: User, spreadsheet: string, sheet?: string): Promise<SheetInfo> {
  const sheets = await listSheets(user, spreadsheet);
  const found = sheet ? sheets.find((s) => s.id === sheet) : sheets.length === 1 ? sheets[0] : undefined;
  if (found) return found;
  if (sheet) throw new UserError('err.sheets.noSheet', { sheet });
  throw new UserError('err.sheets.pickSheet', { names: sheets.map((s) => `${s.title} (?sheet=${s.id})`).join(', ') });
}

/** A, B, …, Z, AA, … for a 1-based column number. */
export function columnName(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

const MAX_COLS = 100;

async function values(user: User, spreadsheet: string, range: string): Promise<unknown[][]> {
  const r = await call<{ data: { valueRange?: { values?: unknown[][] } } }>(
    user, `/sheets/v2/spreadsheets/${spreadsheet}/values/${encodeURIComponent(range)}?valueRenderOption=ToString&dateTimeRenderOption=FormattedString`);
  return r.data.valueRange?.values ?? [];
}

/** A cell as text: rich cells (links, mentions, segments) become their text. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(cellText).join('');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return cellText(o.text ?? o.link ?? o.name ?? '');
  }
  return String(v);
}

interface Sheet { info: SheetInfo; columns: { name: string; index: number }[] }

/** The sheet and its columns, named by the first row. Blank header cells are skipped; repeated names get " (2)". */
async function openSheet(user: User, spreadsheet: string, sheetId: string): Promise<Sheet> {
  const info = (await listSheets(user, spreadsheet)).find((s) => s.id === sheetId);
  if (!info) throw new UserError('err.sheets.noSheet', { sheet: sheetId });
  const cols = Math.min(Math.max(info.cols, 1), MAX_COLS);
  const [head = []] = await values(user, spreadsheet, `${sheetId}!A1:${columnName(cols)}1`);
  const seen = new Map<string, number>();
  const columns: Sheet['columns'] = [];
  head.forEach((v, i) => {
    const base = cellText(v).trim();
    if (!base) return;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    columns.push({ name: n > 1 ? `${base} (${n})` : base, index: i });
  });
  if (!columns.length) throw new UserError('err.sheets.noHeader');
  return { info, columns };
}

const lastColumn = (s: Sheet) => columnName(Math.max(...s.columns.map((c) => c.index)) + 1);

export async function sheetFields(user: User, spreadsheet: string, sheetId: string) {
  const s = await openSheet(user, spreadsheet, sheetId);
  return s.columns.map((c) => ({ name: c.name, type: 'Text' }));
}

export interface SheetRecord { id: string; fields: Record<string, string>; text: Record<string, string> }

function matches(r: SheetRecord, c: Condition): boolean {
  const v = r.text[c.field] ?? '';
  const want = String(c.value ?? '');
  switch (c.op) {
    case 'is': return v === want;
    case 'isNot': return v !== want;
    case 'contains': return v.toLowerCase().includes(want.toLowerCase());
    case 'doesNotContain': return !v.toLowerCase().includes(want.toLowerCase());
    case 'isEmpty': return v.trim() === '';
    case 'isNotEmpty': return v.trim() !== '';
    case 'isGreater': return Number(v) > Number(want);
    case 'isLess': return Number(v) < Number(want);
  }
}

/** Rows as records (blank rows skipped), filtered like Base searches, newest rows last. */
export async function sheetRecords(user: User, spreadsheet: string, sheetId: string, o: { where?: Condition[]; max?: number } = {}): Promise<SheetRecord[]> {
  const s = await openSheet(user, spreadsheet, sheetId);
  for (const c of o.where ?? []) if (!s.columns.some((x) => x.name === c.field)) throw new UserError('err.sheets.unknownColumn', { name: c.field, names: s.columns.map((x) => x.name).join(', ') });
  const last = Math.min(s.info.rows, 20_000);
  const out: SheetRecord[] = [];
  // read in blocks so a large sheet doesn't hit Lark's per-call limits
  for (let from = 2; from <= last; from += 2000) {
    const to = Math.min(last, from + 1999);
    const rows = await values(user, spreadsheet, `${sheetId}!A${from}:${lastColumn(s)}${to}`);
    rows.forEach((row, i) => {
      const text = Object.fromEntries(s.columns.map((c) => [c.name, cellText(row?.[c.index]).trim()]));
      if (Object.values(text).every((v) => v === '')) return;
      const r = { id: `row${from + i}`, fields: text, text };
      if ((o.where ?? []).every((c) => matches(r, c))) out.push(r);
    });
  }
  return o.max ? out.slice(-o.max) : out;
}

/** Values for the row in column order; unknown column names are an error so typos don't vanish silently. */
function rowValues(s: Sheet, fields: Record<string, unknown>, base: unknown[] = []): unknown[] {
  for (const name of Object.keys(fields)) if (!s.columns.some((c) => c.name === name)) throw new UserError('err.sheets.unknownColumn', { name, names: s.columns.map((c) => c.name).join(', ') });
  const width = Math.max(...s.columns.map((c) => c.index)) + 1;
  const row = Array.from({ length: width }, (_, i) => base[i] ?? null);
  for (const c of s.columns) {
    if (!(c.name in fields)) continue;
    const v = fields[c.name];
    row[c.index] = v === null || v === undefined ? '' : typeof v === 'number' || typeof v === 'boolean' ? v : Array.isArray(v) ? v.map(cellText).join(', ') : cellText(v);
  }
  return row;
}

/** Appends a row under the last one. */
export async function appendSheetRow(user: User, spreadsheet: string, sheetId: string, fields: Record<string, unknown>) {
  const s = await openSheet(user, spreadsheet, sheetId);
  const r = await call<{ data: { updates?: { updatedRange?: string } } }>(user, `/sheets/v2/spreadsheets/${spreadsheet}/values_append?insertDataOption=INSERT_ROWS`, {
    method: 'POST', body: JSON.stringify({ valueRange: { range: `${sheetId}!A1:${lastColumn(s)}1`, values: [rowValues(s, fields)] } }),
  });
  const row = r.data.updates?.updatedRange?.match(/![A-Z]+(\d+)/)?.[1];
  return { id: row ? `row${row}` : null, fields };
}

/** Changes the given columns of one row, leaving the others as they are. */
export async function updateSheetRow(user: User, spreadsheet: string, sheetId: string, id: string, fields: Record<string, unknown>) {
  const n = Number(id.match(/^row(\d+)$/)?.[1]);
  if (!n || n < 2) throw new UserError('err.sheets.badRow', { id });
  const s = await openSheet(user, spreadsheet, sheetId);
  const range = `${sheetId}!A${n}:${lastColumn(s)}${n}`;
  const [current = []] = await values(user, spreadsheet, range);
  await call(user, `/sheets/v2/spreadsheets/${spreadsheet}/values`, {
    method: 'PUT', body: JSON.stringify({ valueRange: { range, values: [rowValues(s, fields, current)] } }),
  });
  return { id, fields };
}

/** For agents: the sheets in the spreadsheet, and for the chosen one its columns and the last 5 rows. */
export async function inspectSheet(user: User, spreadsheet: string, sheetId?: string) {
  const sheets = await listSheets(user, spreadsheet);
  const id = sheetId ?? (sheets.length === 1 ? sheets[0].id : undefined);
  if (!id) return { kind: 'spreadsheet', sheets, hint: 'pick a sheet id (the ?sheet= in the link) and call again' };
  const fields = await sheetFields(user, spreadsheet, id);
  const rows = await sheetRecords(user, spreadsheet, id, { max: 5 });
  return { kind: 'spreadsheet', sheets, sheet: id, fields, sample: rows.map((r) => ({ row: r.id, ...r.text })), note: 'Row 1 holds the column names; each row below is a record with id row<N>.' };
}
