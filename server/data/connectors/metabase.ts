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
  // Metabase's built-in MCP server (Admin → AI → MCP); it takes the API key like the rest of its API
  mcp: (cfg) => ({ url: `${base(cfg)}/api/metabase-mcp`, headers: { 'x-api-key': cfg.apiKey ?? '' } }),
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
  async databases(cfg) {
    const r = await mb<{ data: { id: number; name: string; engine?: string }[] } | { id: number; name: string; engine?: string }[]>(cfg, '/api/database');
    return (Array.isArray(r) ? r : r.data).map((d) => ({ id: String(d.id), name: d.name, kind: d.engine }));
  },
  sqlItem(database, sql) {
    if (!/^\d+$/.test(database)) throw new UserError('err.conn.badDatabase', { database });
    return `sql:${database}:${readOnlySql(sql)}`;
  },
  async fetch(cfg, item): Promise<Fetched> {
    if (item.startsWith('sql:')) return runSql(cfg, item);
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
  link: (cfg, item) => {
    const sql = parseSqlItem(item);
    if (!sql) return `${base(cfg)}/question/${item}`;
    // an unsaved question in Metabase, opened from its definition
    const card = { dataset_query: { database: Number(sql.database), type: 'native', native: { query: sql.sql } }, display: 'table', visualization_settings: {} };
    return `${base(cfg)}/question#${Buffer.from(JSON.stringify(card)).toString('base64')}`;
  },
  async info(cfg, item) {
    if (parseSqlItem(item)) return { name: 'SQL' };
    if (!/^\d+$/.test(item)) throw new UserError('err.conn.itemGone');
    const card = await mb<Card & { description?: string | null }>(cfg, `/api/card/${item}`);
    return { name: card.name, description: card.description?.trim() || undefined };
  },
  async boards(cfg, q) {
    const list = await mb<{ id: number; name: string; archived?: boolean; collection?: { name?: string } | null }[] | { data: { id: number; name: string; archived?: boolean }[] }>(cfg, '/api/dashboard');
    const needle = q?.trim().toLowerCase();
    return (Array.isArray(list) ? list : list.data)
      .filter((d) => !d.archived && (!needle || d.name.toLowerCase().includes(needle) || String(d.id) === needle))
      .map((d) => ({ id: String(d.id), name: d.name, group: (d as { collection?: { name?: string } | null }).collection?.name ?? undefined, url: `${base(cfg)}/dashboard/${d.id}` }));
  },
  async boardChangedAt(cfg, id) {
    if (!/^\d+$/.test(id)) throw new UserError('err.conn.itemGone');
    const d = await mb<MbDashboard & { updated_at?: string }>(cfg, `/api/dashboard/${id}`);
    const times = [d.updated_at, ...d.dashcards.map((c) => c.card?.updated_at)].map((t) => (t ? Date.parse(t) : 0));
    return Math.max(0, ...times.filter(Number.isFinite));
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
            const stack = vs['stackable.stack_type'];
            const money = Object.values((vs.column_settings ?? {}) as Record<string, { number_style?: string; currency?: string }>).find((s) => s?.number_style === 'currency');
            const note = [vs['graph.y_axis.title_text'], vs['graph.x_axis.title_text']].filter((x): x is string => typeof x === 'string' && !!x.trim()).join(' · ');
            return {
              kind: 'chart', item: String(c.card.id), name: c.card.name, chart: DISPLAY[c.card.display ?? ''] ?? 'other',
              dims: strings(vs['graph.dimensions']), metrics: strings(vs['graph.metrics']), labels: labelsOf(c.card, vs), width,
              ...(stack === 'stacked' || stack === 'normalized' ? { stacked: true } : {}),
              ...(money ? { currency: money.currency ?? 'USD' } : {}),
              ...(note ? { note } : {}),
            };
          })
          .filter((c): c is BoardCard => c !== null),
      })),
    };
  },
};

interface MbDashboard {
  name: string;
  tabs?: { id?: number; name?: string }[];
  dashcards: { row: number; col: number; size_x?: number; dashboard_tab_id?: number | null; visualization_settings?: Record<string, unknown>; card?: { id?: number; name: string; display?: string; updated_at?: string; visualization_settings?: Record<string, unknown>; result_metadata?: { name: string; display_name?: string }[] } | null }[];
}

/** Rows the regular query endpoint returns at most; a question with more is exported instead. */
const QUERY_LIMIT = 2000;

