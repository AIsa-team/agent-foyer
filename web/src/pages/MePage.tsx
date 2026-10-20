import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, type Agent, type AppInfo, type SkillInfo } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { connectPrompt, publishPrompt } from '../prompts';
import { AppIcon, Avatar, CopyBox, CopyButton, Dialog, Loading, Step, useAction, useApi, useMe } from '../ui';

interface Profile { apps: AppInfo[]; skills: SkillInfo[]; installedSkills: number; agents: Agent[]; radar: { axes: Axis[]; people: number } }
interface LarkStatus { connected: boolean; expired?: boolean; until?: number; connectUrl: string; available: boolean }

/** The person's own Lark data connection: home charts, alerts and agents read Base tables with it. */
function LarkDataCard() {
  const { t } = useI18n();
  const { data, reload } = useApi<LarkStatus>('/lark/status');
  const { busy, run } = useAction();
  if (!data?.available) return null;
  const disconnect = () => {
    if (confirm(t('me.lark.disconnectConfirm'))) run(() => api.post('/lark/disconnect'), t('me.lark.disconnected')).then(reload);
  };
  return (
    <div className="card pad" style={{ marginTop: 12 }}>
      <div className="section-title" style={{ marginBottom: 8 }}>
        {t('me.lark.title')}
        {data.connected && <span className="badge ok" style={{ marginLeft: 8 }}>{t('me.connected')}</span>}
        <span className="spacer" />
        {data.connected
          ? <button className="btn sm ghost danger" disabled={busy} onClick={disconnect} type="button">{t('me.lark.disconnect')}</button>
          : <a className="btn sm primary" href={data.connectUrl}>{t('me.lark.connect')}</a>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>{t(data.connected ? 'me.lark.connectedBody' : data.expired ? 'me.lark.expiredBody' : 'me.lark.body')}</p>
    </div>
  );
}

/** The person's own Google connection: apps save email drafts in their Gmail with it (only drafts, never sent). */
function GoogleCard() {
  const { t } = useI18n();
  const { data, reload } = useApi<{ connected: boolean; email?: string | null; available: boolean; connectUrl: string }>('/google/status');
  const { busy, run } = useAction();
  if (!data?.available) return null;
  const disconnect = () => {
    if (confirm(t('me.google.disconnectConfirm'))) run(() => api.post('/google/disconnect'), t('me.google.disconnected')).then(reload);
  };
  return (
    <div className="card pad" style={{ marginTop: 12 }}>
      <div className="section-title" style={{ marginBottom: 8 }}>
        {t('me.google.title')}
        {data.connected && <span className="badge ok" style={{ marginLeft: 8 }}>{t('me.connected')}</span>}
        {data.connected && data.email && <span className="small muted" style={{ marginLeft: 8, fontWeight: 400 }}>{data.email}</span>}
        <span className="spacer" />
        {data.connected
          ? <button className="btn sm ghost danger" disabled={busy} onClick={disconnect} type="button">{t('me.google.disconnect')}</button>
          : <a className="btn sm" href={data.connectUrl}>{t('me.google.connect')}</a>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>{t(data.connected ? 'me.google.connectedBody' : 'me.google.body')}</p>
    </div>
  );
}

/** Which GitHub account is this person's, so agents can read their commits and pull requests (e.g. for the daily report). */
function GitHubCard() {
  const { t } = useI18n();
  const { data, reload } = useApi<{ available: boolean; org: string; login: string | null; connectUrl: string }>('/github/status');
  const { busy, run } = useAction();
  if (!data?.available) return null;
  return (
    <div className="card pad" style={{ marginTop: 12 }}>
      <div className="section-title" style={{ marginBottom: 8 }}>
        GitHub
        {data.login && <span className="badge ok" style={{ marginLeft: 8 }}>{t('me.connected')}</span>}
        {data.login && <span className="small muted mono" style={{ marginLeft: 8, fontWeight: 400 }}>@{data.login}</span>}
        <span className="spacer" />
        {data.login
          ? <button className="btn sm ghost danger" disabled={busy} onClick={() => run(() => api.post('/github/disconnect'), t('me.github.disconnected')).then(reload)} type="button">{t('me.github.disconnect')}</button>
          : <a className="btn sm" href={data.connectUrl}>{t('me.github.connect')}</a>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>{t(data.login ? 'me.github.connectedBody' : 'me.github.body', { org: data.org })}</p>
    </div>
  );
}

function TokenDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const me = useMe();
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const { busy, run } = useAction();
  const create = () => run(async () => {
    const r = await api.post<{ token: string }>('/tokens', { name: name.trim() || t('pat.defaultName') });
    setToken(r.token);
    onCreated();
  });
  return (
    <Dialog title={t('pat.title')} subtitle={t('pat.subtitle')} onClose={onClose} width={520}>
      {!token ? (
        <>
          <div className="field"><span className="label">{t('pat.nameLabel')}</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
          <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy} onClick={create} type="button">{t('pat.create')}</button></div>
        </>
      ) : (
        <div className="stack">
          <p className="small" style={{ margin: 0, color: 'var(--warn)' }}>{t('pat.onceWarning')}</p>
          <CopyBox text={token} />
          <p className="small muted" style={{ margin: 0 }}>{t('pat.howto', { url: me.hub.mcpUrl })}</p>
        </div>
      )}
    </Dialog>
  );
}

interface Axis { key: string; value: number; max: number; top: number; median: number }

/** Rough width of 10px legend text (CJK characters are about twice as wide as Latin ones). */
const textWidth = (s: string) => [...s].reduce((w, ch) => w + (ch.codePointAt(0)! > 0x2e80 ? 10 : 6.4), 0);

/**
 * How far the person has come with the hub, on six axes. Full scale is a goal, or the colleague with the most once
 * someone passes it (connections: all there are). The shape starts from a small core so an empty axis still reads as a
 * point on its spoke; the median of everyone who signed in is shown once there are enough people for it to mean much.
 */
function Radar({ axes, people }: { axes: Axis[]; people: number }) {
  const { t } = useI18n();
  if (axes.length < 3) return null;
  const size = 240;
  // a little left of centre, so labels on the right stay inside the page
  const cx = 108;
  const cy = 120;
  const R = 62;
  const CORE = 0.14;
  const radius = (ratio: number) => R * (CORE + (1 - CORE) * Math.min(1, Math.max(0, ratio)));
  const at = (i: number, r: number) => {
    const a = -Math.PI / 2 + (i / axes.length) * Math.PI * 2;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), cos: Math.cos(a), sin: Math.sin(a) };
  };
  const ratio = (v: number, max: number) => (max > 0 ? v / max : 0);
  const shape = (pick: (x: Axis) => number) => axes.map((x, i) => at(i, radius(ratio(pick(x), x.max)))).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const name = (key: string) => t(`me.radar.${key}` as MessageKey);
  const showMedian = people >= 3;
  return (
    <svg className="me-radar" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={t('me.radar.aria', { list: axes.map((x) => `${name(x.key)} ${x.value}`).join(' · ') })}>
      {[0.25, 0.5, 0.75, 1].map((g) => <circle key={g} cx={cx} cy={cy} r={radius(g)} className={`me-radar__ring${g === 1 ? ' outer' : ''}`} />)}
      {axes.map((_, i) => { const a = at(i, radius(0)); const b = at(i, R); return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="me-radar__spoke" />; })}
      {showMedian && <polygon points={shape((x) => x.median)} className="me-radar__median" />}
      <polygon points={shape((x) => x.value)} className="me-radar__me" />
      {axes.map((x, i) => {
        const p = at(i, radius(ratio(x.value, x.max)));
        const l = at(i, R + 12);
        const anchor = l.cos > 0.3 ? 'start' : l.cos < -0.3 ? 'end' : 'middle';
        // the value over the name, pushed outwards so the block clears the outer ring
        const mid = l.y + l.sin * 8;
        return (
          <g key={x.key}>
            <circle cx={p.x} cy={p.y} r={2.6} className="me-radar__dot" />
            <g className="me-radar__hit">
              <title>{t(`me.radar.${x.key}.tip` as MessageKey, { value: x.value, max: x.max, top: x.top, median: Math.round(x.median * 10) / 10 })}</title>
              <rect x={l.x - (anchor === 'end' ? 64 : anchor === 'middle' ? 32 : 0)} y={mid - 14} width={64} height={28} />
              <text x={l.x} y={mid - 1} textAnchor={anchor} className="me-radar__value">{x.value}</text>
              <text x={l.x} y={mid + 11} textAnchor={anchor} className="me-radar__label">{name(x.key)}</text>
            </g>
          </g>
        );
      })}
      {showMedian && (
        <g className="me-radar__legend" transform={`translate(${size}, 26)`}>
          <text x={0} y={0} textAnchor="end">{t('me.radar.median')}</text>
          <line x1={-textWidth(t('me.radar.median')) - 16} y1={-3} x2={-textWidth(t('me.radar.median')) - 4} y2={-3} className="me-radar__median" />
        </g>
      )}
    </svg>
  );
}

