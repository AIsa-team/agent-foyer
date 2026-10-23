/**
 * Other services' MCP servers (Linear, Notion…) reached through the hub. An admin adds a service by its MCP address
 * and says who may use it; each person connects their own account there once (the service's own OAuth, which the
 * hub runs as an MCP client: discovery, dynamic registration, PKCE, refresh) and their agents then list and call
 * the service's tools through the hub's two tools, as that person. Tokens are kept encrypted per person; the
 * service decides what each person may do. Admins can switch off tools they do not want reached this way.
 *
 * A service can instead be tied to a data connection whose system has its own MCP server (Metabase): it is then
 * reached with that connection's key for everyone, nobody connects an account, and the hub's audience decides who
 * may use it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { config } from '../config.ts';
import { decrypt, encrypt, randomToken } from '../crypto.ts';
import { all, get, now, run, type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { connectionConfig } from '../data/connectors/index.ts';

export type Audience = { company?: boolean; people?: string[]; departments?: string[] };
interface ServiceRow { id: string; name: string; url: string; audience: string; disabled_tools: string; client_enc: string | null; connection_id: string | null; created_by: string; created_at: number; updated_at: number }
interface ConnRow { service_id: string; user_id: string; tokens_enc: string | null; verifier_enc: string | null; state: string | null; state_at: number | null; connected_at: number | null }

const CALLBACK = () => `${config.hubUrl}/auth/services/callback`;
export const serviceConnectUrl = (id: string, returnPath = '/me') => `${config.hubUrl}/auth/services/${encodeURIComponent(id)}/connect?return=${encodeURIComponent(returnPath)}`;

// ---------------------------------------------------------------- services (admins)
const serviceRow = (id: string) => get<ServiceRow>('SELECT * FROM mcp_services WHERE id = ?', id);
const audienceOf = (s: ServiceRow): Audience => JSON.parse(s.audience) as Audience;
const disabledOf = (s: ServiceRow): string[] => JSON.parse(s.disabled_tools) as string[];

export function mayUse(user: User, s: ServiceRow): boolean {
  if (user.role === 'admin') return true;
  const a = audienceOf(s);
  if (a.company || a.people?.includes(user.id)) return true;
  if (a.departments?.length) {
    const mine = all<{ department_id: string }>('SELECT department_id FROM user_departments WHERE user_id = ?', user.id).map((r) => r.department_id);
    return a.departments.some((d) => mine.includes(d));
  }
  return false;
}

const requireAdmin = (u: User) => { if (u.role !== 'admin') throw new UserError('err.noPermission'); };

/** The address and headers of a service tied to a data connection, from that connection's current settings. */
function sharedAccess(connectionId: string) {
  const { connector, cfg } = connectionConfig(connectionId);
  if (!connector.mcp) throw new UserError('err.services.noMcp', { type: connector.label });
  return connector.mcp(cfg);
}

export function saveService(user: User, input: { id: string; name: string; url?: string; connection?: string | null; audience?: Audience; disabledTools?: string[]; create?: boolean }) {
  requireAdmin(user);
  const id = input.id.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) throw new UserError('err.services.badId');
  const old = serviceRow(id);
  const connection = input.connection === undefined ? old?.connection_id ?? null : input.connection || null;
  let url: URL;
  try {
    url = new URL(connection ? sharedAccess(connection).url : (input.url ?? '').trim());
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError('err.services.badUrl');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname))) throw new UserError('err.services.badUrl');
  // the hub's own pages (e.g. the callback address given to the service) are never a service's MCP endpoint
  if (url.origin === new URL(config.hubUrl).origin && url.pathname !== '/mcp') throw new UserError('err.services.ownAddress');
  const name = input.name.trim().slice(0, 60) || id;
  // adding never replaces a service by accident; changing one goes through its settings
  if (input.create && old) throw new UserError('err.services.exists', { id });
  const audience = JSON.stringify(input.audience ?? (old ? audienceOf(old) : { company: true }));
  const disabled = JSON.stringify([...new Set(input.disabledTools ?? (old ? disabledOf(old) : []))]);
  if (old && (old.url !== url.toString() || old.connection_id !== connection)) {
    // another server or another way in: its registration and everyone's tokens no longer apply
    run('UPDATE mcp_services SET client_enc = NULL WHERE id = ?', id);
    run('DELETE FROM mcp_connections WHERE service_id = ?', id);
  }
  run(`INSERT INTO mcp_services (id, name, url, audience, disabled_tools, connection_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, audience = excluded.audience, disabled_tools = excluded.disabled_tools,
         connection_id = excluded.connection_id, updated_at = excluded.updated_at`,
  id, name, url.toString(), audience, disabled, connection, user.id, now(), now());
  forgetTools(id);
  return describeService(user, serviceRow(id)!);
}

