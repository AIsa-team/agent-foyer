import { config } from '../config.ts';
import { now, run } from '../db.ts';
import { upsertUser, type Identity } from '../auth/users.ts';
import type { DirectorySnapshot } from '../directory.ts';
import { larkFetch } from './client.ts';

export function larkAuthorizeUrl(redirectUri: string, state: string, scope?: string): string {
  const u = new URL(`${config.lark.accountsBase}/authen/v1/authorize`);
  u.searchParams.set('client_id', config.lark.appId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  if (scope) u.searchParams.set('scope', scope);
  return u.toString();
}

interface LarkUserInfo {
  open_id: string;
  name: string;
  en_name?: string;
  email?: string;
  enterprise_email?: string;
  avatar_url?: string;
}

export interface UserTokens { access_token: string; expires_in: number; refresh_token?: string; refresh_token_expires_in?: number; scope?: string }

/** Trades a login or data-connect code for the person's tokens and who they are. */
export async function exchangeCode(code: string, redirectUri: string): Promise<{ identity: Identity; tokens: UserTokens }> {
  const tokens = await larkFetch<UserTokens>('/authen/v2/oauth/token', {
    method: 'POST',
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: config.lark.appId,
      client_secret: config.lark.appSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const info = await larkFetch<{ data: LarkUserInfo }>('/authen/v1/user_info', { token: tokens.access_token });
  return { identity: identityOf({ ...info.data, avatar: { avatar_240: info.data.avatar_url } }), tokens };
}


let tenantToken: { value: string; expiresAt: number } | undefined;

export async function getTenantToken(): Promise<string> {
  if (tenantToken && tenantToken.expiresAt > now() + 60_000) return tenantToken.value;
  const res = await larkFetch<{ tenant_access_token: string; expire: number }>('/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    body: JSON.stringify({ app_id: config.lark.appId, app_secret: config.lark.appSecret }),
  });
  tenantToken = { value: res.tenant_access_token, expiresAt: now() + res.expire * 1000 };
  return tenantToken.value;
}


/** Contacts and departments as Lark returns them. */
type LarkDept = {
  open_department_id: string; name: string; parent_department_id?: string; leader_user_id?: string;
  i18n_name?: { zh_cn?: string; en_us?: string }; leaders?: { leaderType: number; leaderID: string }[];
};
type LarkContact = { open_id: string; name: string; en_name?: string; email?: string; enterprise_email?: string; avatar?: { avatar_240?: string } };
/** People are keyed by their Lark open_id; the company email wins over a personal one. */
const identityOf = (u: LarkContact): Identity => ({
  id: u.open_id, name: u.name, enName: u.en_name, email: u.enterprise_email || u.email, avatar: u.avatar?.avatar_240,
});
type Page<K extends string, T> = { data: { [k in K]?: T[] } & { page_token?: string; has_more: boolean } };

async function allPages<K extends string, T>(path: string, key: K, token: string): Promise<T[]> {
  const out: T[] = [];
  let pageToken = '';
  do {
    const r = await larkFetch<Page<K, T>>(`${path}${path.includes('?') ? '&' : '?'}page_size=50${pageToken ? `&page_token=${pageToken}` : ''}`, { token });
    out.push(...((r.data[key] as T[] | undefined) ?? []));
    pageToken = r.data.has_more ? r.data.page_token ?? '' : '';
  } while (pageToken);
  return out;
}

/**
 * The company directory as Lark has it, for the hub to keep people and departments in step (see ../directory.ts).
 * Reads only what the app's contact range covers (Lark returns it via /contact/v3/scopes), so it works whether the
 * range is the whole company or a few departments. Needs contact:contact.base:readonly.
 */
export async function readDirectory(): Promise<DirectorySnapshot> {
  const out: DirectorySnapshot = { departments: [], people: [], members: [] };
  if (config.devLogin) return out;
  const token = await getTenantToken();
  const scope = { departments: [] as string[], users: [] as string[] };
  let pageToken = '';
  do {
    const r = await larkFetch<{ data: { department_ids?: string[]; user_ids?: string[]; page_token?: string; has_more: boolean } }>(
      `/contact/v3/scopes?department_id_type=open_department_id&user_id_type=open_id&page_size=100${pageToken ? `&page_token=${pageToken}` : ''}`,
      { token },
    );
    scope.departments.push(...(r.data.department_ids ?? []));
    scope.users.push(...(r.data.user_ids ?? []));
    pageToken = r.data.has_more ? r.data.page_token ?? '' : '';
  } while (pageToken);

  const departments = new Set(scope.departments);
  const addDept = (d: LarkDept) => {
    const i18n: Record<string, string> = {};
    if (d.i18n_name?.zh_cn) i18n['zh-CN'] = d.i18n_name.zh_cn;
    if (d.i18n_name?.en_us) i18n.en = d.i18n_name.en_us;
    const leaders = [d.leader_user_id, ...(d.leaders ?? []).map((l) => l.leaderID)].filter((x): x is string => !!x);
    out.departments.push({ id: d.open_department_id, name: d.name, i18n, parentId: d.parent_department_id ?? null, leaderIds: [...new Set(leaders)] });
  };
  for (const dep of scope.departments) {
    try {
      const info = await larkFetch<{ data: { department: LarkDept } }>(`/contact/v3/departments/${dep}?department_id_type=open_department_id&user_id_type=open_id`, { token });
      addDept(info.data.department);
      const children = await allPages<'items', LarkDept>(
        `/contact/v3/departments/${dep}/children?fetch_child=true&department_id_type=open_department_id&user_id_type=open_id`, 'items', token);
      for (const c of children) {
        departments.add(c.open_department_id);
        addDept(c);
      }
    } catch (e) {
      console.warn('[lark] skip sub-departments of', dep, (e as Error).message);
    }
  }

  const seen = new Set<string>();
  const add = (u: LarkContact) => {
    if (seen.has(u.open_id)) return;
    seen.add(u.open_id);
    out.people.push(identityOf(u));
  };
  for (const dep of departments) {
    try {
      const users = await allPages<'items', LarkContact>(
        `/contact/v3/users/find_by_department?department_id=${dep}&department_id_type=open_department_id&user_id_type=open_id`, 'items', token);
      users.forEach(add);
      out.members.push({ departmentId: dep, userIds: users.map((u) => u.open_id) });
    } catch (e) {
      console.warn('[lark] skip members of department', dep, (e as Error).message);
    }
  }
  // people granted individually rather than through a department
  for (const id of scope.users) {
    if (seen.has(id)) continue;
    try {
      const r = await larkFetch<{ data: { user: LarkContact } }>(`/contact/v3/users/${id}?user_id_type=open_id`, { token });
      add(r.data.user);
    } catch (e) {
      console.warn('[lark] skip user', id, (e as Error).message);
    }
  }
  return out;
}
