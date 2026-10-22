import { useState } from 'react';
import { api, type Person } from './api';
import { useI18n, type MessageKey } from './i18n';
import { LOCALES } from './i18n/locales';
import { Dialog, Icon, Loading, PersonPicker, useAction, useApi } from './ui';

interface ConnectorInfo { type: string; label: string; identity: 'service' | 'person'; fields: { name: string; secret?: boolean; placeholder?: string }[]; boards: boolean }
interface Imported { id: string; title: string; board: string; url: string; updatedAt: number }
interface Connection { id: string; type: string; label: string; config: Record<string, string>; secretsSet: string[]; status: string | null; checkedAt: number | null; sources: number; imported: Imported[] }
interface ImportResult { name: string; url: string; boards: { id: string; title: string }[]; sources: { created: string[]; reused: string[] }; skipped: { name: string; reason: string }[] }
interface Audience { company: boolean; people: { id: string; name: string }[]; departments: { id: string; name: string }[] }
interface Source { id: string; title: string; description?: string; url: string; connection: string; item: string; audience: Audience }
interface Data { connectors: ConnectorInfo[]; connections: Connection[]; sources: Source[]; departments: { id: string; name: string }[] }
interface Item { id: string; name: string; group?: string; url?: string }

/**
 * Admin page section: connections to other systems (Metabase…) with their key, and the data sources read through
 * them with who may see each. Keys are typed here and nowhere else; they are never shown again.
 */
export function ConnectionsSection() {
  const { t } = useI18n();
  const { data, error, reload } = useApi<Data>('/admin/connections');
  if (!data) return <Loading error={error} />;
  return (
    <div className="stack" style={{ gap: 12 }}>
      {data.connectors.map((c) => {
        const conn = data.connections.find((x) => x.type === c.type);
        return (
          <div key={c.type} className="card pad">
            <ConnectionCard connector={c} conn={conn} reload={reload} />
            {conn && c.boards && <BoardsList conn={conn} departments={data.departments} reload={reload} />}
            {conn && <SourcesList conn={conn} sources={data.sources.filter((s) => s.connection === conn.id)} departments={data.departments} reload={reload} />}
          </div>
        );
      })}
      <p className="small muted" style={{ margin: 0 }}>{t('conn.otherSystems')}</p>
    </div>
  );
}

function ConnectionCard({ connector, conn, reload }: { connector: ConnectorInfo; conn?: Connection; reload: () => void }) {
  const { t, ago } = useI18n();
  const { busy, run } = useAction();
  const [editing, setEditing] = useState(!conn);
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(conn?.config ?? {}) }));
  const ok = conn?.status?.startsWith('ok:');
  const save = () => run(async () => {
    await api.post('/admin/connections', { id: conn?.id, type: connector.type, config: values });
    setValues((v) => Object.fromEntries(Object.entries(v).filter(([k]) => !connector.fields.find((f) => f.name === k)?.secret)));
    setEditing(false);
  }, t('conn.saved')).then(reload);
  return (
    <>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <b>{connector.label}</b>
        {conn && <span className={`badge ${ok ? 'ok' : 'danger'}`}>{ok ? t('conn.ok') : t('conn.error')}</span>}
        {conn && <span className="small muted grow ellipsis">{conn.config.url}</span>}
        <span className="spacer" />
        {conn && !editing && (
          <>
            <button className="btn sm" disabled={busy} onClick={() => run(() => api.post(`/admin/connections/${conn.id}/test`), t('conn.tested')).then(reload)} type="button">{t('conn.test')}</button>
            <button className="btn sm" onClick={() => setEditing(true)} type="button">{t('conn.edit')}</button>
            <button className="btn sm ghost danger" disabled={busy || conn.sources > 0} title={conn.sources > 0 ? t('conn.inUse') : undefined}
              onClick={() => confirm(t('conn.deleteConfirm', { name: connector.label })) && run(() => api.del(`/admin/connections/${conn.id}`)).then(reload)} type="button">{t('common.delete')}</button>
          </>
        )}
      </div>
      {conn?.status && (
        <p className="small muted" style={{ margin: '4px 0 0' }}>
          {ok ? t('conn.actsAs', { who: conn.status.slice(3) }) : conn.status.slice(6)}
          {conn.checkedAt ? ` · ${t('conn.checked', { ago: ago(conn.checkedAt) })}` : ''}
        </p>
      )}
      {editing && (
        <div className="stack" style={{ gap: 10, marginTop: 12 }}>
          {!conn && <p className="small muted" style={{ margin: 0 }}>{t(`conn.howTo.${connector.type}` as MessageKey)}</p>}
          {connector.fields.map((f) => (
            <label key={f.name} className="conn-field">
              <span className="small">{t(`conn.field.${f.name}` as MessageKey)}</span>
              <input className="input" type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false}
                placeholder={f.secret && conn?.secretsSet.includes(f.name) ? t('conn.secretKept') : f.placeholder}
                value={values[f.name] ?? ''} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
            </label>
          ))}
          <p className="small muted" style={{ margin: 0 }}>{t('conn.secretNote')}</p>
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={save} type="button">{t('conn.testAndSave')}</button>
            {conn && <button className="btn ghost" onClick={() => setEditing(false)} type="button">{t('common.cancel')}</button>}
          </div>
        </div>
      )}
    </>
  );
}