export function deleteService(user: User, id: string) {
  requireAdmin(user);
  run('DELETE FROM mcp_services WHERE id = ?', id);
  forgetTools(id);
}

function describeService(user: User, s: ServiceRow) {
  const conn = get<ConnRow>('SELECT * FROM mcp_connections WHERE service_id = ? AND user_id = ?', s.id, user.id);
  return {
    id: s.id, name: s.name, url: s.url, shared: !!s.connection_id, connected: !!s.connection_id || !!conn?.tokens_enc, connectUrl: serviceConnectUrl(s.id),
    ...(user.role === 'admin' ? {
      audience: audienceOf(s), disabledTools: disabledOf(s), connection: s.connection_id,
      people: s.connection_id ? 0 : get<{ n: number }>('SELECT COUNT(*) AS n FROM mcp_connections WHERE service_id = ? AND tokens_enc IS NOT NULL', s.id)!.n,
    } : {}),
  };
}

/** The services this person may use, and whether they connected each. */
export const servicesFor = (user: User) => all<ServiceRow>('SELECT * FROM mcp_services ORDER BY name').filter((s) => mayUse(user, s)).map((s) => describeService(user, s));

function usable(user: User, id: string): ServiceRow {
  const s = serviceRow(id);
  if (!s || !mayUse(user, s)) throw new UserError('err.services.notFound', { id });
  return s;
}

// ---------------------------------------------------------------- the person's OAuth with a service
/** Keeps the hub's registration with the service, and this person's tokens and PKCE verifier, in the database. */
class Provider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  private s: ServiceRow;
  private userId: string;
  private pendingState?: string;
  constructor(s: ServiceRow, userId: string, pendingState?: string) {
    this.s = s;
    this.userId = userId;
    this.pendingState = pendingState;
  }
  get redirectUrl() { return CALLBACK(); }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: `${config.companyName} Hub`, redirect_uris: [CALLBACK()], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  state() { return this.pendingState ?? randomToken(16); }
  clientInformation() {
    const v = get<{ client_enc: string | null }>('SELECT client_enc FROM mcp_services WHERE id = ?', this.s.id)?.client_enc;
    return v ? (JSON.parse(decrypt(v)) as OAuthClientInformationMixed) : undefined;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    run('UPDATE mcp_services SET client_enc = ? WHERE id = ?', encrypt(JSON.stringify(info)), this.s.id);
  }
  private conn() { return get<ConnRow>('SELECT * FROM mcp_connections WHERE service_id = ? AND user_id = ?', this.s.id, this.userId); }
  private ensure() { run('INSERT OR IGNORE INTO mcp_connections (service_id, user_id) VALUES (?, ?)', this.s.id, this.userId); }
  tokens() {
    const v = this.conn()?.tokens_enc;
    return v ? (JSON.parse(decrypt(v)) as OAuthTokens) : undefined;
  }
  saveTokens(t: OAuthTokens) {
    this.ensure();
    run('UPDATE mcp_connections SET tokens_enc = ?, connected_at = COALESCE(connected_at, ?), verifier_enc = NULL, state = NULL WHERE service_id = ? AND user_id = ?',
      encrypt(JSON.stringify(t)), now(), this.s.id, this.userId);
  }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(v: string) {
    this.ensure();
    run('UPDATE mcp_connections SET verifier_enc = ? WHERE service_id = ? AND user_id = ?', encrypt(v), this.s.id, this.userId);
  }
  codeVerifier() {
    const v = this.conn()?.verifier_enc;
    if (!v) throw new UserError('err.services.expired');
    return decrypt(v);
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'client') run('UPDATE mcp_services SET client_enc = NULL WHERE id = ?', this.s.id);
    if (scope === 'all' || scope === 'tokens') run('UPDATE mcp_connections SET tokens_enc = NULL WHERE service_id = ? AND user_id = ?', this.s.id, this.userId);
    if (scope === 'all' || scope === 'verifier') run('UPDATE mcp_connections SET verifier_enc = NULL WHERE service_id = ? AND user_id = ?', this.s.id, this.userId);
  }
}

