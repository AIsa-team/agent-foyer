import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api';
import { barChart, lineChart, statTile } from '../brand/aisa-charts.js';
import { useI18n, type MessageKey } from '../i18n';
import { Icon, useApi } from '../ui';

/**
 * A data source up close, opened from a number or chart on a home page or board: the same numbers over a range the
 * viewer picks, by day / week / month, split by a field, and the records underneath. Built from the AIsa kit
 * (aisa-ui.css components, aisa-charts), read with the viewer's own access like everything else.
 */

interface Meta {
  id: string; title: string; kind: 'base' | 'app' | 'connector'; item: string | null; records: number;
  where: { label: string; url: string }; fields: { name: string; kind: 'date' | 'number' | 'text'; from?: number; to?: number }[];
}
type Cond = { field: string; op: string; value?: string | number };
interface Query { measure: { op: string; field?: string }; date?: { field: string; bucket: string; last?: number }; groupBy?: string; series?: string; where?: Cond[] }
interface Rows { total: number; matched: number; fields: { name: string; type: string | number }[]; rows: Record<string, string>[]; note?: string }

const RANGES = [7, 30, 90, 365] as const;
const BUCKETS = ['day', 'week', 'month'] as const;
type Bucket = typeof BUCKETS[number];
const DAY = 86_400_000;
/** records shown at first, and added per "show more" */
const PAGE = 25;

/** How many buckets a range of days covers. */
const bucketsIn = (days: number, b: Bucket) => (b === 'day' ? days : b === 'week' ? Math.ceil(days / 7) : Math.ceil(days / 30.4));
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** The first moment a range of `days` covers, ending today. */
const since = (days: number) => today() - (days - 1) * DAY;
/** A step is only offered when it gives a chart a few points to draw. */
const MIN_POINTS = 4;

/** The link a home tile or chart opens, carrying its query so the page starts from what was on screen. */
export const detailUrl = (src: { data: string; query: Record<string, unknown> }) => `/data/source/${encodeURIComponent(src.data)}?q=${encodeURIComponent(JSON.stringify(src.query))}`;

async function module<T>(source: string, query: Query, kind: string) {
  return (await api.post<{ value: T }>('/data/module', { source, query, kind })).value;
}

/** One kit chart in a kit card; redrawn when its data changes. */
function ChartCard({ draw, data, title }: { draw: (el: HTMLElement, cfg: Record<string, unknown>) => { destroy(): void }; data: Record<string, unknown> | null; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || !data) return;
    const h = draw(ref.current, { ...data, title });
    return () => h.destroy();
  }, [data, title, draw]);
  // the chart library owns the inside of `ref`: React never puts anything there, or a redraw would pull nodes out from under it
  return <div className="aisa-card aisa-card--pad"><div ref={ref} hidden={!data} />{!data && <div className="aisa-skeleton" style={{ height: 240 }} />}</div>;
}

function Tile({ cfg }: { cfg: Record<string, unknown> | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || !cfg) return;
    const h = statTile(ref.current, cfg);
    return () => h.destroy();
  }, [cfg]);
  return <div className="aisa-card aisa-card--pad"><div ref={ref} hidden={!cfg} />{!cfg && <div className="aisa-skeleton" style={{ height: 64 }} />}</div>;
}

