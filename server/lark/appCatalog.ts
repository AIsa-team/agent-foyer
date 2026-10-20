/**
 * Lark apps an admin can pick from when adding entries to the Apps page: Lark's own features that have a documented
 * AppLink, and the apps installed in the company (read with the hub's app identity; needs admin:app.info:readonly).
 */
import { config } from '../config.ts';
import { tr } from '../i18n/index.ts';
import { getTenantToken } from './auth.ts';
import { LarkError, larkFetch, SCOPE_CODES } from './client.ts';

export interface CatalogItem { key: string; name: string; description: string; icon: string; url: string }

const applink = () => `https://applink.${config.lark.domain === 'feishu.cn' ? 'feishu.cn' : 'larksuite.com'}/client`;

/** Lark features with a documented AppLink that needs no app id; Lark has no API for their icons, so the hub ships its own. */
function builtins(locale: string): CatalogItem[] {
  return [
    { key: 'calendar', name: tr(locale, 'lark.app.calendar'), description: '', icon: '/lark/calendar.svg', url: `${applink()}/calendar/open` },
    { key: 'tasks', name: tr(locale, 'lark.app.tasks'), description: '', icon: '/lark/tasks.svg', url: `${applink()}/todo/open` },
  ];
}

interface LarkApp {
  app_id: string; app_name?: string; avatar_url?: string; description?: string; status?: number;
  pc_default_ability?: string; mobile_default_ability?: string;
  i18n?: { i18n_key: string; name?: string; description?: string }[];
}

/** How Lark opens an app, from what it can do on desktop (or else on mobile). */
function openUrl(a: LarkApp): string | null {
  const ability = a.pc_default_ability || a.mobile_default_ability;
  if (ability === 'web_app') return `${applink()}/web_app/open?appId=${a.app_id}`;
  if (ability === 'gadget') return `${applink()}/mini_program/open?appId=${a.app_id}&mode=appCenter`;
  if (ability === 'bot') return `${applink()}/bot/open?appId=${a.app_id}`;
  return null;
}

let cache: { at: number; locale: string; value: CatalogItem[] } | undefined;

async function installed(locale: string): Promise<CatalogItem[]> {
  if (cache && cache.locale === locale && Date.now() - cache.at < 10 * 60_000) return cache.value;
  // the languages Lark keeps app names in
  const lang = ({ zh: 'zh_cn', ja: 'ja_jp' } as Record<string, string>)[locale.split('-')[0]] ?? 'en_us';
  const token = await getTenantToken();
  const apps: LarkApp[] = [];
  let pageToken = '';
  do {
    const r = await larkFetch<{ data: { app_list?: LarkApp[]; page_token?: string; has_more?: boolean } }>(
      `/application/v6/applications?lang=${lang}&page_size=50${pageToken ? `&page_token=${pageToken}` : ''}`, { token });
    apps.push(...(r.data.app_list ?? []));
    pageToken = r.data.has_more ? r.data.page_token ?? '' : '';
  } while (pageToken && apps.length < 500);
  const value = apps
    // the hub itself is already the page you are on; disabled apps can't be opened
    .filter((a) => a.app_id !== config.lark.appId && a.status !== 0 && a.status !== 2)
    .map((a) => {
      const own = a.i18n?.find((x) => x.i18n_key === lang);
      const url = openUrl(a);
      return url && { key: a.app_id, name: own?.name || a.app_name || a.app_id, description: own?.description || a.description || '', icon: a.avatar_url ?? '', url };
    })
    .filter((x): x is CatalogItem => !!x)
    .sort((a, b) => a.name.localeCompare(b.name, locale));
  cache = { at: Date.now(), locale, value };
  return value;
}

/** What the picker offers. `installedMissing` says the company's apps need the admin:app.info:readonly scope. */
export async function larkAppCatalog(locale: string) {
  try {
    return { builtins: builtins(locale), installed: await installed(locale), installedMissing: false };
  } catch (e) {
    if (e instanceof LarkError && SCOPE_CODES.has(e.code)) return { builtins: builtins(locale), installed: [], installedMissing: true };
    throw e;
  }
}
