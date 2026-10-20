import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, type Agent, type AppInfo, type SkillInfo } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { connectPrompt, publishPrompt } from '../prompts';
import { AppIcon, Avatar, CopyBox, CopyButton, Dialog, Loading, Step, useAction, useApi, useMe } from '../ui';

interface Profile { apps: AppInfo[]; skills: SkillInfo[]; installedSkills: number; agents: Agent[] }
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

/**
 * The person at the centre, their agents on the inner ring, apps on the middle one and Skills on the outer one.
 * Agents are named; apps and Skills are dots with their name on hover.
 */
function Orbit({ agents, apps, skills }: { agents: string[]; apps: string[]; skills: string[] }) {
  const { t } = useI18n();
  const size = 240;
  const c = size / 2;
  const rings = [
    { r: 38, items: agents, label: t('me.orbit.agents', { n: agents.length }), named: true },
    { r: 70, items: apps, label: t('me.orbit.apps', { n: apps.length }), named: false },
    { r: 102, items: skills, label: t('me.orbit.skills', { n: skills.length }), named: false },
  ];
  // spread items over the ring, leaving the upper-left quarter (where the ring labels are) free
  const at = (r: number, i: number, n: number, offset: number) => {
    const a = -Math.PI / 3 + offset + ((i + 0.5) / Math.max(n, 1)) * (Math.PI * 1.4);
    return { x: c + r * Math.cos(a), y: c + r * Math.sin(a), a };
  };
  return (
    <svg className="me-orbit" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={rings.map((g) => g.label).join(' · ')}>
      {rings.map((g, gi) => (
        <g key={gi}>
          <circle cx={c} cy={c} r={g.r} className={`me-orbit__ring ${gi ? 'dashed' : ''}`} />
          <text x={c - g.r * 0.71 - 4} y={c - g.r * 0.71 - 4} textAnchor="end" className="me-orbit__label">{g.label}</text>
          {g.items.map((name, i) => {
            const p = at(g.r, i, g.items.length, gi * 0.15);
            return (
              <g key={i}>
                {g.named && <line x1={c} y1={c} x2={p.x} y2={p.y} className="me-orbit__spoke" />}
                <rect x={p.x - 3.5} y={p.y - 3.5} width={7} height={7} className="me-orbit__dot"><title>{name}</title></rect>
                {g.named && <text x={p.x + (Math.cos(p.a) >= 0 ? 8 : -8)} y={p.y + 4} textAnchor={Math.cos(p.a) >= 0 ? 'start' : 'end'} className="me-orbit__name">{name}</text>}
              </g>
            );
          })}
        </g>
      ))}
      <circle cx={c} cy={c} r={5} className="me-orbit__me" />
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
        <Orbit agents={data.agents.map((a) => a.name)} apps={data.apps.map((a) => a.name)} skills={data.skills.map((s) => s.name)} />
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
