import { useMemo, useState } from 'react';
import { api } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { Avatar, CopyBox, Empty, Icon, Loading, useAction, useApi, useMe } from '../ui';

// ---------------------------------------------------------------- data (mirrors server/data/checks.ts issuesFor)
type Level = 'error' | 'verify' | 'style';
interface Owner { id: string; name: string; avatar: string | null }
interface IssueRow {
  record: string; label: string; detail: Record<string, string>; since: number; owners: Owner[]; url: string; mine: boolean;
  exception: { reason: string | null; by: string; at: number } | null;
}
interface CheckInfo { id: number; title: string; hint: string; team: string; level: Level; source: { id: string; title: string }; error: string | null; lastRun: number | null; canEdit: boolean; rows: IssueRow[] }
export interface IssuesData {
  checks: CheckInfo[];
  counts: { mine: number; all: number; exceptions: number; byLevel: Record<Level, number> };
  people: (Owner & { count: number; errors: number })[];
  lastRun: { at: number; ms: number } | null;
}

export const LEVEL_BADGE: Record<Level, string> = { error: 'danger', verify: 'warn', style: '' };
type Tab = 'mine' | 'all' | 'exceptions';

/** "key: value" pairs that explain why a record is listed. */
function Detail({ detail }: { detail: Record<string, string> }) {
  const { t } = useI18n();
  return (
    <span className="issue-detail">
      {Object.entries(detail).map(([k, v]) => (
        <span key={k}>
          <span className="muted">{k === '×' ? t('issues.dupes') : k === '→' ? t('issues.usual') : k}</span> {v || <span className="muted">{t('issues.blank')}</span>}
        </span>
      ))}
    </span>
  );
}

