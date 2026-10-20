/**
 * The resources page ("资料"): company culture (mission, vision, values) and grouped links to policies/SOPs
 * and brand material. All text is stored per language; admins edit it in the UI or through their agent (MCP).
 */
import { all, get, now, run, tx, type User } from './db.ts';
import { isSupportedLocale, UserError } from './i18n/index.ts';
import { localeCodes } from './localized.ts';

/** Text in several languages: { "zh-CN": "...", "en": "..." } */
export type I18nText = Record<string, string>;

export interface Culture {
  mission?: I18nText;
  vision?: I18nText;
  values?: { icon?: string; title: I18nText; description?: I18nText }[];
}

const FALLBACK = ['en', 'zh-CN'];

export function pick(text: I18nText | null | undefined, locale: string): string {
  if (!text) return '';
  for (const code of [locale, ...FALLBACK, ...Object.keys(text)]) if (text[code]?.trim()) return text[code];
  return '';
}

function parse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/** Validates language keys and trims; empty strings drop the language. */
function cleanText(t: unknown, max = 500): I18nText {
  if (t === undefined || t === null) return {};
  if (typeof t === 'string') throw new UserError('err.library.textNeedsLanguages', { supported: localeCodes().join(', ') });
  const out: I18nText = {};
  for (const [code, v] of Object.entries(t as Record<string, unknown>)) {
    if (!isSupportedLocale(code)) throw new UserError('err.localeUnsupported', { locale: code, supported: localeCodes().join(', ') });
    const s = String(v ?? '').trim().slice(0, max);
    if (s) out[code] = s;
  }
  return out;
}

const requireAdmin = (u: User) => {
  if (u.role !== 'admin') throw new UserError('err.adminOnly');
};

export function getCulture(): Culture {
  return parse<Culture>(get<{ value: string }>("SELECT value FROM settings WHERE key = 'culture'")?.value, {});
}

