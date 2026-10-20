import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type LocalizedMap, type Me, type Person } from './api';
import { LOCALES } from './i18n/locales';
import { useI18n } from './i18n';

// ---------- icons (lucide-style strokes) ----------
const ICONS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  apps: 'M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3M15 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z',
  skill: 'M12 2 3 7l9 5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  settings: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  check: 'M5 12.5 10 17 19 7',
  x: 'M6 6l12 12M18 6 6 18',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  logout: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H4',
  back: 'M15 18l-6-6 6-6',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M20 11a8 8 0 0 0-14.9-4M4 4v4h4M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4',
  doc: 'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7zM14 3v4h4M9 12h6M9 16h6',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12.5v-1',
  chart: 'M4 20V11M10 20V5M16 20v-6M3 20h18',
  org: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16.5 3.6a4 4 0 0 1 0 7.3M22 21a7 7 0 0 0-4.5-6.5',
  issues: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5v5.5M12 16.5v.5',
  library: 'M3 5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v15H4a1 1 0 0 1-1-1zM8 5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v15H8zM14.2 6.4l2.9-.8a1 1 0 0 1 1.2.7l3.3 12.4a1 1 0 0 1-.7 1.2l-2.9.8z',
};
export type IconName = keyof typeof ICONS;
/** An icon an admin gave a link: an image (a URL, or a path on the hub), an emoji, or a plain link mark. */
export function LinkIcon({ icon, size = 20 }: { icon: string; size?: number }) {
  if (/^(https?:\/\/|\/[^/])/.test(icon)) return <img src={icon} width={size} height={size} style={{ borderRadius: Math.round(size / 4.5), flex: 'none' }} alt="" />;
  return icon ? <span className="emoji" style={{ fontSize: Math.round(size * 0.8), lineHeight: 1 }}>{icon}</span> : <Icon name="external" size={Math.round(size * 0.8)} />;
}

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICONS[name]} />
    </svg>
  );
}

// ---------- identity ----------
const MeContext = createContext<Me | null>(null);
export const MeProvider = MeContext.Provider;
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe outside provider');
  return me;
}

export function Avatar({ person, size = '' }: { person?: Pick<Person, 'name' | 'avatar'> | null; size?: '' | 'md' | 'lg' }) {
  if (!person) return null;
  if (person.avatar) return <img className={`avatar ${size}`} src={person.avatar} alt="" />;
  return <span className={`avatar ${size}`}>{person.name.slice(0, 1)}</span>;
}

const TILE_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6'];
export function AppIcon({ src, name, size = '' }: { src: string | null; name: string; size?: '' | 'sm' | 'lg' }) {
  if (src) return <img className={`app-icon ${size}`} src={src} alt="" />;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return <span className={`app-icon ${size}`} style={{ background: TILE_COLORS[h % TILE_COLORS.length] }}>{name.slice(0, 1).toUpperCase()}</span>;
}

// ---------- feedback ----------
type ToastFn = (msg: string, kind?: 'ok' | 'error') => void;
const ToastContext = createContext<ToastFn>(() => {});
export const useToast = () => useContext(ToastContext);
export function ToastHost({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'error' } | null>(null);
  const timer = useRef<number>(undefined);
  const show = useCallback<ToastFn>((msg, kind = 'ok') => {
    setToast({ msg, kind });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), kind === 'error' ? 4000 : 1800);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && <div className={`toast ${toast.kind === 'error' ? 'error' : ''}`} role="status">{toast.msg}</div>}
    </ToastContext.Provider>
  );
}

