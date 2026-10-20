/**
 * Aggregations over a Base table, run as the viewer: count / sum / avg / min / max of a field, optionally grouped
 * by a field and/or bucketed by a date field, then shaped for the home page charts. The zod schema is also what
 * agents see in the MCP tools.
 */
import { z } from 'zod';
import { config } from '../config.ts';
import { UserError } from '../i18n/index.ts';
import { FIELD, plainNumber, plainText, plainValues, timeOf, type Condition, type Field } from '../lark/base.ts';

export const querySchema = z.object({
  measure: z.object({
    op: z.enum(['count', 'sum', 'avg', 'min', 'max']).describe('count rows, or sum/avg/min/max a number field'),
    field: z.string().optional().describe('number field (not needed for count)'),
  }),
  groupBy: z.string().optional().describe('field to group by: one bar / slice / row per value (multi-select and people count once per value)'),
  series: z.string().optional().describe('second grouping, one series per value (bar/line only; keep it to ≤ 8 values)'),
  date: z.object({
    field: z.string().describe('date field, or a text field holding ISO dates ("2026-07-20T06:32:29Z"), or a number field of timestamps'),
    bucket: z.enum(['day', 'week', 'month', 'quarter']),
    last: z.number().int().min(1).max(366).optional().describe('only the last N buckets up to now, empty ones filled with 0'),
    complete: z.boolean().optional().describe('end with the last finished bucket (e.g. last full month), so "this month so far" is not compared with a whole month; use it for change alerts and period-over-period tiles'),
  }).optional().describe(`bucket rows by a date field (company time zone ${config.timezone}); the x axis of line charts`),
  where: z.array(z.object({
    field: z.string(),
    op: z.enum(['is', 'isNot', 'contains', 'doesNotContain', 'isEmpty', 'isNotEmpty', 'isGreater', 'isLess']),
    value: z.union([z.string(), z.number()]).optional(),
  })).max(10).optional().describe('row filters (use date.last for time windows)'),
  sort: z.enum(['value_desc', 'value_asc', 'label']).optional().describe('for groupBy without date; default value_desc'),
  limit: z.number().int().min(1).max(50).optional().describe('keep the top N groups (default 12)'),
});
export type Query = z.infer<typeof querySchema>;

export interface Row { key: string; series?: string; value: number }
export interface Result { rows: Row[]; value: number; records: number; measure: string; buckets?: string[] }

// ---------------------------------------------------------------- date buckets in the company time zone
// Building a formatter is slow and charts bucket thousands of rows, so keep one, and remember each quarter-hour seen
// (time zone offsets are whole quarter-hours, so every moment in one has the same date).
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
const seenDays = new Map<number, { y: number; m: number; d: number }>();
const parts = (ms: number) => {
  const key = Math.floor(ms / 900_000);
  const hit = seenDays.get(key);
  if (hit) return hit;
  const p = dayFormat.formatToParts(new Date(ms));
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const v = { y: get('year'), m: get('month'), d: get('day') };
  if (seenDays.size > 200_000) seenDays.clear();
  seenDays.set(key, v);
  return v;
};
const pad = (n: number) => String(n).padStart(2, '0');

