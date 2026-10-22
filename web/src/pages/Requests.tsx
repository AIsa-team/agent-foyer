/** App requests (需求): asking a colleague to build an app, or leaving it in the pool for whoever has time. */
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, type AppInfo, type Person } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { requestAskPrompt, requestBuildPrompt } from '../prompts';
import { AppIcon, Avatar, CopyBox, Dialog, Icon, Loading, PersonPicker, useAction, useApi, useMe } from '../ui';
import { AppsTabs } from './Apps';

type Status = 'open' | 'taken' | 'done' | 'closed';
export interface AppRequest {
  id: number; title: string; body: string; due: string | null; scope: 'pool' | 'invite'; status: Status;
  requester: Person | null; invitee: Person | null; declinedBy: Person | null; builder: Person | null;
  app: { slug: string; name: string; url: string; icon: string | null } | null;
  closeReason: string | null; via: 'web' | 'agent'; agent: string | null;
  voters: (Person & { note: string | null; at: number })[]; myVote: boolean;
  createdAt: number; updatedAt: number; takenAt: number | null; doneAt: number | null;
  can: { take: boolean; decline: boolean; release: boolean; deliver: boolean; invite: boolean; toPool: boolean; edit: boolean; close: boolean; vote: boolean };
}

export function StatusBadge({ r }: { r: Pick<AppRequest, 'status' | 'scope' | 'invitee'> }) {
  const { t } = useI18n();
  const key = r.status === 'open' && r.scope === 'invite' ? (r.invitee ? 'requests.status.invited' : 'requests.status.declined') : `requests.status.${r.status}`;
  const tone = r.status === 'done' ? 'ok' : r.status === 'closed' ? '' : r.status === 'taken' ? '' : 'warn';
  return <span className={`badge ${tone}`}>{t(key as MessageKey)}</span>;
}

const FILTERS = ['open', 'taken', 'done', 'mine', 'closed'] as const;