export function DataSourcePage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'records' ? 'records' : 'overview';
  const setTab = (t: 'overview' | 'records') => setParams((p) => { const n = new URLSearchParams(p); if (t === 'records') n.set('tab', t); else n.delete('tab'); return n; }, { replace: true });
  const { t, locale } = useI18n();
  const meta = useApi<Meta>(`/data/sources/${encodeURIComponent(id)}`);
  const start = useMemo(() => { try { return JSON.parse(params.get('q') ?? '{}') as Partial<Query>; } catch { return {}; } }, [params]);

  const dates = meta.data?.fields.filter((f) => f.kind === 'date') ?? [];
  const numbers = meta.data?.fields.filter((f) => f.kind === 'number') ?? [];
  const groups = meta.data?.fields.filter((f) => f.kind === 'text') ?? [];

  const [measure, setMeasure] = useState(() => start.measure?.op && start.measure.op !== 'count' && start.measure.field ? `${start.measure.op}:${start.measure.field}` : 'count');
  const [dateField, setDateField] = useState(start.date?.field ?? '');
  const [bucket, setBucket] = useState<Bucket>((BUCKETS as readonly string[]).includes(start.date?.bucket ?? '') ? start.date!.bucket as Bucket : 'day');
  // a tile shows one week or month; up close, start from at least a month so there is a trend to see
  const [range, setRange] = useState<number>(() => {
    const b = (start.date?.bucket ?? 'day') as Bucket;
    const days = Math.max(30, (start.date?.last ?? 30) * (b === 'week' ? 7 : b === 'month' ? 30 : 1));
    return RANGES.find((r) => r >= days) ?? 365;
  });
  const [groupBy, setGroupBy] = useState(start.groupBy ?? start.series ?? '');
  const [filters, setFilters] = useState<Cond[]>(start.where ?? []);
  const [sort, setSort] = useState<{ field: string; desc: boolean } | null>(null);
  const [shown, setShown] = useState(PAGE);

  // once the fields are known: a date field to bucket by, if the source has one
  const date = dateField || dates[0]?.name || '';
  const [op, field] = measure === 'count' ? ['count', undefined] : measure.split(':') as [string, string];
  const m = { op, ...(field ? { field } : {}) };
  const from = since(range);
  // a source may hold only recent data (a question limited to the last two weeks): draw from where it starts
  const dataFrom = meta.data?.fields.find((f) => f.name === date)?.from;
  const dataStart = dataFrom ? new Date(new Date(dataFrom).setHours(0, 0, 0, 0)).getTime() : undefined;
  const partial = dataStart !== undefined && dataStart > from;
  const days = partial ? Math.round((today() - dataStart!) / DAY) + 1 : range;
  const allowed = BUCKETS.filter((b) => b === 'day' || bucketsIn(days, b) >= MIN_POINTS);
  const step: Bucket = allowed.includes(bucket) ? bucket : 'day';
  const inRange: Cond[] = date ? [...filters, { field: date, op: 'isGreater', value: from - 1 }] : filters;
  const before: Cond[] = date ? [...filters, { field: date, op: 'isGreater', value: from - range * DAY - 1 }, { field: date, op: 'isLess', value: from }] : filters;
  // comparing with the period before only means something when the data covers it
  const comparable = !!date && (dataStart === undefined || dataStart <= from - range * DAY);
  const key = JSON.stringify([id, measure, date, step, range, groupBy, filters, locale, days]);

  const [trend, setTrend] = useState<Record<string, unknown> | null>(null);
  const [split, setSplit] = useState<Record<string, unknown> | null>(null);
  const [total, setTotal] = useState<Record<string, unknown> | null>(null);
  const [count, setCount] = useState<Record<string, unknown> | null>(null);
  const [rows, setRows] = useState<Rows | null>(null);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => {
    if (!meta.data) return;
    let live = true;
    setTrend(null); setSplit(null); setTotal(null); setCount(null); setRows(null); setErr(null); setShown(PAGE);
    const fail = (e: unknown) => live && setErr(e);
    const measureLabel = op === 'count' ? t('ds.records') : t(`ds.op.${op}` as MessageKey, { field: field! });
    const periodLabel = t('ds.prevPeriod');
    if (date) {
      module<Record<string, unknown>>(id, { measure: m, date: { field: date, bucket: step, last: bucketsIn(days, step) }, ...(groupBy ? { series: groupBy } : {}), where: filters }, 'line').then((v) => live && setTrend(v), fail);
    }
    if (groupBy) module<Record<string, unknown>>(id, { measure: m, groupBy, where: inRange }, 'bar').then((v) => live && setSplit(v), fail);
    // the total over the range, against the range before it
    Promise.all([module<{ value: number }>(id, { measure: m, where: inRange }, 'stat'), comparable ? module<{ value: number }>(id, { measure: m, where: before }, 'stat') : null]).then(([now, prev]) => {
      if (!live) return;
      const delta = prev && prev.value ? (now.value - prev.value) / Math.abs(prev.value) : undefined;
      setTotal({ label: measureLabel, value: now.value, ...(delta !== undefined && Number.isFinite(delta) ? { delta, period: periodLabel } : {}) });
    }, fail);
    module<{ value: number }>(id, { measure: { op: 'count' }, where: inRange }, 'stat').then((v) => live && setCount({ label: t('ds.records'), value: v.value }), fail);
    api.post<Rows>('/data/rows', { source: id, where: inRange, sort: date ? { field: date, desc: true } : undefined, limit: 200 }).then((v) => live && setRows(v), fail);
    return () => { live = false; };
  }, [key, meta.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (meta.error || (!meta.data && !meta.error)) {
    return (
      <div className="aisa ds-page">
        {meta.error ? (
          <div className="aisa-empty">
            <b>{t('ds.error')}</b>
            <p className="aisa-small aisa-muted">{meta.error}</p>
          </div>
        ) : <div className="aisa-skeleton" style={{ height: 320 }} />}
      </div>
    );
  }
  const d = meta.data!;
  const openLabel = d.kind === 'connector' ? t('ds.openIn', { where: d.where.label === 'metabase' ? 'Metabase' : d.where.label })
    : d.kind === 'base' ? t('ds.openIn', { where: 'Lark' }) : t('ds.openApp');
  const sorted = rows && sort ? [...rows.rows].sort((a, b) => {
    const x = a[sort.field] ?? '', y = b[sort.field] ?? '';
    const nx = Number(x), ny = Number(y);
    const c = x !== '' && y !== '' && Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y, locale);
    return sort.desc ? -c : c;
  }) : rows?.rows;
  const isNum = (name: string) => numbers.some((f) => f.name === name);

  return (
    <div className="aisa ds-page">
      <nav className="aisa-breadcrumb" aria-label={t('ds.breadcrumb')}>
        <Link to="/data">{t('data.title')}</Link><span aria-current="page">{d.title}</span>
      </nav>
      <div className="aisa-page-head">
        <div>
          <h1>{d.title}</h1>
          <p>{t('ds.sub', { n: d.records.toLocaleString(locale) })}</p>
        </div>
        <a className="aisa-btn" href={d.where.url} target="_blank" rel="noreferrer">{openLabel} <Icon name="external" size={13} /></a>
      </div>

      {/* one filter row: the range first, then how to count and split */}
      <div className="aisa-filters">
        {date && (
          <div className="aisa-segmented" role="group" aria-label={t('ds.range')}>
            {RANGES.map((r) => <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>{t(`ds.range.${r}` as MessageKey)}</button>)}
          </div>
        )}
        {date && (
          <div className="aisa-segmented" role="group" aria-label={t('ds.bucket')}>
            {BUCKETS.map((b) => (
              <button key={b} type="button" aria-pressed={step === b} disabled={!allowed.includes(b)} title={allowed.includes(b) ? undefined : t('ds.bucketTooFew')}
                onClick={() => setBucket(b)}>{t(`ds.bucket.${b}`)}</button>
            ))}
          </div>
        )}
        <select className="aisa-select aisa-select--sm" style={{ width: 'auto' }} value={measure} onChange={(e) => setMeasure(e.target.value)} aria-label={t('ds.measure')}>
          <option value="count">{t('ds.records')}</option>
          {numbers.flatMap((f) => [
            <option key={`sum:${f.name}`} value={`sum:${f.name}`}>{t('ds.op.sum', { field: f.name })}</option>,
            <option key={`avg:${f.name}`} value={`avg:${f.name}`}>{t('ds.op.avg', { field: f.name })}</option>,
          ])}
        </select>
        {groups.length > 0 && (
          <select className="aisa-select aisa-select--sm" style={{ width: 'auto' }} value={groupBy} onChange={(e) => setGroupBy(e.target.value)} aria-label={t('ds.split')}>
            <option value="">{t('ds.noSplit')}</option>
            {groups.map((f) => <option key={f.name} value={f.name}>{t('ds.splitBy', { field: f.name })}</option>)}
          </select>
        )}
        {dates.length > 1 && (
          <select className="aisa-select aisa-select--sm" style={{ width: 'auto' }} value={date} onChange={(e) => setDateField(e.target.value)} aria-label={t('ds.dateField')}>
            {dates.map((f) => <option key={f.name} value={f.name}>{t('ds.byDate', { field: f.name })}</option>)}
          </select>
        )}
        {filters.map((c, i) => (
          <span key={i} className="aisa-chip" aria-pressed="true">
            {c.field} {t(`ds.cond.${c.op}` as MessageKey)} {c.value ?? ''}
            <button type="button" className="ds-chip-x" aria-label={t('ds.removeFilter')} onClick={() => setFilters(filters.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
          </span>
        ))}
      </div>

      {err ? (
        <div className="aisa-alert aisa-alert--danger">{err instanceof Error ? err.message : String(err)}</div>
      ) : (
        <>
          {partial && <p className="aisa-small aisa-muted ds-note">{t('ds.dataFrom', { date: new Date(dataStart!).toLocaleDateString(locale, { month: 'long', day: 'numeric' }) })}</p>}
          <div className="aisa-tabs" role="tablist" aria-label={t('ds.tabs')}>
            <button type="button" role="tab" aria-selected={tab === 'overview'} onClick={() => setTab('overview')}>{t('ds.tab.overview')}</button>
            <button type="button" role="tab" aria-selected={tab === 'records'} onClick={() => setTab('records')}>
              {t('ds.tab.records')}{rows && <span className="aisa-count">{rows.matched}</span>}
            </button>
          </div>
          {tab === 'overview' ? (
          <div className="ds-overview">
          <div className="aisa-kpis ds-kpis">
            <Tile cfg={total} />
            {op !== 'count' && <Tile cfg={count} />}
          </div>
          {date && <ChartCard draw={lineChart} data={trend} title={t('ds.trendTitle', { bucket: t(`ds.bucket.${step}`) })} />}
          {groupBy && <ChartCard draw={barChart} data={split} title={t('ds.splitTitle', { field: groupBy })} />}
          </div>
          ) : (
          <div className="ds-records">
            {rows && rows.matched > rows.rows.length && <p className="aisa-small aisa-muted">{t('ds.rowsSome', { shown: rows.rows.length, n: rows.matched })}</p>}
            {!rows ? <div className="aisa-skeleton" style={{ height: 160 }} /> : rows.rows.length === 0 ? (
              <div className="aisa-empty"><b>{t('ds.noRows')}</b></div>
            ) : (
              <div className="aisa-table-wrap aisa-dense">
                <table className="aisa-table">
                  <thead><tr>
                    {rows.fields.map((f) => (
                      <th key={f.name} className={isNum(f.name) ? 'is-num' : undefined}>
                        <button type="button" className="aisa-sort" aria-sort={sort?.field === f.name ? (sort.desc ? 'descending' : 'ascending') : undefined}
                          onClick={() => setSort(sort?.field === f.name ? { field: f.name, desc: !sort.desc } : { field: f.name, desc: isNum(f.name) })}>{f.name}</button>
                      </th>
                    ))}
                    <th aria-label={t('ds.link')} />
                  </tr></thead>
                  <tbody>
                    {sorted!.slice(0, shown).map((r, i) => (
                      <tr key={i}>
                        {rows.fields.map((f) => <td key={f.name} className={isNum(f.name) ? 'is-num' : undefined}>{r[f.name]}</td>)}
                        <td>{r._url && <a href={r._url} target="_blank" rel="noreferrer" aria-label={t('ds.link')}><Icon name="external" size={12} /></a>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rows && rows.rows.length > shown && (
              <button className="aisa-btn aisa-btn--sm ds-more" type="button" onClick={() => setShown(shown + PAGE * 4)}>
                {t('ds.showMore', { n: Math.min(PAGE * 4, rows.rows.length - shown) })}
              </button>
            )}
          </div>
          )}
        </>
      )}
    </div>
  );
}
