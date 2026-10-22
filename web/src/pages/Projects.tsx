/**
 * 项目: the company's Linear projects as each person sees them in Linear (read with their own connection), and one
 * project in detail: its pace (done vs time passed), milestones, latest updates and issues. Built from the design
 * system (aisa-ui.css components, aisa-charts tiles and timeline). Changing things stays in Linear.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ganttChart, statTile } from '../brand/aisa-charts.js';
import { useI18n, type MessageKey } from '../i18n';
import { Icon, Loading, useApi } from '../ui';
import { moodOf, PaceRing } from './Home';

type Health = 'onTrack' | 'atRisk' | 'offTrack';
interface Person { name: string; avatar: string | null }
interface Update { body: string; health: Health | null; at: string | null; by: Person | null; url: string | null }
export interface Project {
  /** they lead it, are a member, or have issues in it */
  mine: boolean;
  id: string; name: string; description: string; url: string; color: string | null; progress: number | null;
  startDate: string | null; targetDate: string | null; updatedAt: string | null;
  status: { name: string; type: string } | null; health: Health | null; lead: Person | null; teams: string[]; lastUpdate: Update | null;
}
interface Issue {
  id: string; identifier: string; title: string; url: string; priority: number; priorityLabel: string; dueDate: string | null;
  state: { name: string; type: string } | null; assignee: Person | null; milestone: string | null; completedAt: string | null;
}
interface ProjectDetail extends Project {
  updates: Update[]; milestones: { id: string; name: string; targetDate: string | null; issues: number; done: number }[];
  issues: Issue[]; issueCounts: { total: number; done: number }; moreIssues: boolean;
}
interface LinearStatus { available: boolean; connected: boolean; name: string | null; workspace: string | null; connectUrl: string }

const FILTERS = ['active', 'planned', 'completed', 'all'] as const;
const isActive = (p: Project) => p.status?.type === 'started' || p.status?.type === 'paused';
const inFilter = (p: Project, f: (typeof FILTERS)[number]) => {
  const t = p.status?.type ?? '';
  if (f === 'active') return isActive(p);
  if (f === 'planned') return t === 'planned' || t === 'backlog';
  if (f === 'completed') return t === 'completed';
  return true;
};
const HEALTH_BADGE: Record<Health, string> = { onTrack: 'aisa-badge--success', atRisk: 'aisa-badge--warning', offTrack: 'aisa-badge--danger' };
const today = () => new Date().toISOString().slice(0, 10);
const pct = (v: number | null) => Math.round((v ?? 0) * 100);
const DAY = 86_400_000;
/** Whole days from today to a YYYY-MM-DD date (negative when it has passed). */
const daysTo = (d: string) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / DAY);
const late = (p: Project) => !!p.targetDate && daysTo(p.targetDate) < 0 && p.status?.type !== 'completed' && p.status?.type !== 'canceled';

function PersonChip({ p }: { p: Person | null }) {
  if (!p) return <span className="aisa-muted">—</span>;
  return (
    <span className="aisa-person">
      {p.avatar ? <img className="aisa-avatar aisa-avatar--sm" src={p.avatar} alt="" /> : <span className="aisa-avatar aisa-avatar--sm">{p.name.slice(0, 1).toUpperCase()}</span>}
      <span className="aisa-truncate">{p.name}</span>
    </span>
  );
}

function HealthBadge({ h }: { h: Health | null }) {
  const { t } = useI18n();
  if (!h) return <span className="aisa-muted aisa-small">{t('projects.health.none')}</span>;
  return <span className={`aisa-badge aisa-badge--dot ${HEALTH_BADGE[h]}`}>{t(`projects.health.${h}` as MessageKey)}</span>;
}

function StatusBadge({ s }: { s: Project['status'] }) {
  if (!s) return <span className="aisa-muted">—</span>;
  return <span className={`aisa-badge ${s.type === 'completed' ? 'aisa-badge--success' : s.type === 'started' ? 'aisa-badge--ink' : ''}`}>{s.name}</span>;
}