/** Starts connecting: the address of the service's consent page, or null when the person is connected already. */
export async function startConnect(user: User, id: string): Promise<string | null> {
  const s = usable(user, id);
  if (s.connection_id) return null;
  const state = randomToken(16);
  run('INSERT OR IGNORE INTO mcp_connections (service_id, user_id) VALUES (?, ?)', s.id, user.id);
  run('UPDATE mcp_connections SET state = ?, state_at = ? WHERE service_id = ? AND user_id = ?', state, now(), s.id, user.id);
  const p = new Provider(s, user.id, state);
  try {
    const r = await auth(p, { serverUrl: s.url });
    if (r === 'AUTHORIZED') return null;
  } catch (e) {
    throw new UserError('err.services.unreachable', { name: s.name, detail: (e as Error).message.slice(0, 200) });
  }
  if (!p.authorizationUrl) throw new UserError('err.services.unreachable', { name: s.name, detail: 'no authorization address' });
  return p.authorizationUrl.toString();
}

/** Back from the service's consent page: exchange the code for the person's tokens. Returns the service. */
export async function finishConnect(user: User, state: string, code: string): Promise<string> {
  const c = get<ConnRow>('SELECT * FROM mcp_connections WHERE state = ? AND user_id = ?', state, user.id);
  if (!c || !c.state_at || now() - c.state_at > 30 * 60_000) throw new UserError('err.services.expired');
  const s = usable(user, c.service_id);
  const r = await auth(new Provider(s, user.id, state), { serverUrl: s.url, authorizationCode: code });
  if (r !== 'AUTHORIZED') throw new UserError('err.services.expired');
  forgetTools(s.id, user.id);
  return s.id;
}

export function disconnect(user: User, id: string) {
  run('DELETE FROM mcp_connections WHERE service_id = ? AND user_id = ?', id, user.id);
  forgetTools(id, user.id);
}

