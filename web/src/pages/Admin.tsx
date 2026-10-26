import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, type AppInfo, type LarkLink } from '../api';
import { useI18n } from '../i18n';
import { LOCALES } from '../i18n/locales';
import { ConnectionsSection } from '../connections';
import { AiSection } from '../ai';
import { ServicesSection } from '../services';
import { AppIcon, Avatar, Icon, LinkIcon, Loading, useAction, useApi, useMe, useToast } from '../ui';

interface AdminData {
  pending: AppInfo[];
  users: { id: string; name: string; email: string | null; avatar: string | null; role: 'admin' | 'member'; last_seen_at: number | null }[];
  larkLinks: LarkLink[];
  devLogin: boolean;
  alertNotify: 'admins' | 'everyone';
  dataCombine: boolean;
  okrOwner: string | null;
  requestsChat: { id: string; name: string; locale?: string } | null;
}

/** The Lark group new pool requests are posted to: picked from the groups the bot is in, or entered by id. */
function RequestsChatSection({ chat, reload }: { chat: AdminData['requestsChat']; reload: () => void }) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const [chats, setChats] = useState<{ id: string; name: string }[] | null>(null);
  const [problem, setProblem] = useState('');
  const [manual, setManual] = useState({ id: '', name: '' });
  useEffect(() => {
    api.get<{ chats: { id: string; name: string }[] }>('/admin/lark-chats').then((r) => setChats(r.chats), (e: Error) => { setChats([]); setProblem(e.message); });
  }, []);
  const save = (c: { id: string; name: string; locale?: string } | null) => run(() => api.post('/admin/requests-chat', { chat: c && { ...c, locale: c.locale ?? chat?.locale } }), t('admin.alertsSaved')).then(reload);
  return (
    <div className="section">
      <div className="section-title">{t('admin.requestsChat')}</div>
      <div className="card pad">
        <p className="small muted" style={{ marginTop: 0 }}>{t('admin.requestsChatHint')}</p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select className="select" style={{ maxWidth: 320 }} disabled={busy || chats === null} value={chat?.id ?? ''}
            onChange={(e) => save(e.target.value ? chats?.find((c) => c.id === e.target.value) ?? chat : null)}>
            <option value="">{t('admin.requestsChatNone')}</option>
            {chat && !chats?.some((c) => c.id === chat.id) && <option value={chat.id}>{chat.name}</option>}
            {(chats ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {chat && (
            <select className="select" style={{ maxWidth: 200 }} disabled={busy} value={chat.locale ?? ''} aria-label={t('admin.requestsChatLocale')}
              onChange={(e) => save({ ...chat, locale: e.target.value })}>
              {LOCALES.map((l) => <option key={l.code} value={l.code}>{t('admin.requestsChatLocaleIs', { name: l.name })}</option>)}
            </select>
          )}
        </div>
        {problem && (
          <div className="stack" style={{ gap: 8, marginTop: 12 }}>
            <p className="small muted" style={{ margin: 0 }}>{problem}</p>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input className="input" style={{ maxWidth: 220 }} placeholder="oc_…" value={manual.id} onChange={(e) => setManual({ ...manual, id: e.target.value })} />
              <input className="input" style={{ maxWidth: 200 }} placeholder={t('admin.requestsChatName')} value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} />
              <button className="btn sm" type="button" disabled={busy || !manual.id.trim()} onClick={() => save({ id: manual.id.trim(), name: manual.name.trim() || manual.id.trim() })}>{t('admin.requestsChatUse')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface CatalogItem { key: string; name: string; description: string; icon: string; url: string }
interface Catalog { builtins: CatalogItem[]; installed: CatalogItem[]; installedMissing: boolean }

/** A dropdown of Lark's own features and the company's Lark apps, with their icons and a filter box. */
function AppPicker({ groups, chosen, onPick }: {
  groups: { label: string; items: CatalogItem[] }[]; chosen: CatalogItem | 'custom' | undefined; onPick: (key: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const needle = q.trim().toLowerCase();
  const shown = groups.map((g) => ({ ...g, items: g.items.filter((x) => !needle || `${x.name} ${x.description}`.toLowerCase().includes(needle)) }))
    .filter((g) => g.items.length);
  const custom: CatalogItem = { key: 'custom', name: t('admin.linkCustom'), description: '', icon: '', url: '' };
  const flat = [...shown.flatMap((g) => g.items), custom];
  const pick = (key: string) => { onPick(key); setOpen(false); setQ(''); };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => (i + (e.key === 'ArrowDown' ? 1 : flat.length - 1)) % flat.length); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(flat[Math.min(at, flat.length - 1)].key); }
  };
  const row = (x: CatalogItem) => {
    const i = flat.indexOf(x);
    return (
      <button key={x.key} type="button" className={`palette__item${i === at ? ' on' : ''}`} onMouseEnter={() => setAt(i)} onClick={() => pick(x.key)}>
        <span className="palette__icon">{x.key === 'custom' ? <Icon name="external" /> : <LinkIcon icon={x.icon} size={22} />}</span>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="ellipsis" style={{ display: 'block' }}>{x.name}</span>
          {x.description && <span className="small muted ellipsis" style={{ display: 'block' }}>{x.description}</span>}
        </span>
      </button>
    );
  };
  return (
    <div className="app-picker" ref={box}>
      <button type="button" className="select app-picker__button" onClick={() => setOpen(!open)} aria-expanded={open}>
        {chosen === 'custom' ? <><Icon name="external" /> {t('admin.linkCustom')}</>
          : chosen ? <><LinkIcon icon={chosen.icon} size={18} /> <span className="ellipsis">{chosen.name}</span></>
          : <span className="muted">{t('admin.linkPick')}</span>}
      </button>
      {open && (
        <div className="palette app-picker__panel">
          <div className="palette__input">
            <Icon name="search" />
            <input autoFocus value={q} placeholder={t('admin.linkFilter')} onChange={(e) => { setQ(e.target.value); setAt(0); }} onKeyDown={keys} />
          </div>
          <div className="palette__list">
            {shown.map((g) => (
              <div key={g.label}>
                <div className="palette__group">{g.label}</div>
                {g.items.map(row)}
              </div>
            ))}
            <div className="palette__group">{t('admin.linkOther')}</div>
            {row(custom)}
          </div>
        </div>
      )}
    </div>
  );
}

/** Pick a Lark feature or one of the company's Lark apps and add it in one click; a custom link is the fallback. */
function LinkForm({ added, onAdded }: { added: LarkLink[]; onAdded: () => void }) {
  const { t } = useI18n();
  const { data: catalog } = useApi<Catalog>('/lark-links/catalog');
  const empty = { name: '', description: '', url: '', icon: '' };
  const [pick, setPick] = useState('');
  const [f, setF] = useState(empty);
  const { busy, run } = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const have = new Set(added.map((l) => l.url));
  const groups = [
    { label: t('admin.linkBuiltins'), items: catalog?.builtins.filter((x) => !have.has(x.url)) ?? [] },
    { label: t('admin.linkInstalled'), items: catalog?.installed.filter((x) => !have.has(x.url)) ?? [] },
  ];
  const chosen = groups.flatMap((g) => g.items).find((x) => x.key === pick);
  const custom = pick === 'custom';
  const add = () => {
    const { key: _key, ...item } = chosen ?? { key: '', ...f };
    return run(() => api.post('/lark-links', item), t('admin.addedToast')).then((ok) => ok && (setPick(''), setF(empty), onAdded()));
  };
  return (
    <div className="stack" style={{ gap: 8, marginTop: 12 }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <AppPicker groups={groups} chosen={custom ? 'custom' : chosen} onPick={setPick} />
        {chosen && <span className="small muted grow ellipsis" style={{ minWidth: 0 }}>{chosen.description}</span>}
        {!custom && (
          <button className="btn" disabled={busy || !chosen} type="button" onClick={add} style={{ marginLeft: 'auto' }}><Icon name="plus" /> {t('admin.add')}</button>
        )}
      </div>
      {custom && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input className="input" style={{ width: 70 }} placeholder={t('admin.iconPlaceholder')} value={f.icon} onChange={set('icon')} title={t('admin.iconTitle')} />
          <input className="input" style={{ width: 140 }} placeholder={t('admin.namePlaceholder')} value={f.name} onChange={set('name')} />
          <input className="input" style={{ width: 160 }} placeholder={t('admin.descPlaceholder')} value={f.description} onChange={set('description')} />
          <input className="input grow" style={{ minWidth: 200 }} placeholder={t('admin.urlPlaceholder')} value={f.url} onChange={set('url')} />
          <button className="btn" disabled={busy || !f.name || !f.url} type="button" onClick={add}><Icon name="plus" /> {t('admin.add')}</button>
        </div>
      )}
      {catalog?.installedMissing && <p className="small muted" style={{ margin: 0 }}>{t('admin.linkInstalledMissing')}</p>}
    </div>
  );
}

export function AdminPage() {
  const me = useMe();
  const { t, ago } = useI18n();
  const { data, error, reload } = useApi<AdminData>(me.user.role === 'admin' ? '/admin' : null);
  const { busy, run } = useAction();
  const toast = useToast();
  // links like /admin#lark-links land on that section once the page has loaded
  const loaded = !!data;
  useEffect(() => {
    if (loaded && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [loaded]);
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

      {me.hub.features.messages && me.hub.features.lark && <RequestsChatSection chat={data.requestsChat} reload={reload} />}

      {me.hub.features.lark && (
        <div className="section" id="lark-links">
          <div className="section-title">{t('admin.larkLinks')} <span className="count">{t('admin.larkLinksHint')}</span></div>
          <div className="card pad">
            {data.larkLinks.length === 0 && <p className="small muted" style={{ margin: 0 }}>{t('admin.larkLinksEmpty')}</p>}
            <div className="stack" style={{ gap: 6 }}>
              {data.larkLinks.map((l) => (
                <div key={l.id} className="row">
                  <span style={{ width: 28, display: 'grid', placeItems: 'center' }}><LinkIcon icon={l.icon || '🔗'} /></span>
                  <span style={{ fontWeight: 500 }}>{l.name}</span>
                  <span className="small muted grow ellipsis" style={{ minWidth: 0 }}>{l.url}</span>
                  <label className="row small" style={{ gap: 4, whiteSpace: 'nowrap' }}>
                    <input type="checkbox" checked={!!l.in_sidebar} disabled={busy}
                      onChange={(e) => run(() => api.post(`/lark-links/${l.id}/sidebar`, { on: e.target.checked }), t('admin.sidebarSaved')).then(reload)} />
                    {t('admin.inSidebar')}
                  </label>
                  <button className="btn sm ghost danger" onClick={() => run(() => api.del(`/lark-links/${l.id}`)).then(reload)} type="button">{t('common.delete')}</button>
                </div>
              ))}
            </div>
            <LinkForm added={data.larkLinks} onAdded={reload} />
          </div>
        </div>
      )}

      <div className="section" id="services">
        <div className="section-title">{t('admin.services')} <span className="count">{t('admin.servicesHint')}</span></div>
        <ServicesSection />
      </div>

      <div className="section" id="ai">
        <div className="section-title">{t('admin.ai')} <span className="count">{t('admin.aiHint')}</span></div>
        <AiSection />
      </div>

      <div className="section" id="connections">
        <div className="section-title">{t('admin.connections')} <span className="count">{t('admin.connectionsHint')}</span></div>
        <ConnectionsSection />
        <div className="card pad" style={{ marginTop: 12 }}>
          <label className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={data.dataCombine} disabled={busy} style={{ marginTop: 3 }}
              onChange={(e) => run(() => api.post('/admin/data-combine', { on: e.target.checked }), t(e.target.checked ? 'admin.combineOn' : 'admin.combineOff')).then(reload)} />
            <span><b>{t('admin.combine')}</b><br /><span className="small muted">{t('admin.combineHint')}</span></span>
          </label>
        </div>
      </div>

      <div className="section">
        <div className="section-title">{t('admin.members')} <span className="count">{t('admin.memberCount', { n: data.users.length })}</span><span className="spacer" />
          {!data.devLogin && me.hub.features.directory && <button className="btn sm" disabled={busy} onClick={sync} type="button"><Icon name="refresh" /> {t('admin.sync')}</button>}
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
