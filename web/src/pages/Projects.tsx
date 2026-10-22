/**
 * 项目: the company's Linear projects as each person sees them in Linear (read with their own connection), and one
 * project in detail: its pace (done vs time passed), milestones, latest updates and issues. Built from the design
 * system (aisa-ui.css components, aisa-charts tiles and timeline). Changing things stays in Linear.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ganttChart, statTile } from '../brand/aisa-charts.js';
import { api } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { Icon, Loading, useAction, useApi } from '../ui';
import { KitDialog } from '../kit';
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
  members: Person[]; milestoneDates: { name: string; date: string }[];
}
interface Issue {
  id: string; identifier: string; title: string; url: string; priority: number; priorityLabel: string; dueDate: string | null;
  state: { id: string | null; name: string; type: string } | null; assignee: Person | null; assigneeId: string | null;
  milestone: string | null; team: string | null; completedAt: string | null;
}
interface Team { id: string; name: string; key: string; states: { id: string; name: string; type: string }[]; members: (Person & { id: string })[] }
interface ProjectDetail extends Project {
  updates: Update[]; milestones: { id: string; name: string; targetDate: string | null; issues: number; done: number }[];
  issues: Issue[]; issueCounts: { total: number; done: number }; moreIssues: boolean;
  teamOptions: Team[]; canWrite: boolean;
}
interface IssueDetail extends Omit<Issue, 'priorityLabel' | 'milestone' | 'completedAt'> {
  description: string; createdAt: string | null; creator: Person | null; comments: { id: string; body: string; at: string; by: Person | null }[]; canWrite: boolean;
  teamOptions: Team[]; project: { id: string; name: string } | null;
}
interface MyIssue { id: string; identifier: string; title: string; url: string; priority: number; dueDate: string | null; state: { name: string; type: string } | null; project: { id: string; name: string } | null; doneStateId: string | null }
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

/** Project members as overlapping avatars (at most five, then a count). */
function Avatars({ people }: { people: Person[] }) {
  if (!people.length) return <span className="aisa-muted">—</span>;
  const shown = people.slice(0, 5);
  return (
    <span className="aisa-avatars" title={people.map((m) => m.name).join(', ')}>
      {shown.map((m, i) => (m.avatar
        ? <img key={i} className="aisa-avatar aisa-avatar--sm" src={m.avatar} alt={m.name} />
        : <span key={i} className="aisa-avatar aisa-avatar--sm" aria-label={m.name}>{m.name.slice(0, 1).toUpperCase()}</span>))}
      {people.length > shown.length && <span className="aisa-avatar aisa-avatar--sm proj-more">+{people.length - shown.length}</span>}
    </span>
  );
}

/** The person's own open issues, nearest due first; ticking one moves it to its team's done state. */
function MyIssues({ open }: { open: (id: string) => void }) {
  const { t, locale } = useI18n();
  const { data, error, reload } = useApi<{ canWrite: boolean; issues: MyIssue[] }>('/projects/my-issues');
  const { busy, run } = useAction();
  const fmt = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' });
  const done = (i: MyIssue) => run(() => api.patch(`/linear/issues/${i.id}`, { stateId: i.doneStateId }), t('projects.markedDone', { id: i.identifier })).then(reload);
  const shown = data?.issues.slice(0, 8) ?? [];
  return (
    <section className="aisa-card aisa-card--pad">
      <div className="proj-card-title"><h3>{t('projects.myIssues')}</h3>{data && <span className="aisa-small aisa-muted">{t('projects.openCount', { n: data.issues.length })}</span>}</div>
      {!data ? <div className="aisa-skeleton" style={{ height: 120 }}>{error && <span className="aisa-small">{error}</span>}</div>
        : data.issues.length === 0 ? <p className="aisa-small aisa-muted" style={{ margin: 0 }}>{t('projects.noMyIssues')}</p> : (
          <ul className="aisa-todo">
            {shown.map((i) => {
              const left = i.dueDate ? daysTo(i.dueDate) : null;
              return (
                <li key={i.id} className={`aisa-todo__item${left !== null && left < 0 ? ' is-overdue' : ''}`}>
                  <label className="aisa-check" title={data.canWrite ? t('projects.markDone') : t('projects.readOnlyHint')}>
                    <input type="checkbox" disabled={busy || !data.canWrite || !i.doneStateId} onChange={() => done(i)} aria-label={t('projects.markDone')} />
                  </label>
                  <button type="button" className="aisa-todo__title proj-issue" onClick={() => open(i.id)}><span className="aisa-muted proj-id">{i.identifier}</span> {i.title}</button>
                  {i.project ? <Link className="aisa-todo__tag" to={`/projects/${i.project.id}`}>{i.project.name}</Link> : <span className="aisa-todo__tag">—</span>}
                  <span className="aisa-todo__due">{left === null ? '' : left < 0 ? t('projects.overdueDays', { n: -left }) : left === 0 ? t('projects.dueToday') : fmt(i.dueDate!)}</span>
                </li>
              );
            })}
          </ul>
        )}
      {data && data.issues.length > shown.length && <p className="aisa-small aisa-muted" style={{ margin: '8px 0 0' }}>{t('projects.moreMine', { n: data.issues.length - shown.length })}</p>}
    </section>
  );
}

