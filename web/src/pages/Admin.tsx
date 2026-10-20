import { useState } from 'react';
import { Link } from 'react-router';
import { api, type AppInfo, type LarkLink } from '../api';
import { useI18n } from '../i18n';
import { AppIcon, Avatar, Icon, Loading, useAction, useApi, useMe, useToast } from '../ui';

interface AdminData {
  pending: AppInfo[];
  users: { id: string; name: string; email: string | null; avatar: string | null; role: 'admin' | 'member'; last_seen_at: number | null }[];
  larkLinks: LarkLink[];
  devLogin: boolean;
  alertNotify: 'admins' | 'everyone';
  okrOwner: string | null;
}

function LinkForm({ onAdded }: { onAdded: () => void }) {
  const { t } = useI18n();
  const empty = { name: '', description: '', url: '', icon: '' };
  const [f, setF] = useState(empty);
  const { busy, run } = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="row" style={{ flexWrap: 'wrap', marginTop: 12 }}>
      <input className="input" style={{ width: 70 }} placeholder={t('admin.iconPlaceholder')} value={f.icon} onChange={set('icon')} title={t('admin.iconTitle')} />
      <input className="input" style={{ width: 140 }} placeholder={t('admin.namePlaceholder')} value={f.name} onChange={set('name')} />
      <input className="input" style={{ width: 160 }} placeholder={t('admin.descPlaceholder')} value={f.description} onChange={set('description')} />
      <input className="input grow" style={{ minWidth: 200 }} placeholder={t('admin.urlPlaceholder')} value={f.url} onChange={set('url')} />
      <button className="btn" disabled={busy || !f.name || !f.url} type="button"
        onClick={() => run(() => api.post('/lark-links', f), t('admin.addedToast')).then((ok) => ok && (setF(empty), onAdded()))}>
        <Icon name="plus" /> {t('admin.add')}
      </button>
    </div>
  );
}

