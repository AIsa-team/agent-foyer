import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, ApiError, type Agent, type AppInfo, type LarkLink, type SkillInfo } from '../api';
import { barChart, calendarHeatmap, divergingBar, donutChart, funnelChart, ganttChart, lineChart, progressList, rankList, ringGauge, segmentBar, slopeChart, statTile, waffleChart } from '../brand/aisa-charts.js';
import { useI18n, type MessageKey } from '../i18n';
import { AgentStep, CopyBox, Dialog, Empty, Icon, Loading, Step, useAction, useApi, useMe } from '../ui';
import { AppCard, LarkTile } from './Apps';
import { openSearch, searchShortcut } from '../Search';
import { SkillUpdatesBanner } from './Skills';
import { LEVEL_BADGE, type IssuesData } from './Issues';
import { HeroPulse, type Pulse } from './HeroPulse';
import { detailUrl } from './DataSource';
import type { AppRequest } from './Requests';

// ---------------------------------------------------------------- layout types (mirror server/homepage.ts)
type Text = Record<string, string>;
interface AppSource { app: string; path: string; pick?: string }
/** a Lark Base data source, read with the viewer's own Lark access */
interface BaseSource { data: string; query: Record<string, unknown> }
type Source = AppSource | BaseSource;
type Width = 'full' | 'half' | 'third';
const CHARTS = {
  bar: barChart, line: lineChart, area: lineChart, donut: donutChart, ring: ringGauge, rank: rankList, funnel: funnelChart, waffle: waffleChart,
  progress: progressList, segment: segmentBar, slope: slopeChart, diverging: divergingBar, gantt: ganttChart, calendar: calendarHeatmap,
};
type ChartKind = keyof typeof CHARTS;
type Base = { id?: string; own?: boolean };
export type Module = Base & (
  | { type: 'apps'; width?: Width; title?: Text; pinned?: string[]; hidden?: string[]; limit?: number }
  | { type: 'stats'; width?: Width; title?: Text; items: { label: Text; value?: number | string; format?: object; delta?: number; period?: Text; goodWhenUp?: boolean; trend?: number[]; source?: Source }[] }
  | { type: 'chart'; width?: Width; title?: Text; subtitle?: Text; kind: ChartKind; data?: Record<string, unknown>; source?: Source; format?: object; height?: number; stacked?: boolean }
  | { type: 'links'; width?: Width; title?: Text; items: { label: Text; url: string; icon?: string }[] }
  | { type: 'note'; width?: Width; title?: Text; body: Text }
  | { type: 'image'; width?: Width; url: string; alt?: Text; height?: number; fit?: 'cover' | 'contain' }
  | { type: 'skills'; width?: Width; title?: Text }
  | { type: 'resources'; width?: Width; title?: Text }
  | { type: 'alerts'; width?: Width; title?: Text; showOk?: boolean }
  | { type: 'okr'; width?: Width; title?: Text; user?: string }
  | { type: 'github'; width?: Width; title?: Text; weeks?: number }
  | { type: 'table'; width?: Width; title?: Text; source: { data: string; where?: object[]; sort?: { field: string; desc?: boolean }; fields?: string[] }; limit?: number }
  | { type: 'issues'; width?: Width; title?: Text }
  | { type: 'requests'; width?: Width; title?: Text; limit?: number });

export interface HomeData {
  layout: { modules: Module[] };
  from: 'user' | 'department' | 'company' | 'default' | 'preview';
  department?: string;
  apps: AppInfo[];
  larkLinks: LarkLink[];
  skillUpdates: SkillInfo[];
  newSkills: SkillInfo[];
  resources: { id: number; title: string; url: string; owner: string | null }[];
  myDepartments: { id: string; name: string; canEdit: boolean }[];
  editableDepartments: { id: string; name: string }[];
  pulse: Pulse;
  /** shared modules this person hid, and whether they changed anything */
  hidden?: Module[];
  adjusted?: boolean;
}

/** Per-language text from a layout, with the same fallback as the rest of the UI. */
function useText() {
  const { locale } = useI18n();
  return (t?: Text) => (t ? t[locale] ?? t.en ?? t['zh-CN'] ?? Object.values(t)[0] ?? '' : '');
}

function greetingKey(d: Date): MessageKey {
  const h = d.getHours();
  if (h < 5 || h >= 22) return 'home.greeting.night';
  if (h < 11) return 'home.greeting.morning';
  if (h < 13) return 'home.greeting.noon';
  if (h < 18) return 'home.greeting.afternoon';
  return 'home.greeting.evening';
}

/** `kind` tells the hub how to shape Base data: a chart kind, or "stat" for a KPI tile. */
async function loadSource(src: Source, kind: string) {
  if ('data' in src) return (await api.post<{ value: unknown }>('/data/module', { source: src.data, query: src.query, kind })).value;
  const q = new URLSearchParams({ app: src.app, path: src.path, ...(src.pick ? { pick: src.pick } : {}) });
  return (await api.get<{ value: unknown }>(`/home/source?${q}`)).value;
}