function Progress({ value }: { value: number | null }) {
  return (
    <span className="proj-progress">
      <span className="aisa-progress aisa-progress--thin" role="progressbar" aria-valuenow={pct(value)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ '--value': `${pct(value)}%` } as React.CSSProperties} />
      </span>
      <span className="aisa-small">{pct(value)}%</span>
    </span>
  );
}

/** A chart from aisa-charts mounted into a card, redrawn when its settings change. */
function Chart({ draw, cfg, className = 'aisa-card aisa-card--pad' }: { draw: typeof statTile; cfg: Record<string, unknown>; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = JSON.stringify(cfg);
  useEffect(() => {
    if (!ref.current) return;
    const h = draw(ref.current, cfg);
    return () => h.destroy();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className={className}><div ref={ref} /></div>;
}

/** Not set up, or not connected yet: say what to do. */
function NotReady({ status }: { status: LinearStatus }) {
  const { t } = useI18n();
  return (
    <div className="aisa-card">
      <div className="aisa-empty">
        <span className="aisa-icon-chip"><img src="/services/linear.svg" alt="" width={18} height={18} /></span>
        <strong>{t(status.available ? 'projects.connect.title' : 'projects.off.title')}</strong>
        <span>{t(status.available ? 'projects.connect.body' : 'projects.off.body')}</span>
        {status.available && <a className="aisa-btn aisa-btn--primary" href={status.connectUrl}>{t('projects.connect.button')}</a>}
      </div>
    </div>
  );
}

const workspaceUrl = (projects: Project[]) => projects[0]?.url.split('/project/')[0] ?? 'https://linear.app';

export function ProjectsPage() {
  const { t, locale } = useI18n();
  const nav = useNavigate();
  const { data, error } = useApi<{ status: LinearStatus; projects: Project[] }>('/projects');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('active');
  const [view, setView] = useState<'list' | 'timeline'>('list');
  // theirs by default; the choice is kept in this browser
  const [scope, setScopeState] = useState<'mine' | 'all'>(() => {
    try { return localStorage.getItem('projects.scope') === 'all' ? 'all' : 'mine'; } catch { return 'mine'; }
  });
  const setScope = (v: 'mine' | 'all') => {
    setScopeState(v);
    try { localStorage.setItem('projects.scope', v); } catch { /* private window */ }
  };
  const [q, setQ] = useState('');
  const fmt = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(locale, { month: 'short', day: 'numeric' }) : '—');
  const head = (
    <div className="aisa-page-head">
      <div>
        <h1>{t('projects.title')}</h1>
        <p>{data?.status.connected ? t('projects.sub', { workspace: data.status.workspace ?? 'Linear' }) : t('projects.subIntro')}</p>
      </div>
      {data?.status.connected && <a className="aisa-btn" href={workspaceUrl(data.projects)} target="_blank" rel="noreferrer">{t('projects.openLinear')} <Icon name="external" size={13} /></a>}
    </div>
  );
  if (!data) return <div className="aisa proj-page">{head}<Loading error={error} /></div>;
  if (!data.status.available || !data.status.connected) return <div className="aisa proj-page">{head}<NotReady status={data.status} /></div>;
  const needle = q.trim().toLowerCase();
  const inScope = data.projects.filter((p) => scope === 'all' || p.mine);
  const count = (f: (typeof FILTERS)[number]) => inScope.filter((p) => inFilter(p, f)).length;
  const shown = inScope.filter((p) => inFilter(p, filter) && (!needle || `${p.name} ${p.teams.join(' ')} ${p.lead?.name ?? ''}`.toLowerCase().includes(needle)));
  const active = inScope.filter(isActive);
  const kpis = [
    { label: t('projects.kpi.active'), value: active.length },
    { label: t('projects.kpi.atRisk'), value: active.filter((p) => p.health === 'atRisk' || p.health === 'offTrack').length },
    { label: t('projects.kpi.dueSoon'), value: active.filter((p) => p.targetDate && daysTo(p.targetDate) >= 0 && daysTo(p.targetDate) <= 30).length },
    { label: t('projects.kpi.late'), value: inScope.filter(late).length },
  ];
  const dated = shown.filter((p) => p.startDate && p.targetDate);
  return (
    <div className="aisa proj-page">
      {head}
      <div className="aisa-kpis proj-kpis">
        {kpis.map((k) => <Chart key={k.label} draw={statTile} cfg={{ label: k.label, value: k.value, format: { decimals: 0 } }} />)}
      </div>
      <div className="aisa-filters">
        <div className="aisa-segmented" role="group" aria-label={t('projects.scope')}>
          <button type="button" aria-pressed={scope === 'mine'} onClick={() => setScope('mine')}>{t('projects.scope.mine')} <span className="aisa-count">{data.projects.filter((p) => p.mine).length}</span></button>
          <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>{t('projects.scope.all')} <span className="aisa-count">{data.projects.length}</span></button>
        </div>
        <div className="aisa-segmented" role="group" aria-label={t('projects.filter')}>
          {FILTERS.map((f) => <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{t(`projects.filter.${f}` as MessageKey)} <span className="aisa-count">{count(f)}</span></button>)}
        </div>
        <div className="aisa-input-group" style={{ width: 'min(260px, 100%)' }}>
          <span className="aisa-input-group__addon"><Icon name="search" size={14} /></span>
          <input className="aisa-input aisa-input--sm" type="search" value={q} placeholder={t('projects.search')} aria-label={t('projects.search')} onChange={(e) => setQ(e.target.value)} />
        </div>
        <span className="aisa-spacer" />
        <div className="aisa-segmented" role="group" aria-label={t('projects.view')}>
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>{t('projects.view.list')}</button>
          <button type="button" aria-pressed={view === 'timeline'} onClick={() => setView('timeline')}>{t('projects.view.timeline')}</button>
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="aisa-card">
          <div className="aisa-empty">
            <strong>{t(!data.projects.length ? 'projects.none' : scope === 'mine' && !inScope.length ? 'projects.noneMine' : 'projects.noneHere')}</strong>
            {scope === 'mine' && !inScope.length && data.projects.length > 0 && <>
              <span>{t('projects.noneMineHint')}</span>
              <button className="aisa-btn aisa-btn--sm" type="button" onClick={() => setScope('all')}>{t('projects.showAll', { n: data.projects.length })}</button>
            </>}
          </div>
        </div>
      ) : view === 'timeline' ? (
        <>
          {dated.length > 0
            ? <Chart draw={ganttChart} cfg={{ tasks: dated.map((p) => ({ name: p.name, owner: p.lead?.name ?? '', start: p.startDate, end: p.targetDate, progress: p.progress ?? 0 })) }} />
            : <div className="aisa-card"><div className="aisa-empty"><span>{t('projects.timeline.none')}</span></div></div>}
          {dated.length < shown.length && <p className="aisa-small aisa-muted">{t('projects.timeline.undated', { n: shown.length - dated.length })}</p>}
        </>
      ) : (
        <div className="aisa-table-wrap aisa-dense">
          <table className="aisa-table">
            <thead>
              <tr>
                <th>{t('projects.col.name')}</th>
                <th className="aisa-hide-sm">{t('projects.col.lead')}</th>
                <th>{t('projects.col.status')}</th>
                <th className="aisa-hide-sm">{t('projects.col.health')}</th>
                <th>{t('projects.col.progress')}</th>
                <th className="aisa-hide-sm">{t('projects.col.target')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} className="proj-row" onClick={() => nav(`/projects/${p.id}`)}>
                  <td>
                    <Link to={`/projects/${p.id}`} className="proj-name" onClick={(e) => e.stopPropagation()}>{p.name}</Link>
                    {p.teams.length > 0 && <div className="aisa-small aisa-muted">{p.teams.join(' · ')}</div>}
                  </td>
                  <td className="aisa-hide-sm"><PersonChip p={p.lead} /></td>
                  <td><StatusBadge s={p.status} /></td>
                  <td className="aisa-hide-sm"><HealthBadge h={p.health} /></td>
                  <td><Progress value={p.progress} /></td>
                  <td className="aisa-hide-sm">
                    <span className={late(p) ? 'proj-late' : ''}>{fmt(p.targetDate)}</span>
                    {late(p) && <span className="aisa-badge aisa-badge--warning" style={{ marginLeft: 6 }}>{t('projects.late')}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const ISSUE_GROUPS = ['started', 'unstarted', 'backlog', 'completed'] as const;
const groupOf = (i: Issue) => {
  const t = i.state?.type ?? 'backlog';
  return t === 'triage' ? 'backlog' : t === 'canceled' ? null : (t as (typeof ISSUE_GROUPS)[number]);
};

/** Done vs time passed, as on the OKR pace card; with the days left to the target date. */
function PaceCard({ p }: { p: ProjectDetail }) {
  const { t } = useI18n();
  const done = p.progress ?? 0;
  const span = p.startDate && p.targetDate ? Date.parse(p.targetDate) - Date.parse(p.startDate) : 0;
  const elapsed = span > 0 ? Math.max(0, Math.min(1, (Date.now() - Date.parse(p.startDate!)) / span)) : null;
  const finished = p.status?.type === 'completed';
  const mood = finished ? 'ok' : moodOf(done, elapsed);
  const left = p.targetDate ? daysTo(p.targetDate) : null;
  return (
    <div className="aisa-card aisa-card--pad">
      <div className="aisa-pace">
        <div className="aisa-pace__dial"><PaceRing done={done} elapsed={finished ? null : elapsed} mood={mood} /></div>
        <div>
          <div className="aisa-pace__title">{t(finished ? 'projects.mood.done' : `projects.mood.${mood}` as MessageKey)}</div>
          <div className="aisa-pace__sub">{elapsed === null || finished ? t('projects.pace.doneOnly', { done: `${pct(done)}%` }) : t('projects.pace.sub', { elapsed: `${Math.round(elapsed * 100)}%`, done: `${pct(done)}%` })}</div>
          <div className="aisa-pace__stats">
            <span className="is-dot"><span>{t('projects.pace.issues')}</span><b>{p.issueCounts.done} / {p.issueCounts.total}</b></span>
            {left !== null && !finished && <span><span>{t('projects.col.target')}</span><b className={left < 0 ? 'proj-late' : ''}>{left < 0 ? t('projects.daysOver', { n: -left }) : left === 0 ? t('projects.dueToday') : t('projects.daysLeft', { n: left })}</b></span>}
            <span><span>{t('projects.col.health')}</span><b><HealthBadge h={p.health} /></b></span>
            <span><span>{t('projects.col.lead')}</span><b><PersonChip p={p.lead} /></b></span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ProjectDetailPage() {
  const { t, locale } = useI18n();
  const { id } = useParams();
  const { data: p, error } = useApi<ProjectDetail>(`/projects/${id}`);
  const [group, setGroup] = useState<(typeof ISSUE_GROUPS)[number]>('started');
  const fmt = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const crumb = (
    <nav className="aisa-breadcrumb" aria-label={t('projects.title')}>
      <Link to="/projects">{t('projects.title')}</Link>{p && <span aria-current="page">{p.name}</span>}
    </nav>
  );
  if (!p) return <div className="aisa proj-page">{crumb}<Loading error={error} /></div>;
  // urgent first (Linear: 1 urgent … 4 low, 0 none)
  const issues = p.issues.filter((i) => groupOf(i) === group).sort((a, b) => (a.priority || 9) - (b.priority || 9));
  const count = (g: (typeof ISSUE_GROUPS)[number]) => p.issues.filter((i) => groupOf(i) === g).length;
  const current = p.milestones.findIndex((m) => !(m.issues > 0 && m.done === m.issues));
  return (
    <div className="aisa proj-page">
      {crumb}
      <div className="aisa-page-head">
        <div style={{ minWidth: 0 }}>
          <h1>{p.name}</h1>
          {p.description && <p>{p.description}</p>}
        </div>
        <a className="aisa-btn" href={p.url} target="_blank" rel="noreferrer">{t('projects.openInLinear')} <Icon name="external" size={13} /></a>
      </div>

      <div className="proj-top">
        <PaceCard p={p} />
        <div className="aisa-card aisa-card--pad">
          <dl className="aisa-kv">
            <dt>{t('projects.col.status')}</dt><dd><StatusBadge s={p.status} /></dd>
            {p.teams.length > 0 && <><dt>{t('projects.teams')}</dt><dd>{p.teams.join(' · ')}</dd></>}
            <dt>{t('projects.dates')}</dt><dd>{fmt(p.startDate)} → {fmt(p.targetDate)}</dd>
            <dt>{t('projects.col.progress')}</dt><dd><Progress value={p.progress} /></dd>
          </dl>
        </div>
      </div>

      {p.milestones.length > 0 && (
        <section className="aisa-card proj-section">
          <div className="aisa-card__head"><h3>{t('projects.milestones')}</h3><span className="aisa-small aisa-muted">{t('projects.milestonesDone', { done: p.milestones.filter((m) => m.issues > 0 && m.done === m.issues).length, total: p.milestones.length })}</span></div>
          <div className="aisa-card__body">
            <ol className="aisa-flow">
              {p.milestones.map((m, i) => (
                <li key={m.id} className={i < current || current === -1 ? 'is-done' : i === current ? 'is-current' : ''}>
                  <div className="aisa-flow__mark" />
                  <div className="aisa-flow__index" />
                  <div className="aisa-flow__title">{m.name}</div>
                  <div className="aisa-flow__meta">{m.targetDate ? fmt(m.targetDate) : t('projects.noDate')}</div>
                  <div className="aisa-flow__sla">{t('projects.issuesDone', { done: m.done, total: m.issues })}</div>
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}

      <div className="proj-grid">
        <section className="aisa-card">
          <div className="aisa-card__head">
            <h3>{t('projects.issues')}</h3>
            <div className="aisa-segmented" role="group" aria-label={t('projects.issues')}>
              {ISSUE_GROUPS.map((g) => <button key={g} type="button" aria-pressed={group === g} onClick={() => setGroup(g)}>{t(`projects.state.${g}` as MessageKey)} <span className="aisa-count">{count(g)}</span></button>)}
            </div>
          </div>
          <div className="aisa-card__body">
            {issues.length === 0 ? <div className="aisa-empty"><span>{t('projects.noIssues')}</span></div> : (
              <div className="aisa-table-wrap aisa-dense proj-issues">
                <table className="aisa-table aisa-table--compact">
                  <tbody>
                    {issues.map((i) => (
                      <tr key={i.id}>
                        <td className="aisa-small aisa-muted proj-id">{i.identifier}</td>
                        <td className="proj-issue-title"><a href={i.url} target="_blank" rel="noreferrer" className="proj-issue">{i.title}</a>{i.state && <div className="aisa-small aisa-muted">{i.state.name}{i.priorityLabel && i.priority ? ` · ${i.priorityLabel}` : ''}</div>}</td>
                        <td className="aisa-hide-sm"><PersonChip p={i.assignee} /></td>
                        <td className="aisa-hide-sm aisa-small">{i.dueDate ? <span className={daysTo(i.dueDate) < 0 && group !== 'completed' ? 'proj-late' : ''}>{fmt(i.dueDate)}</span> : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {p.moreIssues && <p className="aisa-small aisa-muted" style={{ margin: '10px 0 0' }}>{t('projects.moreIssues')}</p>}
          </div>
        </section>

        <section className="aisa-card">
          <div className="aisa-card__head"><h3>{t('projects.updates')}</h3></div>
          <div className="aisa-card__body">
            {p.updates.length === 0 ? <p className="aisa-small aisa-muted" style={{ margin: 0 }}>{t('projects.noUpdates')}</p> : (
              <ol className="aisa-timeline">
                {p.updates.map((u, i) => (
                  <li key={i}>
                    <div style={{ minWidth: 0 }}>
                      <time>{when(u.at)}</time>
                      <div className="proj-update-head"><PersonChip p={u.by} /> {u.health && <HealthBadge h={u.health} />}</div>
                      <p className="proj-update">{u.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
