/**
 * The team's daily report, kept as one Lark document per day in a wiki folder ("团队工作日报 1020"). Each project is
 * a table whose rows start with @someone, followed by columns like "done yesterday / plan today / blockers".
 * Agents read today's report and fill in their own person's rows, always with that person's own Lark access, so the
 * document shows them as the editor. Which folder and title pattern is set by an admin.
 */
import { config } from '../config.ts';
import { get, now, run, type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { allBlocks as docAllBlocks, docCall, larkLink } from './docs.ts';
import { parseBaseUrl } from './base.ts';

interface DailyConfig { space: string; folder: string; folderTitle: string; title: string; host?: string }

export function dailyConfig(): DailyConfig | null {
  const v = get<{ value: string }>("SELECT value FROM settings WHERE key = 'daily.config'")?.value;
  return v ? (JSON.parse(v) as DailyConfig) : null;
}

const call = <T>(user: User, path: string, init?: RequestInit) => docCall<T>(user, path, init);

interface WikiNode { node_token: string; obj_token: string; obj_type: string; title: string; space_id: string; obj_create_time?: string }

/** Admin: where the daily reports live (a wiki page whose children are the reports) and how they are titled. */
export async function setDailyConfig(admin: User, folderUrl: string, title: string) {
  if (admin.role !== 'admin') throw new UserError('err.adminOnly');
  if (!title.includes('{')) throw new UserError('err.daily.badTitle');
  const ref = parseBaseUrl(folderUrl);
  if (ref.kind !== 'wiki') throw new UserError('err.daily.notWiki');
  const node = (await call<{ data: { node: WikiNode } }>(admin, `/wiki/v2/spaces/get_node?token=${encodeURIComponent(ref.token)}`)).data.node;
  // links back to the report use the company's own Lark address, as in the link the admin gave
  const c: DailyConfig = { space: node.space_id, folder: node.node_token, folderTitle: node.title, title, host: new URL(folderUrl.trim()).host };
  run(`INSERT INTO settings (key, value, updated_at) VALUES ('daily.config', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, JSON.stringify(c), now());
  return c;
}

/** The title for a day in the company time zone: {YYYY} {MM} {DD} {M} {D}. */
export function titleFor(pattern: string, day: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(day).map((p) => [p.type, p.value]));
  return pattern.replace(/\{YYYY\}/g, parts.year).replace(/\{MM\}/g, parts.month).replace(/\{DD\}/g, parts.day)
    .replace(/\{M\}/g, String(Number(parts.month))).replace(/\{D\}/g, String(Number(parts.day)));
}

async function findReport(user: User, c: DailyConfig, title: string): Promise<WikiNode | null> {
  let pageToken = '';
  do {
    const r = await call<{ data: { items?: WikiNode[]; page_token?: string; has_more?: boolean } }>(user,
      `/wiki/v2/spaces/${c.space}/nodes?parent_node_token=${c.folder}&page_size=50${pageToken ? `&page_token=${pageToken}` : ''}`);
    const hit = (r.data.items ?? []).find((n) => n.title.trim() === title && n.obj_type === 'docx');
    if (hit) return hit;
    pageToken = r.data.has_more ? r.data.page_token ?? '' : '';
  } while (pageToken);
  return null;
}

// ---------------------------------------------------------------- reading the document
interface Element { text_run?: { content?: string }; mention_user?: { user_id?: string }; mention_doc?: { title?: string; url?: string }; link?: { url?: string } }
interface Block { block_id: string; block_type: number; parent_id?: string; children?: string[]; table?: { cells: string[]; property: { row_size: number; column_size: number } }; [k: string]: unknown }

const HEADING = new Set([3, 4, 5, 6, 7, 8, 9, 10, 11]);
const TEXT_KEYS = ['text', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'heading7', 'heading8', 'heading9', 'bullet', 'ordered', 'quote', 'todo', 'code'];

function elementsOf(b: Block): Element[] {
  for (const k of TEXT_KEYS) {
    const v = b[k] as { elements?: Element[] } | undefined;
    if (v?.elements) return v.elements;
  }
  return [];
}

const nameOf = (openId: string) => get<{ name: string }>('SELECT name FROM users WHERE id = ?', openId)?.name ?? openId;

function textOf(b: Block, withMentions = true): string {
  return elementsOf(b).map((e) => e.text_run?.content ?? (e.mention_user?.user_id ? (withMentions ? `@${nameOf(e.mention_user.user_id)}` : '') : e.mention_doc?.title ?? '')).join('');
}

const allBlocks = (user: User, doc: string) => docAllBlocks(user, doc) as Promise<Map<string, Block>>;

interface Row { person: { id: string; name: string } | null; cells: string[]; cellIds: string[] }
interface Section { name: string; columns: string[]; rows: Row[] }

/** Each table with the heading it sits under: "社媒资源层 @ken" → "社媒资源层", "三、日常工作" → "日常工作". */
function sections(blocks: Map<string, Block>, doc: string): Section[] {
  const root = blocks.get(doc) ?? [...blocks.values()].find((b) => b.block_type === 1);
  const out: Section[] = [];
  let heading = '';
  const cellText = (id: string) => (blocks.get(id)?.children ?? []).map((k) => blocks.get(k)).filter(Boolean).map((b) => textOf(b!)).join('\n').trim();
  for (const id of root?.children ?? []) {
    const b = blocks.get(id);
    if (!b) continue;
    if (HEADING.has(b.block_type)) heading = textOf(b, false).replace(/^[一二三四五六七八九十]+、\s*/, '').trim();
    if (b.block_type !== 31 || !b.table) continue;
    const { cells, property } = b.table;
    const cols = property.column_size;
    const rows: Row[] = [];
    for (let r = 1; r < property.row_size; r++) {
      const ids = cells.slice(r * cols, r * cols + cols);
      const first = (blocks.get(ids[0])?.children ?? []).map((k) => blocks.get(k)).flatMap((x) => (x ? elementsOf(x) : []));
      const who = first.find((e) => e.mention_user?.user_id)?.mention_user?.user_id;
      rows.push({ person: who ? { id: who, name: nameOf(who) } : null, cells: ids.slice(1).map(cellText), cellIds: ids.slice(1) });
    }
    out.push({ name: heading || `#${out.length + 1}`, columns: cells.slice(1, cols).map(cellText), rows });
  }
  return out;
}

async function openReport(user: User, date?: string) {
  const c = dailyConfig();
  if (!c) throw new UserError('err.daily.notConfigured');
  const day = date ? new Date(`${date}T12:00:00Z`) : new Date();
  if (Number.isNaN(day.getTime())) throw new UserError('err.daily.badDate');
  const title = titleFor(c.title, day);
  const node = await findReport(user, c, title);
  if (!node) throw new UserError('err.daily.notFound', { title, folder: c.folderTitle });
  const blocks = await allBlocks(user, node.obj_token);
  const url = c.host ? `https://${c.host}/wiki/${node.node_token}` : larkLink('wiki', node.node_token);
  return { node, title, url, sections: sections(blocks, node.obj_token) };
}

/** Today's (or a given day's) report: every table, and the rows of the asking person. */
export async function readDailyReport(user: User, date?: string) {
  const r = await openReport(user, date);
  const mine = r.sections.flatMap((s) => s.rows.filter((x) => x.person?.id === user.id).map((x) => ({ section: s.name, columns: s.columns, cells: x.cells })));
  const people = new Map<string, { name: string; filled: boolean }>();
  for (const s of r.sections) for (const row of s.rows) {
    if (!row.person) continue;
    const prev = people.get(row.person.id);
    people.set(row.person.id, { name: row.person.name, filled: (prev?.filled ?? false) || row.cells.some((x) => x.trim()) });
  }
  return {
    title: r.title, url: r.url,
    mine,
    sections: r.sections.map((s) => ({ name: s.name, columns: s.columns, rows: s.rows.map((x) => ({ person: x.person?.name ?? null, cells: x.cells })) })),
    notFilledYet: [...people.values()].filter((p) => !p.filled).map((p) => p.name),
  };
}

// ---------------------------------------------------------------- writing the person's rows
async function replaceCell(user: User, doc: string, cellId: string, text: string) {
  const cell = (await call<{ data: { block: Block } }>(user, `/docx/v1/documents/${doc}/blocks/${cellId}`)).data.block;
  const old = cell.children?.length ?? 0;
  const lines = text.split('\n').map((l) => l.trimEnd());
  const children = (lines.length ? lines : ['']).map((content) => ({ block_type: 2, text: { elements: [{ text_run: { content } }] } }));
  // add the new text first (a cell must never be empty), then remove what was there
  await call(user, `/docx/v1/documents/${doc}/blocks/${cellId}/children?document_revision_id=-1`, { method: 'POST', body: JSON.stringify({ index: 0, children }) });
  if (old) {
    await call(user, `/docx/v1/documents/${doc}/blocks/${cellId}/children/batch_delete?document_revision_id=-1`, {
      method: 'DELETE', body: JSON.stringify({ start_index: children.length, end_index: children.length + old }),
    });
  }
}

/**
 * Writes the asking person's rows. `rows` name a section (as read) and give the columns after the person, in order;
 * an empty string or null leaves that column as it is.
 */
export async function fillDailyReport(user: User, input: { date?: string; rows: { section: string; cells: (string | null)[] }[] }) {
  const r = await openReport(user, input.date);
  const written: { section: string; columns: string[] }[] = [];
  for (const want of input.rows) {
    const key = want.section.trim();
    const section = r.sections.find((s) => s.name === key) ?? r.sections.find((s) => s.name.includes(key) || key.includes(s.name));
    if (!section) throw new UserError('err.daily.noSection', { section: key, sections: r.sections.map((s) => s.name).join(', ') });
    const row = section.rows.find((x) => x.person?.id === user.id);
    if (!row) throw new UserError('err.daily.noRow', { section: section.name });
    const cols: string[] = [];
    for (let i = 0; i < Math.min(want.cells.length, row.cellIds.length); i++) {
      const v = want.cells[i];
      if (v === null || v === undefined || !String(v).trim()) continue;
      await replaceCell(user, r.node.obj_token, row.cellIds[i], String(v).slice(0, 5000));
      cols.push(section.columns[i] ?? `#${i + 2}`);
    }
    written.push({ section: section.name, columns: cols });
  }
  return { title: r.title, url: r.url, written };
}