const sourceKey = (src?: Source) => (src ? JSON.stringify(src) : '');

/** Shown instead of numbers until the viewer connects their Lark data (the hub reads Base with their access). */
export function ConnectLark() {
  const { t } = useI18n();
  return (
    <div className="home-connect">
      <span className="small muted">{t('home.connectLark')}</span>
      <a className="btn sm" href={`/auth/lark/connect?return=${encodeURIComponent(location.pathname)}`}>{t('home.connectLarkCta')}</a>
    </div>
  );
}

export const needsLark = (e: unknown) => e instanceof ApiError && e.code === 'err.lark.notConnected';

/** The viewer cannot open the table in Lark: link to it, where Lark offers "request access". */
function NoAccess({ err }: { err: unknown }) {
  const { t } = useI18n();
  const url = err instanceof ApiError ? String(err.params?.url ?? '') : '';
  return (
    <div className="home-connect">
      <span className="small muted">{t('home.noAccess')}</span>
      {url && <a className="btn sm" href={url} target="_blank" rel="noreferrer">{t('home.requestAccess')} <Icon name="external" size={12} /></a>}
    </div>
  );
}
const noAccess = (e: unknown) => e instanceof ApiError && e.code === 'err.data.deniedSource';

function ModuleCard({ title, children, pad = true }: { title?: string; children: React.ReactNode; pad?: boolean }) {
  return (
    <div className={`card ${pad ? 'pad' : ''} home-module`}>
      {title && <div className="home-module__title">{title}</div>}
      {children}
    </div>
  );
}

function AppsModule({ m, data }: { m: Extract<Module, { type: 'apps' }>; data: HomeData }) {
  const { t } = useI18n();
  const text = useText();
  const hidden = new Set(m.hidden ?? []);
  const lark = data.larkLinks.map((l) => ({ key: `lark:${l.id}`, lark: l }));
  const own = data.apps.map((a) => ({ key: a.slug, app: a }));
  const all = [...lark, ...own].filter((x) => !hidden.has(x.key));
  const pinned = (m.pinned ?? []).map((k) => all.find((x) => x.key === k)).filter(Boolean) as typeof all;
  const rest = all.filter((x) => !pinned.includes(x));
  const items = [...pinned, ...rest].slice(0, m.limit ?? 8);
  return (
    <div className="home-module">
      <div className="section-title">{text(m.title) || t('home.commonApps')}<span className="spacer" /><Link to="/apps" className="small muted">{t('home.all')}</Link></div>
      {items.length ? (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
          {items.map((x) => ('lark' in x && x.lark ? <LarkTile key={x.key} link={x.lark} /> : 'app' in x && x.app ? <AppCard key={x.key} app={x.app} /> : null))}
        </div>
      ) : <div className="card"><Empty title={t('home.noApps')} hint={t('home.noAppsHint')} /></div>}
    </div>
  );
}

function StatTileView({ item }: { item: Extract<Module, { type: 'stats' }>['items'][number] }) {
  const text = useText();
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState<unknown>(item.source ? undefined : item.value);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (item.source) loadSource(item.source, 'stat').then(setValue, setErr);
  }, [sourceKey(item.source)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ref.current || value === undefined) return;
    // Base sources answer { value, trend, delta }; app sources answer the bare value
    const live = item.source && 'data' in item.source ? (value as { value: number; trend?: number[]; delta?: number }) : { value };
    const h = statTile(ref.current, {
      label: text(item.label), value: live.value, format: item.format, delta: item.delta ?? ('delta' in live ? live.delta : undefined),
      period: text(item.period) || undefined, goodWhenUp: item.goodWhenUp, trend: item.trend ?? ('trend' in live ? live.trend : undefined),
    });
    return () => h.destroy();
  });
  if (needsLark(err) || noAccess(err)) return <div className="card pad"><div className="small muted" style={{ marginBottom: 8 }}>{text(item.label)}</div>{needsLark(err) ? <ConnectLark /> : <NoAccess err={err} />}</div>;
  if (err instanceof Error) return <div className="card pad"><div className="small muted">{text(item.label)}</div><div className="small" style={{ color: 'var(--danger)' }} title={err.message}>{t('home.sourceError')}</div></div>;
  // the chart library owns the inside of `ref`; the loading note sits beside it
  const body = <><div ref={ref} />{value === undefined && <span className="small muted">{t('common.loading')}</span>}</>;
  // a number from a data source opens its detail page
  return item.source && 'data' in item.source
    ? <Link className="card pad home-drill" to={detailUrl(item.source)} title={t('home.details')}>{body}</Link>
    : <div className="card pad">{body}</div>;
}

