/**
 * Each person's Linear connection: they agree once on Linear (read only), the hub keeps their tokens encrypted and
 * refreshes them (Linear access tokens last about a day). Everything is then read as that person, so the 项目 page
 * shows only the teams and projects they can see in Linear.
 */
import { config } from '../config.ts';
import { decrypt, encrypt } from '../crypto.ts';
import { get, now, run, type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';

export const linearEnabled = () => !!config.linear.clientId && !!config.linear.clientSecret;
export const CALLBACK = () => `${config.hubUrl}/auth/linear/callback`;
export const linearConnectUrl = (returnPath: string) => `${config.hubUrl}/auth/linear/connect?return=${encodeURIComponent(returnPath)}`;

interface Row { user_id: string; access_enc: string; refresh_enc: string | null; expires_at: number; linear_id: string | null; linear_name: string | null; workspace: string | null; connected_at: number }
interface Tokens { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }

export function linearAuthorizeUrl(state: string): string {
  const u = new URL(`${config.linear.authBase}/oauth/authorize`);
  u.searchParams.set('client_id', config.linear.clientId);
  u.searchParams.set('redirect_uri', CALLBACK());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'read');
  u.searchParams.set('state', state);
  u.searchParams.set('prompt', 'consent');
  return u.toString();
}

async function tokenRequest(params: Record<string, string>): Promise<Tokens & { access_token: string }> {
  const res = await fetch(`${config.linear.apiBase}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.linear.clientId, client_secret: config.linear.clientSecret, ...params }),
  });
  const t = (await res.json().catch(() => ({}))) as Tokens;
  if (!res.ok || !t.access_token) throw new Error(`Linear: ${t.error_description ?? t.error ?? res.status}`);
  return t as Tokens & { access_token: string };
}

function keep(userId: string, t: Tokens & { access_token: string }, who?: { id: string; name: string; workspace: string }) {
  const expires = now() + (t.expires_in ?? 86_400) * 1000;
  run(`INSERT INTO linear_connections (user_id, access_enc, refresh_enc, expires_at, linear_id, linear_name, workspace, connected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET access_enc = excluded.access_enc, refresh_enc = COALESCE(excluded.refresh_enc, refresh_enc),
         expires_at = excluded.expires_at, linear_id = COALESCE(excluded.linear_id, linear_id), linear_name = COALESCE(excluded.linear_name, linear_name),
         workspace = COALESCE(excluded.workspace, workspace)`,
  userId, encrypt(t.access_token), t.refresh_token ? encrypt(t.refresh_token) : null, expires, who?.id ?? null, who?.name ?? null, who?.workspace ?? null, now());
}

/** After the person agreed on Linear: keep their tokens and who they are there. */
export async function finishLinearLink(user: User, code: string) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK() });
  const me = await gqlWith<{ viewer: { id: string; name: string; organization: { name: string } } }>(t.access_token, '{ viewer { id name organization { name } } }');
  keep(user.id, t, { id: me.viewer.id, name: me.viewer.name, workspace: me.viewer.organization.name });
}

export function unlinkLinear(user: User) {
  run('DELETE FROM linear_connections WHERE user_id = ?', user.id);
}

export function linearStatus(user: User) {
  const r = get<Row>('SELECT * FROM linear_connections WHERE user_id = ?', user.id);
  return { available: linearEnabled(), connected: !!r, name: r?.linear_name ?? null, workspace: r?.workspace ?? null, connectUrl: linearConnectUrl('/projects') };
}

// ---------------------------------------------------------------- reading as the person
async function gqlWith<T>(token: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${config.linear.apiBase}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
  if (res.status === 401 || body.errors?.some((e) => /AUTHENTICATION/i.test(e.extensions?.code ?? ''))) throw new UnauthorizedError();
  if (!res.ok || body.errors?.length || !body.data) throw new Error(`Linear: ${body.errors?.map((e) => e.message).join('; ') || res.status}`);
  return body.data;
}
class UnauthorizedError extends Error {}

const refreshing = new Map<string, Promise<string>>();
/** The person's access token, refreshed when it is about to run out. */
async function tokenFor(user: User): Promise<string> {
  const r = get<Row>('SELECT * FROM linear_connections WHERE user_id = ?', user.id);
  if (!r) throw new UserError('err.linear.notConnected', { url: linearConnectUrl('/projects') });
  if (r.expires_at - now() > 5 * 60_000 || !r.refresh_enc) return decrypt(r.access_enc);
  const running = refreshing.get(user.id);
  if (running) return running;
  const p = tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(r.refresh_enc) })
    .then((t) => (keep(user.id, t), t.access_token))
    .finally(() => refreshing.delete(user.id));
  refreshing.set(user.id, p);
  return p;
}

/** A GraphQL query as the person; a connection Linear no longer accepts is dropped and they are asked to connect again. */
export async function linearQuery<T>(user: User, query: string, variables?: Record<string, unknown>): Promise<T> {
  try {
    return await gqlWith<T>(await tokenFor(user), query, variables);
  } catch (e) {
    if (e instanceof UnauthorizedError || /invalid_grant/.test((e as Error).message)) {
      unlinkLinear(user);
      throw new UserError('err.linear.reconnect', { url: linearConnectUrl('/projects') });
    }
    throw e;
  }
}
