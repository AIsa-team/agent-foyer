/**
 * Lark documents for agents, always as the person: search documents and wiki pages by keyword, list the pages under a
 * wiki page, read a document as Markdown
 * (and its tables cell by cell), change the text of its cells and paragraphs or add to its end, and create one from
 * Markdown (so it is theirs, in their own space, a folder or under a wiki page they can edit). Writing asks for
 * document scopes the first time; placing under a wiki page also asks for wiki editing. Lark decides what the person
 * may read and change.
 */
import { config } from '../config.ts';
import { get, type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { DENIED_CODES, LarkError, SCOPE_CODES } from './client.ts';
import { asUser } from './userToken.ts';
import { inlineElements, markdownToBlocks, type NewBlock } from './markdown.ts';
import { readFile } from './files.ts';

/** Editing and creating documents; asked for when someone first has an agent write one. */
export const DOCS_SCOPES = ['docx:document', 'docx:document:create'];
/** Searching documents and wiki pages; asked for the first time someone has an agent search. */
export const SEARCH_SCOPE = 'search:docs:read';
/** Creating pages in a knowledge base; only asked for when a document is placed under a wiki page. */
export const WIKI_WRITE_SCOPE = 'wiki:wiki';

const connectUrl = (wiki: boolean) => `${config.hubUrl}/auth/lark/connect?return=%2Fme&docs=1${wiki ? '&wiki=1' : ''}`;

/** Lark calls as the person; missing scopes and missing access become messages they can act on. */
export async function docCall<T>(user: User, path: string, init?: RequestInit, wiki = false): Promise<T> {
  try {
    return await asUser<T>(user, path, init);
  } catch (e) {
    if (e instanceof LarkError && SCOPE_CODES.has(e.code)) {
      if (!init?.method || init.method === 'GET') throw new UserError('err.lark.scopeMissing', { detail: e.message });
      throw new UserError('err.docs.writeScope', { detail: e.message, url: connectUrl(wiki) });
    }
    if (e instanceof LarkError && DENIED_CODES.has(e.code)) throw new UserError('err.docs.denied');
    throw e;
  }
}

/** A link people can open: the generic Lark address forwards to the company's own one. */
export const larkLink = (kind: 'docx' | 'wiki' | 'file', token: string) => `https://www.${config.lark.domain === 'feishu.cn' ? 'feishu.cn' : 'larksuite.com'}/${kind}/${token}`;

type Ref = { kind: 'docx' | 'wiki' | 'folder' | 'file'; token: string };
/** Document, wiki page, Drive folder or Drive file from a link (or a bare token, taken as a document). */
export function parseDocRef(raw: string): Ref {
  const s = raw.trim();
  const m = s.match(/\/(docx|wiki|drive\/folder|file)\/([A-Za-z0-9]+)/);
  if (m) return { kind: m[1] === 'drive/folder' ? 'folder' : (m[1] as 'docx' | 'wiki' | 'file'), token: m[2] };
  if (/^[A-Za-z0-9]{20,}$/.test(s)) return { kind: 'docx', token: s };
  throw new UserError('err.docs.badLink', { url: raw });
}

interface WikiNode { node_token: string; obj_token: string; obj_type: string; title: string; space_id: string }
const wikiNode = async (user: User, token: string) =>
  (await docCall<{ data: { node: WikiNode } }>(user, `/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}`)).data.node;

/** A link on the company's own Lark address when the person gave one, else the generic address. */
function linkLike(given: string, kind: 'docx' | 'wiki' | 'file', token: string) {
  try {
    const u = new URL(given.trim());
    if (/^https?:$/.test(u.protocol) && /(larksuite\.com|feishu\.cn|larkoffice\.com)$/.test(u.hostname)) return `https://${u.host}/${kind}/${token}`;
  } catch { /* a bare token */ }
  return larkLink(kind, token);
}

// ---------------------------------------------------------------- search
interface SearchUnit {
  title_highlighted?: string; summary_highlighted?: string; entity_type?: string;
  result_meta?: { doc_types?: string; url?: string; owner_name?: string; update_time?: number; last_open_time?: number; edit_user_name?: string };
}
const plain = (s?: string) => (s ?? '').replace(/<\/?h>/g, '').trim();

/**
 * Documents and wiki pages matching `query` that the person may open, most relevant first (Lark's search, as them).
 * `titleOnly` matches titles only; `limit` is at most 50.
 */
export async function searchDocs(user: User, query: string, opts: { titleOnly?: boolean; limit?: number; where?: 'all' | 'docs' | 'wiki' } = {}) {
  const q = query.trim().slice(0, 50);
  if (!q) throw new UserError('err.docs.searchEmpty');
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const filter = opts.titleOnly ? { only_title: true } : {};
  const where = opts.where ?? 'all';
  const found: SearchUnit[] = [];
  let total = 0;
  let page = '';
  for (let i = 0; i < 5 && found.length < limit; i++) {
    const body = {
      query: q, page_size: Math.min(20, limit - found.length), ...(page ? { page_token: page } : {}),
      ...(where !== 'wiki' ? { doc_filter: filter } : {}), ...(where !== 'docs' ? { wiki_filter: filter } : {}),
    };
    let r: { data: { res_units?: SearchUnit[]; total?: number; has_more?: boolean; page_token?: string } };
    try {
      r = await asUser(user, '/search/v2/doc_wiki/search', { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      if (e instanceof LarkError && SCOPE_CODES.has(e.code)) throw new UserError('err.docs.searchScope', { detail: e.message, url: `${config.hubUrl}/auth/lark/connect?return=%2Fme&search=1` });
      throw e;
    }
    found.push(...(r.data.res_units ?? []));
    total = r.data.total ?? found.length;
    if (!r.data.has_more || !r.data.page_token) break;
    page = r.data.page_token;
  }
  const day = (s?: number) => (s ? new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date(s * 1000)) : null);
  return {
    query: q, total,
    results: found.slice(0, limit).map((u) => ({
      title: plain(u.title_highlighted),
      type: (u.result_meta?.doc_types ?? u.entity_type ?? '').toLowerCase(),
      url: u.result_meta?.url ?? null,
      ...(plain(u.summary_highlighted) ? { summary: plain(u.summary_highlighted) } : {}),
      owner: u.result_meta?.owner_name ?? null,
      updated: day(u.result_meta?.update_time),
      ...(u.result_meta?.edit_user_name ? { lastEditedBy: u.result_meta.edit_user_name } : {}),
    })),
  };
}

// ---------------------------------------------------------------- wiki pages
interface WikiChild extends WikiNode { obj_create_time?: string; has_child?: boolean }

/** The pages under a wiki page, in Lark's order; `title` keeps those whose title contains it. */
export async function listWiki(user: User, url: string, title?: string) {
  const ref = parseDocRef(url);
  if (ref.kind !== 'wiki') throw new UserError('err.docs.notWiki');
  const node = await wikiNode(user, ref.token);
  const items: WikiChild[] = [];
  let page = '';
  for (let i = 0; i < 20; i++) {
    const r = await docCall<{ data: { items?: WikiChild[]; page_token?: string; has_more?: boolean } }>(user,
      `/wiki/v2/spaces/${node.space_id}/nodes?parent_node_token=${node.node_token}&page_size=50${page ? `&page_token=${encodeURIComponent(page)}` : ''}`);
    items.push(...(r.data.items ?? []));
    if (!r.data.has_more || !r.data.page_token) break;
    page = r.data.page_token;
  }
  const needle = title?.trim().toLowerCase();
  const pages = items.filter((n) => !needle || n.title.toLowerCase().includes(needle)).map((n) => ({
    title: n.title, url: linkLike(url, 'wiki', n.node_token), type: n.obj_type,
    created: n.obj_create_time ? new Date(Number(n.obj_create_time) * 1000).toISOString() : null, hasChildren: !!n.has_child,
  }));
  return { title: node.title, url: linkLike(url, 'wiki', node.node_token), pages: pages.slice(0, 200), total: pages.length };
}

// ---------------------------------------------------------------- reading
/** The document behind a link: a document, or the document of a wiki page. */
async function openDoc(user: User, url: string, known?: WikiNode) {
  const ref = parseDocRef(url);
  if (ref.kind === 'folder' || ref.kind === 'file') throw new UserError('err.docs.notDoc', { type: ref.kind });
  let doc = ref.token, title = '', link = larkLink(ref.kind, ref.token);
  if (ref.kind === 'wiki') {
    const node = known ?? await wikiNode(user, ref.token);
    if (node.obj_type !== 'docx') throw new UserError('err.docs.notDoc', { type: node.obj_type });
    doc = node.obj_token;
    title = node.title;
  }
  if (!title) title = (await docCall<{ data: { document: { title?: string } } }>(user, `/docx/v1/documents/${doc}`)).data.document.title ?? '';
  return { doc, title, link };
}

/**
 * A document (or the document behind a wiki page) as Markdown; with `tables`, also each table cell by cell (id, text,
 * people mentioned) under the heading it sits under, so particular cells can be changed with editDoc.
 */
export async function readDoc(user: User, url: string, opts: { tables?: boolean } = {}) {
  // a file (an uploaded HTML page, a PDF…) is read as a file
  const ref = parseDocRef(url);
  if (ref.kind === 'file') return readFile(user, ref.token, '', linkLike(url, 'file', ref.token));
  const node = ref.kind === 'wiki' ? await wikiNode(user, ref.token) : undefined;
  if (node?.obj_type === 'file') return readFile(user, node.obj_token, node.title, linkLike(url, 'wiki', ref.token));
  const { doc, title, link } = await openDoc(user, url, node);
  // built from the blocks, which reading a document already allows (Lark's own Markdown export needs another scope)
  const blocks = await allBlocks(user, doc);
  const markdown = toMarkdown(blocks, doc);
  return {
    title, url: link, markdown: markdown.length > 200_000 ? markdown.slice(0, 200_000) + '\n\n…' : markdown, truncated: markdown.length > 200_000,
    ...(opts.tables ? { tables: tablesOf(blocks, doc) } : {}),
  };
}

// ---------------------------------------------------------------- changing
/**
 * Replaces a table cell's content with text, one paragraph per line, with inline Markdown (bold, links…) as Lark styles:
 * the new text goes in first (a cell is never empty).
 */
async function replaceCell(user: User, doc: string, cell: DocBlock, text: string) {
  const old = cell.children?.length ?? 0;
  const lines = text.split('\n').map((l) => l.trimEnd());
  const children = (lines.length ? lines : ['']).map((line) => ({ block_type: 2, text: { elements: inlineElements(line) } }));
  await docCall(user, `/docx/v1/documents/${doc}/blocks/${cell.block_id}/children?document_revision_id=-1`, { method: 'POST', body: JSON.stringify({ index: 0, children }) });
  if (old) {
    await docCall(user, `/docx/v1/documents/${doc}/blocks/${cell.block_id}/children/batch_delete?document_revision_id=-1`, {
      method: 'DELETE', body: JSON.stringify({ start_index: children.length, end_index: children.length + old }),
    });
  }
}

/**
 * Changes a document as the person: `edits` replace the text of table cells or paragraphs (headings, list items,
 * quotes…) by their id from readDoc's tables or blocks; `append` adds Markdown at the end. Everything is checked
 * before anything is written.
 */
export async function editDoc(user: User, url: string, input: { edits?: { id: string; text: string }[]; append?: string }) {
  const edits = input.edits ?? [];
  if (!edits.length && !input.append?.trim()) throw new UserError('err.docs.nothingToDo');
  const { doc, title, link } = await openDoc(user, url);
  const blocks = await allBlocks(user, doc);
  const targets = edits.map((e) => {
    const b = blocks.get(e.id);
    if (!b || b.block_id === doc) throw new UserError('err.docs.noBlock', { id: e.id });
    if (b.block_type !== 32 && !KEYS[b.block_type]) throw new UserError('err.docs.notText', { id: e.id });
    return { b, text: String(e.text ?? '').slice(0, 20_000) };
  });
  const appended = input.append?.trim() ? markdownToBlocks(input.append.trim()) : null;
  const groups = appended ? appended.top.map((id) => subtree(id, new Map(appended.blocks.map((b) => [b.block_id, b])))) : [];
  if (groups.some((g) => g.length > MAX_PER_CALL)) throw new UserError('err.docs.tooBig');
  for (const { b, text } of targets) {
    if (b.block_type === 32) await replaceCell(user, doc, b, text);
    else {
      await docCall(user, `/docx/v1/documents/${doc}/blocks/${b.block_id}?document_revision_id=-1`, {
        // a code block keeps the text as written; anything else takes inline Markdown as Lark styles
        method: 'PATCH', body: JSON.stringify({ update_text_elements: { elements: b.block_type === 14 ? [{ text_run: { content: text } }] : inlineElements(text) } }),
      });
    }
  }
  const added = groups.length ? await insertGroups(user, doc, groups) : 0;
  return { title, url: link, edited: targets.map((t) => t.b.block_id), appendedBlocks: added, ...(appended?.images ? { imagesLeftOut: appended.images } : {}) };
}

// ---------------------------------------------------------------- creating
const MAX_PER_CALL = 1000;

/** The block and everything under it, in order. */
function subtree(id: string, byId: Map<string, NewBlock>, out: NewBlock[] = []): NewBlock[] {
  const b = byId.get(id);
  if (!b) return out;
  out.push(b);
  for (const c of b.children) subtree(c, byId, out);
  return out;
}

/**
 * Creates a document from Markdown as the person and returns its link. `parent` is a wiki page (the document becomes
 * a page under it) or a Drive folder; without it the document goes to the person's own space. Images are left out
 * (they would need uploading), which the result says.
 */
export async function createDoc(user: User, input: { title: string; markdown: string; parent?: string }) {
  const title = input.title.trim().slice(0, 800);
  if (!title) throw new UserError('err.docs.noTitle');
  const parent = input.parent?.trim() ? parseDocRef(input.parent) : null;
  if (parent?.kind === 'docx' || parent?.kind === 'file') throw new UserError('err.docs.badParent');
  // converted and checked before anything is created, so a problem never leaves an empty document behind
  const { top, blocks: all, images } = markdownToBlocks(input.markdown.trim());
  const byId = new Map(all.map((b) => [b.block_id, b]));
  const groups = top.map((id) => subtree(id, byId));
  if (groups.some((g) => g.length > MAX_PER_CALL)) throw new UserError('err.docs.tooBig');

  let doc: string, link: string;
  if (parent?.kind === 'wiki') {
    const under = await wikiNode(user, parent.token);
    const made = (await docCall<{ data: { node: WikiNode } }>(user, `/wiki/v2/spaces/${under.space_id}/nodes`, {
      method: 'POST', body: JSON.stringify({ obj_type: 'docx', node_type: 'origin', parent_node_token: under.node_token, title }),
    }, true)).data.node;
    doc = made.obj_token;
    link = larkLink('wiki', made.node_token);
  } else {
    doc = (await docCall<{ data: { document: { document_id: string } } }>(user, '/docx/v1/documents', {
      method: 'POST', body: JSON.stringify({ title, ...(parent ? { folder_token: parent.token } : {}) }),
    })).data.document.document_id;
    link = larkLink('docx', doc);
  }

  const written = await insertGroups(user, doc, groups);
  return { title, url: link, token: doc, inWiki: parent?.kind === 'wiki', blocks: written, ...(images ? { imagesLeftOut: images } : {}) };
}

/** Adds blocks at the end of a document in order, as many whole top-level blocks per call as fit in Lark's limit of 1000. */
async function insertGroups(user: User, doc: string, groups: NewBlock[][]): Promise<number> {
  let written = 0;
  let batch: { ids: string[]; blocks: NewBlock[] } = { ids: [], blocks: [] };
  const flush = async () => {
    if (!batch.ids.length) return;
    await docCall(user, `/docx/v1/documents/${doc}/blocks/${doc}/descendant?document_revision_id=-1`, {
      method: 'POST', body: JSON.stringify({ index: -1, children_id: batch.ids, descendants: batch.blocks }),
    });
    written += batch.blocks.length;
    batch = { ids: [], blocks: [] };
  };
  for (const g of groups) {
    if (batch.blocks.length + g.length > MAX_PER_CALL) await flush();
    batch.ids.push(g[0].block_id);
    batch.blocks.push(...g);
  }
  await flush();
  return written;
}

// ---------------------------------------------------------------- blocks to Markdown
interface Run { content?: string; text_element_style?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; inline_code?: boolean; link?: { url?: string } } }
interface Element { text_run?: Run; mention_user?: { user_id?: string }; mention_doc?: { title?: string; url?: string }; equation?: { content?: string } }
export interface DocBlock { block_id: string; block_type: number; parent_id?: string; children?: string[]; table?: { cells?: string[]; property: { row_size: number; column_size: number } }; [k: string]: unknown }

/** Every block of a document, all pages of them. */
export async function allBlocks(user: User, doc: string): Promise<Map<string, DocBlock>> {
  const out = new Map<string, DocBlock>();
  let pageToken = '';
  do {
    const r = await docCall<{ data: { items: DocBlock[]; page_token?: string; has_more?: boolean } }>(user,
      `/docx/v1/documents/${doc}/blocks?page_size=500&user_id_type=open_id${pageToken ? `&page_token=${pageToken}` : ''}`);
    for (const b of r.data.items) out.set(b.block_id, b);
    pageToken = r.data.has_more ? r.data.page_token ?? '' : '';
  } while (pageToken);
  return out;
}

const KEYS: Record<number, string> = { 2: 'text', 3: 'heading1', 4: 'heading2', 5: 'heading3', 6: 'heading4', 7: 'heading5', 8: 'heading6', 9: 'heading7', 10: 'heading8', 11: 'heading9', 12: 'bullet', 13: 'ordered', 14: 'code', 15: 'quote', 17: 'todo' };
const personName = (id: string) => get<{ name: string }>('SELECT name FROM users WHERE id = ?', id)?.name ?? id;

function inline(b: DocBlock, raw = false): string {
  // Lark often splits text into pieces with the same style ("**昨****天**"); join those first
  const els: Element[] = [];
  for (const e of (b[KEYS[b.block_type]] as { elements?: Element[] } | undefined)?.elements ?? []) {
    const prev = els[els.length - 1];
    if (prev?.text_run && e.text_run && JSON.stringify(prev.text_run.text_element_style ?? {}) === JSON.stringify(e.text_run.text_element_style ?? {})) {
      els[els.length - 1] = { text_run: { ...prev.text_run, content: (prev.text_run.content ?? '') + (e.text_run.content ?? '') } };
    } else els.push(e);
  }
  return els.map((e) => {
    if (e.mention_user?.user_id) return `@${personName(e.mention_user.user_id)}`;
    if (e.mention_doc) return e.mention_doc.url ? `[${e.mention_doc.title ?? e.mention_doc.url}](${decodeURIComponent(e.mention_doc.url)})` : e.mention_doc.title ?? '';
    if (e.equation?.content) return `$${e.equation.content.trim()}$`;
    let t = e.text_run?.content ?? '';
    if (raw || !t.trim()) return t;
    const st = e.text_run?.text_element_style ?? {};
    // characters that would read as Markdown are escaped, so text read here and written back stays as it was
    if (st.inline_code) t = `\`${t}\``;
    else t = t.replace(/[\\`*~]/g, '\\$&');
    if (st.bold) t = `**${t}**`;
    if (st.italic) t = `*${t}*`;
    if (st.strikethrough) t = `~~${t}~~`;
    if (st.link?.url) t = `[${t}](${decodeURIComponent(st.link.url)})`;
    return t;
  }).join('');
}

/** Every table in document order, under the last heading before it, as rows of cells: id, text (inline Markdown), people mentioned. */
export function tablesOf(blocks: Map<string, DocBlock>, root: string) {
  const kids = (id: string) => (blocks.get(id)?.children ?? []).map((k) => blocks.get(k)).filter((x): x is DocBlock => !!x);
  const cellOf = (id: string) => {
    const inside = kids(id);
    const people = new Map<string, string>();
    for (const b of inside) {
      for (const e of (b[KEYS[b.block_type]] as { elements?: Element[] } | undefined)?.elements ?? []) {
        if (e.mention_user?.user_id) people.set(e.mention_user.user_id, personName(e.mention_user.user_id));
      }
    }
    return { id, text: inside.map((b) => inline(b, b.block_type === 14)).join('\n').trim(), ...(people.size ? { people: [...people].map(([pid, name]) => ({ id: pid, name })) } : {}) };
  };
  const out: { id: string; heading: string; rows: ReturnType<typeof cellOf>[][] }[] = [];
  let heading = '';
  const walk = (b: DocBlock) => {
    if (b.block_type >= 3 && b.block_type <= 11) heading = inline(b, true).trim();
    if (b.block_type === 31 && b.table) {
      const cells = b.table.cells ?? b.children ?? [];
      const cols = b.table.property.column_size;
      const rows = [];
      for (let r = 0; r < b.table.property.row_size; r++) rows.push(cells.slice(r * cols, r * cols + cols).map(cellOf));
      out.push({ id: b.block_id, heading, rows });
      return;
    }
    for (const c of kids(b.block_id)) walk(c);
  };
  for (const b of kids(root)) walk(b);
  return out;
}

/** Markdown for a document's blocks: headings, paragraphs, nested lists, to-dos, quotes, code, dividers and tables. */
export function toMarkdown(blocks: Map<string, DocBlock>, root: string): string {
  const out: string[] = [];
  const kids = (id: string) => (blocks.get(id)?.children ?? []).map((k) => blocks.get(k)).filter((x): x is DocBlock => !!x);
  const cell = (id: string) => kids(id).map((b) => inline(b)).join('<br>').replace(/\|/g, '\\|').trim();
  const walk = (b: DocBlock, depth: number, n: number) => {
    const pad = '  '.repeat(depth);
    const t = b.block_type;
    if (t >= 3 && t <= 11) out.push('', `${'#'.repeat(Math.min(t - 2, 6))} ${inline(b)}`, '');
    else if (t === 2) out.push(pad + inline(b));
    else if (t === 12) out.push(`${pad}- ${inline(b)}`);
    else if (t === 13) out.push(`${pad}${n}. ${inline(b)}`);
    else if (t === 17) out.push(`${pad}- [${(b.todo as { style?: { done?: boolean } })?.style?.done ? 'x' : ' '}] ${inline(b)}`);
    else if (t === 15) out.push(`${pad}> ${inline(b)}`);
    else if (t === 14) out.push('', '```', inline(b, true), '```', '');
    else if (t === 22) out.push('', '---', '');
    else if (t === 27) out.push(`${pad}[image]`);
    else if (t === 31 && b.table) {
      const { property } = b.table;
      const cells = b.table.cells ?? b.children ?? [];
      const cols = property.column_size;
      out.push('');
      for (let r = 0; r < property.row_size; r++) {
        out.push(`| ${cells.slice(r * cols, r * cols + cols).map(cell).join(' | ')} |`);
        if (r === 0) out.push(`|${' --- |'.repeat(cols)}`);
      }
      out.push('');
      return;
    }
    // containers (quote boxes, callouts, grids) and list items carry their content as children
    let i = 0;
    const nested = t === 12 || t === 13 || t === 17 ? depth + 1 : depth;
    for (const c of kids(b.block_id)) walk(c, nested, c.block_type === 13 ? ++i : (i = 0));
  };
  let i = 0;
  for (const b of kids(root)) walk(b, 0, b.block_type === 13 ? ++i : (i = 0));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
