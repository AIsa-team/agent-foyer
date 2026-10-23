/**
 * Lark Base tables as data sources, always read with the viewer's own Lark access, so people only see rows they could
 * open in Lark. Registered by the Lark channel as the 'base' kind (see ../data/kinds.ts).
 */
import { existsSync, readFileSync, rmSync, writeFile } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzip } from 'node:zlib';
import { config, paths } from '../config.ts';
import { all, get, type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import type { Row, SourceKind, SourceRow, Table } from '../data/kinds.ts';
import { fetchRecords, isAdvanced, listFields, listTables, parseBaseUrl, pickTable, resolveAppToken, searchRecords } from './base.ts';
import { inspectSheet, parseSheetUrl, resolveSpreadsheet, wikiObject } from './sheets.ts';
import { connection } from './userToken.ts';
import { plainText } from '../data/fields.ts';

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
 * Whether this person may open the table in Lark. The answer is kept for 5 minutes (asking Lark on every chart would
 * be slow), so access removed in Lark takes up to that long to apply.
 */
function canRead(user: User, s: SourceRow): Promise<boolean> {
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
function startSnapshotRefresher() {
  const tick = () => {
    for (const src of all<SourceRow>("SELECT * FROM data_sources WHERE kind = 'base'")) {
      loadSnapshot(src.id);
      const snap = snapshots.get(src.id);
      if (!snap || (!snap.advanced && Date.now() - snap.at > SNAPSHOT_TTL)) takeSnapshot(src);
    }
  };
  setTimeout(tick, 2_000);
  setInterval(tick, 60_000).unref();
}

async function sharedRows(user: User, s: SourceRow): Promise<Row[] | null> {
  loadSnapshot(s.id);
  let snap = snapshots.get(s.id);
  if (snap?.advanced) return null;
  if (!(await canRead(user, s))) return null;
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

export const larkBaseSource: SourceKind = {
  kind: 'base',
  label: 'lark',
  matches: (url) => /(larksuite\.com|feishu\.cn|larkoffice\.com)\/(base|wiki)\//.test(url),
  async register(user, input) {
    const ref = parseBaseUrl(input.url);
    const app = await resolveAppToken(user, ref);
    const table = await pickTable(user, app, input.table ?? ref.table);
    // reading the fields proves the person can open it, and that the ids are right
    await listFields(user, app, table, ref.view);
    return { url: input.url, app_token: app, table_id: table, view_id: ref.view ?? null };
  },
  connected: (user) => connection(user.id).connected,
  canRead,
  async load(user, s, fresh): Promise<Table> {
    const fields = await listFields(user, s.app_token, s.table_id, s.view_id ?? undefined);
    const rows = (!fresh && (await sharedRows(user, s))) || (await baseRows(user, s));
    return { fields, rows };
  },
  recordUrl: (s, recordId) => `${s.url}${s.url.includes('?') ? '&' : '?'}record=${encodeURIComponent(recordId)}`,
  forget(id) {
    snapshots.delete(id);
    rmSync(snapshotFile(id), { force: true });
    for (const k of readable.keys()) if (k.startsWith(`${id}\u0000`)) readable.delete(k);
  },
  start: startSnapshotRefresher,
};
