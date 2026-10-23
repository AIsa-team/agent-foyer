/**
 * Other services' MCP servers reached through the hub. Admins add them (address, who may use them, which tools are
 * allowed); everyone connects their own account on the Me page, and their agents use the tools through the hub.
 * A service can instead use a data connection's key (e.g. Metabase's own MCP): one company credential, nothing to connect.
 */
import { useState } from 'react';
import { api } from './api';
import { useI18n } from './i18n';
import { AppIcon, useAction, useApi } from './ui';

export interface Service {
  id: string; name: string; url: string; shared?: boolean; connected: boolean; connectUrl: string; connection?: string | null;
  audience?: { company?: boolean; departments?: string[]; people?: string[] }; disabledTools?: string[]; people?: number;
}
interface Tool { name: string; description: string; readOnly: boolean; enabled: boolean }

/** A service's mark: a known logo, or a letter tile. */
export function ServiceMark({ s }: { s: Pick<Service, 'id' | 'name'> }) {
  return s.id === 'linear' ? <span className="conn-logo"><img src="/services/linear.svg" alt="" /></span> : <AppIcon src={null} name={s.name} size="sm" />;
}

/** Admin: add, change and remove services, choose who may use them and which tools are allowed. */
export function ServicesSection() {
  const { t } = useI18n();
  const { data, reload } = useApi<{ services: Service[]; departments: { id: string; name: string }[]; connections: { id: string; type: string }[] }>('/admin/services');
  const { busy, run } = useAction();
  const empty = { id: '', name: '', url: '', connection: '' };
  const [draft, setDraft] = useState(empty);
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return null;
  const add = () => run(() => api.post('/admin/services', { ...draft, connection: draft.connection || null, create: true }), t('services.saved')).then((ok) => ok && (setDraft(empty), reload()));
  return (
    <div className="card pad">
      <p className="small muted" style={{ marginTop: 0 }}>{t('services.hint')}</p>
      {data.services.length > 0 && (
        <div className="stack" style={{ gap: 0, marginBottom: 14 }}>
          {data.services.map((s) => (
            <div key={s.id} className="svc-row">
              <div className="row" style={{ gap: 10 }}>
                <ServiceMark s={s} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div><b style={{ fontWeight: 600 }}>{s.name}</b> <span className="mono small muted">{s.id}</span></div>
                  <div className="small muted ellipsis">{s.url} · {s.shared ? t('services.sharedVia', { connection: s.connection ?? '' }) : t('services.people', { n: s.people ?? 0 })} · {audienceText(s, data.departments, t)}</div>
                </div>
                <button className="btn sm" type="button" onClick={() => setOpen(open === s.id ? null : s.id)}>{t(open === s.id ? 'services.close' : 'services.manage')}</button>
              </div>
              {open === s.id && <ServiceSettings s={s} departments={data.departments} reload={reload} />}
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input className="input" style={{ width: 120 }} placeholder={t('services.f.id')} value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
        <input className="input" style={{ width: 160 }} placeholder={t('services.f.name')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        {data.connections.length > 0 && (
          <select className="input" style={{ width: 'auto' }} value={draft.connection} onChange={(e) => setDraft({ ...draft, connection: e.target.value })} aria-label={t('services.f.access')}>
            <option value="">{t('services.access.own')}</option>
            {data.connections.map((c) => <option key={c.id} value={c.id}>{t('services.access.connection', { connection: c.id })}</option>)}
          </select>
        )}
        {!draft.connection && <input className="input grow" style={{ minWidth: 220 }} placeholder="https://mcp.linear.app/mcp" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />}
        <button className="btn primary" type="button" disabled={busy || !draft.id.trim() || (!draft.connection && !draft.url.trim())} onClick={add}>{t('services.add')}</button>
      </div>
      <p className="small muted" style={{ margin: '8px 0 0' }}>{t(draft.connection ? 'services.sharedHint' : 'services.urlHint')}</p>
    </div>
  );
}

function audienceText(s: Service, departments: { id: string; name: string }[], t: ReturnType<typeof useI18n>['t']) {
  const a = s.audience ?? {};
  if (a.company) return t('services.audience.company');
  const names = (a.departments ?? []).map((d) => departments.find((x) => x.id === d)?.name ?? d);
  return names.length ? names.join(t('common.listSeparator')) : t('services.audience.admins');
}

function ServiceSettings({ s, departments, reload }: { s: Service; departments: { id: string; name: string }[]; reload: () => void }) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const tools = useApi<{ tools: Tool[] }>(s.connected ? `/admin/services/${s.id}/tools` : null);
  const save = (patch: Partial<Pick<Service, 'audience' | 'disabledTools'>>) =>
    run(() => api.post('/admin/services', { id: s.id, name: s.name, url: s.url, audience: patch.audience ?? s.audience, disabledTools: patch.disabledTools ?? s.disabledTools }), t('services.saved')).then(() => { reload(); tools.reload(); });
  const company = !!s.audience?.company;
  const depts = s.audience?.departments ?? [];
  const toggleTool = (name: string, on: boolean) => {
    const off = new Set(s.disabledTools ?? []);
    if (on) off.delete(name); else off.add(name);
    void save({ disabledTools: [...off] });
  };
  return (
    <div className="svc-settings">
      <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>{t('services.audience')}</div>
      <label className="row small" style={{ gap: 6 }}>
        <input type="checkbox" checked={company} disabled={busy} onChange={(e) => save({ audience: e.target.checked ? { company: true } : { departments: [] } })} />
        {t('services.audience.company')}
      </label>
      {!company && departments.length > 0 && (
        <div className="row small" style={{ gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
          {departments.map((d) => (
            <label key={d.id} className="row" style={{ gap: 4 }}>
              <input type="checkbox" checked={depts.includes(d.id)} disabled={busy}
                onChange={(e) => save({ audience: { departments: e.target.checked ? [...depts, d.id] : depts.filter((x) => x !== d.id) } })} />
              {d.name}
            </label>
          ))}
        </div>
      )}
      <div className="small" style={{ fontWeight: 600, margin: '14px 0 6px' }}>{t('services.tools')}</div>
      {!s.connected ? <p className="small muted" style={{ margin: 0 }}>{t('services.toolsConnectFirst')} <a href={s.connectUrl.replace('return=%2Fme', 'return=%2Fadmin')}>{t('services.connect')}</a></p>
        : !tools.data ? <p className="small muted" style={{ margin: 0 }}>{tools.error ?? t('common.loading')}</p> : (
          <div className="svc-tools">
            {tools.data.tools.map((x) => (
              <label key={x.name} className="svc-tool">
                <input type="checkbox" checked={x.enabled} disabled={busy} onChange={(e) => toggleTool(x.name, e.target.checked)} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="mono small">{x.name}</span> {x.readOnly ? <span className="badge">{t('services.readOnly')}</span> : <span className="badge warn">{t('services.writes')}</span>}
                  <span className="small muted svc-tool__desc">{x.description}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn sm ghost danger" type="button" disabled={busy}
          onClick={() => confirm(t('services.deleteConfirm', { name: s.name })) && run(() => api.del(`/admin/services/${s.id}`), t('services.deleted')).then(reload)}>{t('services.delete')}</button>
      </div>
    </div>
  );
}
