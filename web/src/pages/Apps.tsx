import { useState } from 'react';
import { Link } from 'react-router';
import type { Agent, AppInfo, LarkLink } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { publishPrompt } from '../prompts';
import { AgentStep, AppIcon, Avatar, CopyBox, Dialog, Icon, LinkIcon, Loading, Step, useApi, useMe } from '../ui';

export function AppCard({ app }: { app: AppInfo }) {
  const { t } = useI18n();
  const status = app.status !== 'online' ? t(`status.${app.status}` as MessageKey) : null;
  return (
    <Link to={`/apps/${app.slug}`} className="card app-card">
      <div className="head">
        <AppIcon src={app.icon} name={app.name} />
        <div className="grow">
          <div className="title ellipsis">{app.name}</div>
          {/* not an <a>: the whole card is already a link */}
          <span
            className="host" role="link" tabIndex={0}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(app.url, '_blank', 'noopener'); }}
          >
            {app.host} <Icon name="external" size={12} />
          </span>
        </div>
        {status ? <span className={`badge ${app.status === 'failed' ? 'danger' : 'warn'}`}>{status}</span> : app.isNew && <span className="badge">{t('apps.new')}</span>}
      </div>
      <div className="desc">{app.description || <span className="muted">{t('common.noDescription')}</span>}</div>
      <div className="foot">
        <span className="row"><Avatar person={app.owner} /> {app.owner?.name}</span>
        <span>
          {app.usage30 > 0 && <>{t('apps.usage30', { n: app.usage30 })} · </>}
          {t(`visibility.${app.visibility}` as MessageKey)}{app.publicStatus === 'pending' ? t('visibility.pendingSuffix') : ''}
        </span>
      </div>
    </Link>
  );
}

export function LarkTile({ link }: { link: LarkLink }) {
  return (
    <a className="card link-tile" href={link.url} target="_blank" rel="noreferrer">
      <LinkIcon icon={link.icon || '🔗'} size={28} />
      <div className="grow">
        <div className="ellipsis" style={{ fontWeight: 500 }}>{link.name}</div>
        {link.description && <div className="small muted ellipsis">{link.description}</div>}
      </div>
      <span className="muted"><Icon name="external" size={13} /></span>
    </a>
  );
}

export function PublishDialog({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const { t } = useI18n();
  const profile = useApi<{ agents: Agent[] }>('/profile');
  return (
    <Dialog title={t('publish.title')} subtitle={t('publish.subtitle', { login: me.hub.login })} onClose={onClose}>
      <div className="steps">
        <AgentStep agents={profile.data?.agents ?? null} />
        <Step n={2} title={t('publish.step2.title')}>
          <p>{t('publish.step2.intro')}</p>
          <CopyBox text={publishPrompt(me, t)} />
          <p style={{ marginTop: 10 }}>{t('publish.step2.after')}</p>
        </Step>
        <Step n={3} title={t('publish.step3.title')}>
          <p>{t('publish.step3.body', { domain: me.hub.appsDomain, login: me.hub.login })}</p>
        </Step>
      </div>
    </Dialog>
  );
}

/** 应用 | 需求, on top of both pages. */
export function AppsTabs({ active, waiting }: { active: 'apps' | 'requests'; waiting?: number }) {
  const { t } = useI18n();
  return (
    <div className="seg" style={{ marginBottom: 18 }}>
      <Link to="/apps" className={active === 'apps' ? 'on' : ''}>{t('requests.tab.apps')}</Link>
      <Link to="/requests" className={active === 'requests' ? 'on' : ''}>{t('requests.tab.requests')}{waiting ? <span className="seg__count">{waiting}</span> : null}</Link>
    </div>
  );
}

export function AppsPage() {
  const { t } = useI18n();
  const me = useMe();
  const { data, error } = useApi<{ apps: AppInfo[]; larkLinks: LarkLink[]; requestsWaiting?: number }>('/apps');
  const [q, setQ] = useState('');
  const [publishing, setPublishing] = useState(false);
  if (!data) return <Loading error={error} />;
  const match = (s: string) => s.toLowerCase().includes(q.trim().toLowerCase());
  const apps = data.apps.filter((a) => match(a.name) || match(a.description) || match(a.slug));
  const links = data.larkLinks.filter((l) => match(l.name));
  return (
    <>
      <div className="page-head">
        <h1>{t('apps.title')}</h1>
        <div className="row">
          <input className="input" style={{ width: 200 }} placeholder={t('apps.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn primary" onClick={() => setPublishing(true)} type="button">{t('apps.publish')}</button>
        </div>
      </div>
      <AppsTabs active="apps" waiting={data.requestsWaiting} />

      <div className="section-title">{t('apps.own')} <span className="count">{t('common.count', { n: apps.length })}</span></div>
      {apps.length ? (
        <div className="grid">{apps.map((a) => <AppCard key={a.slug} app={a} />)}</div>
      ) : (
        <div className="card"><div className="empty"><b>{q ? t('apps.noneFound') : t('apps.none')}</b>{!q && <span className="small">{t('apps.noneHint')}</span>}</div></div>
      )}

      {/* Lark apps the company uses, added by admins; admins see the section even before there are any */}
      {me.hub.features.lark && (links.length > 0 || (me.user.role === 'admin' && !q)) && (
        <div className="section">
          <div className="section-title">{t('apps.lark')} <span className="count">{t('common.count', { n: links.length })}</span></div>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
            {links.map((l) => <LarkTile key={l.id} link={l} />)}
            {me.user.role === 'admin' && (
              <Link to="/admin#lark-links" className="card link-tile link-tile--add">
                <Icon name="plus" size={16} />
                <div className="grow">
                  <div style={{ fontWeight: 500 }}>{t('apps.larkAdd')}</div>
                  {links.length === 0 && <div className="small muted">{t('apps.larkAddHint')}</div>}
                </div>
              </Link>
            )}
          </div>
        </div>
      )}
      {publishing && <PublishDialog onClose={() => setPublishing(false)} />}
    </>
  );
}
