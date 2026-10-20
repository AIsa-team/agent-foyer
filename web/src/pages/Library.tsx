import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { useI18n } from '../i18n';
import { LOCALES } from '../i18n/locales';
import { CopyBox, Dialog, Icon, Loading, useAction, useApi, useMe } from '../ui';

type I18nText = Record<string, string>;
interface Resource { id: number; title: string; description: string; url: string; owner: string | null; preview: string | null; appSlug: string | null; skillSlug: string | null; updatedAt: number }
interface Group { id: number; name: string; note: string; items: Resource[]; nameI18n?: I18nText }
interface Library {
  culture: { mission: string; vision: string; values: { icon?: string; title: string; description: string }[] };
  sections: { section: 'policies' | 'brand'; groups: Group[] }[];
}

/** Small illustrations for the brand cards, drawn with the brand tokens (no images to keep in sync). */
function Preview({ kind }: { kind: string | null }) {
  if (kind === 'slides') {
    return (
      <div className="lib-preview lib-preview--slides" aria-hidden>
        <div className="lib-slide lib-slide--cover"><span /><span /><img src="/brand/logo.svg" alt="" /></div>
        <div className="lib-slide"><span className="w60" /><span className="w40" /><span className="w50" /></div>
        <div className="lib-slide"><i /><i /><i /><i /></div>
        <div className="lib-slide"><svg viewBox="0 0 100 40"><path d="M2 34 L22 26 L42 29 L62 16 L82 18 L98 6" fill="none" stroke="var(--aisa-accent)" strokeWidth="2" strokeLinecap="round" /></svg></div>
      </div>
    );
  }
  if (kind === 'ui') {
    return (
      <div className="lib-preview lib-preview--ui" aria-hidden>
        <div className="lib-ui-card"><span className="w40" /><span className="lib-ui-btn" /><span className="w70" /><span className="lib-ui-bar" /></div>
        <div className="lib-ui-side">
          <div className="lib-ui-card lib-ui-donut"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="13" fill="none" stroke="var(--aisa-accent-soft-line)" strokeWidth="6" /><circle cx="18" cy="18" r="13" fill="none" stroke="var(--aisa-accent)" strokeWidth="6" strokeDasharray="52 82" transform="rotate(-90 18 18)" /></svg></div>
          <div className="lib-ui-card lib-ui-bars">{[30, 45, 38, 60, 52, 80].map((h, i) => <i key={i} style={{ height: `${h}%` }} />)}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="lib-preview lib-preview--brand" aria-hidden>
      <img className="lib-brand-rings" src="/brand/motif.svg" alt="" />
      <img className="lib-brand-mark" src="/brand/logo.svg" alt="" />
    </div>
  );
}

function AddResourceDialog({ groups, section, onClose, onSaved }: { groups: Group[]; section: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const [groupId, setGroupId] = useState<number | 'new'>(groups[0]?.id ?? 'new');
  const [groupName, setGroupName] = useState<I18nText>({});
  const [title, setTitle] = useState<I18nText>({});
  const [url, setUrl] = useState('');
  const [owner, setOwner] = useState('');
  const save = () => run(async () => {
    let gid = groupId;
    if (gid === 'new') gid = (await api.post<{ id: number }>('/library/groups', { section, name: groupName })).id;
    await api.post('/library/resources', { groupId: gid, title, url, owner: owner || undefined });
  }, t('common.saved')).then((ok) => ok && (onSaved(), onClose()));
  const perLocale = (value: I18nText, set: (v: I18nText) => void, label: string) => (
    <div className="stack" style={{ gap: 6 }}>
      <span className="label" style={{ marginBottom: 0 }}>{label}</span>
      {LOCALES.map((l) => (
        <input key={l.code} className="input" placeholder={l.name} aria-label={`${label} (${l.name})`} value={value[l.code] ?? ''} onChange={(e) => set({ ...value, [l.code]: e.target.value })} />
      ))}
    </div>
  );
  return (
    <Dialog title={t('library.add.title')} onClose={onClose} width={520}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="field">
          <span className="label">{t('library.add.group')}</span>
          <select className="select input" value={String(groupId)} onChange={(e) => setGroupId(e.target.value === 'new' ? 'new' : Number(e.target.value))}>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            <option value="new">{t('library.add.newGroup')}</option>
          </select>
        </div>
        {groupId === 'new' && perLocale(groupName, setGroupName, t('library.add.groupName'))}
        {perLocale(title, setTitle, t('library.add.docTitle'))}
        <div className="field"><span className="label">{t('library.add.url')}</span><input className="input" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
        <div className="field"><span className="label">{t('library.add.owner')}</span><input className="input" value={owner} onChange={(e) => setOwner(e.target.value)} /></div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" disabled={busy || !url || !Object.values(title).some((v) => v.trim()) || (groupId === 'new' && !Object.values(groupName).some((v) => v.trim()))} onClick={save} type="button">{t('common.save')}</button>
        </div>
      </div>
    </Dialog>
  );
}

export function LibraryPage() {
  const me = useMe();
  const { t, ago } = useI18n();
  const { data, error, reload } = useApi<Library>('/library');
  const [adding, setAdding] = useState<'policies' | 'brand' | null>(null);
  const { run } = useAction();
  const admin = me.user.role === 'admin';
  if (!data) return <Loading error={error} />;
  const { culture } = data;
  const policies = data.sections.find((s) => s.section === 'policies')?.groups ?? [];
  const brand = data.sections.find((s) => s.section === 'brand')?.groups ?? [];
  const hub = t('prompt.hub', { company: me.hub.companyName, mcp: me.hub.mcpName });
  const hasCulture = culture.mission || culture.vision || culture.values.length;
  const remove = (id: number) => {
    if (confirm(t('library.removeConfirm'))) run(() => api.del(`/library/resources/${id}`)).then(reload);
  };

  return (
    <>
      <div className="page-head"><h1>{t('library.title')}</h1></div>

      {hasCulture ? (
        <div className="card lib-culture">
          <div className="lib-culture__left">
            {culture.mission && <div><div className="lib-kicker">{t('library.mission')}</div><p className="lib-statement">{culture.mission}</p></div>}
            {culture.vision && <div><div className="lib-kicker">{t('library.vision')}</div><p className="lib-statement">{culture.vision}</p></div>}
          </div>
          {culture.values.length > 0 && (
            <div className="lib-culture__right">
              <div className="lib-kicker">{t('library.values')}</div>
              <div className="lib-values">
                {culture.values.map((v, i) => (
                  <div key={i} className="lib-value">
                    <span className="lib-value__icon">{v.icon || '◆'}</span>
                    <div><b>{v.title}</b>{v.description && <p>{v.description}</p>}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : admin ? (
        <div className="card pad">
          <h3>{t('library.cultureEmpty')}</h3>
          <p className="small muted" style={{ marginTop: -6 }}>{t('library.cultureEmptyHint')}</p>
          <CopyBox text={t('library.culturePrompt', { hub })} />
        </div>
      ) : null}

      <div className="section">
        <div className="section-title">
          {t('library.policies')} <span className="count">{t('common.count', { n: policies.reduce((a, g) => a + g.items.length, 0) })}</span>
          <span className="spacer" />
          {admin && <button className="btn sm ghost" onClick={() => setAdding('policies')} type="button"><Icon name="plus" /> {t('library.addPolicy')}</button>}
        </div>
        {policies.length === 0 ? (
          <div className="card"><div className="empty"><b>{t('library.policiesEmpty')}</b>{admin && <span className="small">{t('library.policiesEmptyHint', { hub })}</span>}</div></div>
        ) : policies.map((g) => (
          <div key={g.id} className="lib-group">
            <div className="lib-group__name">{g.name}{g.note && <span className="muted"> · {g.note}</span>} <span className="muted small">{g.items.length}</span></div>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
              {g.items.map((r) => (
                <div key={r.id} className="card lib-doc">
                  <a href={r.url} target="_blank" rel="noreferrer" className="lib-doc__link">
                    <span className="lib-doc__icon"><Icon name="doc" /></span>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="lib-doc__title ellipsis">{r.title}</span>
                      <span className="small muted ellipsis">{[r.owner, t('common.updatedAgo', { ago: ago(r.updatedAt) })].filter(Boolean).join(' · ')}</span>
                    </span>
                  </a>
                  {admin && <button className="btn sm ghost lib-doc__remove" onClick={() => remove(r.id)} aria-label={t('common.delete')} type="button"><Icon name="x" /></button>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="section">
        <div className="section-title">{t('library.brand')}</div>
        {brand.flatMap((g) => g.items).length === 0 ? (
          <div className="card"><div className="empty"><b>{t('library.brandEmpty')}</b></div></div>
        ) : (
          <div className="lib-brand">
            {brand.flatMap((g) => g.items).map((r) => (
              <div key={r.id} className="card lib-brand-card">
                <a href={r.url} target="_blank" rel="noreferrer" className="lib-brand-card__visual"><Preview kind={r.preview} /></a>
                <div className="lib-brand-card__foot">
                  <a href={r.url} target="_blank" rel="noreferrer" className="grow" style={{ minWidth: 0 }}>
                    <div className="lib-doc__title">{r.title} <Icon name="external" size={12} /></div>
                    {r.description && <div className="small muted">{r.description}</div>}
                  </a>
                  {r.skillSlug && (
                    <Link to={`/skills/${r.skillSlug}`} className="lib-skill-link">
                      <span className="small muted">Skill</span>
                      <b className="mono">{r.skillSlug}</b>
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {adding && <AddResourceDialog groups={(adding === 'policies' ? policies : brand)} section={adding} onClose={() => setAdding(null)} onSaved={reload} />}
    </>
  );
}
