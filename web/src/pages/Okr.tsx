import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '../api';
import { useI18n } from '../i18n';
import { Avatar, Empty, Icon, Loading, useMe } from '../ui';
import { ConnectLark, moodOf, needsLark, OkrModule, PaceRing } from './Home';

interface Person { id: string; name: string; avatar: string | null }
interface Node { id: string; owner: Person; content: string; progress: number; krs: number; alignsTo: string[] }
interface Board {
  period: { id: string; name: string; start: number | null; end: number | null } | null;
  periods: { id: string; name: string }[];
  elapsed: number | null;
  done: number;
  company: { owner: Person | null; objectives: string[]; named: boolean } | null;
  nodes: Node[];
  unaligned: string[];
  pace: { person: Person; objectives: number; done: number }[];
  people: { total: number; withOkrs: number; without: Person[]; hidden: Person[] };
  progress: { total: number; people: number; recent: { id: string; at: number; text: string; owner: Person; on: string }[] };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const lagging = (p: number, elapsed: number | null) => elapsed !== null && elapsed - p > 0.1;

function Card({ n, elapsed, me, onMe }: { n: Node; elapsed: number | null; me: string; onMe: (el: HTMLElement | null) => void }) {
  return (
    <div className={`okr-node ${n.owner.id === me ? 'mine' : ''}`} ref={n.owner.id === me ? onMe : undefined}>
      <div className="row" style={{ gap: 6 }}><Avatar person={n.owner} /><span className="small muted ellipsis">{n.owner.name}</span><span className="grow" /><b className={`small ${lagging(n.progress, elapsed) ? 'okr__lag' : ''}`}>{pct(n.progress)}</b></div>
      <div className="okr-node__text">{n.content}</div>
      <div className={`okr__bar ${lagging(n.progress, elapsed) ? 'is-lag' : ''}`} style={{ margin: '6px 0 0' }}><span style={{ width: pct(n.progress) }} /></div>
    </div>
  );
}

/** One objective and, to its right, everything that aligns to it. */
function Branch({ n, nodes, elapsed, me, onMe, depth }: { n: Node; nodes: Node[]; elapsed: number | null; me: string; onMe: (el: HTMLElement | null) => void; depth: number }) {
  const kids = depth < 4 ? nodes.filter((x) => x.alignsTo.includes(n.id)) : [];
  return (
    <div className="okr-branch">
      <Card n={n} elapsed={elapsed} me={me} onMe={onMe} />
      {kids.length > 0 && <div className="okr-children">{kids.map((k) => <Branch key={k.id} n={k} nodes={nodes} elapsed={elapsed} me={me} onMe={onMe} depth={depth + 1} />)}</div>}
    </div>
  );
}

export function OkrPage() {
  const me = useMe();
  const { t, ago } = useI18n();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'me' ? 'me' : 'company';
  const [data, setData] = useState<Board | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [zoom, setZoom] = useState(1);
  const [showUnaligned, setShowUnaligned] = useState(false);
  const mine = useRef<HTMLElement | null>(null);
  const period = params.get('period') ?? '';
  useEffect(() => {
    setData(null);
    api.get<Board>(`/okr/board${period ? `?period=${encodeURIComponent(period)}` : ''}`).then(setData, setErr);
  }, [period]);
  const byId = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);