// ---------------------------------------------------------------- read-only SQL, run as an unsaved question
/**
 * One SELECT (or WITH … SELECT) and nothing else: no second statement, nothing that writes, locks or changes the
 * session. Metabase runs what it is given with its own database login, so this is checked here as well; the login
 * itself should only be able to read.
 */
export function readOnlySql(sql: string): string {
  const text = String(sql ?? '').trim().replace(/;\s*$/, '');
  if (!text) throw new UserError('err.conn.sqlEmpty');
  if (text.length > 20_000) throw new UserError('err.conn.sqlTooLong');
  // what is left once comments and quoted text are taken out is what the database would act on
  const bare = withoutQuotesAndComments(text).toLowerCase();
  if (bare.includes(';')) throw new UserError('err.conn.sqlOneStatement');
  if (!/^\s*\(*\s*(select|with)\b/.test(bare)) throw new UserError('err.conn.sqlSelectOnly');
  const bad = /\b(insert|update|delete|merge|upsert|drop|alter|create|truncate|rename|grant|revoke|call|exec|execute|handler|load|lock|unlock|attach|detach|copy|vacuum|analyze|optimize|kill|shutdown|set|use|into|outfile|dumpfile)\b|\breplace\s+into\b|\bfor\s+(update|share)\b|\bpg_sleep\b|\bsleep\s*\(|\bbenchmark\s*\(/.exec(bare);
  if (bad) throw new UserError('err.conn.sqlReadOnly', { word: bad[0].trim() });
  return text;
}

/** The SQL with quoted text and comments blanked, read in one pass so neither can hide the other. */
function withoutQuotesAndComments(sql: string): string {
  let out = '';
  for (let i = 0; i < sql.length;) {
    const c = sql[i], two = sql.slice(i, i + 2);
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\' && c !== '`') { j += 2; continue; }
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      // an unclosed quote hides the rest: refuse rather than guess
      if (j >= sql.length) throw new UserError('err.conn.sqlReadOnly', { word: c });
      out += c === '`' ? ' x ' : " '' ";
      i = j + 1;
    } else if (two === '--' || c === '#') {
      const j = sql.indexOf('\n', i);
      out += ' ';
      i = j < 0 ? sql.length : j;
    } else if (two === '/*') {
      const j = sql.indexOf('*/', i + 2);
      if (j < 0) throw new UserError('err.conn.sqlReadOnly', { word: '/*' });
      // MySQL runs /*! … */ as code
      if (sql[i + 2] === '!') throw new UserError('err.conn.sqlReadOnly', { word: '/*!' });
      out += ' ';
      i = j + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function parseSqlItem(item: string): { database: string; sql: string } | null {
  const m = /^sql:(\d+):([\s\S]+)$/.exec(item);
  return m ? { database: m[1], sql: m[2] } : null;
}

type DatasetAnswer = { status?: string; error?: string; row_count?: number; data?: { rows: unknown[][]; cols: { name: string; base_type?: string; effective_type?: string }[] } };

async function runSql(cfg: ConnectionConfig, item: string): Promise<Fetched> {
  const parsed = parseSqlItem(item);
  if (!parsed) throw new UserError('err.conn.itemGone');
  const query = { database: Number(parsed.database), type: 'native', native: { query: readOnlySql(parsed.sql) } };
  const q = await mb<DatasetAnswer>(cfg, '/api/dataset', { method: 'POST', body: JSON.stringify(query) });
  if (q.status !== 'completed' || !q.data) throw new UserError('err.conn.failed', { detail: String(q.error ?? q.status ?? 'unexpected result') });
  const cols = q.data.cols;
  const fields = cols.map((c) => ({ name: c.name, type: typeOf(c.effective_type ?? c.base_type) }));
  if ((q.row_count ?? q.data.rows.length) < QUERY_LIMIT) return { rows: q.data.rows.map((r) => Object.fromEntries(cols.map((c, i) => [c.name, r[i]]))), fields };
  // more than the regular query returns: the export has no limit
  const rows = await mb<unknown>(cfg, '/api/dataset/json', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ query: JSON.stringify(query) }).toString(),
  });
  if (!Array.isArray(rows)) throw new UserError('err.conn.failed', { detail: String((rows as { error?: string })?.error ?? 'unexpected result') });
  return { rows: rows as Record<string, unknown>[], fields };
}

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