export function setCulture(user: User, patch: Culture) {
  requireAdmin(user);
  const cur = getCulture();
  const next: Culture = {
    mission: patch.mission !== undefined ? cleanText(patch.mission) : cur.mission,
    vision: patch.vision !== undefined ? cleanText(patch.vision) : cur.vision,
    values: patch.values !== undefined
      ? patch.values.slice(0, 12).map((v) => ({ icon: v.icon?.slice(0, 40), title: cleanText(v.title, 40), description: cleanText(v.description, 200) }))
      : cur.values,
  };
  run(`INSERT INTO settings (key, value, updated_at) VALUES ('culture', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, JSON.stringify(next), now());
  return next;
}

interface GroupRow { id: number; section: string; name_i18n: string; note_i18n: string | null; sort: number }
interface ResourceRow {
  id: number; group_id: number; title_i18n: string; desc_i18n: string | null; url: string; owner_name: string | null;
  preview: string | null; app_slug: string | null; skill_slug: string | null; sort: number; updated_at: number;
}

const SECTIONS = ['policies', 'brand'];

/** Everything the page shows, in `locale`. `raw` keeps all languages for editors. */
export function library(locale: string, raw = false) {
  const culture = getCulture();
  const groups = all<GroupRow>('SELECT * FROM resource_groups ORDER BY sort, id');
  const items = all<ResourceRow>('SELECT * FROM resources ORDER BY sort, id');
  const view = (r: ResourceRow) => ({
    id: r.id,
    title: pick(parse<I18nText>(r.title_i18n, {}), locale),
    description: pick(parse<I18nText>(r.desc_i18n, {}), locale),
    url: r.url,
    owner: r.owner_name,
    preview: r.preview,
    appSlug: r.app_slug,
    skillSlug: r.skill_slug,
    updatedAt: r.updated_at,
    ...(raw ? { titleI18n: parse<I18nText>(r.title_i18n, {}), descI18n: parse<I18nText>(r.desc_i18n, {}) } : {}),
  });
  return {
    culture: {
      mission: pick(culture.mission, locale),
      vision: pick(culture.vision, locale),
      values: (culture.values ?? []).map((v) => ({ icon: v.icon, title: pick(v.title, locale), description: pick(v.description, locale) })),
      ...(raw ? { raw: culture } : {}),
    },
    sections: SECTIONS.map((section) => ({
      section,
      groups: groups.filter((g) => g.section === section).map((g) => ({
        id: g.id,
        name: pick(parse<I18nText>(g.name_i18n, {}), locale),
        note: pick(parse<I18nText>(g.note_i18n, {}), locale),
        ...(raw ? { nameI18n: parse<I18nText>(g.name_i18n, {}), noteI18n: parse<I18nText>(g.note_i18n, {}) } : {}),
        items: items.filter((r) => r.group_id === g.id).map(view),
      })),
    })),
  };
}

export function upsertGroup(user: User, g: { id?: number; section: string; name: I18nText; note?: I18nText; sort?: number }) {
  requireAdmin(user);
  if (!SECTIONS.includes(g.section)) throw new UserError('err.library.badSection', { sections: SECTIONS.join(', ') });
  const name = cleanText(g.name, 60);
  if (!Object.keys(name).length) throw new UserError('err.library.nameRequired');
  const note = g.note ? JSON.stringify(cleanText(g.note, 60)) : null;
  if (g.id) {
    run('UPDATE resource_groups SET section = ?, name_i18n = ?, note_i18n = ?, sort = COALESCE(?, sort) WHERE id = ?', g.section, JSON.stringify(name), note, g.sort ?? null, g.id);
    return g.id;
  }
  return Number(run('INSERT INTO resource_groups (section, name_i18n, note_i18n, sort) VALUES (?, ?, ?, ?)', g.section, JSON.stringify(name), note, g.sort ?? 0).lastInsertRowid);
}

export function deleteGroup(user: User, id: number) {
  requireAdmin(user);
  run('DELETE FROM resource_groups WHERE id = ?', id);
}

export function upsertResource(user: User, r: {
  id?: number; groupId: number; title: I18nText; description?: I18nText; url: string; owner?: string;
  preview?: string; appSlug?: string; skillSlug?: string; sort?: number;
}) {
  requireAdmin(user);
  if (!get('SELECT 1 FROM resource_groups WHERE id = ?', r.groupId)) throw new UserError('err.library.groupNotFound', { id: r.groupId });
  if (!/^https?:\/\//.test(r.url ?? '')) throw new UserError('err.library.urlInvalid');
  const title = cleanText(r.title, 120);
  if (!Object.keys(title).length) throw new UserError('err.library.nameRequired');
  const desc = r.description ? JSON.stringify(cleanText(r.description, 300)) : null;
  const preview = r.preview && ['brand', 'slides', 'ui'].includes(r.preview) ? r.preview : null;
  return tx(() => {
    if (r.id) {
      run(`UPDATE resources SET group_id = ?, title_i18n = ?, desc_i18n = ?, url = ?, owner_name = ?, preview = ?, app_slug = ?, skill_slug = ?,
             sort = COALESCE(?, sort), updated_at = ? WHERE id = ?`,
        r.groupId, JSON.stringify(title), desc, r.url, r.owner ?? null, preview, r.appSlug ?? null, r.skillSlug ?? null, r.sort ?? null, now(), r.id);
      return r.id;
    }
    return Number(run(`INSERT INTO resources (group_id, title_i18n, desc_i18n, url, owner_name, preview, app_slug, skill_slug, sort, created_by, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.groupId, JSON.stringify(title), desc, r.url, r.owner ?? null, preview, r.appSlug ?? null, r.skillSlug ?? null, r.sort ?? 0, user.id, now(), now()).lastInsertRowid);
  });
}

export function deleteResource(user: User, id: number) {
  requireAdmin(user);
  run('DELETE FROM resources WHERE id = ?', id);
}
