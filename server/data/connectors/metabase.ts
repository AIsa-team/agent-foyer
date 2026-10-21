/**
 * Metabase: saved questions as data sources. An admin creates an API key in Metabase (Admin → Authentication → API
 * keys) for a group that only sees what the hub needs; the hub runs the questions with it. Field types come from the
 * question's result metadata, so dates and numbers chart right even when the values look like text.
 */
import { UserError } from '../../i18n/index.ts';
import type { BoardCard, BoardDef, ConnectionConfig, Connector, Fetched } from './types.ts';

const base = (cfg: ConnectionConfig) => {
  let u: URL;
  try {
    u = new URL(cfg.url);
  } catch {
    throw new UserError('err.conn.badUrl', { url: cfg.url ?? '' });
  }
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') throw new UserError('err.conn.httpsOnly');
  return u.origin + u.pathname.replace(/\/+$/, '');
};

async function mb<T>(cfg: ConnectionConfig, p: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base(cfg)}${p}`, {
      ...init,
      headers: { 'x-api-key': cfg.apiKey ?? '', 'content-type': 'application/json', ...(init.headers ?? {}) },
      // some questions take a while in Metabase itself
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError('err.conn.unreachable', { detail: (e as Error).message });
  }
  const text = await res.text();
  if (res.status === 401) throw new UserError('err.conn.badKey');
  if (res.status === 403) throw new UserError('err.conn.forbidden');
  if (res.status === 404) throw new UserError('err.conn.itemGone');
  if (!res.ok) throw new UserError('err.conn.failed', { detail: `${res.status} ${text.slice(0, 160)}` });
  return JSON.parse(text) as T;
}

interface Card { id: number; name: string; archived?: boolean; display?: string; collection?: { name?: string } | null; result_metadata?: { name: string; display_name?: string; base_type?: string; effective_type?: string }[] }

const typeOf = (t = ''): 'text' | 'number' | 'date' | 'checkbox' =>
  /Date|Time/.test(t) ? 'date' : /Integer|Float|Decimal|Number|BigInteger/.test(t) ? 'number' : /Boolean/.test(t) ? 'checkbox' : 'text';

export const metabase: Connector = {
  type: 'metabase',
  label: 'Metabase',
  identity: 'service',
  fields: [
    { name: 'url', placeholder: 'https://metabase.example.com' },
    { name: 'apiKey', secret: true, placeholder: 'mb_…' },
  ],
  async test(cfg) {
    const me = await mb<{ common_name?: string; email?: string; is_superuser?: boolean }>(cfg, '/api/user/current');
    if (me.is_superuser) throw new UserError('err.conn.adminKey');
    return { as: me.common_name || me.email || 'API key' };
  },
  async browse(cfg, q) {
    const cards = await mb<Card[]>(cfg, '/api/card?f=all');
    const needle = q?.trim().toLowerCase();
    return cards
      .filter((c) => !c.archived && (!needle || c.name.toLowerCase().includes(needle) || String(c.id) === needle))
      .slice(0, 200)
      .map((c) => ({ id: String(c.id), name: c.name, group: c.collection?.name ?? undefined, kind: c.display, url: `${base(cfg)}/question/${c.id}` }));
  },
  async fetch(cfg, item): Promise<Fetched> {
    if (!/^\d+$/.test(item)) throw new UserError('err.conn.itemGone');
    // the regular query answers from Metabase's result cache (the export below never does), up to 2,000 rows
    const q = await mb<{ status?: string; error?: string; row_count?: number; data?: { rows: unknown[][]; cols: { name: string; base_type?: string; effective_type?: string }[] } }>(
      cfg, `/api/card/${item}/query`, { method: 'POST', body: '{}' });
    if (q.status !== 'completed' || !q.data) throw new UserError('err.conn.failed', { detail: String(q.error ?? q.status ?? 'unexpected result') });
    if ((q.row_count ?? q.data.rows.length) < QUERY_LIMIT) {
      const cols = q.data.cols;
      return {
        rows: q.data.rows.map((r) => Object.fromEntries(cols.map((c, i) => [c.name, r[i]]))),
        fields: cols.map((c) => ({ name: c.name, type: typeOf(c.effective_type ?? c.base_type) })),
      };
    }
    return exported(cfg, item);
  },
  link: (cfg, item) => `${base(cfg)}/question/${item}`,
  async boards(cfg, q) {
    const list = await mb<{ id: number; name: string; archived?: boolean; collection?: { name?: string } | null }[] | { data: { id: number; name: string; archived?: boolean }[] }>(cfg, '/api/dashboard');
    const needle = q?.trim().toLowerCase();
    return (Array.isArray(list) ? list : list.data)
      .filter((d) => !d.archived && (!needle || d.name.toLowerCase().includes(needle) || String(d.id) === needle))
      .map((d) => ({ id: String(d.id), name: d.name, group: (d as { collection?: { name?: string } | null }).collection?.name ?? undefined, url: `${base(cfg)}/dashboard/${d.id}` }));
  },
  async board(cfg, id): Promise<BoardDef> {
    if (!/^\d+$/.test(id)) throw new UserError('err.conn.itemGone');
    const d = await mb<MbDashboard>(cfg, `/api/dashboard/${id}`);
    const tabs = d.tabs?.length ? d.tabs : [{ id: undefined, name: undefined }];
    return {
      id, name: d.name, url: `${base(cfg)}/dashboard/${id}`,
      tabs: tabs.map((t) => ({
        name: t.name,
        cards: d.dashcards
          .filter((c) => (t.id === undefined ? true : c.dashboard_tab_id === t.id))
          .sort((a, b) => a.row - b.row || a.col - b.col)
          .map((c): BoardCard | null => {
            const vs = { ...(c.card?.visualization_settings ?? {}), ...(c.visualization_settings ?? {}) } as Record<string, unknown>;
            const width = Math.min(1, (c.size_x ?? 24) / 24);
            if (!c.card?.id) return typeof vs.text === 'string' && vs.text.trim() ? { kind: 'text', text: vs.text, width } : null;
            const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
            return { kind: 'chart', item: String(c.card.id), name: c.card.name, chart: DISPLAY[c.card.display ?? ''] ?? 'other', dims: strings(vs['graph.dimensions']), metrics: strings(vs['graph.metrics']), labels: labelsOf(c.card, vs), width };
          })
          .filter((c): c is BoardCard => c !== null),
      })),
    };
  },
};

interface MbDashboard {
  name: string;
  tabs?: { id?: number; name?: string }[];
  dashcards: { row: number; col: number; size_x?: number; dashboard_tab_id?: number | null; visualization_settings?: Record<string, unknown>; card?: { id?: number; name: string; display?: string; visualization_settings?: Record<string, unknown>; result_metadata?: { name: string; display_name?: string }[] } | null }[];
}

/** Rows the regular query endpoint returns at most; a question with more is exported instead. */
const QUERY_LIMIT = 2000;

/** All rows, through the export (no row limit, but no cache either). */
async function exported(cfg: ConnectionConfig, item: string): Promise<Fetched> {
  const [card, rows] = await Promise.all([
    mb<Card>(cfg, `/api/card/${item}`),
    mb<unknown>(cfg, `/api/card/${item}/query/json`, { method: 'POST' }),
  ]);
  if (!Array.isArray(rows)) throw new UserError('err.conn.failed', { detail: String((rows as { error?: string })?.error ?? 'unexpected result') });
  // the export names columns as they are displayed ("payg_usd ($)" for a currency column, a renamed title…):
  // map them back to the question's column names, which charts and dashboards refer to
  const meta = card.result_metadata ?? [];
  const keys = Object.keys((rows[0] ?? {}) as object);
  const nameOf = new Map(keys.map((k) => {
    const m = meta.find((x) => x.name === k) ?? meta.find((x) => x.display_name === k)
      ?? meta.find((x) => k.startsWith(`${x.name} (`) || (x.display_name && k.startsWith(`${x.display_name} (`)));
    return [k, m?.name ?? k];
  }));
  const renamed = [...nameOf].some(([k, n]) => k !== n);
  return {
    rows: renamed ? (rows as Record<string, unknown>[]).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [nameOf.get(k) ?? k, v]))) : rows as Record<string, unknown>[],
    fields: meta.map((m) => ({ name: m.name, type: typeOf(m.effective_type ?? m.base_type) })),
  };
}

/** Column names as the chart shows them: a series title, else a column title, else Metabase's display name. */
function labelsOf(card: NonNullable<MbDashboard['dashcards'][number]['card']>, vs: Record<string, unknown>) {
  const out: Record<string, string> = {};
  for (const m of card.result_metadata ?? []) if (m.display_name && m.display_name !== m.name) out[m.name] = m.display_name;
  for (const [key, v] of Object.entries((vs.column_settings ?? {}) as Record<string, { column_title?: string }>)) {
    const name = key.match(/\["name","([^"]+)"\]/)?.[1];
    if (name && v?.column_title) out[name] = v.column_title;
  }
  for (const [name, v] of Object.entries((vs.series_settings ?? {}) as Record<string, { title?: string }>)) if (v?.title) out[name] = v.title;
  return Object.keys(out).length ? out : undefined;
}

/** Metabase's chart types in the hub's terms. */
const DISPLAY: Record<string, NonNullable<BoardCard['chart']>> = {
  scalar: 'number', smartscalar: 'number', gauge: 'number', progress: 'number',
  line: 'line', area: 'area', bar: 'bar', combo: 'bar', waterfall: 'bar', row: 'row', pie: 'pie', funnel: 'funnel',
  table: 'table', pivot: 'table', object: 'table',
};