/** Loads data from the API; reload() refetches. Refetches when the UI language changes (names are localized server-side). */
export function useApi<T>(path: string | null) {
  const { locale } = useI18n();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    api.get<T>(path).then((d) => alive && (setData(d), setError(null)), (e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [path, tick, locale]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

/** Wraps an async action with a busy flag and error toast. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast(okMsg);
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { busy, run };
}

export function Loading({ error }: { error?: string | null }) {
  const { t } = useI18n();
  return <div className="empty">{error ? <span style={{ color: 'var(--danger)' }}>{error}</span> : t('common.loading')}</div>;
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <span className="check"><Icon name="check" /></span>
      <b>{title}</b>
      {hint && <span className="small">{hint}</span>}
    </div>
  );
}

// ---------- copy ----------
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const toast = useToast();
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setDone(true);
    toast(t('common.copied'));
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <button className="btn sm ghost" onClick={copy} type="button">
      <Icon name={done ? 'check' : 'copy'} /> {done ? t('common.copied') : label ?? t('common.copy')}
    </button>
  );
}

/** Text to copy. With `dialogTitle`, only the first lines show and the whole text opens in a dialog. */
export function CopyBox({ text, dialogTitle }: { text: string; dialogTitle?: string }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  return (
    <div className="copybox">
      <div className="grow">
        <div className={`text ${dialogTitle ? 'clamp' : ''}`}>{text}</div>
        {dialogTitle && (
          <button className="btn sm ghost" style={{ paddingLeft: 0, marginTop: 4 }} onClick={() => setOpen(true)} type="button">{t('common.showAll')}</button>
        )}
      </div>
      <CopyButton text={text} />
      {open && dialogTitle && <Dialog title={dialogTitle} onClose={() => setOpen(false)} width={720}><CopyBox text={text} /></Dialog>}
    </div>
  );
}

// ---------- layout pieces ----------
export function Dialog({ title, subtitle, onClose, children, width }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; width?: number }) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal aria-label={title} style={width ? { maxWidth: width } : undefined}>
        <div className="dialog-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="btn sm ghost" onClick={onClose} aria-label={t('common.close')} type="button"><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Step({ n, done, title, children }: { n: number; done?: boolean; title: string; children?: ReactNode }) {
  return (
    <div className={`step ${done ? 'done' : ''}`}>
      <div className="rail"><span className="dot">{done ? <Icon name="check" size={14} /> : n}</span></div>
      <div className="body">
        <h4>{title}</h4>
        {children}
      </div>
    </div>
  );
}

/** First step in every "do it with your agent" dialog. */
export function AgentStep({ agents }: { agents: { name: string }[] | null }) {
  const { t } = useI18n();
  const connected = !!agents?.length;
  return (
    <Step n={1} done={connected} title={t('agentStep.title')}>
      {connected ? (
        <p>{t('agentStep.connected', { names: agents!.map((a) => a.name).join(t('common.listSeparator')) })}</p>
      ) : (
        <p>{t('agentStep.notConnected.before')} <a href="/me" style={{ textDecoration: 'underline' }}>{t('agentStep.notConnected.link')}</a> {t('agentStep.notConnected.after')}</p>
      )}
    </Step>
  );
}

// ---------- people ----------
export function PersonPicker({ value, onChange }: { value: Person[]; onChange: (v: Person[]) => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Person[]>([]);
  useEffect(() => {
    if (!q.trim()) return setResults([]);
    const t = setTimeout(() => {
      api.get<Person[]>(`/users?q=${encodeURIComponent(q)}`).then(setResults, () => {});
    }, 150);
    return () => clearTimeout(t);
  }, [q]);
  const chosen = new Set(value.map((p) => p.id));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {value.length > 0 && (
        <div className="chips">
          {value.map((p) => (
            <span className="chip" key={p.id}>
              <Avatar person={p} /> {p.name}
              <button onClick={() => onChange(value.filter((x) => x.id !== p.id))} aria-label={`${t('common.remove')} ${p.name}`} type="button">×</button>
            </span>
          ))}
        </div>
      )}
      <div className="picker">
        <input className="input" placeholder={t('picker.placeholder')} value={q} onChange={(e) => setQ(e.target.value)} />
        {results.length > 0 && (
          <div className="picker-list">
            {results.filter((r) => !chosen.has(r.id)).map((r) => (
              <button key={r.id} onClick={() => { onChange([...value, r]); setQ(''); }} type="button">
                <Avatar person={r} /> {r.name} <span className="muted small">{r.email}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- per-language listing text ----------
/** Name + one-line description for every UI language. Empty fields fall back to another language. */
export function LocalizedFields({ value, onChange, fallback, multilineDescription }: {
  value: LocalizedMap;
  onChange: (v: LocalizedMap) => void;
  fallback: { name: string; description: string };
  multilineDescription?: boolean;
}) {
  const { t } = useI18n();
  const set = (code: string, field: 'name' | 'description', v: string) => onChange({ ...value, [code]: { ...value[code], [field]: v } });
  return (
    <div className="stack" style={{ gap: 14 }}>
      {LOCALES.map((l) => (
        <div key={l.code} className="stack" style={{ gap: 6 }}>
          <span className="label" style={{ marginBottom: 0 }}>{l.name}</span>
          <input className="input" placeholder={fallback.name || t('localized.namePlaceholder')} value={value[l.code]?.name ?? ''}
            onChange={(e) => set(l.code, 'name', e.target.value)} aria-label={`${t('localized.namePlaceholder')} (${l.name})`} />
          {multilineDescription ? (
            <textarea className="textarea" placeholder={fallback.description || t('localized.descPlaceholder')} value={value[l.code]?.description ?? ''}
              onChange={(e) => set(l.code, 'description', e.target.value)} aria-label={`${t('localized.descPlaceholder')} (${l.name})`} />
          ) : (
            <input className="input" placeholder={fallback.description || t('localized.descPlaceholder')} value={value[l.code]?.description ?? ''}
              onChange={(e) => set(l.code, 'description', e.target.value)} aria-label={`${t('localized.descPlaceholder')} (${l.name})`} />
          )}
        </div>
      ))}
      <span className="small muted">{t('localized.hint')}</span>
    </div>
  );
}

/** Stable comparison so Save is enabled only when something changed. */
export function sameLocalized(a: LocalizedMap = {}, b: LocalizedMap = {}) {
  const norm = (m: LocalizedMap) => JSON.stringify(Object.keys(m).sort().map((k) => [k, (m[k]?.name ?? '').trim(), (m[k]?.description ?? '').trim()]).filter(([, n, d]) => n || d));
  return norm(a) === norm(b);
}

// ---------- icon editor (apps and Skills) ----------
/** Upload an SVG/PNG icon or remove it; `endpoint` is the PATCH path that accepts iconSvg / iconPngBase64 / removeIcon. */
export function IconEditor({ src, name, endpoint, prompt, onSaved, fallback }: {
  src: string | null; name: string; endpoint: string; prompt: string; onSaved: () => void; fallback?: React.ReactNode;
}) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    const svg = file.type === 'image/svg+xml';
    reader.onload = () => run(() => api.patch(endpoint, svg ? { iconSvg: reader.result as string } : { iconPngBase64: reader.result as string }), t('appDetail.iconUpdated')).then(onSaved);
    if (svg) reader.readAsText(file);
    else reader.readAsDataURL(file);
  };
  return (
    <div className="card pad">
      <h3>{t('appDetail.icon')}</h3>
      <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
        {src ? <AppIcon src={src} name={name} size="lg" /> : fallback ?? <AppIcon src={null} name={name} size="lg" />}
        <div className="grow stack" style={{ gap: 8 }}>
          <div className="row">
            <label className="btn sm">{t('appDetail.iconChange')}<input type="file" accept="image/svg+xml,image/png" hidden onChange={onFile} disabled={busy} /></label>
            {src && <button className="btn sm ghost" disabled={busy} onClick={() => run(() => api.patch(endpoint, { removeIcon: true })).then(onSaved)} type="button">{t('appDetail.iconRemove')}</button>}
          </div>
          <span className="small muted">{t('appDetail.iconHint')}</span>
          <div className="row small"><span className="grow">“{prompt}”</span><CopyButton text={prompt} /></div>
        </div>
      </div>
    </div>
  );
}

/** Pick an optional related item (or none) and save it with one PATCH field. */
export function LinkEditor({ title, hint, current, options, endpoint, field, onSaved }: {
  title: string; hint: string; current: string | null; options: { value: string; label: string }[]; endpoint: string; field: string; onSaved: () => void;
}) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const [value, setValue] = useState(current ?? '');
  useEffect(() => setValue(current ?? ''), [current]);
  return (
    <div className="card pad">
      <h3>{title}</h3>
      <p className="small muted" style={{ marginTop: -6 }}>{hint}</p>
      <div className="row">
        <select className="select input" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">{t('link.none')}</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button className="btn" disabled={busy || value === (current ?? '')} type="button"
          onClick={() => run(() => api.patch(endpoint, { [field]: value || null }), value ? t('link.saved') : t('link.removed')).then(onSaved)}>{t('common.save')}</button>
      </div>
    </div>
  );
}
