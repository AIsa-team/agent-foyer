/**
 * Display name and one-line description of apps and Skills in several languages. Only the listing text is
 * translated; the app or Skill content stays as its author wrote it.
 */
import { config } from './config.ts';
import { isSupportedLocale, LOCALES, UserError } from './i18n/index.ts';

export interface LocalizedText { name?: string; description?: string }
export type LocalizedMap = Record<string, LocalizedText>;

const FALLBACK = ['en', 'zh-CN'];
export const localeCodes = () => LOCALES.map((l) => l.code);

export function parseLocalized(json: string | null | undefined): LocalizedMap {
  if (!json) return {};
  try {
    return JSON.parse(json) as LocalizedMap;
  } catch {
    return {};
  }
}

/** Text for a locale: that locale, then the fallback chain, then the base fields. */
export function localize(base: { name: string; description: string }, json: string | null, locale: string) {
  const map = parseLocalized(json);
  const order = [locale, config.defaultLocale, ...FALLBACK];
  const pick = (field: keyof LocalizedText) => {
    for (const code of order) {
      const v = map[code]?.[field]?.trim();
      if (v) return v;
    }
    return undefined;
  };
  return { name: pick('name') ?? base.name, description: pick('description') ?? base.description };
}

/**
 * Merges a patch into stored translations. Unknown languages are rejected so typos surface;
 * an empty string removes that field.
 */
export function mergeLocalized(json: string | null, patch: LocalizedMap | undefined): string | null {
  const map = parseLocalized(json);
  if (!patch) return json;
  for (const [code, text] of Object.entries(patch)) {
    if (!isSupportedLocale(code)) throw new UserError('err.localeUnsupported', { locale: code, supported: localeCodes().join(', ') });
    const next = { ...map[code] };
    for (const field of ['name', 'description'] as const) {
      const v = text?.[field];
      if (v === undefined) continue;
      const trimmed = v.trim().slice(0, field === 'name' ? 80 : 300);
      if (trimmed) next[field] = trimmed;
      else delete next[field];
    }
    if (next.name || next.description) map[code] = next;
    else delete map[code];
  }
  return Object.keys(map).length ? JSON.stringify(map) : null;
}

/** Languages that still lack a name or description, so agents can be nudged to fill them. */
export function missingLocales(json: string | null): string[] {
  const map = parseLocalized(json);
  return localeCodes().filter((c) => !map[c]?.name || !map[c]?.description);
}