const audienceText = (a: Audience, t: ReturnType<typeof useI18n>['t']) => {
  if (a.company) return t('conn.aud.company');
  const parts = [...a.departments.map((d) => d.name), ...a.people.map((p) => p.name)];
  return parts.length ? t('conn.aud.adminsAnd', { who: parts.join(t('common.listSeparator')) }) : t('conn.aud.admins');
};

function SourcesList({ conn, sources, departments, reload }: { conn: Connection; sources: Source[]; departments: Data['departments']; reload: () => void }) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const [adding, setAdding] = useState(false);
  const [audienceOf, setAudienceOf] = useState<Source | null>(null);
  const [describing, setDescribing] = useState<Source | null>(null);
  return (
    <div style={{ marginTop: 16 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <b className="small">{t('conn.sources')}</b>
        <span className="small muted">{t('conn.sourcesHint')}</span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setAdding(true)} type="button"><Icon name="plus" /> {t('conn.addSource')}</button>
      </div>
      {sources.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{t('conn.noSources')}</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>{t('conn.col.source')}</th><th className="hide-sm">{t('conn.col.item')}</th><th>{t('conn.col.audience')}</th><th /></tr></thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div>{s.title}</div>
                    <div className="small muted mono">{s.id}</div>
                    <button className="conn-desc" onClick={() => setDescribing(s)} type="button" title={t('conn.desc.edit')}>
                      {s.description ? s.description : <span className="muted">{t('conn.desc.none')}</span>}
                    </button>
                  </td>
                  <td className="small hide-sm"><a href={s.url} target="_blank" rel="noreferrer">#{s.item} <Icon name="external" size={12} /></a></td>
                  <td className="small">
                    <button className="btn sm ghost" onClick={() => setAudienceOf(s)} type="button" title={t('conn.aud.edit')}>
                      <Icon name={s.audience.company ? 'org' : 'user'} size={13} /> {audienceText(s.audience, t)}
                    </button>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn sm ghost danger" disabled={busy}
                      onClick={() => confirm(t('conn.deleteSourceConfirm', { name: s.title })) && run(() => api.del(`/admin/data-sources/${s.id}`)).then(reload)} type="button">{t('common.delete')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <AddSource conn={conn} taken={sources.map((s) => s.id)} departments={departments} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
      {audienceOf && <AudienceDialog source={audienceOf} departments={departments} onClose={() => setAudienceOf(null)} onSaved={() => { setAudienceOf(null); reload(); }} />}
      {describing && <DescriptionDialog source={describing} onClose={() => setDescribing(null)} onSaved={() => { setDescribing(null); reload(); }} />}
    </div>
  );
}

/** Who besides admins may see it: the whole company, or chosen departments and people. */
function AudienceEditor({ value, onChange, departments }: { value: { company: boolean; people: Person[]; departments: string[] }; onChange: (v: { company: boolean; people: Person[]; departments: string[] }) => void; departments: Data['departments'] }) {
  const { t } = useI18n();
  return (
    <div className="stack" style={{ gap: 10 }}>
      <label className={`option ${!value.company ? 'selected' : ''}`}>
        <input type="radio" checked={!value.company} onChange={() => onChange({ ...value, company: false })} />
        <span><b>{t('conn.aud.chosen')}</b><br /><span className="small muted">{t('conn.aud.chosenHint')}</span></span>
      </label>
      {!value.company && (
        <div className="stack" style={{ gap: 8, paddingLeft: 28 }}>
          {departments.length > 0 && (
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {departments.map((d) => {
                const on = value.departments.includes(d.id);
                return (
                  <button key={d.id} className={`conn-chip ${on ? 'on' : ''}`} type="button" aria-pressed={on}
                    onClick={() => onChange({ ...value, departments: on ? value.departments.filter((x) => x !== d.id) : [...value.departments, d.id] })}>{d.name}</button>
                );
              })}
            </div>
          )}
          <PersonPicker value={value.people} onChange={(people) => onChange({ ...value, people })} />
        </div>
      )}
      <label className={`option ${value.company ? 'selected' : ''}`}>
        <input type="radio" checked={value.company} onChange={() => onChange({ ...value, company: true })} />
        <span><b>{t('conn.aud.company')}</b><br /><span className="small muted">{t('conn.aud.companyHint')}</span></span>
      </label>
    </div>
  );
}

const toPayload = (v: { company: boolean; people: Person[]; departments: string[] }) =>
  v.company ? { company: true } : { people: v.people.map((p) => p.id), departments: v.departments };

function AudienceDialog({ source, departments, onClose, onSaved }: { source: Source; departments: Data['departments']; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const [value, setValue] = useState<{ company: boolean; people: Person[]; departments: string[] }>({ company: source.audience.company, people: source.audience.people.map((p) => ({ ...p, avatar: null })), departments: source.audience.departments.map((d) => d.id) });
  return (
    <Dialog title={t('conn.aud.title', { name: source.title })} subtitle={t('conn.aud.subtitle')} onClose={onClose}>
      <AudienceEditor value={value} onChange={setValue} departments={departments} />
      <div className="row" style={{ marginTop: 16 }}>
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose} type="button">{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy} onClick={() => run(() => api.post(`/admin/data-sources/${source.id}/audience`, { audience: toPayload(value) }), t('conn.aud.saved')).then(onSaved)} type="button">{t('common.save')}</button>
      </div>
    </Dialog>
  );
}

/** Pick an item of the connection (searchable), name it in every language, choose who sees it. */
function AddSource({ conn, taken, departments, onClose, onSaved }: { conn: Connection; taken: string[]; departments: Data['departments']; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const { data, error } = useApi<{ items: Item[] }>(`/admin/connections/${conn.id}/browse${search ? `?q=${encodeURIComponent(search)}` : ''}`);
  const [item, setItem] = useState<Item | null>(null);
  const [id, setId] = useState('');
  const [title, setTitle] = useState<Record<string, string>>({});
  const [audience, setAudience] = useState({ company: false, people: [] as Person[], departments: [] as string[] });
  const choose = (it: Item) => {
    setItem(it);
    let base = `${conn.type === 'metabase' ? 'mb' : conn.id}-${it.id}`;
    for (let n = 2; taken.includes(base); n++) base = `${conn.type === 'metabase' ? 'mb' : conn.id}-${it.id}-${n}`;
    setId(base);
    setTitle(Object.fromEntries(LOCALES.map((l) => [l.code, it.name])));
  };
  const save = () => run(() => api.post('/admin/data-sources', { id, title, connection: conn.id, item: item!.id, audience: toPayload(audience) }), t('conn.sourceSaved')).then(onSaved);
  return (
    <Dialog title={t('conn.addSourceTitle', { name: conn.label })} onClose={onClose} width={640}>
      {!item ? (
        <>
          <form className="row" onSubmit={(e) => { e.preventDefault(); setSearch(q); }}>
            <input className="input grow" autoFocus placeholder={t('conn.search')} value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn" type="submit">{t('common.search')}</button>
          </form>
          <div className="conn-items">
            {!data ? <Loading error={error} /> : data.items.length === 0 ? <p className="small muted">{t('conn.noItems')}</p> : data.items.map((it) => (
              <button key={it.id} className="conn-item" onClick={() => choose(it)} type="button">
                <span className="grow ellipsis">{it.name}</span>
                {it.group && <span className="small muted ellipsis">{it.group}</span>}
                <span className="small muted mono">#{it.id}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <div className="row small">
            <span className="grow">{item.name} <span className="muted mono">#{item.id}</span></span>
            <button className="btn sm ghost" onClick={() => setItem(null)} type="button">{t('conn.pickAnother')}</button>
          </div>
          {LOCALES.map((l) => (
            <label key={l.code} className="conn-field">
              <span className="small">{t('conn.titleIn', { language: l.name })}</span>
              <input className="input" value={title[l.code] ?? ''} onChange={(e) => setTitle({ ...title, [l.code]: e.target.value })} />
            </label>
          ))}
          <label className="conn-field">
            <span className="small">{t('conn.sourceId')}</span>
            <input className="input mono" value={id} onChange={(e) => setId(e.target.value.toLowerCase())} />
            <span className="small muted">{t('conn.sourceIdHint')}</span>
          </label>
          <div>
            <div className="small" style={{ marginBottom: 6 }}>{t('conn.col.audience')}</div>
            <AudienceEditor value={audience} onChange={setAudience} departments={departments} />
          </div>
          <div className="row">
            <span className="spacer" />
            <button className="btn ghost" onClick={onClose} type="button">{t('common.cancel')}</button>
            <button className="btn primary" disabled={busy || !id} onClick={save} type="button">{t('common.save')}</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Dashboards of the other system brought in as boards on the Data page, each with a way to sync it again. */
function BoardsList({ conn, departments, reload }: { conn: Connection; departments: Data['departments']; reload: () => void }) {
  const { t, ago } = useI18n();
  const { busy, run } = useAction();
  const [importing, setImporting] = useState(false);
  // one sync per dashboard re-imports all of its tabs
  const dashboards = [...new Map(conn.imported.map((b) => [b.board, b])).values()];
  return (
    <div style={{ marginTop: 16 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <b className="small">{t('conn.boards')}</b>
        <span className="small muted">{t('conn.boardsHint')}</span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setImporting(true)} type="button"><Icon name="plus" /> {t('conn.importBoard')}</button>
      </div>
      {conn.imported.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{t('conn.noBoards')}</p> : (
        <div className="stack" style={{ gap: 6 }}>
          {conn.imported.map((b) => (
            <div key={b.id} className="row small">
              <a href={`/data?board=${encodeURIComponent(b.id)}`} className="grow ellipsis">{b.title}</a>
              <span className="muted">{t('conn.synced', { ago: ago(b.updatedAt) })}</span>
              <a className="muted" href={b.url} target="_blank" rel="noreferrer">#{b.board} <Icon name="external" size={12} /></a>
            </div>
          ))}
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {dashboards.map((b) => (
              <button key={b.board} className="btn sm ghost" disabled={busy} type="button"
                onClick={() => run(() => api.post(`/admin/connections/${conn.id}/import`, { board: b.board }), t('conn.syncDone')).then(reload)}>
                <Icon name="refresh" /> {t('conn.sync', { name: `#${b.board}` })}
              </button>
            ))}
          </div>
        </div>
      )}
      {importing && <ImportBoard conn={conn} departments={departments} onClose={() => setImporting(false)} onDone={reload} />}
    </div>
  );
}

function ImportBoard({ conn, departments, onClose, onDone }: { conn: Connection; departments: Data['departments']; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const { data, error } = useApi<{ items: Item[] }>(`/admin/connections/${conn.id}/boards${search ? `?q=${encodeURIComponent(search)}` : ''}`);
  const [board, setBoard] = useState<Item | null>(null);
  const [audience, setAudience] = useState({ company: false, people: [] as Person[], departments: [] as string[] });
  const [result, setResult] = useState<ImportResult | null>(null);
  const go = () => run(async () => {
    setResult(await api.post<ImportResult>(`/admin/connections/${conn.id}/import`, { board: board!.id, audience: toPayload(audience) }));
    onDone();
  });
  return (
    <Dialog title={t('conn.importTitle', { name: conn.label })} subtitle={t('conn.importSubtitle')} onClose={onClose} width={640}>
      {result ? (
        <div className="stack" style={{ gap: 12 }}>
          <p style={{ margin: 0 }}>{t('conn.importDone', { boards: result.boards.length, created: result.sources.created.length, reused: result.sources.reused.length })}</p>
          <div className="stack" style={{ gap: 4 }}>
            {result.boards.map((b) => <a key={b.id} href={`/data?board=${encodeURIComponent(b.id)}`}>{b.title} →</a>)}
          </div>
          {result.skipped.length > 0 && (
            <div className="small muted">
              <div>{t('conn.importSkipped', { n: result.skipped.length })}</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{result.skipped.map((x, i) => <li key={i}>{x.name} — {x.reason}</li>)}</ul>
            </div>
          )}
          <div className="row"><span className="spacer" /><button className="btn primary" onClick={onClose} type="button">{t('common.close')}</button></div>
        </div>
      ) : !board ? (
        <>
          <form className="row" onSubmit={(e) => { e.preventDefault(); setSearch(q); }}>
            <input className="input grow" autoFocus placeholder={t('conn.search')} value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn" type="submit">{t('common.search')}</button>
          </form>
          <div className="conn-items">
            {!data ? <Loading error={error} /> : data.items.length === 0 ? <p className="small muted">{t('conn.noItems')}</p> : data.items.map((it) => (
              <button key={it.id} className="conn-item" onClick={() => setBoard(it)} type="button">
                <span className="grow ellipsis">{it.name}</span>
                {it.group && <span className="small muted ellipsis">{it.group}</span>}
                <span className="small muted mono">#{it.id}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <div className="row small">
            <span className="grow">{board.name} <span className="muted mono">#{board.id}</span></span>
            <button className="btn sm ghost" onClick={() => setBoard(null)} type="button">{t('conn.pickAnother')}</button>
          </div>
          <p className="small muted" style={{ margin: 0 }}>{t('conn.importHow')}</p>
          <div>
            <div className="small" style={{ marginBottom: 6 }}>{t('conn.importAudience')}</div>
            <AudienceEditor value={audience} onChange={setAudience} departments={departments} />
          </div>
          <div className="row">
            <span className="spacer" />
            <button className="btn ghost" onClick={onClose} type="button">{t('common.cancel')}</button>
            <button className="btn primary" disabled={busy} onClick={go} type="button">{busy ? t('conn.importing') : t('conn.import')}</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** What a source counts, in every language; empty goes back to what the other system says. */
function DescriptionDialog({ source, onClose, onSaved }: { source: Source; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(LOCALES.map((l) => [l.code, source.description ?? ''])));
  return (
    <Dialog title={t('conn.desc.title', { name: source.title })} subtitle={t('conn.desc.subtitle')} onClose={onClose} width={600}>
      <div className="stack" style={{ gap: 12 }}>
        {LOCALES.map((l) => (
          <label key={l.code} className="conn-field">
            <span className="small">{l.name}</span>
            <textarea className="input" rows={4} value={text[l.code] ?? ''} onChange={(e) => setText({ ...text, [l.code]: e.target.value })} />
          </label>
        ))}
        <div className="row">
          <button className="btn ghost" disabled={busy} onClick={() => run(() => api.post(`/data/sources/${source.id}/description`, { description: null }), t('conn.desc.reset')).then(onSaved)} type="button">{t('conn.desc.useSource')}</button>
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose} type="button">{t('common.cancel')}</button>
          <button className="btn primary" disabled={busy} onClick={() => run(() => api.post(`/data/sources/${source.id}/description`, { description: text }), t('common.saved')).then(onSaved)} type="button">{t('common.save')}</button>
        </div>
      </div>
    </Dialog>
  );
}
