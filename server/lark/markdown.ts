/**
 * Markdown to Lark document blocks, in the shape the "create nested blocks" API takes: a list of top-level ids and
 * every block (with temporary ids and their children). Done here rather than with Lark's converter, which needs an
 * extra scope. Covers what agents write: headings, paragraphs, nested bullet / numbered / to-do lists, quotes, code,
 * dividers, tables, and inline bold, italic, strikethrough, code and links. Images are counted and left out.
 */
export interface NewBlock { block_id: string; block_type: number; children: string[]; [k: string]: unknown }
export interface Converted { top: string[]; blocks: NewBlock[]; images: number }

interface Style { bold?: true; italic?: true; strikethrough?: true; inline_code?: true; link?: { url: string } }
type Element = { text_run: { content: string; text_element_style?: Style } };

const HEADING = [3, 4, 5, 6, 7, 8];   // heading1..heading6
const KEY: Record<number, string> = { 2: 'text', 3: 'heading1', 4: 'heading2', 5: 'heading3', 6: 'heading4', 7: 'heading5', 8: 'heading6', 12: 'bullet', 13: 'ordered', 15: 'quote', 17: 'todo' };

/** Inline Markdown to Lark text elements. */
export function inlineElements(text: string): Element[] {
  const out: Element[] = [];
  const push = (content: string, style: Style = {}) => {
    if (!content) return;
    const prev = out[out.length - 1];
    if (prev && JSON.stringify(prev.text_run.text_element_style ?? {}) === JSON.stringify(style)) prev.text_run.content += content;
    else out.push({ text_run: { content, ...(Object.keys(style).length ? { text_element_style: style } : {}) } });
  };
  const walk = (s: string, style: Style) => {
    // the first of: `code`, [text](url), ***x***, **x**, ~~x~~, *x* / _x_, a bare URL
    const re = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|~~(.+?)~~|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\*)|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?，。；：！？）])/g;
    let at = 0;
    for (let m; (m = re.exec(s)); ) {
      push(s.slice(at, m.index).replace(/\\([\\`*_[\]~])/g, '$1'), style);
      if (m[1] !== undefined) push(m[1], { ...style, inline_code: true });
      else if (m[2] !== undefined) walk(m[2], { ...style, link: { url: encodeURIComponent(m[3]) } });
      else if (m[4] !== undefined) walk(m[4], { ...style, bold: true, italic: true });
      else if (m[5] !== undefined) walk(m[5], { ...style, bold: true });
      else if (m[6] !== undefined) walk(m[6], { ...style, strikethrough: true });
      else if (m[7] !== undefined) walk(m[7], { ...style, italic: true });
      else if (m[8] !== undefined) walk(m[8], { ...style, italic: true });
      else if (m[9] !== undefined) push(m[9], { ...style, link: { url: encodeURIComponent(m[9]) } });
      at = m.index + m[0].length;
    }
    push(s.slice(at).replace(/\\([\\`*_[\]~])/g, '$1'), style);
  };
  walk(text, {});
  return out.length ? out : [{ text_run: { content: '' } }];
}

const isCjk = (ch: string | undefined) => !!ch && /[⺀-鿿＀-￯]/.test(ch);

export function markdownToBlocks(markdown: string): Converted {
  const blocks: NewBlock[] = [];
  const top: string[] = [];
  let n = 0, images = 0;
  const add = (type: number, body: Record<string, unknown>, parent?: NewBlock): NewBlock => {
    const b: NewBlock = { block_id: `b${++n}`, block_type: type, children: [], ...body };
    blocks.push(b);
    if (parent) parent.children.push(b.block_id);
    else top.push(b.block_id);
    return b;
  };
  const textBlock = (type: number, text: string, parent?: NewBlock, extra: Record<string, unknown> = {}) =>
    add(type, { [KEY[type]]: { elements: inlineElements(text), ...extra } }, parent);

  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  // open list items by indent, so deeper items nest under the one above
  let list: { indent: number; block: NewBlock }[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    const text = para.reduce((acc, l) => (acc && !isCjk(acc.at(-1)) && !isCjk(l[0]) ? `${acc} ${l}` : acc + l), '');
    textBlock(2, text);
    para = [];
  };
  const endBlock = () => { flushPara(); list = []; };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { flushPara(); continue; }

    const fence = t.match(/^(```|~~~)/);
    if (fence) {
      endBlock();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      add(14, { code: { elements: [{ text_run: { content: body.join('\n') } }], style: { language: 1, wrap: true } } });
      continue;
    }
    const heading = t.match(/^(#{1,6})\s+(.*?)\s*#*$/);
    if (heading) { endBlock(); textBlock(HEADING[heading[1].length - 1], heading[2]); continue; }
    if (/^([-*_])(\s*\1){2,}$/.test(t)) { endBlock(); add(22, { divider: {} }); continue; }
    if (/^!\[[^\]]*\]\([^)]*\)$/.test(t)) { endBlock(); images++; continue; }

    // a table: a row of cells, a separator line, more rows
    if (t.startsWith('|') && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(lines[i + 1]?.trim() ?? '')) {
      endBlock();
      const cellsOf = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const rows = [cellsOf(t)];
      for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(cellsOf(lines[i]));
      i--;
      const cols = rows[0].length;
      const table = add(31, { table: { property: { row_size: rows.length, column_size: cols, header_row: true } } });
      for (const row of rows) {
        for (let c = 0; c < cols; c++) {
          const cell = add(32, { table_cell: {} }, table);
          for (const part of (row[c] ?? '').split(/<br\s*\/?>/i)) textBlock(2, part, cell);
        }
      }
      continue;
    }

    const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/);
    if (item) {
      flushPara();
      const indent = item[1].replace(/\t/g, '    ').length;
      while (list.length && list[list.length - 1].indent >= indent) list.pop();
      const parent = list[list.length - 1]?.block;
      const type = item[3] !== undefined ? 17 : /\d/.test(item[2]) ? 13 : 12;
      const b = textBlock(type, item[4], parent, type === 17 ? { style: { done: item[3].toLowerCase() === 'x' } } : {});
      list.push({ indent, block: b });
      continue;
    }
    if (t.startsWith('>')) { endBlock(); textBlock(15, t.replace(/^>\s?/, '')); continue; }
    // a line indented under a list item continues it as its own paragraph
    if (list.length && /^\s+/.test(line)) { textBlock(2, t, list[list.length - 1].block); continue; }
    list = [];
    para.push(t);
  }
  flushPara();
  return { top, blocks, images };
}
