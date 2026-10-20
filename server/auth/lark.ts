import { config } from '../config.ts';
import { all, get, now, run, tx, type User } from '../db.ts';
import { larkFetch } from '../lark/client.ts';

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
export async function exchangeCode(code: string, redirectUri: string): Promise<{ info: LarkUserInfo; tokens: UserTokens }> {
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
  return { info: info.data, tokens };
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

export function upsertUser(info: { open_id: string; name: string; en_name?: string; email?: string; enterprise_email?: string; avatar_url?: string }, touch = true): User {
  const email = info.enterprise_email || info.email || null;
  return tx(() => {
    const isFirst = !get('SELECT 1 FROM users LIMIT 1');
    const isConfiguredAdmin = config.admins.includes(info.open_id) || (!!email && config.admins.includes(email));
    run(
      `INSERT INTO users (id, name, en_name, email, avatar, role, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, en_name = excluded.en_name, email = excluded.email,
         avatar = excluded.avatar, last_seen_at = COALESCE(excluded.last_seen_at, users.last_seen_at),
         role = CASE WHEN ? THEN 'admin' ELSE users.role END`,
      info.open_id, info.name, info.en_name ?? null, email, info.avatar_url ?? null,
      isFirst || isConfiguredAdmin ? 'admin' : 'member', now(), touch ? now() : null, isConfiguredAdmin ? 1 : 0,
    );
    return get<User>('SELECT * FROM users WHERE id = ?', info.open_id)!;
  });
}

/**
 * Pull the company directory so people can be picked as app members before they ever log in.
 * Needs the contact:user.base:readonly + contact:department.base:readonly scopes and a contact range covering the company.
 */
type LarkDept = {
  open_department_id: string; name: string; parent_department_id?: string; leader_user_id?: string;
  i18n_name?: { zh_cn?: string; en_us?: string }; leaders?: { leaderType: number; leaderID: string }[];
};
type LarkContact = { open_id: string; name: string; en_name?: string; email?: string; enterprise_email?: string; avatar?: { avatar_240?: string } };
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
 * Pull the company directory so people can be picked as app members before they ever log in.
 * Reads only what the app's contact range covers (Lark returns it via /contact/v3/scopes), so it works
 * whether the range is the whole company or a few departments. Needs contact:contact.base:readonly.
 */
export async function syncDirectory(): Promise<number> {
  if (config.devLogin) return 0;
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
  const saveDept = (d: LarkDept) => {
    const i18n: Record<string, string> = {};
    if (d.i18n_name?.zh_cn) i18n['zh-CN'] = d.i18n_name.zh_cn;
    if (d.i18n_name?.en_us) i18n.en = d.i18n_name.en_us;
    const leaders = [d.leader_user_id, ...(d.leaders ?? []).map((l) => l.leaderID)].filter(Boolean);
    run(
      `INSERT INTO departments (id, name, name_i18n, parent_id, leader_ids, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_i18n = excluded.name_i18n, parent_id = excluded.parent_id,
         leader_ids = excluded.leader_ids, updated_at = excluded.updated_at`,
      d.open_department_id, d.name, Object.keys(i18n).length ? JSON.stringify(i18n) : null, d.parent_department_id ?? null, JSON.stringify([...new Set(leaders)]), now(),
    );
  };
  for (const dep of scope.departments) {
    try {
      const info = await larkFetch<{ data: { department: LarkDept } }>(`/contact/v3/departments/${dep}?department_id_type=open_department_id&user_id_type=open_id`, { token });
      saveDept(info.data.department);
      const children = await allPages<'items', LarkDept>(
        `/contact/v3/departments/${dep}/children?fetch_child=true&department_id_type=open_department_id&user_id_type=open_id`, 'items', token);
      for (const c of children) {
        departments.add(c.open_department_id);
        saveDept(c);
      }
    } catch (e) {
      console.warn('[lark] skip sub-departments of', dep, (e as Error).message);
    }
  }

  const seen = new Set<string>();
  const save = (u: LarkContact) => {
    if (seen.has(u.open_id)) return;
    seen.add(u.open_id);
    upsertUser({ ...u, avatar_url: u.avatar?.avatar_240 }, false);
  };
  for (const dep of departments) {
    try {
      const users = await allPages<'items', LarkContact>(
        `/contact/v3/users/find_by_department?department_id=${dep}&department_id_type=open_department_id&user_id_type=open_id`, 'items', token);
      users.forEach(save);
      // membership is refreshed per department, so moves between departments are picked up
      run('DELETE FROM user_departments WHERE department_id = ?', dep);
      for (const u of users) run('INSERT OR IGNORE INTO user_departments (user_id, department_id) VALUES (?, ?)', u.open_id, dep);
    } catch (e) {
      console.warn('[lark] skip members of department', dep, (e as Error).message);
    }
  }
  // people granted individually rather than through a department
  for (const id of scope.users) {
    if (seen.has(id)) continue;
    try {
      const r = await larkFetch<{ data: { user: LarkContact } }>(`/contact/v3/users/${id}?user_id_type=open_id`, { token });
      save(r.data.user);
    } catch (e) {
      console.warn('[lark] skip user', id, (e as Error).message);
    }
  }
  return seen.size;
}

/** Fake people for local development without a Lark app; removed again once Lark login is configured. */
export function seedDevUsers() {
  if (!config.devLogin) {
    run(`DELETE FROM users WHERE id LIKE 'ou_dev_%'
         AND NOT EXISTS (SELECT 1 FROM apps WHERE owner_id = users.id) AND NOT EXISTS (SELECT 1 FROM skills WHERE owner_id = users.id)`);
    return;
  }
  if (all('SELECT 1 FROM users LIMIT 1').length) return;
  const people = [
    { open_id: 'ou_dev_alex', name: 'Alex', email: 'alex@example.com' },
    { open_id: 'ou_dev_alice', name: '林小雨', email: 'alice@example.com' },
    { open_id: 'ou_dev_bob', name: '周明', email: 'bob@example.com' },
  ];
  for (const p of people) upsertUser(p, false);
}