// ---------------------------------------------------------------- tools, as the person
async function withClient<T>(user: User, s: ServiceRow, fn: (c: Client) => Promise<T>): Promise<T> {
  if (s.connection_id) return withSharedClient(s, s.connection_id, fn);
  const conn = get<ConnRow>('SELECT tokens_enc FROM mcp_connections WHERE service_id = ? AND user_id = ?', s.id, user.id);
  if (!conn?.tokens_enc) throw new UserError('err.services.notConnected', { name: s.name, url: serviceConnectUrl(s.id) });
  const client = new Client({ name: `${config.companyName} Hub`, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(s.url), { authProvider: new Provider(s, user.id) });
  try {
    await client.connect(transport);
    return await fn(client);
  } catch (e) {
    if (e instanceof UnauthorizedError || /unauthori[sz]ed|invalid_grant/i.test((e as Error).message)) {
      run('UPDATE mcp_connections SET tokens_enc = NULL WHERE service_id = ? AND user_id = ?', s.id, user.id);
      throw new UserError('err.services.reconnect', { name: s.name, url: serviceConnectUrl(s.id) });
    }
    throw e;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** A service tied to a data connection: its key, the same for everyone; a rejected key is for an admin to fix. */
async function withSharedClient<T>(s: ServiceRow, connectionId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const access = sharedAccess(connectionId);
  const client = new Client({ name: `${config.companyName} Hub`, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(access.url), { requestInit: { headers: access.headers } });
  try {
    await client.connect(transport);
    return await fn(client);
  } catch (e) {
    if (e instanceof UnauthorizedError || /\b401\b|unauthori[sz]ed/i.test((e as Error).message)) throw new UserError('err.services.sharedKey', { name: s.name });
    throw e;
  } finally {
    await client.close().catch(() => undefined);
  }
}

interface ToolInfo { name: string; description?: string; inputSchema: unknown; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string } }
const toolCache = new Map<string, { at: number; tools: ToolInfo[] }>();
function forgetTools(id: string, userId?: string) {
  for (const k of toolCache.keys()) if (k.startsWith(`${id}|`) && (!userId || k === `${id}|${userId}`)) toolCache.delete(k);
}

async function toolsOf(user: User, s: ServiceRow): Promise<ToolInfo[]> {
  // one identity for everyone: one list
  const key = `${s.id}|${s.connection_id ? '*' : user.id}`;
  const hit = toolCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.tools;
  const tools: ToolInfo[] = [];
  await withClient(user, s, async (c) => {
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r = await c.listTools(cursor ? { cursor } : undefined);
      tools.push(...(r.tools as ToolInfo[]));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
  });
  toolCache.set(key, { at: Date.now(), tools });
  return tools;
}

/** Services the person may use; with `id`, that service's tools (minus those an admin switched off) and their arguments. */
export async function listTools(user: User, id?: string) {
  if (!id) return servicesFor(user).map(({ id: sid, name, shared, connected, connectUrl }) => ({ service: sid, name, ...(shared ? { shared } : {}), connected, ...(connected ? {} : { connectUrl }) }));
  const s = usable(user, id);
  const off = new Set(disabledOf(s));
  const tools = (await toolsOf(user, s)).filter((t) => !off.has(t.name));
  return {
    service: s.id, name: s.name,
    tools: tools.map((t) => ({
      name: t.name, description: t.description ?? '', input: t.inputSchema,
      // what the service says about it; anything not marked read-only may change data
      readOnly: !!t.annotations?.readOnlyHint, ...(t.annotations?.destructiveHint ? { destructive: true } : {}),
    })),
  };
}

/** Every tool a service offers, switched off or not, for an admin choosing which to allow (read with their own connection). */
export async function adminTools(user: User, id: string) {
  requireAdmin(user);
  const s = usable(user, id);
  const off = new Set(disabledOf(s));
  return (await toolsOf(user, s)).map((t) => ({ name: t.name, description: t.description ?? '', readOnly: !!t.annotations?.readOnlyHint, enabled: !off.has(t.name) }));
}

/** Calls one tool of a service as the person and returns what it answered. */
export async function callTool(user: User, id: string, tool: string, args: Record<string, unknown>, agent: string) {
  const s = usable(user, id);
  if (disabledOf(s).includes(tool)) throw new UserError('err.services.toolOff', { tool, name: s.name });
  let ok = false;
  try {
    const r = await withClient(user, s, (c) => c.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 }));
    ok = !r.isError;
    return { service: s.id, tool, ok, ...(r.structuredContent ? { structured: r.structuredContent } : {}), content: r.content };
  } finally {
    run('INSERT INTO mcp_calls (service_id, user_id, agent, tool, ok, at) VALUES (?, ?, ?, ?, ?, ?)', s.id, user.id, agent, tool, ok ? 1 : 0, now());
  }
}