function ChartModule({ m }: { m: Extract<Module, { type: 'chart' }> }) {
  const text = useText();
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<Record<string, unknown> | undefined>(m.source ? undefined : m.data);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (m.source) loadSource(m.source, m.kind).then((v) => setData(v as Record<string, unknown>), setErr);
  }, [sourceKey(m.source), m.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ref.current || !data) return;
    const cfg = { ...data, title: text(m.title) || undefined, subtitle: text(m.subtitle) || undefined, format: m.format ?? data.format, height: m.height, ...(m.stacked ? { stacked: true } : {}) };
    const fn = CHARTS[m.kind] ?? barChart;
    const h = fn(ref.current, m.kind === 'area' ? { ...cfg, area: true } : cfg);
    return () => h.destroy();
  });
  return (
    <div className="card pad home-module">
      {needsLark(err) || noAccess(err) ? <>{m.title && <div className="home-module__title">{text(m.title)}</div>}{needsLark(err) ? <ConnectLark /> : <NoAccess err={err} />}</>
        : err instanceof Error ? <div className="small" style={{ color: 'var(--danger)' }} title={err.message}>{text(m.title)} · {t('home.sourceError')}</div> : <><div ref={ref} />{!data && <span className="small muted">{t('common.loading')}</span>}</>}
      {m.source && 'data' in m.source && !err && <div className="home-more"><Link to={detailUrl(m.source)}>{t('home.details')} →</Link></div>}
    </div>
  );
}

interface AlertInfo {
  id: number; title: string; state: 'pending' | 'ok' | 'firing' | 'error' | 'paused'; value: number | null; condition: string;
  error: string | null; since: number | null; source: { title: string; url: string | null }; muted: boolean; mine: boolean;
}

const ALERT_BADGE: Record<AlertInfo['state'], string> = { firing: 'danger', error: 'warn', ok: 'ok', pending: '', paused: '' };

/** Alert rules on Lark Base data that the viewer owns or is told about; firing ones first. */
function AlertsModule({ m }: { m: Extract<Module, { type: 'alerts' }> }) {
  const { t, ago, locale } = useI18n();
  const text = useText();
  const { data, error, reload } = useApi<{ alerts: AlertInfo[] }>('/alerts');
  const { run } = useAction();
  const shown = (data?.alerts ?? []).filter((a) => m.showOk || a.state === 'firing' || a.state === 'error');
  const mute = (a: AlertInfo) => {
    // recipients leave the rule; the owner only pauses their own messages
    if (!a.muted && !a.mine && !confirm(t('home.alerts.muteConfirm', { title: a.title }))) return;
    run(() => api.post(`/alerts/${a.id}/mute`, { muted: !a.muted }), t(a.muted ? 'home.alerts.unmuted' : 'home.alerts.mutedToast')).then(reload);
  };
  return (
    <ModuleCard title={text(m.title) || t('home.module.alerts')}>
      {!data ? <Loading error={error} /> : shown.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{t('home.alerts.none')}</p> : (
        <div className="home-links">
          {shown.map((a) => (
            <div key={a.id} className="home-link home-alert" title={a.error ?? a.condition}>
              <span className={`badge ${ALERT_BADGE[a.state]}`}>{t(`home.alerts.${a.state}`)}</span>
              <a className="grow ellipsis" href={a.source.url ?? undefined} target="_blank" rel="noreferrer">
                {a.title}
                <span className="small muted"> · {a.state === 'error' ? a.error : a.condition}</span>
              </a>
              {a.value !== null && a.state !== 'error' && <b className="home-alert__value">{new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(a.value)}</b>}
              {a.since && (a.state === 'firing' || a.state === 'error') && <span className="small muted">{t('home.alerts.since', { ago: ago(a.since) })}</span>}
              <button className="btn sm ghost home-alert__mute" type="button" onClick={() => mute(a)}>
                {t(a.muted ? 'home.alerts.unmute' : 'home.alerts.mute')}
              </button>
            </div>
          ))}
        </div>
      )}
    </ModuleCard>
  );
}

interface OkrData {
  period: { id: string; name: string; start: number | null; end: number | null };
  done: number;
  elapsed: number | null;
  objectives: { id: string; content: string; progress: number; krs: { id: string; content: string; progress: number }[] }[];
  url: string;
}

const MOUTH = { ok: 'M15 29c2.6 3.4 5.6 5 9 5s6.4-1.6 9-5', slight: 'M16 31h16', behind: 'M15 34c2.6-3.4 5.6-5 9-5s6.4 1.6 9 5' };
/** Same rule as the pace card in the design system: on pace, up to 10 points behind, or further behind. */
export const moodOf = (done: number, elapsed: number | null) => (elapsed === null || done >= elapsed ? 'ok' : elapsed - done <= 0.1 ? 'slight' : 'behind');
const lagging = (progress: number, elapsed: number | null) => elapsed !== null && elapsed - progress > 0.1;

