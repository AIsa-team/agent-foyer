/**
 * Each person's own Google connection (OAuth 2.0 with PKCE, offline access), used to save email drafts in their
 * Gmail. The hub asks only for gmail.compose, which can create drafts and send, and only ever creates drafts.
 */
import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { decrypt, encrypt, randomToken } from '../crypto.ts';
import { get, now, run, type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';
const SCOPES = ['openid', 'email', GMAIL_SCOPE];
export const CALLBACK = () => `${config.hubUrl}/auth/google/callback`;

export const googleConnectUrl = (returnPath: string) => `${config.hubUrl}/auth/google/connect?return=${encodeURIComponent(returnPath)}`;

/** The URL to send the person to, and the PKCE verifier to keep until they come back. */
export function googleAuthorize(user: User, state: string): { url: string; verifier: string } {
  const verifier = randomToken(32);
  const u = new URL(config.google.authUrl);
  u.searchParams.set('client_id', config.google.clientId);
  u.searchParams.set('redirect_uri', CALLBACK());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  // a refresh token is only returned on consent, so always ask
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  u.searchParams.set('code_challenge_method', 'S256');
  if (user.email) u.searchParams.set('login_hint', user.email);
  return { url: u.toString(), verifier };
}

interface Tokens { access_token: string; expires_in: number; refresh_token?: string; scope?: string; error?: string; error_description?: string }

async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
  const res = await fetch(config.google.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, ...params }),
  });
  const t = (await res.json().catch(() => ({}))) as Tokens;
  if (!res.ok || !t.access_token) throw Object.assign(new Error(`Google token request failed: ${t.error_description ?? t.error ?? res.status}`), { oauthError: t.error });
  return t;
}

export async function finishGoogleConnect(user: User, code: string, verifier: string) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CALLBACK() });
  if (!(t.scope ?? '').split(' ').includes(GMAIL_SCOPE)) throw new UserError('err.google.scopeDenied');
  const info = (await (await fetch(config.google.userinfoUrl, { headers: { authorization: `Bearer ${t.access_token}` } })).json().catch(() => ({}))) as { email?: string };
  // drafts should land in the work mailbox: the Google account must be on the same domain as the person's hub email
  const domain = (e?: string | null) => e?.split('@')[1]?.toLowerCase();
  if (user.email && domain(info.email) !== domain(user.email)) throw new UserError('err.google.otherDomain', { email: info.email ?? '—', domain: domain(user.email) ?? '' });
  run(`INSERT INTO google_tokens (user_id, email, access_enc, access_expires_at, refresh_enc, scopes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, access_enc = excluded.access_enc, access_expires_at = excluded.access_expires_at,
         refresh_enc = COALESCE(excluded.refresh_enc, google_tokens.refresh_enc), scopes = excluded.scopes, updated_at = excluded.updated_at`,
    user.id, info.email ?? null, encrypt(t.access_token), now() + t.expires_in * 1000, t.refresh_token ? encrypt(t.refresh_token) : null, t.scope ?? null, now());
}

interface Row { email: string | null; access_enc: string; access_expires_at: number; refresh_enc: string | null }

export function googleConnection(userId: string) {
  const r = get<Row>('SELECT email, access_enc, access_expires_at, refresh_enc FROM google_tokens WHERE user_id = ?', userId);
  if (!r || (!r.refresh_enc && r.access_expires_at < now())) return { connected: false as const };
  return { connected: true as const, email: r.email };
}

export function forgetGoogle(userId: string) {
  run('DELETE FROM google_tokens WHERE user_id = ?', userId);
}

/** A valid access token for this person, refreshed when needed; a refused refresh forgets the connection. */
export async function googleAccessToken(user: Pick<User, 'id'>): Promise<string> {
  const r = get<Row>('SELECT email, access_enc, access_expires_at, refresh_enc FROM google_tokens WHERE user_id = ?', user.id);
  if (!r) throw new UserError('err.google.notConnected');
  if (r.access_expires_at > now() + 60_000) return decrypt(r.access_enc);
  if (!r.refresh_enc) throw new UserError('err.google.notConnected');
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(r.refresh_enc) });
    run('UPDATE google_tokens SET access_enc = ?, access_expires_at = ?, updated_at = ? WHERE user_id = ?', encrypt(t.access_token), now() + t.expires_in * 1000, now(), user.id);
    return t.access_token;
  } catch (e) {
    if ((e as { oauthError?: string }).oauthError === 'invalid_grant') {
      forgetGoogle(user.id);
      throw new UserError('err.google.notConnected');
    }
    throw e;
  }
}