/** What is coming up: target dates of active projects and their milestones, overdue first. */
function Upcoming({ projects }: { projects: Project[] }) {
  const { t, locale } = useI18n();
  const fmt = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  const items = projects.filter((p) => isActive(p) || p.status?.type === 'planned').flatMap((p) => [
    ...(p.targetDate ? [{ key: `${p.id}|t`, project: p, title: p.name, what: t('projects.col.target'), date: p.targetDate }] : []),
    ...p.milestoneDates.map((m, i) => ({ key: `${p.id}|m${i}`, project: p, title: m.name, what: `${p.name} · ${t('projects.milestone')}`, date: m.date })),
  ]).map((x) => ({ ...x, n: daysTo(x.date) }))
    .filter((x) => x.n <= 60 && (x.n >= 0 || x.key.endsWith('|t')))
    .sort((a, b) => a.n - b.n).slice(0, 6);
  return (
    <section className="aisa-card aisa-card--pad">
      <div className="proj-card-title"><h3>{t('projects.upcoming')}</h3><span className="aisa-small aisa-muted">{t('projects.upcomingHint')}</span></div>
      {items.length === 0 ? <p className="aisa-small aisa-muted" style={{ margin: 0 }}>{t('projects.noUpcoming')}</p> : (
        <ul className="aisa-countdown">
          {items.map((x) => (
            <li key={x.key} className={x.n <= 7 ? 'is-urgent' : ''}>
              <div className="aisa-countdown__n"><b>{Math.abs(x.n)}</b><span>{x.n < 0 ? t('projects.cd.over') : x.n === 0 ? t('projects.cd.today') : t('projects.cd.left')}</span></div>
              <div style={{ minWidth: 0 }}>
                <Link to={`/projects/${x.project.id}`} className="aisa-countdown__title proj-link">{x.title}</Link>
                <div className="aisa-countdown__meta">{x.what} · {fmt(x.date)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
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
  const [panel, setPanel] = useState<string | null>(null);
  const [mineKey, setMineKey] = useState(0);
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
      <div className="proj-two">
        <MyIssues key={mineKey} open={setPanel} />
        <Upcoming projects={inScope} />
      </div>
      {panel && <IssuePanel id={panel} onClose={() => setPanel(null)} onChanged={() => setMineKey((k) => k + 1)} />}
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
                <th className="aisa-hide-sm">{t('projects.col.members')}</th>
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
                  <td className="aisa-hide-sm"><Avatars people={p.members} /></td>
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

const PRIORITIES = [1, 2, 3, 4, 0] as const;

/** State, assignee, priority and due date of an issue, as controls when the person may change them. */
function IssueControls({ issue, teams, canWrite, onChanged, compact }: { issue: Pick<Issue, 'id' | 'state' | 'assigneeId' | 'priority' | 'dueDate' | 'team'>; teams: Team[]; canWrite: boolean; onChanged: () => void; compact?: boolean }) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const team = teams.find((x) => x.id === issue.team) ?? teams[0];
  const save = (patch: Record<string, unknown>) => run(() => api.patch(`/linear/issues/${issue.id}`, patch), t('projects.saved')).then((ok) => ok && onChanged());
  if (!canWrite || !team) return null;
  const cls = 'aisa-select aisa-select--sm';
  return (
    <div className={compact ? 'proj-controls proj-controls--compact' : 'proj-controls'}>
      <select className={cls} disabled={busy} value={issue.state?.id ?? ''} aria-label={t('projects.f.state')} onChange={(e) => save({ stateId: e.target.value })}>
        {team.states.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
      <select className={cls} disabled={busy} value={issue.assigneeId ?? ''} aria-label={t('projects.f.assignee')} onChange={(e) => save({ assigneeId: e.target.value || null })}>
        <option value="">{t('projects.unassigned')}</option>
        {team.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
      <select className={cls} disabled={busy} value={issue.priority} aria-label={t('projects.f.priority')} onChange={(e) => save({ priority: Number(e.target.value) })}>
        {PRIORITIES.map((n) => <option key={n} value={n}>{t(`projects.priority.${n}` as MessageKey)}</option>)}
      </select>
      <input className="aisa-input aisa-input--sm" type="date" disabled={busy} value={issue.dueDate ?? ''} aria-label={t('projects.f.due')} onChange={(e) => save({ dueDate: e.target.value || null })} />
    </div>
  );
}

/** One issue in a drawer from the right: its controls, description and comments, with a box to reply. */
function IssuePanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t, ago } = useI18n();
  const { data: i, error, reload } = useApi<IssueDetail>(`/linear/issues/${id}`);
  const { busy, run } = useAction();
  const [comment, setComment] = useState('');
  const changed = () => { reload(); onChanged(); };
  const send = () => run(() => api.post(`/linear/issues/${id}/comments`, { body: comment }), t('projects.commented')).then((ok) => ok && (setComment(''), reload()));
  return (
    <KitDialog kind="drawer" onClose={onClose}
      title={i ? <><span className="aisa-muted proj-id">{i.identifier}</span> {i.title}</> : t('common.loading')}
      subtitle={i?.project?.name}
      foot={i?.canWrite ? (
        <div className="proj-reply">
          <textarea className="aisa-textarea" rows={3} value={comment} maxLength={10000} placeholder={t('projects.commentPh')} onChange={(e) => setComment(e.target.value)} />
          <div className="aisa-row" style={{ justifyContent: 'space-between' }}>
            <a className="aisa-btn aisa-btn--sm aisa-btn--ghost" href={i.url} target="_blank" rel="noreferrer">{t('projects.openInLinear')} <Icon name="external" size={12} /></a>
            <button className="aisa-btn aisa-btn--primary aisa-btn--sm" type="button" disabled={busy || !comment.trim()} onClick={send}>{t('projects.comment')}</button>
          </div>
        </div>
      ) : i && <a className="aisa-btn aisa-btn--sm" href={i.url} target="_blank" rel="noreferrer">{t('projects.openInLinear')} <Icon name="external" size={12} /></a>}>
      {!i ? <div className="aisa-skeleton" style={{ height: 220 }}>{error && <span className="aisa-small">{error}</span>}</div> : (
        <div className="proj-panel">
          <div className="proj-panel__meta">
            {i.canWrite ? <IssueControls issue={i} teams={i.teamOptions} canWrite onChanged={changed} /> : (
              <span className="aisa-small aisa-muted">{i.state?.name} · {i.assignee?.name ?? t('projects.unassigned')} · {t(`projects.priority.${i.priority}` as MessageKey)}</span>
            )}
          </div>
          {i.description ? <div className="proj-desc">{i.description}</div> : <p className="aisa-small aisa-muted">{t('projects.noDescription')}</p>}
          <h4 className="proj-h4">{t('projects.comments', { n: i.comments.length })}</h4>
          {i.comments.length > 0 ? (
            <ul className="aisa-feed">
              {i.comments.map((c) => (
                <li key={c.id}>
                  <PersonDot p={c.by} />
                  <div style={{ minWidth: 0 }}><b>{c.by?.name ?? '—'}</b><p className="proj-comment">{c.body}</p></div>
                  <time>{ago(Date.parse(c.at))}</time>
                </li>
              ))}
            </ul>
          ) : <p className="aisa-small aisa-muted" style={{ margin: 0 }}>{t('projects.noComments')}</p>}
        </div>
      )}
    </KitDialog>
  );
}

function PersonDot({ p }: { p: Person | null }) {
  if (p?.avatar) return <img className="aisa-avatar aisa-avatar--md" src={p.avatar} alt="" />;
  return <span className="aisa-avatar aisa-avatar--md">{(p?.name ?? '?').slice(0, 1).toUpperCase()}</span>;
}

/** A new issue in this project. */
function NewIssueDialog({ p, onClose, onDone }: { p: ProjectDetail; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const [f, setF] = useState({ teamId: p.teamOptions[0]?.id ?? '', title: '', description: '', assigneeId: '', priority: 0, milestoneId: '', dueDate: '' });
  const team = p.teamOptions.find((x) => x.id === f.teamId);
  const submit = () => run(() => api.post(`/projects/${p.id}/issues`, { ...f, assigneeId: f.assigneeId || null, milestoneId: f.milestoneId || null, dueDate: f.dueDate || null }), t('projects.created'))
    .then((ok) => ok && (onDone(), onClose()));
  return (
    <KitDialog title={t('projects.newIssue')} subtitle={p.name} onClose={onClose} wide
      foot={<>
        <button className="aisa-btn" type="button" onClick={onClose}>{t('common.cancel')}</button>
        <button className="aisa-btn aisa-btn--primary" type="button" disabled={busy || !f.title.trim() || !f.teamId} onClick={submit}>{t('projects.create')}</button>
      </>}>
      <div className="proj-form">
        {p.teamOptions.length > 1 && (
          <label className="aisa-field"><span className="aisa-field__label">{t('projects.f.team')}</span>
            <select className="aisa-select" value={f.teamId} onChange={(e) => setF({ ...f, teamId: e.target.value, assigneeId: '' })}>{p.teamOptions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          </label>
        )}
        <label className="aisa-field"><span className="aisa-field__label">{t('projects.f.title')}</span>
          <input className="aisa-input" value={f.title} maxLength={255} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </label>
        <label className="aisa-field"><span className="aisa-field__label">{t('projects.f.description')} <span className="aisa-muted">{t('requests.f.optional')}</span></span>
          <textarea className="aisa-textarea" rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </label>
        <div className="proj-form__row">
          <label className="aisa-field"><span className="aisa-field__label">{t('projects.f.assignee')}</span>
            <select className="aisa-select" value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })}>
              <option value="">{t('projects.unassigned')}</option>
              {(team?.members ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <label className="aisa-field"><span className="aisa-field__label">{t('projects.f.priority')}</span>
            <select className="aisa-select" value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })}>
              {PRIORITIES.map((n) => <option key={n} value={n}>{t(`projects.priority.${n}` as MessageKey)}</option>)}
            </select>
          </label>
        </div>
        <div className="proj-form__row">
          {p.milestones.length > 0 && (
            <label className="aisa-field"><span className="aisa-field__label">{t('projects.f.milestone')}</span>
              <select className="aisa-select" value={f.milestoneId} onChange={(e) => setF({ ...f, milestoneId: e.target.value })}>
                <option value="">{t('projects.noMilestone')}</option>
                {p.milestones.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </label>
          )}
          <label className="aisa-field"><span className="aisa-field__label">{t('projects.f.due')}</span>
            <input className="aisa-input" type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
          </label>
        </div>
      </div>
    </KitDialog>
  );
}

/** A project update: how it is going (health) and what happened. */
function UpdateDialog({ p, onClose, onDone }: { p: ProjectDetail; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const [health, setHealth] = useState<Health>(p.health ?? 'onTrack');
  const [body, setBody] = useState('');
  const submit = () => run(() => api.post(`/projects/${p.id}/updates`, { health, body }), t('projects.posted')).then((ok) => ok && (onDone(), onClose()));
  return (
    <KitDialog title={t('projects.writeUpdate')} subtitle={p.name} onClose={onClose} wide
      foot={<>
        <button className="aisa-btn" type="button" onClick={onClose}>{t('common.cancel')}</button>
        <button className="aisa-btn aisa-btn--primary" type="button" disabled={busy || !body.trim()} onClick={submit}>{t('projects.post')}</button>
      </>}>
      <div className="proj-form">
        <div className="aisa-field"><span className="aisa-field__label">{t('projects.col.health')}</span>
          <div className="aisa-segmented" role="group" aria-label={t('projects.col.health')}>
            {(['onTrack', 'atRisk', 'offTrack'] as Health[]).map((h) => <button key={h} type="button" aria-pressed={health === h} onClick={() => setHealth(h)}>{t(`projects.health.${h}` as MessageKey)}</button>)}
          </div>
        </div>
        <label className="aisa-field"><span className="aisa-field__label">{t('projects.f.update')}</span>
          <textarea className="aisa-textarea" rows={7} value={body} placeholder={t('projects.updatePh')} onChange={(e) => setBody(e.target.value)} />
        </label>
      </div>
    </KitDialog>
  );
}

export function ProjectDetailPage() {
  const { t, locale } = useI18n();
  const { id } = useParams();
  const { data: p, error, reload } = useApi<ProjectDetail>(`/projects/${id}`);
  const [group, setGroup] = useState<(typeof ISSUE_GROUPS)[number]>('started');
  const [panel, setPanel] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'issue' | 'update' | null>(null);
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
        <div className="aisa-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {p.canWrite && <button className="aisa-btn" type="button" onClick={() => setDialog('update')}>{t('projects.writeUpdate')}</button>}
          {p.canWrite && p.teamOptions.length > 0 && <button className="aisa-btn aisa-btn--primary" type="button" onClick={() => setDialog('issue')}><Icon name="plus" size={13} /> {t('projects.newIssue')}</button>}
          <a className="aisa-btn" href={p.url} target="_blank" rel="noreferrer">{t('projects.openInLinear')} <Icon name="external" size={13} /></a>
        </div>
      </div>
      {!p.canWrite && (
        <div className="aisa-alert proj-alert">
          <div className="grow">{t('projects.readOnlyHint')}</div>
          <a className="aisa-btn aisa-btn--sm" href={`/auth/linear/connect?return=${encodeURIComponent(`/projects/${p.id}`)}`}>{t('projects.allowEdit')}</a>
        </div>
      )}

      <div className="proj-top">
        <PaceCard p={p} />
        <div className="aisa-card aisa-card--pad">
          <dl className="aisa-kv">
            <dt>{t('projects.col.status')}</dt><dd><StatusBadge s={p.status} /></dd>
            {p.teams.length > 0 && <><dt>{t('projects.teams')}</dt><dd>{p.teams.join(' · ')}</dd></>}
            {p.members.length > 0 && <><dt>{t('projects.col.members')}</dt><dd className="aisa-row" style={{ gap: 8 }}><Avatars people={p.members} /><span className="aisa-small aisa-muted">{t('projects.peopleN', { n: p.members.length })}</span></dd></>}
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
                        <td className="proj-issue-title">
                          <button type="button" className="proj-issue" onClick={() => setPanel(i.id)}>{i.title}</button>
                          {p.canWrite
                            ? <IssueControls issue={i} teams={p.teamOptions} canWrite onChanged={reload} compact />
                            : i.state && <div className="aisa-small aisa-muted">{i.state.name}{i.priorityLabel && i.priority ? ` · ${i.priorityLabel}` : ''}</div>}
                        </td>
                        {!p.canWrite && <td className="aisa-hide-sm"><PersonChip p={i.assignee} /></td>}
                        {!p.canWrite && <td className="aisa-hide-sm aisa-small">{i.dueDate ? <span className={daysTo(i.dueDate) < 0 && group !== 'completed' ? 'proj-late' : ''}>{fmt(i.dueDate)}</span> : ''}</td>}
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
      {panel && <IssuePanel id={panel} onClose={() => setPanel(null)} onChanged={reload} />}
      {dialog === 'issue' && <NewIssueDialog p={p} onClose={() => setDialog(null)} onDone={reload} />}
      {dialog === 'update' && <UpdateDialog p={p} onClose={() => setDialog(null)} onDone={reload} />}
    </div>
  );
}