/** Ink ring = progress, thin tick = time passed, face = how the two compare. */
export function PaceRing({ done, elapsed, mood }: { done: number; elapsed: number | null; mood: keyof typeof MOUTH }) {
  return (
    <svg className="okr-ring" viewBox="0 0 132 132" role="img" aria-label={`${Math.round(done * 100)}%${elapsed !== null ? ` / ${Math.round(elapsed * 100)}%` : ''}`}>
      <circle cx="66" cy="66" r="58" pathLength="100" className="okr-ring__track" />
      <circle cx="66" cy="66" r="58" pathLength="100" className="okr-ring__value" style={{ strokeDasharray: `${done * 100} 100` }} />
      {elapsed !== null && (
        <g style={{ transform: `rotate(${elapsed * 360}deg)`, transformOrigin: '66px 66px' }}>
          <line x1="66" x2="66" y1="0" y2="16" className="okr-ring__tick-gap" />
          <line x1="66" x2="66" y1="0" y2="16" className="okr-ring__tick" />
        </g>
      )}
      <g transform="translate(30 30) scale(1.5)">
        <circle cx="17" cy="20" r="2.6" fill="currentColor" />
        <circle cx="31" cy="20" r="2.6" fill="currentColor" />
        <path d={MOUTH[mood]} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      </g>
    </svg>
  );
}

