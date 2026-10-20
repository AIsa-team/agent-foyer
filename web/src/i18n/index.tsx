import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { FALLBACK_CHAIN, LOCALES, type MessageKey } from './locales';

export type { MessageKey };
export type Params = Record<string, string | number>;
export type T = (key: MessageKey, params?: Params) => string;

const STORAGE_KEY = 'hub-locale';
const COOKIE = 'hub_locale';
const supported = (code: string | null | undefined) => LOCALES.find((l) => l.code === code)?.code;

/** Best supported match for a list of BCP 47 tags: exact first, then by base language (zh-TW → zh-CN). */
export function matchLocale(prefs: readonly string[]): string | undefined {
  for (const p of prefs) {
    const exact = LOCALES.find((l) => l.code.toLowerCase() === p.toLowerCase());
    if (exact) return exact.code;
    const base = p.split('-')[0].toLowerCase();
    const loose = LOCALES.find((l) => l.code.split('-')[0].toLowerCase() === base);
    if (loose) return loose.code;
  }
  return undefined;
}

function initialLocale(): string {
  try {
    const saved = supported(localStorage.getItem(STORAGE_KEY));
    if (saved) return saved;
  } catch {
    /* storage unavailable */
  }
  return matchLocale(navigator.languages?.length ? navigator.languages : [navigator.language]) ?? FALLBACK_CHAIN[0];
}

function translate(locale: string, key: MessageKey, params?: Params): string {
  let msg: string | undefined;
  for (const code of [locale, ...FALLBACK_CHAIN]) {
    msg = LOCALES.find((l) => l.code === code)?.messages[key];
    if (msg !== undefined) break;
  }
  if (msg === undefined) return key;
  return params ? msg.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : msg;
}

interface I18n {
  locale: string;
  setLocale: (code: string) => void;
  t: T;
  ago: (ts: number | null | undefined) => string;
  fmtDate: (ts: number) => string;
}

const I18nContext = createContext<I18n | null>(null);

/** Applies the locale to <html lang> and to the cookie the server reads for its own pages and messages. */
function applyLocale(code: string) {
  document.documentElement.lang = code;
  document.cookie = `${COOKIE}=${encodeURIComponent(code)}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}

export function I18nProvider({ children, onChange }: { children: ReactNode; onChange?: (code: string) => void }) {
  const [locale, setLocaleState] = useState(initialLocale);
  const setLocale = useCallback((code: string) => {
    const next = supported(code);
    if (!next) return;
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage unavailable */
    }
    onChange?.(next);
  }, [onChange]);

  const value = useMemo<I18n>(() => {
    applyLocale(locale);
    const t: T = (key, params) => translate(locale, key, params);
    const ago = (ts: number | null | undefined) => {
      if (!ts) return '';
      const s = (Date.now() - ts) / 1000;
      if (s < 60) return t('time.justNow');
      if (s < 3600) return t('time.minutesAgo', { n: Math.floor(s / 60) });
      if (s < 86400) return t('time.hoursAgo', { n: Math.floor(s / 3600) });
      if (s < 86400 * 30) return t('time.daysAgo', { n: Math.floor(s / 86400) });
      return new Date(ts).toLocaleDateString(locale);
    };
    const fmtDate = (ts: number) => new Date(ts).toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' });
    return { locale, setLocale, t, ago, fmtDate };
  }, [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(I18nContext);
  if (!v) throw new Error('useI18n outside provider');
  return v;
}

export function LocaleSelect() {
  const { locale, setLocale, t } = useI18n();
  return (
    <select className="select locale-select" value={locale} onChange={(e) => setLocale(e.target.value)} aria-label={t('nav.language')} title={t('nav.language')}>
      {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
    </select>
  );
}
