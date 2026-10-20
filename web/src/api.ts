export type Visibility = 'private' | 'members' | 'company' | 'public';

export type LocalizedMap = Record<string, { name?: string; description?: string }>;

export interface Person { id: string; name: string; avatar: string | null; email?: string | null; en_name?: string | null }

export interface AppInfo {
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  url: string;
  host: string;
  kind: 'static' | 'container';
  visibility: Visibility;
  publicStatus: 'none' | 'pending' | 'approved' | 'rejected';
  status: 'building' | 'online' | 'stopped' | 'failed';
  version: number | null;
  owner: Person | null;
  canManage: boolean;
  canOpen: boolean;
  members?: Person[];
  envKeys?: string[];
  localized?: LocalizedMap;
  relatedSkill: { slug: string; name: string; icon: string | null } | null;
  updatedAt: number;
}

export interface SkillInfo {
  slug: string;
  name: string;
  description: string;
  version: number;
  listed: boolean;
  owner: Person;
  installs: number;
  myVersion: number | null;
  hasUpdate: boolean;
  canManage: boolean;
  localized?: LocalizedMap;
  icon: string | null;
  relatedApp: { slug: string; name: string; url: string; canOpen: boolean; icon: string | null } | null;
  updatedAt: number;
}

export interface LarkLink { id: number; name: string; description: string; url: string; icon: string }

export interface Agent { id: string; name: string; connectedAt: number; lastUsedAt: number }

export interface Me {
  user: { id: string; name: string; email: string | null; avatar: string | null; role: 'admin' | 'member'; locale: string | null };
  hub: { url: string; mcpUrl: string; mcpName: string; appsDomain: string; companyName: string; accent: string | null; devLogin: boolean };
}

export class ApiError extends Error {
  status: number;
  /** server message key, e.g. err.lark.notConnected, for errors the UI handles specially */
  code?: string;
  params?: Record<string, string | number>;
  constructor(status: number, message: string, code?: string, params?: Record<string, string | number>) {
    super(message);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch('/api' + path, {
    method,
    headers: {
      ...(body !== undefined || method !== 'GET' ? { 'content-type': 'application/json' } : {}),
      'x-hub-locale': document.documentElement.lang,
    },
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    location.href = `/auth/login?return=${encodeURIComponent(location.pathname + location.search)}`;
    throw new ApiError(401, 'Please sign in');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string; params?: Record<string, string | number> };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.code, data.params);
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  patch: <T>(p: string, b: unknown) => request<T>('PATCH', p, b),
  del: <T>(p: string, b?: unknown) => request<T>('DELETE', p, b ?? {}),
};

export const VISIBILITY_KEYS: Visibility[] = ['private', 'members', 'company', 'public'];
