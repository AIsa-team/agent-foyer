import { config } from '../config.ts';
import { escapeHtml } from '../html.ts';
import en from './locales/en.ts';
import zhCN, { type MessageKey } from './locales/zh-CN.ts';

export type { MessageKey };
export type Params = Record<string, string | number>;
type Messages = Partial<Record<MessageKey, string>>;

/**
 * Server languages; keep the codes in step with web/src/i18n/locales. To add one, create locales/<code>.ts
 * (missing keys fall back to English, then Simplified Chinese) and list it here.
 */
export const LOCALES: { code: string; messages: Messages }[] = [
  { code: 'zh-CN', messages: zhCN },
  { code: 'en', messages: en },
];
const FALLBACK_CHAIN = ['en', 'zh-CN'];

export const isSupportedLocale = (code: unknown): code is string => typeof code === 'string' && LOCALES.some((l) => l.code === code);

/** Best supported match for BCP 47 tags: exact first, then by base language. */
export function matchLocale(prefs: string[]): string | undefined {
  for (const p of prefs) {
    const exact = LOCALES.find((l) => l.code.toLowerCase() === p.toLowerCase());
    if (exact) return exact.code;
    const base = p.split('-')[0].toLowerCase();
    const loose = LOCALES.find((l) => l.code.split('-')[0].toLowerCase() === base);
    if (loose) return loose.code;
  }
  return undefined;
}

function parseAcceptLanguage(header: string | undefined | null): string[] {
  return (header ?? '')
    .split(',')
    .map((part) => {
      const [tag, ...rest] = part.trim().split(';');
      const q = Number(rest.find((r) => r.trim().startsWith('q='))?.trim().slice(2) ?? 1);
      return { tag, q: Number.isFinite(q) ? q : 0 };
    })
    .filter((x) => x.tag && x.tag !== '*')
    .sort((a, b) => b.q - a.q)
    .map((x) => x.tag);
}

/** Locale for a request: explicit header from the web UI, then the UI's cookie, then Accept-Language, then the default. */
export function requestLocale(get: (header: string) => string | undefined | null): string {
  const explicit = get('x-hub-locale');
  if (isSupportedLocale(explicit)) return explicit;
  const cookie = /(?:^|;\s*)hub_locale=([^;]+)/.exec(get('cookie') ?? '')?.[1];
  if (cookie) {
    const decoded = (() => {
      try {
        return decodeURIComponent(cookie);
      } catch {
        return cookie;
      }
    })();
    if (isSupportedLocale(decoded)) return decoded;
  }
  return matchLocale(parseAcceptLanguage(get('accept-language'))) ?? config.defaultLocale;
}

export function tr(locale: string, key: MessageKey, params?: Params): string {
  let msg: string | undefined;
  for (const code of [locale, ...FALLBACK_CHAIN]) {
    msg = LOCALES.find((l) => l.code === code)?.messages[key];
    if (msg !== undefined) break;
  }
  if (msg === undefined) return key;
  return params ? msg.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : msg;
}

/** Like tr, but HTML-escaped, with each parameter value shown in bold. */
export function trHtml(locale: string, key: MessageKey, params: Params = {}): string {
  const bolded: Params = {};
  for (const [k, v] of Object.entries(params)) bolded[k] = `\u0000${k}\u0000`;
  return escapeHtml(tr(locale, key, bolded)).replace(/\u0000(\w+)\u0000/g, (_m, k: string) => `<b>${escapeHtml(String(params[k]))}</b>`);
}

/** A message to show a person, resolved into their language at the edge (web API or MCP). */
export class UserError extends Error {
  key: MessageKey;
  params: Params;
  constructor(key: MessageKey, params: Params = {}) {
    super(tr(config.defaultLocale, key, params));
    this.key = key;
    this.params = params;
  }
  localized(locale: string): string {
    return tr(locale, this.key, this.params);
  }
}

/** Untranslated message reference, e.g. publish notes that are translated by whoever shows them. */
export interface Msg { key: MessageKey; params?: Params }
