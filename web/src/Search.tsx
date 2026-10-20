import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { api } from './api';
import { useI18n, type MessageKey } from './i18n';
import { AppIcon, Avatar, Icon, type IconName } from './ui';

interface Results {
  apps: { slug: string; name: string; description: string; icon: string | null; url: string }[];
  skills: { slug: string; name: string; description: string; icon: string | null }[];
  resources: { id: number; title: string; group: string; url: string }[];
  people: { id: string; name: string; email: string | null; avatar: string | null }[];
  boards: { id: string; title: string; department: string | null }[];
}
interface Hit { key: string; group: MessageKey; label: string; sub?: string; icon: React.ReactNode; go: () => void }

const OPEN_EVENT = 'hub:search';
export const openSearch = () => window.dispatchEvent(new Event(OPEN_EVENT));
export const searchShortcut = () => (/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K');

/** Hub-wide search (⌘K / Ctrl+K): pages, apps, Skills, resources, colleagues and data boards. */
export function SearchBox({ pages }: { pages: { to: string; label: string; icon: IconName }[] }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Results | null>(null);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    // other places (the home page) open it with openSearch()
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);
  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 0);
    else { setQ(''); setRes(null); }
  }, [open]);
  useEffect(() => {
    if (!q.trim()) return setRes(null);
    const timer = setTimeout(() => api.get<Results>(`/search?q=${encodeURIComponent(q)}`).then(setRes, () => setRes(null)), 150);
    return () => clearTimeout(timer);
  }, [q]);

  const hits = useMemo<Hit[]>(() => {
    const needle = q.trim().toLowerCase();
    const close = (fn: () => void) => () => { setOpen(false); fn(); };
    const out: Hit[] = pages.filter((p) => needle && p.label.toLowerCase().includes(needle))
      .map((p) => ({ key: `p${p.to}`, group: 'search.pages', label: p.label, icon: <Icon name={p.icon} />, go: close(() => nav(p.to)) }));
    if (res) {
      out.push(...res.apps.map((a) => ({ key: `a${a.slug}`, group: 'search.apps' as MessageKey, label: a.name, sub: a.description, icon: <AppIcon src={a.icon} name={a.name} size="sm" />, go: close(() => nav(`/apps/${a.slug}`)) })));
      out.push(...res.skills.map((s) => ({ key: `s${s.slug}`, group: 'search.skills' as MessageKey, label: s.name, sub: s.description, icon: <Icon name="skill" />, go: close(() => nav(`/skills/${s.slug}`)) })));
      out.push(...res.boards.map((b) => ({ key: `b${b.id}`, group: 'search.boards' as MessageKey, label: b.title, sub: b.department ?? undefined, icon: <Icon name="chart" />, go: close(() => nav(`/data?board=${b.id}`)) })));
      out.push(...res.resources.map((r) => ({ key: `r${r.id}`, group: 'search.resources' as MessageKey, label: r.title, sub: r.group, icon: <Icon name="doc" />, go: close(() => window.open(r.url, '_blank', 'noopener')) })));
      out.push(...res.people.map((p) => ({ key: `u${p.id}`, group: 'search.people' as MessageKey, label: p.name, sub: p.email ?? undefined, icon: <Avatar person={p} />, go: close(() => nav(`/org?person=${encodeURIComponent(p.id)}`)) })));
    }
    return out;
  }, [res, q, pages, nav]);
  useEffect(() => setSel(0), [hits.length]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(hits.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter' && hits[sel]) hits[sel].go();
    else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <>
      <button className="search-trigger" onClick={() => setOpen(true)} type="button">
        <Icon name="search" /><span className="grow">{t('search.placeholder')}</span><kbd>{mac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      {/* rendered at the document root, above everything (the sidebar is its own stacking context) */}
      {open && createPortal(
        <div className="palette-backdrop" onMouseDown={() => setOpen(false)}>
          <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={t('search.placeholder')}>
            <div className="palette__input"><Icon name="search" /><input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder={t('search.hint')} /><kbd>Esc</kbd></div>
            <div className="palette__list">
              {!q.trim() ? <p className="small muted palette__empty">{t('search.tip')}</p> : hits.length === 0 ? <p className="small muted palette__empty">{res ? t('search.none') : t('common.loading')}</p> : hits.map((h, i) => (
                <div key={h.key}>
                  {(i === 0 || hits[i - 1].group !== h.group) && <div className="palette__group">{t(h.group)}</div>}
                  <button className={`palette__item ${i === sel ? 'on' : ''}`} onMouseEnter={() => setSel(i)} onClick={h.go} type="button">
                    <span className="palette__icon">{h.icon}</span>
                    <span className="grow ellipsis">{h.label}{h.sub && <span className="small muted"> · {h.sub}</span>}</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
