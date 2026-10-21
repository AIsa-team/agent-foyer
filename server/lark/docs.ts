/**
 * Lark documents for agents: read one as Markdown, or create one from Markdown, always as the person (so a created
 * document is theirs, in their own space, a folder or under a wiki page they can edit). Writing asks for document
 * scopes the first time; placing under a wiki page also asks for wiki editing.
 */
import { config } from '../config.ts';
import { get, type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { DENIED_CODES, LarkError, SCOPE_CODES } from './client.ts';
import { asUser } from './userToken.ts';
import { markdownToBlocks, type NewBlock } from './markdown.ts';

/** Editing and creating documents; asked for when someone first has an agent write one. */
export const DOCS_SCOPES = ['docx:document', 'docx:document:create'];
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
export const larkLink = (kind: 'docx' | 'wiki', token: string) => `https://www.${config.lark.domain === 'feishu.cn' ? 'feishu.cn' : 'larksuite.com'}/${kind}/${token}`;

type Ref = { kind: 'docx' | 'wiki' | 'folder'; token: string };
/** Document, wiki page or Drive folder from a link (or a bare token, taken as a document). */
export function parseDocRef(raw: string): Ref {
  const s = raw.trim();
  const m = s.match(/\/(docx|wiki|drive\/folder)\/([A-Za-z0-9]+)/);
  if (m) return { kind: m[1] === 'drive/folder' ? 'folder' : (m[1] as 'docx' | 'wiki'), token: m[2] };
  if (/^[A-Za-z0-9]{20,}$/.test(s)) return { kind: 'docx', token: s };
  throw new UserError('err.docs.badLink', { url: raw });
}

interface WikiNode { node_token: string; obj_token: string; obj_type: string; title: string; space_id: string }
const wikiNode = async (user: User, token: string) =>
  (await docCall<{ data: { node: WikiNode } }>(user, `/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}`)).data.node;

// ---------------------------------------------------------------- reading
/** A document (or the document behind a wiki page) as Markdown. */
export async function readDoc(user: User, url: string) {
  const ref = parseDocRef(url);
  if (ref.kind === 'folder') throw new UserError('err.docs.notDoc', { type: 'folder' });
  let doc = ref.token, title = '', link = larkLink(ref.kind, ref.token);
  if (ref.kind === 'wiki') {
    const node = await wikiNode(user, ref.token);
    if (node.obj_type !== 'docx') throw new UserError('err.docs.notDoc', { type: node.obj_type });
    doc = node.obj_token;
    title = node.title;
  }
  if (!title) title = (await docCall<{ data: { document: { title?: string } } }>(user, `/docx/v1/documents/${doc}`)).data.document.title ?? '';
  // built from the blocks, which reading a document already allows (Lark's own Markdown export needs another scope)
  const markdown = toMarkdown(await allBlocks(user, doc), doc);
  return { title, url: link, markdown: markdown.length > 200_000 ? markdown.slice(0, 200_000) + '\n\n…' : markdown, truncated: markdown.length > 200_000 };
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
  if (parent?.kind === 'docx') throw new UserError('err.docs.badParent');
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

  // insert in order, as many whole top-level blocks per call as fit in Lark's limit of 1000
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
  return { title, url: link, token: doc, inWiki: parent?.kind === 'wiki', blocks: written, ...(images ? { imagesLeftOut: images } : {}) };
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
    if (st.inline_code) t = `\`${t}\``;
    if (st.bold) t = `**${t}**`;
    if (st.italic) t = `*${t}*`;
    if (st.strikethrough) t = `~~${t}~~`;
    if (st.link?.url) t = `[${t}](${decodeURIComponent(st.link.url)})`;
    return t;
  }).join('');
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