export function bucketKey(ms: number, bucket: 'day' | 'week' | 'month' | 'quarter'): string {
  const { y, m, d } = parts(ms);
  if (bucket === 'month') return `${y}-${pad(m)}`;
  if (bucket === 'quarter') return `${y}-Q${Math.ceil(m / 3)}`;
  if (bucket === 'day') return `${y}-${pad(m)}-${pad(d)}`;
  // week: the Monday it starts on
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

/** The last `n` bucket keys ending with the current one. */
export function lastBuckets(bucket: 'day' | 'week' | 'month' | 'quarter', n: number, at = Date.now()): string[] {
  const keys: string[] = [];
  if (bucket === 'day' || bucket === 'week') {
    const step = (bucket === 'day' ? 1 : 7) * 86_400_000;
    for (let i = n - 1; i >= 0; i--) keys.push(bucketKey(at - i * step, bucket));
  } else {
    const { y, m } = parts(at);
    const months = bucket === 'month' ? 1 : 3;
    const start = bucket === 'month' ? m : (Math.ceil(m / 3) - 1) * 3 + 1;
    for (let i = n - 1; i >= 0; i--) {
      const total = y * 12 + (start - 1) - i * months;
      const yy = Math.floor(total / 12);
      const mm = (total % 12) + 1;
      keys.push(bucket === 'month' ? `${yy}-${pad(mm)}` : `${yy}-Q${Math.ceil(mm / 3)}`);
    }
  }
  return [...new Set(keys)];
}

// ---------------------------------------------------------------- aggregation
function reduce(op: Query['measure']['op'], xs: number[], rows: number): number {
  if (op === 'count') return rows;
  if (!xs.length) return 0;
  if (op === 'sum') return xs.reduce((a, b) => a + b, 0);
  if (op === 'avg') return xs.reduce((a, b) => a + b, 0) / xs.length;
  if (op === 'min') return Math.min(...xs);
  return Math.max(...xs);
}

const labelOf = (x: unknown) => (x === null || x === undefined || x === '' ? '—' : String(x));

function checkField(fields: Field[], name: string | undefined, role: string) {
  if (!name) return undefined;
  const f = fields.find((x) => x.name === name);
  if (!f) throw new UserError('err.data.noField', { field: name, role, fields: fields.map((x) => x.name).join(', ') });
  return f;
}

/** The same row filters Lark applies, for rows already in memory. */
function matches(rec: Record<string, unknown>, c: Condition, f: Field): boolean {
  const texts = plainValues(rec[f.name]).filter((x) => x !== '' && x !== null).map((x) => String(x).trim());
  const text = plainText(rec[f.name], f).trim();
  const want = c.value === undefined ? '' : String(c.value);
  switch (c.op) {
    case 'is': return texts.includes(want) || text === want;
    case 'isNot': return !(texts.includes(want) || text === want);
    case 'contains': return text.includes(want);
    case 'doesNotContain': return !text.includes(want);
    case 'isEmpty': return texts.length === 0;
    case 'isNotEmpty': return texts.length > 0;
    case 'isGreater': case 'isLess': {
      const a = plainNumber(rec[f.name]) ?? timeOf(rec[f.name]);
      const b = Number(want);
      if (a === null || !Number.isFinite(b)) return false;
      return c.op === 'isGreater' ? a > b : a < b;
    }
  }
}

/** Runs a query over a source's fields and rows (already loaded, see sources.ts loadTable). */
export function runQuery(q: Query, table: { fields: Field[]; rows: Record<string, unknown>[] }): Result {
  const fields = table.fields;
  const measureField = checkField(fields, q.measure.field, 'measure');
  if (q.measure.op !== 'count' && !measureField) throw new UserError('err.data.measureField');
  const groupField = checkField(fields, q.groupBy, 'groupBy');
  const seriesField = checkField(fields, q.series, 'series');
  const dateField = checkField(fields, q.date?.field, 'date');
  for (const w of q.where ?? []) checkField(fields, w.field, 'where');

  const records = table.rows.filter((rec) => (q.where ?? []).every((c) => matches(rec, c, fields.find((f) => f.name === c.field)!)));

  // with `complete`, the current (unfinished) bucket is left out
  const current = q.date ? bucketKey(Date.now(), q.date.bucket) : undefined;
  const window = q.date?.last
    ? new Set(q.date.complete ? lastBuckets(q.date.bucket, q.date.last + 1).slice(0, -1) : lastBuckets(q.date.bucket, q.date.last))
    : undefined;
  const cells = new Map<string, { key: string; series?: string; xs: number[]; n: number }>();
  const all = { xs: [] as number[], n: 0 };
  for (const rec of records) {
    let dkey: string | undefined;
    if (dateField) {
      // date fields, or text / number fields holding times (rows without one are left out)
      const t = timeOf(rec[dateField.name]);
      if (t === null) continue;
      dkey = bucketKey(t, q.date!.bucket);
      if (window && !window.has(dkey)) continue;
      if (q.date!.complete && dkey >= current!) continue;
    }
    const num = measureField ? plainNumber(rec[measureField.name]) : null;
    if (q.measure.op !== 'count' && num === null) continue;
    all.n++;
    if (num !== null) all.xs.push(num);
    const groups = groupField ? plainValues(rec[groupField.name]).map(labelOf) : [undefined];
    const series = seriesField ? plainValues(rec[seriesField.name]).map(labelOf) : [undefined];
    for (const g of groups.length ? groups : ['—']) {
      for (const s of series.length ? series : ['—']) {
        const key = dkey ?? g ?? '';
        const ser = dkey ? (g ?? s) : s;
        const id = `${key}\u0000${ser ?? ''}`;
        const c = cells.get(id) ?? { key, series: ser, xs: [], n: 0 };
        c.n++;
        if (num !== null) c.xs.push(num);
        cells.set(id, c);
      }
    }
  }
  let rows: Row[] = [...cells.values()].map((c) => ({ key: c.key, ...(c.series !== undefined ? { series: c.series } : {}), value: round(reduce(q.measure.op, c.xs, c.n)) }));
  let buckets: string[] | undefined;
  if (q.date) {
    buckets = window ? [...window] : [...new Set(rows.map((r) => r.key))].sort();
    // fill empty buckets so lines don't skip time
    const seriesNames = [...new Set(rows.map((r) => r.series))];
    for (const b of buckets) for (const s of seriesNames) if (!rows.some((r) => r.key === b && r.series === s)) rows.push({ key: b, ...(s !== undefined ? { series: s } : {}), value: 0 });
    rows.sort((a, b) => a.key.localeCompare(b.key));
  } else if (groupField) {
    const totals = new Map<string, number>();
    for (const r of rows) totals.set(r.key, (totals.get(r.key) ?? 0) + r.value);
    const order = [...totals.entries()].sort(q.sort === 'label' ? (a, b) => a[0].localeCompare(b[0]) : q.sort === 'value_asc' ? (a, b) => a[1] - b[1] : (a, b) => b[1] - a[1])
      .slice(0, q.limit ?? 12).map(([k]) => k);
    rows = rows.filter((r) => order.includes(r.key)).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }
  const measure = q.measure.op === 'count' ? 'count' : `${q.measure.op}(${measureField!.name})`;
  return { rows, value: round(reduce(q.measure.op, all.xs, all.n)), records: records.length, measure, buckets };
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

// ---------------------------------------------------------------- shapes for the home page charts
export const CHART_KINDS = ['bar', 'line', 'area', 'donut', 'rank', 'funnel', 'waffle', 'segment', 'calendar'] as const;
export type DataChartKind = (typeof CHART_KINDS)[number];

export function toChart(kind: DataChartKind, r: Result, seriesName: string): Record<string, unknown> {
  const keys = r.buckets ?? [...new Set(r.rows.map((x) => x.key))];
  // date buckets within one year read better without it (08-03, 2026-08 stays as is for months)
  const year = r.buckets && keys.length && keys.every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && k.slice(0, 4) === keys[0].slice(0, 4)) ? keys[0].slice(0, 5) : '';
  const bucketLabel = (k: string) => (year && k.startsWith(year) ? k.slice(5) : k);
  const names = [...new Set(r.rows.map((x) => x.series))];
  const valueAt = (k: string, s: string | undefined) => r.rows.find((x) => x.key === k && x.series === s)?.value ?? 0;
  const items = keys.map((k) => ({ name: k, value: r.rows.filter((x) => x.key === k).reduce((a, b) => a + b.value, 0) }));
  switch (kind) {
    case 'bar':
      return { categories: keys.map(bucketLabel), series: names.map((s) => ({ name: s ?? seriesName, values: keys.map((k) => valueAt(k, s)) })) };
    case 'line':
    case 'area':
      return { labels: keys.map(bucketLabel), series: names.map((s) => ({ name: s ?? seriesName, values: keys.map((k) => valueAt(k, s)) })) };
    case 'donut':
    case 'segment':
      return { items };
    case 'waffle':
      return { items, total: items.reduce((a, b) => a + b.value, 0) };
    case 'rank':
      return { items, highlight: 'top' };
    case 'funnel':
      return { stages: items };
    case 'calendar':
      return { data: items.map((x) => ({ date: x.name, value: x.value })) };
  }
}

/** A single number for a KPI tile; with date buckets also the trend and the change from the previous bucket. */
export function toStat(r: Result) {
  if (!r.buckets) return { value: r.value };
  const series = r.buckets.map((b) => r.rows.filter((x) => x.key === b).reduce((a, x) => a + x.value, 0));
  const last = series.at(-1) ?? 0;
  const prev = series.at(-2);
  return { value: last, trend: series, delta: prev ? round(last / prev - 1) : undefined };
}

export { FIELD };