export function OkrModule({ m }: { m: Extract<Module, { type: 'okr' }> }) {
  const { t } = useI18n();
  const text = useText();
  const [data, setData] = useState<OkrData | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    api.get<OkrData>(`/okr${m.user ? `?user=${encodeURIComponent(m.user)}` : ''}`).then(setData, setErr);
  }, [m.user]);
  const title = text(m.title) || t('home.module.okr');
  if (needsLark(err)) return <ModuleCard title={title}><ConnectLark /></ModuleCard>;
  if (err instanceof Error) return <ModuleCard title={title}><p className="small" style={{ margin: 0, color: 'var(--danger)' }}>{err.message}</p></ModuleCard>;
  if (!data) return <ModuleCard title={title}><span className="small muted">{t('common.loading')}</span></ModuleCard>;
  const mood = moodOf(data.done, data.elapsed);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return (
    <div className="card pad home-module okr">
      <div className="home-module__title okr__head">
        <span>{title}</span>
        <span className="small muted">{data.period.name}</span>
        <span className="spacer" />
        <a className="small muted" href={data.url} target="_blank" rel="noreferrer">{t('home.okr.open')} <Icon name="external" size={12} /></a>
      </div>
      {data.objectives.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{t('home.okr.none')}</p> : (
        <>
          <div className="okr__pace">
            <PaceRing done={data.done} elapsed={data.elapsed} mood={mood} />
            <div>
              <div className="okr__mood">{t(`home.okr.mood.${mood}`)}</div>
              <div className="small muted">
                {data.elapsed === null ? t('home.okr.doneOnly', { done: pct(data.done) }) : t('home.okr.sub', { elapsed: pct(data.elapsed), done: pct(data.done) })}
              </div>
            </div>
          </div>
          <ol className="okr__list">
            {data.objectives.map((o, i) => (
              <li key={o.id}>
                <div className="okr__row">
                  <span className="okr__tag">O{i + 1}</span>
                  <span className="grow">{o.content}</span>
                  <b className={lagging(o.progress, data.elapsed) ? 'okr__lag' : ''}>{pct(o.progress)}</b>
                </div>
                <div className={`okr__bar ${lagging(o.progress, data.elapsed) ? 'is-lag' : ''}`}><span style={{ width: pct(o.progress) }} /></div>
                {o.krs.map((k, j) => (
                  <div key={k.id} className="okr__row okr__kr">
                    <span className="okr__tag">KR{j + 1}</span>
                    <span className="grow">{k.content}</span>
                    <span className={lagging(k.progress, data.elapsed) ? 'okr__lag' : 'muted'}>{pct(k.progress)}</span>
                  </div>
                ))}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

interface Contributions {
  linked: boolean; connectUrl?: string; login: string; profile: string; from: string; to: string; days: { date: string; value: number }[];
  total: number; commits: number; pullRequests: number; reviews: number; activeDays: number; streak: { current: number; longest: number };
  repos: { name: string; url: string; commits: number }[];
}

/** The viewer's own GitHub contributions in the company organisation: totals, a calendar heatmap, where most commits went. */
function GitHubModule({ m }: { m: Extract<Module, { type: 'github' }> }) {
  const { t, locale } = useI18n();
  const text = useText();
  const ref = useRef<HTMLDivElement>(null);
  const weeks = m.weeks ?? 52;
  const { data, error } = useApi<Contributions>(`/github/contributions?weeks=${weeks}`);
  const title = text(m.title) || t('home.module.github');
  useEffect(() => {
    if (!ref.current || !data?.linked) return;
    const host = ref.current;
    // on narrow screens keep the cells readable and scroll sideways, starting at the latest weeks
    const narrow = host.clientWidth < 560;
    const h = calendarHeatmap(host, {
      data: data.days, start: data.from, end: data.to, format: { unit: t('home.github.unit'), unitSpace: !locale.startsWith('zh') },
      ...(narrow ? { width: Math.ceil(data.days.length / 7 + 1) * 12 + 40 } : {}),
    });
    host.classList.toggle('gh__calendar--scroll', narrow);
    const plot = host.querySelector<HTMLElement>('.aisa-chart__plot');
    if (narrow && plot) requestAnimationFrame(() => { plot.scrollLeft = plot.scrollWidth; });
    return () => h.destroy();
  }, [data, locale]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <ModuleCard title={title}><Loading error={error} /></ModuleCard>;
  if (!data.linked) {
    return (
      <ModuleCard title={title}>
        <div className="home-connect">
          <span className="small muted">{t('home.github.connect')}</span>
          <a className="btn sm" href={data.connectUrl}>{t('home.github.connectCta')}</a>
        </div>
      </ModuleCard>
    );
  }
  const n = (v: number) => v.toLocaleString(locale);
  const figures: [string, string][] = [
    [t('home.github.commits'), n(data.commits)],
    [t('home.github.prs'), n(data.pullRequests)],
    [t('home.github.reviews'), n(data.reviews)],
    [t('home.github.activeDays'), n(data.activeDays)],
    [t('home.github.streak'), t('home.github.days', { n: data.streak.current })],
  ];
  return (
    <div className="card pad home-module gh">
      <div className="home-module__title gh__head">
        <span>{title}</span>
        <span className="small muted">@{data.login}</span>
        <span className="spacer" />
        <a className="small muted" href={data.profile} target="_blank" rel="noreferrer">{t('home.github.profile')} <Icon name="external" size={12} /></a>
      </div>
      <div className="gh__summary">
        <div className="gh__total">
          <b>{n(data.total)}</b>
          <span className="small muted">{weeks === 52 ? t('home.github.lastYear') : t('home.github.lastWeeks', { n: weeks })}</span>
        </div>
        <dl className="gh__figures">
          {figures.map(([k, v]) => <div key={k}><dt className="small muted">{k}</dt><dd>{v}</dd></div>)}
        </dl>
      </div>
      <div ref={ref} className="gh__calendar" />
      {data.repos.length > 0 && (
        <div className="gh__repos small">
          <span className="muted">{t('home.github.repos')}</span>
          {data.repos.map((r) => <a key={r.name} href={r.url} target="_blank" rel="noreferrer">{r.name} <span className="muted">{n(r.commits)}</span></a>)}
          {data.streak.longest > data.streak.current && <span className="muted gh__longest">{t('home.github.longest', { n: data.streak.longest })}</span>}
        </div>
      )}
    </div>
  );
}

/** A few records of a data source as a table (AIsa kit), and the way to all of them. */
function TableModule({ m }: { m: Extract<Module, { type: 'table' }> }) {
  const { t, locale } = useI18n();
  const text = useText();
  const [data, setData] = useState<{ matched: number; fields: { name: string; type: string | number }[]; rows: Record<string, string>[] } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    api.post<NonNullable<typeof data>>('/data/rows', { source: m.source.data, where: m.source.where ?? [], sort: m.source.sort, limit: m.limit ?? 10 }).then(setData, setErr);
  }, [JSON.stringify(m.source), m.limit]); // eslint-disable-line react-hooks/exhaustive-deps
  const title = text(m.title);
  if (needsLark(err) || noAccess(err)) return <ModuleCard title={title}>{needsLark(err) ? <ConnectLark /> : <NoAccess err={err} />}</ModuleCard>;
  if (err instanceof Error) return <ModuleCard title={title}><div className="small" style={{ color: 'var(--danger)' }} title={err.message}>{t('home.sourceError')}</div></ModuleCard>;
  const cols = data ? (m.source.fields?.length ? m.source.fields.map((n) => data.fields.find((f) => f.name === n)).filter((f): f is NonNullable<typeof f> => !!f) : data.fields) : [];
  const isNum = (f: { type: string | number }) => f.type === 'Number' || f.type === 2;
  return (
    <div className="card pad home-module">
      {title && <div className="home-module__title">{title}</div>}
      {!data ? <span className="small muted">{t('common.loading')}</span> : data.rows.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{t('home.table.empty')}</p> : (
        <div className="aisa-table-wrap aisa-dense">
          <table className="aisa-table">
            <thead><tr>{cols.map((f) => <th key={f.name} className={isNum(f) ? 'is-num' : undefined}>{f.name}</th>)}</tr></thead>
            <tbody>{data.rows.map((r, i) => <tr key={i}>{cols.map((f) => <td key={f.name} className={isNum(f) ? 'is-num' : undefined}>{r[f.name]}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
      {data && (
        <div className="home-more">
          <Link to={`${detailUrl({ data: m.source.data, query: { measure: { op: 'count' }, ...(m.source.where?.length ? { where: m.source.where } : {}) } })}&tab=records`}>
            {t('home.table.all', { n: data.matched.toLocaleString(locale) })} →
          </Link>
        </div>
      )}
    </div>
  );
}

/** "Issues assigned to me": what the viewer needs to fix, per check. */
function IssuesModule({ m }: { m: Extract<Module, { type: 'issues' }> }) {
  const { t, ago } = useI18n();
  const text = useText();
  const { data, error } = useApi<{ lastRun: IssuesData['lastRun']; checks: { id: number; title: string; level: IssuesData['checks'][number]['level']; mine: number }[] }>('/issues/mine');
  const mine = (data?.checks ?? []).map((c) => ({ c, n: c.mine }));
  return (
    <ModuleCard title={text(m.title) || t('home.module.issues')}>
      {!data ? <Loading error={error} /> : mine.length === 0 ? (
        <Empty title={t('issues.mineEmpty')} hint={data.lastRun ? t('issues.checkedAgo', { ago: ago(data.lastRun.at) }) : undefined} />
      ) : (
        <div className="home-links">
          {mine.map(({ c, n }) => (
            <Link key={c.id} to="/issues" className="home-link">
              <span className={`badge ${LEVEL_BADGE[c.level]}`}>{t(`issues.level.${c.level}`)}</span>
              <span className="grow ellipsis">{c.title}</span>
              <b>{n}</b>
            </Link>
          ))}
        </div>
      )}
    </ModuleCard>
  );
}

/** "Requests": apps colleagues need that wait for someone (the pool, and invitations to the viewer). */
function RequestsModule({ m }: { m: Extract<Module, { type: 'requests' }> }) {
  const { t } = useI18n();
  const text = useText();
  const { data, error } = useApi<{ requests: AppRequest[] }>('/requests?status=open&waiting=1');
  const shown = (data?.requests ?? []).slice(0, m.limit ?? 5);
  return (
    <ModuleCard title={text(m.title) || t('home.module.requests')}>
      {!data ? <Loading error={error} /> : shown.length === 0 ? (
        <Empty title={t('requests.none.open')} hint={t('home.requests.emptyHint')} />
      ) : (
        <div className="home-links">
          {shown.map((r) => (
            <Link key={r.id} to={`/requests/${r.id}`} className="home-link">
              <span className="small muted mono">#{r.id}</span>
              <span className="grow ellipsis">{r.title}</span>
              {r.scope === 'invite' ? <span className="badge warn">{t('home.requests.invitedYou')}</span>
                : r.voters.length > 0 && <span className="small muted">{t('requests.alsoNeed', { n: r.voters.length })}</span>}
            </Link>
          ))}
        </div>
      )}
      <div className="home-more" style={{ gap: 14 }}>
        <Link to="/requests?new=1">{t('requests.new')}</Link>
        <Link to="/requests">{t('home.requests.all')} →</Link>
      </div>
    </ModuleCard>
  );
}

export function RenderModule({ m, data }: { m: Module; data: HomeData }) {
  const { t } = useI18n();
  const text = useText();
  const me = useMe();
  switch (m.type) {
    case 'apps':
      return <AppsModule m={m} data={data} />;
    case 'stats':
      return (
        <div className="home-module">
          {m.title && <div className="section-title">{text(m.title)}</div>}
          <div className="home-stats">{m.items.map((it, i) => <StatTileView key={i} item={it} />)}</div>
        </div>
      );
    case 'chart':
      return <ChartModule m={m} />;
    case 'links':
      return (
        <ModuleCard title={text(m.title)}>
          <div className="home-links">
            {m.items.map((l, i) => (
              <a key={i} href={l.url} target="_blank" rel="noreferrer" className="home-link">
                <span className="home-link__icon">{l.icon || <Icon name="external" size={13} />}</span>
                <span className="grow ellipsis">{text(l.label)}</span>
              </a>
            ))}
          </div>
        </ModuleCard>
      );
    case 'note':
      return <ModuleCard title={text(m.title)}><p className="home-note">{text(m.body)}</p></ModuleCard>;
    case 'image':
      return (
        <div className="card home-module home-image" style={{ height: m.height ?? 220 }}>
          <img src={m.url} alt={text(m.alt)} style={{ objectFit: m.fit ?? 'cover' }} referrerPolicy="no-referrer" />
        </div>
      );
    case 'skills':
      return (
        <ModuleCard title={text(m.title) || t('home.module.skills')}>
          {data.newSkills.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{t('skills.none')}</p> : (
            <div className="home-links">
              {data.newSkills.map((s) => (
                <Link key={s.slug} to={`/skills/${s.slug}`} className="home-link">
                  <span className="home-link__icon"><Icon name="skill" size={13} /></span>
                  <span className="grow ellipsis">{s.name}</span>
                  {s.hasUpdate ? <span className="badge warn">{t('skills.canUpdate')}</span> : <span className="small muted">v{s.version}</span>}
                </Link>
              ))}
            </div>
          )}
        </ModuleCard>
      );
    case 'alerts':
      return <AlertsModule m={m} />;
    case 'okr':
      // a layout saved while the hub used Lark
      return me.hub.features.lark ? <OkrModule m={m} /> : null;
    case 'issues':
      return <IssuesModule m={m} />;
    case 'requests':
      return <RequestsModule m={m} />;
    case 'table':
      return <TableModule m={m} />;
    case 'github':
      // a layout saved while the hub had GitHub
      return me.hub.features.github ? <GitHubModule m={m} /> : null;
    case 'resources':
      return (
        <ModuleCard title={text(m.title) || t('home.module.resources')}>
          {data.resources.length === 0 ? <p className="small muted" style={{ margin: 0 }}><Link to="/library">{t('library.policiesEmpty')}</Link></p> : (
            <div className="home-links">
              {data.resources.map((r) => (
                <a key={r.id} href={r.url} target="_blank" rel="noreferrer" className="home-link">
                  <span className="home-link__icon"><Icon name="doc" size={13} /></span>
                  <span className="grow ellipsis">{r.title}</span>
                  {r.owner && <span className="small muted">{r.owner}</span>}
                </a>
              ))}
            </div>
          )}
        </ModuleCard>
      );
  }
}

function CustomizeDialog({ data, onClose }: { data: HomeData; onClose: () => void }) {
  const me = useMe();
  const { t } = useI18n();
  const profile = useApi<{ agents: Agent[] }>('/profile');
  const hub = t('prompt.hub', { company: me.hub.companyName, mcp: me.hub.mcpName });
  const depts = data.editableDepartments;
  return (
    <Dialog title={t('home.customize.title')} subtitle={t('home.customize.subtitle')} onClose={onClose}>
      <div className="steps">
        <AgentStep agents={profile.data?.agents ?? null} />
        <Step n={2} title={t('home.customize.step2')}>
          <p>{t('home.customize.step2Intro')}</p>
          <CopyBox text={t('prompt.homeMe', { hub })} />
          <p style={{ marginTop: 10 }}>{t('home.customize.step2After')}</p>
        </Step>
        {depts.length > 0 && (
          <Step n={3} title={t('home.customize.step3')}>
            <p>{t('home.customize.step3Intro', { departments: depts.map((d) => d.name).join(t('common.listSeparator')) })}</p>
            <CopyBox text={t('prompt.homeDept', { hub, department: depts[0].name })} />
          </Step>
        )}
      </div>
    </Dialog>
  );
}

/** A module's name for lists: its title, or what kind of module it is. */
function useModuleName() {
  const { t } = useI18n();
  const text = useText();
  return (m: Module) => ('title' in m ? text(m.title) : '') || (['skills', 'resources', 'alerts', 'issues', 'okr', 'github', 'requests'].includes(m.type) ? t(`home.module.${m.type}` as MessageKey) : t(`home.adjust.kind.${m.type}` as MessageKey));
}

const WIDTHS: Width[] = ['full', 'half', 'third'];

/** On each module while adjusting the page: move it, change its width, hide it (shared) or remove it (one's own). */
function ModuleTools({ m, at, modules, onChanged }: { m: Module; at: number; modules: Module[]; onChanged: () => void }) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const adjust = (change: Record<string, unknown>) => run(() => api.post('/home/adjust', change)).then(onChanged);
  const move = (by: number) => {
    const ids = modules.map((x) => x.id!);
    const [id] = ids.splice(at, 1);
    ids.splice(at + by, 0, id);
    adjust({ order: ids });
  };
  if (!m.id) return null;
  return (
    <div className="module-tools" role="toolbar" aria-label={t('home.adjust.tools')}>
      <button className="btn sm ghost" disabled={busy || at === 0} onClick={() => move(-1)} type="button" title={t('home.adjust.up')} aria-label={t('home.adjust.up')}>↑</button>
      <button className="btn sm ghost" disabled={busy || at === modules.length - 1} onClick={() => move(1)} type="button" title={t('home.adjust.down')} aria-label={t('home.adjust.down')}>↓</button>
      <span className="seg seg--sm">
        {WIDTHS.map((w) => (
          <button key={w} className={(m.width ?? 'full') === w ? 'on' : ''} disabled={busy} onClick={() => adjust({ width: { id: m.id, width: w } })} type="button">{t(`home.adjust.width.${w}`)}</button>
        ))}
      </span>
      <button className="btn sm ghost" disabled={busy} onClick={() => adjust(m.own ? { remove: m.id } : { hide: m.id })} type="button">{m.own ? t('common.remove') : t('home.adjust.hide')}</button>
    </div>
  );
}

/** Shared modules this person hid, to bring back, and a way back to the shared page as it is. */
function HiddenModules({ data, onChanged }: { data: HomeData; onChanged: () => void }) {
  const { t } = useI18n();
  const name = useModuleName();
  const { busy, run } = useAction();
  const from = { department: t('home.adjust.fromDept', { department: data.department ?? '' }), company: t('home.adjust.fromCompany'), default: t('home.adjust.fromDefault') }[data.from as 'department' | 'company' | 'default'];
  return (
    <div className="home-hidden">
      {(data.hidden ?? []).length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <span className="small muted">{t('home.adjust.hiddenList')}</span>
          {data.hidden!.map((m) => (
            <button key={m.id} className="btn sm" disabled={busy} onClick={() => run(() => api.post('/home/adjust', { show: m.id })).then(onChanged)} type="button">
              <Icon name="plus" /> {name(m)}
            </button>
          ))}
        </div>
      )}
      <p className="small muted" style={{ margin: 0 }}>{t('home.adjust.note')}</p>
      {data.adjusted && from && (
        <button className="btn sm ghost" disabled={busy}
          onClick={() => confirm(t('home.adjust.resetConfirm', { from })) && run(() => api.del('/home/adjust'), t('home.adjust.resetDone')).then(onChanged)} type="button">
          {t('home.adjust.reset', { from })}
        </button>
      )}
    </div>
  );
}

export function HomePage() {
  const me = useMe();
  const { t, locale } = useI18n();
  const [params] = useSearchParams();
  const preview = params.get('preview');
  const { data, error, reload } = useApi<HomeData>(`/home${preview ? `?preview=${encodeURIComponent(preview)}` : ''}`);
  const profile = useApi<{ agents: Agent[] }>('/profile');
  const [customizing, setCustomizing] = useState(false);
  const [editing, setEditing] = useState(false);
  const now = new Date();
  const date = now.toLocaleDateString(locale, { month: 'long', day: 'numeric', weekday: 'long' });
  const fromLabel = data && {
    user: t('home.from.user'),
    department: t('home.from.department', { department: data.department ?? '' }),
    company: t('home.from.company'),
    default: t('home.from.default'),
    preview: t('home.from.preview'),
  }[data.from];
  return (
    <>
      {data?.from === 'preview' && (
        <div className="banner home-preview-banner">
          <Icon name="user" />
          <span className="grow">{t('home.preview.banner')}</span>
          <Link to="/" className="btn sm">{t('home.preview.exit')}</Link>
        </div>
      )}
      <div className="hero hero--home">
        <div className="hero__main">
          <span className="muted">{date}</span>
          <h1>{t('home.greeting', { greeting: t(greetingKey(now)), name: me.user.name })}</h1>
          <button className="hero-search" onClick={openSearch} type="button">
            <Icon name="search" /><span className="grow">{t('home.search')}</span><kbd>{searchShortcut()}</kbd>
          </button>
        </div>
        <HeroPulse pulse={data?.pulse} />
      </div>

      {profile.data && profile.data.agents.length === 0 && (
        <div className="banner" style={{ background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--fg)' }}>
          <Icon name="user" />
          <span className="grow">{t('home.connectBanner')}</span>
          <Link to="/me" className="btn sm primary">{t('home.connectCta')}</Link>
        </div>
      )}
      {data && <SkillUpdatesBanner skills={data.skillUpdates} />}

      {!data ? <Loading error={error} /> : (
        <>
          <div className={`home-grid ${editing ? 'is-editing' : ''}`}>
            {data.layout.modules.map((m, i) => (
              <div key={m.id ?? i} className={`home-cell home-cell--${m.width ?? 'full'}`}>
                {editing && <ModuleTools m={m} at={i} modules={data.layout.modules} onChanged={reload} />}
                <RenderModule m={m} data={data} />
              </div>
            ))}
          </div>
          {editing && <HiddenModules data={data} onChanged={reload} />}
          <div className="home-foot">
            <span className="small muted">{fromLabel}{data.from !== 'preview' && data.from !== 'user' && data.adjusted ? ` · ${t('home.adjust.yours')}` : ''}</span>
            {data.from !== 'preview' && (
              <span className="row">
                <button className={`btn sm ${editing ? 'primary' : ''}`} onClick={() => setEditing(!editing)} type="button">
                  <Icon name={editing ? 'check' : 'apps'} /> {editing ? t('home.adjust.done') : t('home.adjust.button')}
                </button>
                <button className="btn sm" onClick={() => setCustomizing(true)} type="button"><Icon name="settings" /> {t('home.customize.button')}</button>
              </span>
            )}
          </div>
        </>
      )}
      {customizing && data && <CustomizeDialog data={data} onClose={() => setCustomizing(false)} />}
    </>
  );
}