function CheckBlock({ c, rows, onChanged }: { c: CheckInfo; rows: IssueRow[]; onChanged: () => void }) {
  const { t, ago } = useI18n();
  const [open, setOpen] = useState(false);
  const { busy, run } = useAction();
  const toggle = (r: IssueRow) => {
    const reason = r.exception ? undefined : prompt(t('issues.exceptionReason'));
    if (!r.exception && reason === null) return;
    run(() => api.post('/issues/exception', { check: c.id, record: r.record, on: !r.exception, reason: reason || undefined }), t(r.exception ? 'issues.exceptionRemoved' : 'issues.exceptionSaved')).then(onChanged);
  };
  return (
    <div className={`issue-check ${open ? 'open' : ''}`}>
      <button className="issue-check__head" onClick={() => setOpen(!open)} type="button">
        <span className={`badge ${LEVEL_BADGE[c.level]}`}>{t(`issues.level.${c.level}`)}</span>
        <span className="grow ellipsis"><b>{c.title}</b>{c.error && <span className="small" style={{ color: 'var(--danger)' }}> · {t('issues.checkFailed')}</span>}</span>
        <span className="small muted">{c.team || c.source.title}</span>
        <b className="issue-check__count">{rows.length}</b>
        <Icon name="back" size={14} />
      </button>
      {open && (
        <div className="issue-check__body">
          {(c.hint || c.error) && <p className="small muted" style={{ margin: '0 0 10px' }}>{c.error ?? c.hint}</p>}
          {rows.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{t('issues.noneHere')}</p> : (
            <div className="table-wrap">
              <table className="table issue-table">
                <tbody>
                  {rows.slice(0, 300).map((r) => (
                    <tr key={r.record}>
                      <td className="issue-table__label"><a href={r.url} target="_blank" rel="noreferrer">{r.label}</a></td>
                      <td><Detail detail={r.detail} />{r.exception && <div className="small muted">{t('issues.exceptionBy', { name: r.exception.by, reason: r.exception.reason ?? '' })}</div>}</td>
                      <td className="nowrap">{r.owners.length ? r.owners.map((o) => <span key={o.id} className="row" style={{ gap: 6 }}><Avatar person={o} />{o.name}</span>) : <span className="small muted">{t('issues.noOwner')}</span>}</td>
                      <td className="nowrap small muted">{ago(r.since)}</td>
                      <td className="nowrap" style={{ textAlign: 'right' }}>
                        <a className="btn sm ghost" href={r.url} target="_blank" rel="noreferrer">{t('issues.open')}</a>
                        {(r.mine || c.canEdit) && <button className="btn sm ghost" disabled={busy} onClick={() => toggle(r)} type="button">{t(r.exception ? 'issues.undoException' : 'issues.markException')}</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 300 && <p className="small muted">{t('issues.more', { n: rows.length - 300 })}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function IssuesPage() {
  const me = useMe();
  const { t, ago } = useI18n();
  const { data, error, reload } = useApi<IssuesData>('/issues');
  const [fresh, setFresh] = useState<IssuesData | null>(null);
  const [picked, setTab] = useState<Tab | null>(null);
  const [q, setQ] = useState('');
  const [owner, setOwner] = useState('');
  const [source, setSource] = useState('');
  const [level, setLevel] = useState('');
  const [allPeople, setAllPeople] = useState(false);
  const { busy, run } = useAction();
  const d = fresh ?? data;
  const tab: Tab = picked ?? (d && d.counts.mine === 0 ? 'all' : 'mine');

  const filtered = useMemo(() => (d?.checks ?? [])
    .filter((c) => (!source || c.source.id === source) && (!level || c.level === level))
    .map((c) => ({
      c,
      rows: c.rows.filter((r) => (tab === 'exceptions' ? !!r.exception : !r.exception && (tab === 'all' || r.mine))
        && (!owner || r.owners.some((o) => o.id === owner) || (owner === '-' && !r.owners.length))
        && (!q || [r.label, ...Object.values(r.detail), ...r.owners.map((o) => o.name), c.title].join(' ').toLowerCase().includes(q.toLowerCase()))),
    }))
    .filter((x) => x.rows.length)
    .sort((a, b) => ['error', 'verify', 'style'].indexOf(a.c.level) - ['error', 'verify', 'style'].indexOf(b.c.level) || b.rows.length - a.rows.length), [d, tab, q, owner, source, level]);

  if (!d) return <Loading error={error} />;
  const recheck = () => run(async () => setFresh(await api.post<IssuesData>('/issues/run')), t('issues.rechecked'));
  const hub = t('prompt.hub', { company: me.hub.companyName, mcp: me.hub.mcpName });
  const sources = [...new Map(d.checks.map((c) => [c.source.id, c.source.title])).entries()];
  const people = allPeople ? d.people : d.people.slice(0, 9);
  const tabs: [Tab, MessageKey, number][] = [['mine', 'issues.tab.mine', d.counts.mine], ['all', 'issues.tab.all', d.counts.all], ['exceptions', 'issues.tab.exceptions', d.counts.exceptions]];
  return (
    <>
      <div className="page-head">
        <div><h1>{t('issues.title')}</h1><p>{t('issues.intro')}</p></div>
        <div className="row" style={{ gap: 10 }}>
          {d.lastRun && <span className="small muted">{t('issues.lastRun', { ago: ago(d.lastRun.at), s: Math.max(1, Math.round(d.lastRun.ms / 1000)) })}</span>}
          <button className="btn" disabled={busy || !d.checks.length} onClick={recheck} type="button"><Icon name="refresh" /> {t(busy ? 'issues.checking' : 'issues.recheck')}</button>
        </div>
      </div>

      {d.checks.length === 0 ? (
        <div className="card pad">
          <Empty title={t('issues.noChecks')} hint={t('issues.noChecksHint')} />
          <CopyBox text={t('prompt.issues', { hub })} />
        </div>
      ) : (
        <>
          <div className="row issue-tabs">
            <div className="seg">
              {tabs.map(([k, label, n]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)} type="button">{t(label)} <span className="muted">{n}</span></button>)}
            </div>
            <span className="spacer" />
            <span className="small muted">{(['error', 'verify', 'style'] as const).map((l) => `${t(`issues.level.${l}`)} ${d.counts.byLevel[l]}`).join(' · ')}</span>
          </div>

          <div className="card pad issue-filters">
            <div className="search grow"><Icon name="search" /><input className="input" placeholder={t('issues.search')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <select className="select" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">{t('issues.allOwners')}</option>
              {d.people.map((p) => <option key={p.id || '-'} value={p.id || '-'}>{p.name || t('issues.noOwner')}</option>)}
            </select>
            <select className="select" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">{t('issues.allTables')}</option>
              {sources.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
            </select>
            <select className="select" value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="">{t('issues.allLevels')}</option>
              {(['error', 'verify', 'style'] as const).map((l) => <option key={l} value={l}>{t(`issues.level.${l}`)}</option>)}
            </select>
          </div>

          {tab !== 'exceptions' && d.people.length > 0 && (
            <div className="card pad" style={{ marginTop: 12 }}>
              <div className="section-title" style={{ marginBottom: 10 }}>{t('issues.byOwner')}</div>
              <div className="issue-people">
                {people.map((p) => (
                  <button key={p.id || '-'} className={`issue-person ${owner === (p.id || '-') ? 'on' : ''}`} onClick={() => { setOwner(owner === (p.id || '-') ? '' : p.id || '-'); setTab('all'); }} type="button">
                    <Avatar person={p.id ? p : { name: '?', avatar: null }} />
                    <span className="grow">
                      <span className="row"><span className="grow ellipsis">{p.name || t('issues.noOwner')}</span><b>{p.count}</b></span>
                      <span className="issue-bar"><span style={{ width: `${(p.count / d.people[0].count) * 100}%` }} /></span>
                      <span className="small muted">{t('issues.ofWhichErrors', { n: p.errors })}</span>
                    </span>
                  </button>
                ))}
              </div>
              {d.people.length > 9 && <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => setAllPeople(!allPeople)} type="button">{t(allPeople ? 'issues.fewerPeople' : 'issues.allPeople', { n: d.people.length })}</button>}
            </div>
          )}

          <div className="card issue-list" style={{ marginTop: 12 }}>
            {filtered.length === 0
              ? <Empty title={t(tab === 'mine' ? 'issues.mineEmpty' : tab === 'exceptions' ? 'issues.exceptionsEmpty' : 'issues.allEmpty')} hint={d.lastRun ? t('issues.checkedAgo', { ago: ago(d.lastRun.at) }) : undefined} />
              : filtered.map(({ c, rows }) => <CheckBlock key={c.id} c={c} rows={rows} onChanged={() => { setFresh(null); reload(); }} />)}
          </div>
        </>
      )}
    </>
  );
}