export function AdminPage() {
  const me = useMe();
  const { t, ago } = useI18n();
  const { data, error, reload } = useApi<AdminData>(me.user.role === 'admin' ? '/admin' : null);
  const { busy, run } = useAction();
  const toast = useToast();
  if (me.user.role !== 'admin') return <div className="empty"><b>{t('admin.onlyAdmins')}</b></div>;
  if (!data) return <Loading error={error} />;
  const sync = () => run(async () => {
    const r = await api.post<{ synced: number }>('/admin/sync-directory');
    toast(t('admin.syncedToast', { n: r.synced }));
  }).then(reload);
  return (
    <>
      <div className="page-head"><div><h1>{t('admin.title')}</h1><p>{t('admin.subtitle')}</p></div></div>

      <div className="section-title">{t('admin.pending')} <span className="count">{data.pending.length}</span></div>
      <div className="card">
        {data.pending.length === 0 ? <div className="empty small">{t('admin.noPending')}</div> : (
          <table className="table"><tbody>
            {data.pending.map((a) => (
              <tr key={a.slug}>
                <td><Link to={`/apps/${a.slug}`} className="row"><AppIcon src={a.icon} name={a.name} size="sm" /><div><div>{a.name}</div><div className="small muted">{a.host}</div></div></Link></td>
                <td className="small hide-sm">{a.description}</td>
                <td><span className="row small"><Avatar person={a.owner} /> {a.owner?.name}</span></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn sm" disabled={busy} onClick={() => run(() => api.post(`/admin/apps/${a.slug}/public`, { approve: false }), t('admin.rejectedToast')).then(reload)} type="button">{t('admin.reject')}</button>{' '}
                  <button className="btn sm primary" disabled={busy} onClick={() => run(() => api.post(`/admin/apps/${a.slug}/public`, { approve: true }), t('admin.approvedToast')).then(reload)} type="button">{t('admin.approve')}</button>
                </td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>

      {me.hub.features.lark && (
        <div className="section">
          <div className="section-title">{t('admin.okrOwner')}</div>
          <div className="card pad">
            <p className="small muted" style={{ marginTop: 0 }}>{t('admin.okrOwnerHint')}</p>
            <select className="select" value={data.okrOwner ?? ''} disabled={busy} style={{ maxWidth: 320 }}
              onChange={(e) => run(() => api.post('/admin/okr-owner', { owner: e.target.value || null }), t('admin.alertsSaved')).then(reload)}>
              <option value="">{t('admin.okrOwnerAuto')}</option>
              {data.users.map((u) => <option key={u.id} value={u.id}>{u.name}{u.email ? ` · ${u.email}` : ''}</option>)}
            </select>
          </div>
        </div>
      )}

      {me.hub.features.messages && (
        <div className="section">
          <div className="section-title">{t('admin.alerts')}</div>
          <div className="card pad">
            <p className="small muted" style={{ marginTop: 0 }}>{t('admin.alertsHint')}</p>
            <div className="stack" style={{ gap: 8 }}>
              {(['admins', 'everyone'] as const).map((mode) => (
                <label key={mode} className={`option ${data.alertNotify === mode ? 'selected' : ''}`}>
                  <input type="radio" name="alert-notify" checked={data.alertNotify === mode} disabled={busy}
                    onChange={() => run(() => api.post('/admin/alerts', { notify: mode }), t('admin.alertsSaved')).then(reload)} />
                  <span><b>{t(`admin.alerts.${mode}`)}</b><br /><span className="small muted">{t(`admin.alerts.${mode}Hint`)}</span></span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {me.hub.features.lark && (
        <div className="section">
          <div className="section-title">{t('admin.larkLinks')} <span className="count">{t('admin.larkLinksHint')}</span></div>
          <div className="card pad">
            {data.larkLinks.length === 0 && <p className="small muted" style={{ margin: 0 }}>{t('admin.larkLinksEmpty')}</p>}
            <div className="stack" style={{ gap: 6 }}>
              {data.larkLinks.map((l) => (
                <div key={l.id} className="row">
                  <span style={{ width: 28, textAlign: 'center' }}>{/^https?:/.test(l.icon) ? <img src={l.icon} width={20} alt="" /> : l.icon || '🔗'}</span>
                  <span style={{ fontWeight: 500 }}>{l.name}</span>
                  <span className="small muted grow ellipsis">{l.url}</span>
                  <label className="row small" style={{ gap: 4, whiteSpace: 'nowrap' }}>
                    <input type="checkbox" checked={!!l.in_sidebar} disabled={busy}
                      onChange={(e) => run(() => api.post(`/lark-links/${l.id}/sidebar`, { on: e.target.checked }), t('admin.sidebarSaved')).then(reload)} />
                    {t('admin.inSidebar')}
                  </label>
                  <button className="btn sm ghost danger" onClick={() => run(() => api.del(`/lark-links/${l.id}`)).then(reload)} type="button">{t('common.delete')}</button>
                </div>
              ))}
            </div>
            <LinkForm onAdded={reload} />
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-title">{t('admin.members')} <span className="count">{t('admin.memberCount', { n: data.users.length })}</span><span className="spacer" />
          {!data.devLogin && me.hub.features.lark && <button className="btn sm" disabled={busy} onClick={sync} type="button"><Icon name="refresh" /> {t('admin.sync')}</button>}
        </div>
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>{t('admin.col.member')}</th><th className="hide-sm">{t('admin.col.email')}</th><th>{t('admin.col.lastSeen')}</th><th>{t('admin.col.role')}</th></tr></thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td><span className="row"><Avatar person={u} /> {u.name}</span></td>
                  <td className="small muted hide-sm">{u.email}</td>
                  <td className="small muted">{u.last_seen_at ? ago(u.last_seen_at) : t('admin.neverSignedIn')}</td>
                  <td>
                    {u.id === me.user.id ? <span className="badge dark">{t('admin.youAdmin')}</span> : (
                      <select className="select" style={{ width: 120, height: 30 }} value={u.role}
                        onChange={(e) => run(() => api.post(`/admin/users/${u.id}/role`, { role: e.target.value }), t('admin.roleChangedToast')).then(reload)}>
                        <option value="member">{t('admin.role.member')}</option>
                        <option value="admin">{t('admin.role.admin')}</option>
                      </select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