  const head = (
    <div className="page-head">
      <div>
        {data?.period && <span className="small muted">{data.period.name}{data.elapsed !== null && data.elapsed >= 1 ? ` · ${t('okr.ended')}` : ''}</span>}
        <h1>OKR</h1>
        <div className="row" style={{ gap: 10, marginTop: 8 }}>
          <div className="seg">
            <button className={tab === 'company' ? 'on' : ''} onClick={() => setParams({ ...(period ? { period } : {}) })} type="button">{t('okr.tab.company')}</button>
            <button className={tab === 'me' ? 'on' : ''} onClick={() => setParams({ tab: 'me', ...(period ? { period } : {}) })} type="button">{t('okr.tab.me')}</button>
          </div>
          {data && data.periods.length > 1 && tab === 'company' && (
            <select className="select" value={data.period?.id ?? ''} onChange={(e) => setParams({ period: e.target.value })}>
              {data.periods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </div>
      </div>
      {data && data.nodes.length > 0 && (
        <div className="okr-summary">
          <PaceRing done={data.done} elapsed={data.elapsed} mood={moodOf(data.done, data.elapsed)} />
          <div>
            <div className="okr__mood">{t(data.elapsed !== null && data.elapsed >= 1 ? 'okr.closed' : 'okr.summary', { done: pct(data.done) })}</div>
            <div className="small muted">{t('okr.stats', { n: data.people.withOkrs, total: data.people.total, elapsed: data.elapsed === null ? '—' : pct(data.elapsed) })}</div>
            <div className="small muted">{t('okr.progressStats', { n: data.progress.people, total: data.people.withOkrs, updates: data.progress.total })}</div>
          </div>
        </div>
      )}
    </div>
  );

  if (tab === 'me') return <>{head}<OkrModule m={{ type: 'okr', title: { [document.documentElement.lang]: t('okr.myTitle') } }} /></>;
  if (needsLark(err)) return <>{head}<div className="card pad"><ConnectLark /></div></>;
  if (!data) return <>{head}<Loading error={err instanceof Error ? err.message : null} /></>;
  if (!data.nodes.length) return <>{head}<div className="card"><Empty title={t('okr.none')} hint={t('okr.noneHint')} /></div></>;

  const company = (data.company?.objectives ?? []).map((id) => byId.get(id)!).filter(Boolean);
  const unaligned = data.unaligned.map((id) => byId.get(id)!).filter(Boolean);
  const findMe = () => mine.current?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  return (
    <>
      {head}
      <div className="card okr-canvas-wrap">
        <div className="okr-canvas-tools">
          <button className="btn sm" onClick={findMe} type="button"><Icon name="user" /> {t('okr.findMe')}</button>
          <button className="btn sm ghost" onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))} type="button" aria-label="-">−</button>
          <span className="small muted">{Math.round(zoom * 100)}%</span>
          <button className="btn sm ghost" onClick={() => setZoom((z) => Math.min(1.5, z + 0.1))} type="button" aria-label="+">+</button>
          <button className="btn sm ghost" onClick={() => setZoom(1)} type="button">{t('okr.fit')}</button>
        </div>
        <div className="okr-canvas">
          <div className="okr-tree" style={{ zoom }}>
            <div className="okr-branch">
              <div className="okr-company">
                <b>{t('okr.company')}</b>
                <span className="small">{t('okr.companyMeta', { n: data.people.withOkrs, m: data.nodes.length })}</span>
                {data.company?.owner && <span className="small" style={{ opacity: 0.7 }}>{data.company.owner.name}</span>}
              </div>
              <div className="okr-children">
                {company.map((n) => <Branch key={n.id} n={n} nodes={data.nodes} elapsed={data.elapsed} me={me.user.id} onMe={(el) => { if (el && !mine.current) mine.current = el; }} depth={1} />)}
                {unaligned.length > 0 && (
                  <div className="okr-branch">
                    <button className="okr-unaligned" onClick={() => setShowUnaligned(!showUnaligned)} type="button">{t('okr.unaligned', { n: unaligned.length })} <Icon name="back" size={11} /></button>
                    {showUnaligned && <div className="okr-children">{unaligned.map((n) => <Branch key={n.id} n={n} nodes={data.nodes} elapsed={data.elapsed} me={me.user.id} onMe={(el) => { if (el && !mine.current) mine.current = el; }} depth={1} />)}</div>}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="card pad" style={{ marginTop: 16 }}>
        <div className="section-title" style={{ marginBottom: 4 }}>{t('okr.recent')}</div>
        {data.progress.recent.length === 0 ? <p className="small muted" style={{ margin: '6px 0 0' }}>{t('okr.recentNone')}</p> : (
          <div className="okr-feed">
            {data.progress.recent.map((r) => (
              <div key={r.id} className="okr-feed__item">
                <Avatar person={r.owner} />
                <div className="grow">
                  <div className="small"><b>{r.owner.name}</b> <span className="muted">{t('okr.recentOn', { on: r.on })} · {ago(r.at)}</span></div>
                  <p className="okr-feed__text">{r.text}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="two-col" style={{ marginTop: 16 }}>
        <div className="card pad">
          <div className="section-title" style={{ marginBottom: 10 }}>{t('okr.pace')}</div>
          <div className="stack" style={{ gap: 10 }}>
            {data.pace.map((p) => (
              <div key={p.person.id} className="okr-pace-row">
                <Avatar person={p.person} />
                <span className="ellipsis" style={{ width: 90 }}>{p.person.name}</span>
                <div className={`okr__bar grow ${lagging(p.done, data.elapsed) ? 'is-lag' : ''}`} style={{ margin: 0 }}><span style={{ width: pct(p.done) }} /></div>
                <b className={`small ${lagging(p.done, data.elapsed) ? 'okr__lag' : ''}`} style={{ width: 40, textAlign: 'right' }}>{pct(p.done)}</b>
              </div>
            ))}
          </div>
        </div>
        <div className="card pad">
          <div className="section-title" style={{ marginBottom: 10 }}>{t('okr.without', { n: data.people.without.length })}</div>
          {data.people.without.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{t('okr.everyoneHas')}</p> : (
            <div className="okr-people">{data.people.without.map((p) => <span key={p.id} className="row small" style={{ gap: 6 }}><Avatar person={p} />{p.name}</span>)}</div>
          )}
          {data.people.hidden.length > 0 && <p className="small muted" style={{ marginBottom: 0 }}>{t('okr.hidden', { n: data.people.hidden.length })}</p>}
        </div>
      </div>
    </>
  );
}