export function MePage() {
  const me = useMe();
  const { t, ago, fmtDate } = useI18n();
  const nav = useNavigate();
  const { data, error, reload } = useApi<Profile>('/profile');
  const [tokenOpen, setTokenOpen] = useState(false);
  const { run } = useAction();
  if (!data) return <Loading error={error} />;
  const disconnect = (a: Agent) => {
    if (confirm(t('me.disconnectConfirm', { name: a.name }))) run(() => api.del(`/agents/${encodeURIComponent(a.id)}`), t('me.disconnected')).then(reload);
  };
  const publish = publishPrompt(me, t);
  return (
    <>
      <div className="hero me-hero" style={{ paddingTop: 8 }}>
        <Radar axes={data.radar.axes} people={data.radar.people} />
        <span className="muted small">{me.user.role === 'admin' ? t('nav.roleAdmin') : me.user.email}</span>
        <div className="row" style={{ gap: 14, marginTop: 6 }}>
          <Avatar person={me.user} size="lg" />
          <h1 style={{ marginTop: 0 }}>{me.user.name}</h1>
        </div>
        <div className="stats">
          <div><b>{data.apps.length}</b><span>{t('me.statApps')}</span></div>
          <div><b>{data.skills.length}</b><span>{t('me.statSkills')}</span></div>
          <div><b>{data.installedSkills}</b><span>{t('me.statInstalled')}</span></div>
        </div>
      </div>

      <div className="card pad">
        <div className="section-title" style={{ marginBottom: 16 }}>{t('me.agents')}<span className="spacer" /><button className="btn sm ghost" onClick={() => setTokenOpen(true)} type="button">{t('me.usePat')}</button></div>
        <div className="steps horizontal">
          <Step n={1} title={t('me.step1.title')}><p>{t('me.step1.body')}</p></Step>
          <Step n={2} title={t('me.step2.title')}>
            <p>{t('me.step2.body')}</p>
            <CopyBox text={connectPrompt(me, t)} collapsible />
          </Step>
          <Step n={3} title={t('me.step3.title', { login: me.hub.login })}><p>{t('me.step3.body')}</p></Step>
        </div>
      </div>
      {me.hub.features.lark && <LarkDataCard />}
      {me.hub.mailbox === 'Gmail' && <GoogleCard />}
      <GitHubCard />
      {data.agents.length > 0 && (
        <div className="grid" style={{ marginTop: 12 }}>
          {data.agents.map((a) => (
            <div key={a.id} className="card app-card" style={{ minHeight: 0 }}>
              <div className="head">
                <AppIcon src={null} name={a.name} size="sm" />
                <div className="grow"><div className="title">{a.name}</div><span className="small muted">{t('common.usedAgo', { ago: ago(a.lastUsedAt) })}</span></div>
              </div>
              <div className="foot">
                <span className="row"><span className="badge ok">{t('me.connected')}</span> {t('me.connectedOn', { date: fmtDate(a.connectedAt) })}</span>
                <button className="btn sm ghost danger" onClick={() => disconnect(a)} type="button">{t('me.disconnect')}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="section">
        <div className="section-title">{t('me.myApps')} <span className="count">{t('common.count', { n: data.apps.length })}</span></div>
        <div className="card table-wrap">
          <table className="table">
            <tbody>
              {data.apps.map((a) => (
                <tr key={a.slug} className="link" onClick={() => nav(`/apps/${a.slug}`)}>
                  <td><div className="row"><AppIcon src={a.icon} name={a.name} size="sm" /><div><div>{a.name}</div><div className="small muted">{a.host}</div></div></div></td>
                  <td className="small muted hide-sm">{t(`kind.${a.kind}` as MessageKey)}</td>
                  <td><span className="badge">{t(`visibility.${a.visibility}` as MessageKey)}</span></td>
                  <td><span className={`badge ${a.status === 'online' ? 'ok' : a.status === 'failed' ? 'danger' : 'warn'}`}>{t(`status.${a.status}` as MessageKey)}</span></td>
                  <td className="small muted hide-sm">{t('common.updatedAgo', { ago: ago(a.updatedAt) })}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={5}>
                  <div className="row small muted">
                    <span className="grow">{t('me.publishNew', { prompt: publish })}</span>
                    <CopyButton text={publish} />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="section">
        <div className="section-title">{t('me.mySkills')} <span className="count">{t('common.count', { n: data.skills.length })}</span></div>
        {data.skills.length ? (
          <div className="card table-wrap">
            <table className="table">
              <tbody>
                {data.skills.map((s) => (
                  <tr key={s.slug} className="link" onClick={() => nav(`/skills/${s.slug}`)}>
                    <td><div>{s.name}</div><div className="small muted mono">{s.slug}</div></td>
                    <td><span className="badge">v{s.version}</span></td>
                    <td className="small muted hide-sm">{t('skills.installs', { n: s.installs })}</td>
                    <td className="small muted">{s.listed ? '' : t('skills.hidden')}</td>
                    <td className="small muted hide-sm">{t('common.updatedAgo', { ago: ago(s.updatedAt) })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="card"><div className="empty small">{t('me.noSkills')}</div></div>}
      </div>
      {tokenOpen && <TokenDialog onClose={() => setTokenOpen(false)} onCreated={reload} />}
    </>
  );
}