export function RequestsPage() {
  const { t, ago } = useI18n();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('open');
  const [q, setQ] = useState('');
  // ?new=1 (from the home page) opens the form at once
  const [params, setParams] = useSearchParams();
  const [asking, setAsking] = useState(params.get('new') === '1');
  const path = filter === 'mine' ? '/requests?status=all&mine=1' : `/requests?status=${filter}`;
  const { data, error, reload } = useApi<{ requests: AppRequest[]; waiting: number }>(path);
  const needle = q.trim().toLowerCase();
  const list = (data?.requests ?? []).filter((r) => !needle || `${r.title} ${r.body}`.toLowerCase().includes(needle));
  return (
    <>
      <div className="page-head">
        <h1>{t('apps.title')}</h1>
        <div className="row">
          <input className="input" style={{ width: 200 }} placeholder={t('requests.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn primary" onClick={() => setAsking(true)} type="button"><Icon name="plus" /> {t('requests.new')}</button>
        </div>
      </div>
      <AppsTabs active="requests" waiting={data?.waiting} />
      <p className="small muted" style={{ marginTop: 0 }}>{t('requests.intro')}</p>
      <div className="seg seg--sm" style={{ margin: '4px 0 14px' }}>
        {FILTERS.map((f) => <button key={f} type="button" className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{t(`requests.filter.${f}`)}</button>)}
      </div>
      {!data ? <Loading error={error} /> : list.length ? (
        <div className="card req-list">
          {list.map((r) => (
            <Link key={r.id} to={`/requests/${r.id}`} className="req-row">
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="muted mono small">#{r.id}</span>
                  <b className="ellipsis">{r.title}</b>
                </div>
                <div className="small muted ellipsis req-row__body">{r.body}</div>
                <div className="row small muted req-row__meta">
                  <Avatar person={r.requester} /> {r.requester?.name} · {ago(r.createdAt)}
                  {r.due && <> · {t('requests.due', { date: r.due })}</>}
                  {r.voters.length > 0 && <> · {t('requests.alsoNeed', { n: r.voters.length })}</>}
                  {r.builder && r.status !== 'open' && <> · {t('requests.builtBy', { name: r.builder.name })}</>}
                  {r.scope === 'invite' && r.invitee && r.status === 'open' && <> · {t('requests.invitedWho', { name: r.invitee.name })}</>}
                </div>
              </div>
              <StatusBadge r={r} />
            </Link>
          ))}
        </div>
      ) : (
        <div className="card"><div className="empty"><b>{t(q ? 'requests.noneFound' : `requests.none.${filter}`)}</b>{!q && filter === 'open' && <span className="small">{t('requests.noneHint')}</span>}</div></div>
      )}
      {asking && <NewRequestDialog onClose={() => { setAsking(false); if (params.has('new')) setParams({}, { replace: true }); }} onDone={reload} />}
    </>
  );
}

function NewRequestDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const me = useMe();
  const nav = useNavigate();
  const { busy, run } = useAction();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [due, setDue] = useState('');
  const [to, setTo] = useState<'pool' | 'invite'>('pool');
  const [who, setWho] = useState<Person[]>([]);
  const ready = title.trim().length >= 2 && body.trim().length >= 10 && (to === 'pool' || who.length === 1);
  const submit = () => run(async () => {
    const r = await api.post<AppRequest>('/requests', { title, body, due: due || null, invite: to === 'invite' ? who[0]?.id : null });
    onDone();
    onClose();
    nav(`/requests/${r.id}`);
  }, t(to === 'pool' ? 'requests.sentPool' : 'requests.sentInvite'));
  return (
    <Dialog title={t('requests.new')} subtitle={t('requests.newHint')} onClose={onClose} width={620}>
      <div className="stack req-form" style={{ gap: 12 }}>
        <label className="field">
          <span className="label">{t('requests.f.title')}</span>
          <input className="input" value={title} maxLength={80} placeholder={t('requests.f.titlePh')} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">{t('requests.f.body')}</span>
          <textarea className="input textarea" rows={7} value={body} maxLength={4000} placeholder={t('requests.f.bodyPh')} onChange={(e) => setBody(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">{t('requests.f.due')} <span className="muted">{t('requests.f.optional')}</span></span>
          <input className="input" type="date" value={due} style={{ maxWidth: 200 }} onChange={(e) => setDue(e.target.value)} />
        </label>
        <div className="field">
          <span className="label">{t('requests.f.to')}</span>
          <div className="seg seg--sm" style={{ alignSelf: 'flex-start' }}>
            <button type="button" className={to === 'pool' ? 'on' : ''} onClick={() => setTo('pool')}>{t('requests.to.pool')}</button>
            <button type="button" className={to === 'invite' ? 'on' : ''} onClick={() => setTo('invite')}>{t('requests.to.invite')}</button>
          </div>
          <span className="small muted">{t(to === 'pool' ? 'requests.to.poolHint' : 'requests.to.inviteHint')}</span>
          {to === 'invite' && (who.length
            ? <div className="row" style={{ gap: 8 }}><span className="chip"><Avatar person={who[0]} /> {who[0].name}<button type="button" onClick={() => setWho([])} aria-label={t('common.close')}>×</button></span></div>
            : <PersonPicker value={who} onChange={(v) => setWho(v.slice(-1))} exclude={[me.user.id]} />)}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" type="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn primary" type="button" disabled={busy || !ready} onClick={submit}>{t(to === 'pool' ? 'requests.submitPool' : 'requests.submitInvite')}</button>
        </div>
        <div className="small muted">{t('requests.viaAgent')}</div>
        <CopyBox text={requestAskPrompt(me, t)} />
      </div>
    </Dialog>
  );
}

export function RequestDetailPage() {
  const { t, ago, fmtDate } = useI18n();
  const me = useMe();
  const { id } = useParams();
  const { data: r, error, reload } = useApi<AppRequest>(`/requests/${id}`);
  const mine = useApi<{ apps: AppInfo[] }>('/apps');
  const { busy, run } = useAction();
  const [invite, setInvite] = useState<Person[]>([]);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [app, setApp] = useState('');
  if (!r) return <Loading error={error} />;
  const act = (body: Record<string, unknown>, done?: string) => run(() => api.post(`/requests/${r.id}`, body), done ?? t('requests.updated')).then(reload);
  const withReason = (action: string, key: MessageKey) => {
    const reason = prompt(t(key));
    if (reason === null) return;
    void act({ action, reason });
  };
  const myApps = (mine.data?.apps ?? []).filter((a) => a.myRole);
  const building = r.status === 'taken' && r.builder?.id === me.user.id;
  const people: [MessageKey, Person | null][] = [
    ['requests.p.requester', r.requester],
    ...(r.scope === 'invite' && r.invitee ? [['requests.p.invitee', r.invitee] as [MessageKey, Person]] : []),
    ...(r.builder ? [['requests.p.builder', r.builder] as [MessageKey, Person]] : []),
  ];
  return (
    <>
      <Link to="/requests" className="row small muted" style={{ marginBottom: 12 }}><Icon name="back" size={12} /> {t('requests.tab.requests')}</Link>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <h1><span className="muted" style={{ marginRight: '0.3em' }}>#{r.id}</span>{r.title}</h1>
          <div className="row small muted" style={{ marginTop: 4, flexWrap: 'wrap' }}>
            <StatusBadge r={r} />
            <span className="row"><Avatar person={r.requester} /> {r.requester?.name}</span>
            <span>{ago(r.createdAt)}{r.via === 'agent' && <> · {t('requests.viaAgentBy', { agent: r.agent ?? 'Agent' })}</>}</span>
            {r.due && <span>{t('requests.due', { date: r.due })}</span>}
            <span>{t(r.scope === 'pool' ? 'requests.scope.pool' : 'requests.scope.invite')}</span>
          </div>
        </div>
      </div>
      <div className="two-col">
        <div className="stack">
          <div className="card pad">
            {editing ? <EditForm r={r} onDone={() => { setEditing(false); reload(); }} /> : <p className="req-body">{r.body}</p>}
            {r.can.edit && !editing && <button className="btn sm ghost" type="button" onClick={() => setEditing(true)}>{t('requests.edit')}</button>}
          </div>
          {(r.voters.length > 0 || r.can.vote) && <div className="card pad">
            <h3>{t('requests.voters', { n: r.voters.length })}</h3>
            <p className="small muted" style={{ marginTop: 0 }}>{t('requests.votersHint')}</p>
            {r.voters.map((v) => (
              <div key={v.id} className="feedback-item">
                <div className="row small"><Avatar person={v} /> <b>{v.name}</b> <span className="muted">{ago(v.at)}</span></div>
                {v.note && <p className="feedback-body">{v.note}</p>}
              </div>
            ))}
            {r.can.vote && (r.myVote
              ? <button className="btn sm ghost" type="button" disabled={busy} onClick={() => act({ action: 'not_me' })}>{t('requests.notMe')}</button>
              : (
                <div className="stack" style={{ gap: 8 }}>
                  <input className="input" value={note} maxLength={300} placeholder={t('requests.notePh')} onChange={(e) => setNote(e.target.value)} />
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn sm" type="button" disabled={busy} onClick={() => act({ action: 'me_too', note }).then(() => setNote(''))}>{t('requests.meToo')}</button>
                  </div>
                </div>
              ))}
          </div>}
        </div>
        <div className="stack">
          <div className="card pad">
            <h3>{t('requests.progress')}</h3>
            <div className="stack" style={{ gap: 8 }}>
              {people.map(([k, p]) => p && <div key={k} className="row small"><span className="muted req-label">{t(k)}</span><Avatar person={p} /> {p.name}</div>)}
              {r.declinedBy && r.status === 'open' && <div className="small muted">{t('requests.declinedBy', { name: r.declinedBy.name })}</div>}
              {r.takenAt && <div className="row small"><span className="muted req-label">{t('requests.p.taken')}</span>{fmtDate(r.takenAt)}</div>}
              {r.app && (
                <a className="row small" href={r.app.url} target="_blank" rel="noreferrer">
                  <span className="muted req-label">{t('requests.p.app')}</span><AppIcon src={r.app.icon} name={r.app.name} size="sm" /> {r.app.name} <Icon name="external" size={12} />
                </a>
              )}
              {r.status === 'closed' && <div className="small muted">{t('requests.closedWhy', { reason: r.closeReason || '-' })}</div>}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              {r.can.take && <button className="btn primary sm" type="button" disabled={busy} onClick={() => act({ action: 'take' }, t('requests.taken'))}>{t('requests.take')}</button>}
              {r.can.decline && <button className="btn sm" type="button" disabled={busy} onClick={() => withReason('decline', 'requests.reasonDecline')}>{t('requests.decline')}</button>}
              {r.can.release && <button className="btn sm ghost" type="button" disabled={busy} onClick={() => withReason('release', 'requests.reasonRelease')}>{t('requests.release')}</button>}
              {r.can.toPool && <button className="btn sm" type="button" disabled={busy} onClick={() => act({ action: 'to_pool' })}>{t('requests.toPool')}</button>}
              {r.can.close && <button className="btn sm ghost danger" type="button" disabled={busy} onClick={() => withReason('close', 'requests.reasonClose')}>{t('requests.close')}</button>}
            </div>
            {r.can.invite && (
              <div className="stack" style={{ gap: 8, marginTop: 14 }}>
                <span className="small muted">{t(r.scope === 'invite' && r.invitee ? 'requests.reinvite' : 'requests.inviteSomeone')}</span>
                <PersonPicker value={invite} onChange={(v) => setInvite(v.slice(-1))} exclude={[me.user.id, r.invitee?.id]} />
                {invite.length > 0 && <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn sm" type="button" disabled={busy} onClick={() => act({ action: 'invite', user: invite[0].id }, t('requests.sentInvite')).then(() => setInvite([]))}>{t('requests.inviteSend', { name: invite[0].name })}</button></div>}
              </div>
            )}
          </div>
          {(building || r.can.take) && (
            <div className="card pad">
              <h3>{t('requests.buildTitle')}</h3>
              <p className="small muted" style={{ marginTop: 0 }}>{t(building ? 'requests.buildHint' : 'requests.buildHintTake')}</p>
              <CopyBox text={requestBuildPrompt(me, t, r.id, r.title)} />
            </div>
          )}
          {r.can.deliver && myApps.length > 0 && (building || r.status === 'taken') && (
            <div className="card pad">
              <h3>{t('requests.deliverTitle')}</h3>
              <p className="small muted" style={{ marginTop: 0 }}>{t('requests.deliverHint')}</p>
              <div className="row" style={{ gap: 8 }}>
                <select className="select grow" value={app} onChange={(e) => setApp(e.target.value)}>
                  <option value="">{t('requests.pickApp')}</option>
                  {myApps.map((a) => <option key={a.slug} value={a.slug}>{a.name} ({a.slug})</option>)}
                </select>
                <button className="btn sm primary" type="button" disabled={busy || !app} onClick={() => act({ action: 'deliver', app }, t('requests.delivered'))}>{t('requests.deliver')}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function EditForm({ r, onDone }: { r: AppRequest; onDone: () => void }) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const [title, setTitle] = useState(r.title);
  const [body, setBody] = useState(r.body);
  const [due, setDue] = useState(r.due ?? '');
  return (
    <div className="stack" style={{ gap: 10 }}>
      <input className="input" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
      <textarea className="input textarea" rows={8} value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} />
      <input className="input" type="date" value={due} style={{ maxWidth: 200 }} onChange={(e) => setDue(e.target.value)} />
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn sm" type="button" onClick={onDone}>{t('common.cancel')}</button>
        <button className="btn sm primary" type="button" disabled={busy} onClick={() => run(() => api.post(`/requests/${r.id}`, { action: 'edit', title, body, due: due || null }), t('requests.updated')).then((ok) => ok && onDone())}>{t('requests.save')}</button>
      </div>
    </div>
  );
}
