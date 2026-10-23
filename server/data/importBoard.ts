/**
 * Turns a dashboard of another system (any connector with boards, e.g. Metabase) into hub boards on the Data page:
 * every chart's item becomes a data source (reused when it already is one), and every card a module, so the numbers
 * get the hub's audiences, detail pages, alerts and agent tools. One hub board per tab. Importing again syncs: the
 * boards are rebuilt, sources kept.
 *
 * Charts come as they are drawn there. When the other system does not say which columns are the axis and which the
 * values, the first date (else text) column is the axis and the number columns the values. Rates and percentages go
 * to a chart of their own, averaged, so they are not drawn against counts on one scale.
 */
import { all, get, run, type User } from '../db.ts';
import { tr, UserError } from '../i18n/index.ts';
import { config } from '../config.ts';
import { localeCodes } from '../localized.ts';
import { saveBoard } from '../boards.ts';
import { NOTE_MAX } from '../homepage.ts';
import { connectionConfig } from './connectors/index.ts';
import type { BoardCard } from './connectors/types.ts';
import { getSource, loadTable, refreshDescription, saveSource, type Audience, type Table } from './sources.ts';
import { FIELD, isDateField, type Field } from './fields.ts';

type Width = 'full' | 'half' | 'third';
type Module = Record<string, unknown> & { type: string };

const everyLocale = (text: string) => Object.fromEntries(localeCodes().map((l) => [l, text]));
const widthOf = (w: number): Width => (w >= 0.75 ? 'full' : w >= 0.4 ? 'half' : 'third');
// whole words only: "registrations" is a count, "d0_rate" a rate
const RATE = /(?:^|[_\s(])(?:rate|ratio|pct|percent)(?:$|[_\s)])|%|率|比/i;
const isNumber = (f: Field) => f.type === FIELD.number || f.uiType === 'Number' || f.uiType === 'Currency';

