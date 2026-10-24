/**
 * Minimal OAuth 2.1 authorization server so agents (Claude Code, Codex, Cursor...) can connect to the hub MCP
 * with a browser login: discovery metadata, dynamic client registration, PKCE authorization code, refresh tokens.
 * Identity comes from the hub session, which comes from Lark login.
 */
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { config } from '../config.ts';
import { agentVersionOf, deviceOf } from './device.ts';
import { randomToken, sha256, sha256b64url, signToken, verifyToken } from '../crypto.ts';
import { get, now, run, tx, type User } from '../db.ts';
import { HUB_COOKIE, sessionUser } from './session.ts';
import { escapeHtml, page } from '../html.ts';
import { requestLocale, tr, trHtml, type MessageKey } from '../i18n/index.ts';

const ACCESS_TTL = 7 * 24 * 3600 * 1000;
const REFRESH_TTL = 180 * 24 * 3600 * 1000;
export const MCP_PATH = '/mcp';

export const oauth = new Hono();

const metadata = () => ({
  issuer: config.hubUrl,
  authorization_endpoint: `${config.hubUrl}/oauth/authorize`,
  token_endpoint: `${config.hubUrl}/oauth/token`,
  registration_endpoint: `${config.hubUrl}/oauth/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: ['hub'],
});
const resourceMetadata = () => ({
  resource: `${config.hubUrl}${MCP_PATH}`,
  authorization_servers: [config.hubUrl],
  bearer_methods_supported: ['header'],
  scopes_supported: ['hub'],
  resource_name: `${config.companyName} Hub`,
});

oauth.get('/.well-known/oauth-authorization-server', (c) => c.json(metadata()));
oauth.get('/.well-known/oauth-authorization-server/*', (c) => c.json(metadata()));
oauth.get('/.well-known/openid-configuration', (c) => c.json(metadata()));
oauth.get('/.well-known/oauth-protected-resource', (c) => c.json(resourceMetadata()));
oauth.get('/.well-known/oauth-protected-resource/*', (c) => c.json(resourceMetadata()));

function isLoopback(u: URL) {
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

/**
 * https, loopback http (CLI agents), or a native app scheme like cursor:// (desktop agents).
 * The character whitelist keeps a URI from ever carrying markup.
 */
function redirectUriShapeOk(u: string): boolean {
  if (u.length > 500 || !/^[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+$/.test(u)) return false;
  let p: URL;
  try {
    p = new URL(u);
  } catch {
    return false;
  }
  if (p.protocol === 'https:') return true;
  if (p.protocol === 'http:') return isLoopback(p);
  // native schemes: reverse-DNS style or a plain app name, never script-capable ones
  return /^[a-z][a-z0-9+.-]*:$/.test(p.protocol) && !['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:'].includes(p.protocol);
}

/** RFC 8252: loopback redirect URIs may use any port. */
function redirectAllowed(registered: string[], uri: string): boolean {
  let target: URL;
  try {
    target = new URL(uri);
  } catch {
    return false;
  }
  return registered.some((r) => {
    if (r === uri) return true;
    const reg = new URL(r);
    return isLoopback(reg) && isLoopback(target) && reg.hostname === target.hostname && reg.pathname === target.pathname;
  });
}

oauth.post('/oauth/register', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { redirect_uris?: unknown; client_name?: unknown };
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  if (!uris.length) return c.json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' }, 400);
  for (const u of uris) {
    if (!redirectUriShapeOk(u)) return c.json({ error: 'invalid_redirect_uri', error_description: `Not allowed: ${u}` }, 400);
  }
  const clientName = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : 'Agent';
  const clientId = 'agt_' + randomToken(16);
  run('INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)', clientId, clientName, JSON.stringify(uris), now());
  return c.json({
    client_id: clientId,
    client_name: clientName,
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_id_issued_at: Math.floor(now() / 1000),
  }, 201);
});

interface Client { client_id: string; client_name: string; redirect_uris: string }

function readAuthorizeParams(q: Record<string, string>): { error: MessageKey } | { client: Client; redirectUri: string; state: string; challenge: string } {
  const client = get<Client>('SELECT * FROM oauth_clients WHERE client_id = ?', q.client_id ?? '');
  if (!client) return { error: 'oauth.invalidClient' };
  if (!q.redirect_uri || !redirectAllowed(JSON.parse(client.redirect_uris), q.redirect_uri)) return { error: 'oauth.redirectMismatch' };
  if (q.response_type !== 'code') return { error: 'oauth.responseType' };
  if (!q.code_challenge || (q.code_challenge_method ?? 'plain') !== 'S256') return { error: 'oauth.pkce' };
  return { client, redirectUri: q.redirect_uri, state: q.state ?? '', challenge: q.code_challenge };
}

const cannotConnect = (L: string, key: MessageKey) =>
  page(tr(L, 'oauth.cannotConnect'), `<h1>${escapeHtml(tr(L, 'oauth.cannotConnect'))}</h1><p>${escapeHtml(tr(L, key))}</p>`, L);

oauth.get('/oauth/authorize', (c) => {
  const user = sessionUser(getCookie(c, HUB_COOKIE));
  const url = new URL(c.req.url);
  if (!user) return c.redirect(`/auth/login?return=${encodeURIComponent(url.pathname + url.search)}`);
  const L = requestLocale((h) => c.req.header(h));
  const p = readAuthorizeParams(c.req.query());
  if ('error' in p) return c.html(cannotConnect(L, p.error), 400);
  const target = new URL(p.redirectUri);
  const where = isLoopback(target) ? tr(L, 'oauth.where.local')
    : target.protocol === 'https:' ? target.host
    : tr(L, 'oauth.where.nativeApp', { scheme: target.protocol.replace(/:$/, '') });
  return c.html(page(tr(L, 'oauth.consent.title'), `
    <h1>${escapeHtml(tr(L, 'oauth.consent.heading', { client: p.client.client_name, company: config.companyName }))}</h1>
    <p>${trHtml(L, 'oauth.consent.body', { user: user.name, where })}</p>
    <form method="post" action="/oauth/authorize${escapeHtml(url.search)}">
      <input type="hidden" name="csrf" value="${escapeHtml(consentToken(user.id, p.client.client_id))}">
      <button name="decision" value="allow" class="primary">${escapeHtml(tr(L, 'oauth.allow'))}</button>
      <button name="decision" value="deny">${escapeHtml(tr(L, 'oauth.deny'))}</button>
    </form>`, L));
});

oauth.post('/oauth/authorize', async (c) => {
  const user = sessionUser(getCookie(c, HUB_COOKIE));
  if (!user) return c.text('Not logged in', 401);
  const L = requestLocale((h) => c.req.header(h));
  const p = readAuthorizeParams(c.req.query());
  if ('error' in p) return c.html(cannotConnect(L, p.error), 400);
  const form = await c.req.parseBody();
  // consent must come from our own page: same-site app subdomains could otherwise auto-submit this form
  const origin = c.req.header('origin');
  if ((origin && origin !== config.hubUrl) || !verifyToken(`consent:${user.id}:${p.client.client_id}`, String(form.csrf ?? ''))) {
    return c.html(page(tr(L, 'oauth.expired.title'), `<h1>${escapeHtml(tr(L, 'oauth.expired.heading'))}</h1><p>${escapeHtml(tr(L, 'oauth.expired.body'))}</p>`, L), 403);
  }
  const back = new URL(p.redirectUri);
  if (p.state) back.searchParams.set('state', p.state);
  if (form.decision !== 'allow') {
    back.searchParams.set('error', 'access_denied');
    return c.redirect(back.toString());
  }
  const code = randomToken();
  // the browser the person allows it in is usually on the device the agent runs on
  run(
    'INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at, device) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sha256(code), p.client.client_id, user.id, p.redirectUri, p.challenge, now() + 5 * 60 * 1000, deviceOf(c.req.header('user-agent')),
  );
  back.searchParams.set('code', code);
  return c.redirect(back.toString(), 302);
});

const consentToken = (userId: string, clientId: string) => signToken(`consent:${userId}:${clientId}`, 15 * 60 * 1000);

function issueTokens(userId: string, clientId: string, clientName: string, device?: string | null) {
  const access = 'hub_at_' + randomToken();
  const refresh = 'hub_rt_' + randomToken();
  run('INSERT INTO tokens (token_hash, kind, user_id, client_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', sha256(access), 'access', userId, clientId, now() + ACCESS_TTL, now());
  run('INSERT INTO tokens (token_hash, kind, user_id, client_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', sha256(refresh), 'refresh', userId, clientId, now() + REFRESH_TTL, now());
  run(
    `INSERT INTO agent_connections (user_id, client_id, client_name, connected_at, last_used_at, device) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, client_id) DO UPDATE SET last_used_at = excluded.last_used_at, device = COALESCE(excluded.device, agent_connections.device)`,
    userId, clientId, clientName, now(), now(), device ?? null,
  );
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: 'hub' };
}

oauth.post('/oauth/token', async (c) => {
  const ct = c.req.header('content-type') ?? '';
  const body = (ct.includes('application/json') ? await c.req.json() : await c.req.parseBody()) as Record<string, string>;
  const err = (error: string, desc: string) => c.json({ error, error_description: desc }, 400);
  const client = get<Client>('SELECT * FROM oauth_clients WHERE client_id = ?', body.client_id ?? '');
  if (!client) return err('invalid_client', 'unknown client_id');

  if (body.grant_type === 'authorization_code') {
    const row = get<{ user_id: string; redirect_uri: string; code_challenge: string; expires_at: number; client_id: string; device: string | null }>(
      'SELECT * FROM oauth_codes WHERE code_hash = ?', sha256(body.code ?? ''),
    );
    run('DELETE FROM oauth_codes WHERE code_hash = ?', sha256(body.code ?? ''));
    if (!row || row.expires_at < now() || row.client_id !== client.client_id) return err('invalid_grant', 'code invalid or expired');
    if (row.redirect_uri !== body.redirect_uri) return err('invalid_grant', 'redirect_uri mismatch');
    if (!body.code_verifier || sha256b64url(body.code_verifier) !== row.code_challenge) return err('invalid_grant', 'PKCE verification failed');
    return c.json(issueTokens(row.user_id, client.client_id, client.client_name, row.device));
  }

  if (body.grant_type === 'refresh_token') {
    const hash = sha256(body.refresh_token ?? '');
    const row = get<{ user_id: string; client_id: string; expires_at: number }>("SELECT * FROM tokens WHERE token_hash = ? AND kind = 'refresh'", hash);
    if (!row || row.expires_at < now() || row.client_id !== client.client_id) return err('invalid_grant', 'refresh token invalid or expired');
    return c.json(tx(() => {
      run('DELETE FROM tokens WHERE token_hash = ?', hash);
      return issueTokens(row.user_id, client.client_id, client.client_name);
    }));
  }
  return err('unsupported_grant_type', String(body.grant_type));
});

/** Personal access token for agents that cannot do the browser OAuth flow. */
export function createPersonalToken(userId: string, agentName: string, device?: string | null): string {
  const token = 'hub_pat_' + randomToken();
  const clientId = 'pat:' + randomToken(6);
  run('INSERT INTO tokens (token_hash, kind, user_id, client_id, expires_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)', sha256(token), 'pat', userId, clientId, now());
  run('INSERT INTO agent_connections (user_id, client_id, client_name, connected_at, last_used_at, device) VALUES (?, ?, ?, ?, ?, ?)', userId, clientId, agentName, now(), now(), device ?? null);
  return token;
}

export function disconnectAgent(userId: string, clientId: string) {
  tx(() => {
    run('DELETE FROM tokens WHERE user_id = ? AND client_id = ?', userId, clientId);
    run('DELETE FROM agent_connections WHERE user_id = ? AND client_id = ?', userId, clientId);
  });
}

const lastTouched = new Map<string, number>();

/** The person and agent behind a bearer token; `userAgent` keeps the agent's version up to date. */
export function authenticateBearer(header: string | undefined | null, userAgent?: string | null): { user: User; clientId: string; token: string } | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!m) return undefined;
  const row = get<{ user_id: string; client_id: string; expires_at: number | null }>(
    "SELECT user_id, client_id, expires_at FROM tokens WHERE token_hash = ? AND kind IN ('access', 'pat')", sha256(m[1]),
  );
  if (!row || (row.expires_at !== null && row.expires_at < now())) return undefined;
  const user = get<User>('SELECT * FROM users WHERE id = ?', row.user_id);
  if (!user) return undefined;
  const key = row.user_id + '|' + row.client_id;
  if ((lastTouched.get(key) ?? 0) < now() - 60_000) {
    lastTouched.set(key, now());
    run('UPDATE agent_connections SET last_used_at = ?, agent_version = COALESCE(?, agent_version) WHERE user_id = ? AND client_id = ?', now(), agentVersionOf(userAgent), row.user_id, row.client_id);
  }
  return { user, clientId: row.client_id, token: m[1] };
}

export const wwwAuthenticate = () => `Bearer resource_metadata="${config.hubUrl}/.well-known/oauth-protected-resource${MCP_PATH}"`;