/** Markdown from a text card as plain text (the note module keeps line breaks). */
function plainText(md: string) {
  return md
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 ($2)')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_]+)[*_]/g, '$1$2')
    .replace(/^\s*[-*]\s+/gm, '· ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The step of a date column: monthly if every value is the 1st, weekly if every one is a Monday, else daily. */
function stepOf(table: Table, field: string): 'day' | 'week' | 'month' {
  const days = table.rows.map((r) => r.fields[field]).map((v) => (typeof v === 'number' ? new Date(v) : new Date(String(v)))).filter((d) => !Number.isNaN(d.getTime()));
  if (days.length > 1 && days.every((d) => d.getUTCDate() === 1)) return 'month';
  if (days.length > 1 && days.every((d) => d.getUTCDay() === 1)) return 'week';
  return 'day';
}

/** How many steps back from today the data reaches, within limits that keep charts readable. */
function lastOf(table: Table, field: string, step: 'day' | 'week' | 'month') {
  const times = table.rows.map((r) => r.fields[field]).map((v) => (typeof v === 'number' ? v : Date.parse(String(v)))).filter(Number.isFinite);
  if (!times.length) return step === 'day' ? 30 : 12;
  // whole steps between the first date and today, plus today's
  const span = (Date.now() - Math.min(...times)) / 86_400_000;
  const n = Math.floor(step === 'day' ? span : step === 'week' ? span / 7 : span / 30.4) + 1;
  return Math.max(2, Math.min(n, step === 'day' ? 90 : step === 'week' ? 26 : 24));
}

/** One card as hub modules (a chart may become two: amounts, and rates on their own). */
function modulesFor(card: BoardCard, source: string, table: Table): Module[] | null {
  const fields = table.fields;
  const named = (names: string[] | undefined, ok: (f: Field) => boolean) => (names ?? []).map((n) => fields.find((f) => f.name === n)).filter((f): f is Field => !!f && ok(f));
  const dims = named(card.dims, () => true);
  const axis = dims[0] ?? fields.find(isDateField) ?? fields.find((f) => !isNumber(f));
  const values = (named(card.metrics, isNumber).length ? named(card.metrics, isNumber) : fields.filter((f) => isNumber(f) && f !== axis && !dims.includes(f))).slice(0, 6);
  const width = widthOf(card.width);
  const title = everyLocale(card.name ?? '');
  const op = (f: Field) => (RATE.test(f.name) || RATE.test(card.labels?.[f.name] ?? '') ? 'avg' : 'sum');
  const labelOf = (f: Field) => card.labels?.[f.name] ?? f.name;
  const measure = (f: Field) => ({ op: op(f), field: f.name, label: labelOf(f) });

  if (card.chart === 'number') {
    const f = values[0];
    if (!f) return null;
    return [{ type: 'stats', width, items: [{ label: title, source: { data: source, query: { measure: { op: op(f), field: f.name } } }, ...(card.currency && op(f) === 'sum' ? { format: { style: 'currency', currency: card.currency } } : {}) }] }];
  }
  if (card.chart === 'table' || card.chart === 'other' || !axis || !values.length) {
    const date = fields.find(isDateField);
    return [{ type: 'table', width, title, source: { data: source, ...(date ? { sort: { field: date.name, desc: true } } : {}), fields: fields.slice(0, 8).map((f) => f.name) }, limit: 10 }];
  }
  if (card.chart === 'pie' || card.chart === 'funnel') {
    return [{ type: 'chart', width, title, kind: card.chart === 'pie' ? 'donut' : 'funnel', source: { data: source, query: { measure: measure(values[0]), groupBy: axis.name } } }];
  }
  // line / area / bar / row: by date over time, or by a category
  const kind = card.chart === 'area' ? 'area' : card.chart === 'line' ? 'line' : 'bar';
  const amounts = values.filter((f) => op(f) === 'sum');
  const rates = values.filter((f) => op(f) === 'avg');
  // a date axis and one value column, plus a text column the other system splits by (e.g. calls per API per day)
  const second = dims[1] ?? (isDateField(axis) && !card.dims?.length && values.length === 1 ? fields.find((f) => f !== axis && !isNumber(f) && !isDateField(f)) : undefined);
  const chart = (vs: Field[], k: string, suffix = ''): Module => {
    const q: Record<string, unknown> = { measure: measure(vs[0]), ...(vs.length > 1 ? { also: vs.slice(1).map(measure) } : {}) };
    if (isDateField(axis)) {
      const step = stepOf(table, axis.name);
      q.date = { field: axis.name, bucket: step, last: lastOf(table, axis.name, step) };
      if (second && vs.length === 1) q.series = second.name;
    } else {
      q.groupBy = axis.name;
      q.sort = card.chart === 'row' ? 'value_desc' : 'label';
      q.limit = 24;
    }
    const amounts = !suffix && vs.every((f) => op(f) === 'sum');
    return {
      type: 'chart', width, title: suffix ? everyLocale(`${card.name} · ${suffix}`) : title, kind: k, source: { data: source, query: q },
      ...(card.note && !suffix ? { subtitle: everyLocale(card.note.slice(0, 400)) } : {}),
      ...(amounts && card.stacked && vs.length > 1 && (k === 'bar' || k === 'area') ? { stacked: true } : {}),
      ...(amounts && card.currency ? { format: { style: 'currency', currency: card.currency } } : {}),
    };
  };
  const out: Module[] = [];
  if (amounts.length) out.push(chart(amounts, kind));
  if (rates.length) out.push(chart(rates, isDateField(axis) ? 'line' : 'bar', amounts.length ? rates.map(labelOf).join(' / ') : ''));
  return out;
}

/** A few at a time: dashboards hold dozens of questions and each runs in the other system. */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

/** Imports (or syncs) a dashboard. New sources get `audience` (nothing = admins only); existing ones keep theirs. */
export async function importBoard(user: User, connection: string, board: string, opts: { audience?: Audience; locale?: string } = {}) {
  if (user.role !== 'admin') throw new UserError('err.adminOnly');
  const { connector } = connectionConfig(connection);
  if (!connector.board) throw new UserError('err.conn.noBoards', { name: connector.label });
  const { cfg } = connectionConfig(connection);
  const def = await connector.board(cfg, board);
  const created: string[] = [];
  const reused: string[] = [];
  const skipped: { name: string; reason: string }[] = [];

  // the items behind the charts, as data sources (each read once to check it and to see its columns)
  const items = [...new Set(def.tabs.flatMap((t) => t.cards).filter((c) => c.kind === 'chart' && c.item).map((c) => c.item!))];
  const sourceOf = new Map<string, { id: string; table: Table } | { error: string }>();
  await pool(items, 2, async (item) => {
    const card = def.tabs.flatMap((t) => t.cards).find((c) => c.item === item)!;
    try {
      const existing = get<{ id: string }>('SELECT id FROM data_sources WHERE connection_id = ? AND item = ?', connection, item);
      const id = existing?.id ?? `${connection}-${item}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 41);
      if (!existing) {
        await saveSource(user, { id, title: everyLocale(card.name ?? item), connection, item, audience: opts.audience ?? {} });
        created.push(id);
      } else {
        reused.push(id);
        await refreshDescription(id);
      }
      sourceOf.set(item, { id, table: await loadTable(user, getSource(id)) });
    } catch (e) {
      sourceOf.set(item, { error: e instanceof UserError ? e.localized(opts.locale ?? config.defaultLocale) : (e as Error).message });
    }
  });

  const tabs = def.tabs.filter((t) => t.cards.some((c) => c.kind === 'chart'));
  const boards: { id: string; title: string }[] = [];
  tabs.forEach((tab, ti) => {
    const modules: Module[] = [];
    let heading: string | undefined;
    tab.cards.forEach((card, ci) => {
      if (card.kind === 'text') {
        const body = plainText(card.text ?? '').slice(0, NOTE_MAX);
        // a short line right above numbers is their heading
        if (body && !body.includes('\n') && body.length <= 60 && tab.cards[ci + 1]?.chart === 'number') heading = body;
        else if (body) modules.push({ type: 'note', width: widthOf(card.width), body: everyLocale(body) });
        return;
      }
      const s = sourceOf.get(card.item!);
      const title = heading;
      heading = undefined;
      if (!s || 'error' in s) { skipped.push({ name: card.name ?? card.item ?? '', reason: s && 'error' in s ? s.error : 'not read' }); return; }
      const ms = modulesFor(card, s.id, s.table);
      if (!ms) { skipped.push({ name: card.name ?? '', reason: tr(opts.locale ?? config.defaultLocale, 'conn.import.noNumber') }); return; }
      ms.forEach((m, mi) => {
        // numbers side by side in the other system share one row of tiles here
        const prev = modules.at(-1);
        if (m.type === 'stats' && prev?.type === 'stats' && (prev.items as unknown[]).length < 6 && !(mi === 0 && title)) {
          (prev.items as unknown[]).push(...(m.items as unknown[]));
          prev.width = 'full';
          return;
        }
        if (mi === 0 && title) m.title = everyLocale(title);
        modules.push(m);
      });
    });
    const id = `${connection}-${board}${tabs.length > 1 ? `-${ti + 1}` : ''}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 41);
    const title = tab.name && tabs.length > 1 ? `${def.name} · ${tab.name}` : def.name;
    saveBoard(user, { id, title: everyLocale(title), layout: { modules } });
    run('UPDATE boards SET origin = ? WHERE id = ?', JSON.stringify({ connection, board, tab: tab.name ?? null, url: def.url }), id);
    boards.push({ id, title });
  });
  return { name: def.name, url: def.url, boards, sources: { created, reused }, skipped };
}

/** Boards imported through a connection, for the admin page (with the dashboard each came from, to sync it). */
export function importedBoards(connection: string) {
  return all<{ id: string; title_i18n: string; origin: string; updated_at: number }>("SELECT id, title_i18n, origin, updated_at FROM boards WHERE origin IS NOT NULL")
    .map((b) => ({ id: b.id, titles: JSON.parse(b.title_i18n) as Record<string, string>, origin: JSON.parse(b.origin) as { connection: string; board: string; tab: string | null; url: string }, updatedAt: b.updated_at }))
    .filter((b) => b.origin.connection === connection);
}
