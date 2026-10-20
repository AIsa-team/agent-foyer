/**
 * Sign-in with any OpenID Connect provider (Google, Microsoft Entra ID, Okta, Keycloak, Authentik…): authorization
 * code flow with PKCE as a confidential client. Who signed in comes from the userinfo endpoint over TLS, so the ID
 * token needs no signature check here.
 */
import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { randomToken } from '../crypto.ts';
import { UserError } from '../i18n/index.ts';
import type { Identity } from './users.ts';

interface Discovery { authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string }
let discovery: Promise<Discovery> | undefined;

function discover(): Promise<Discovery> {
  discovery ??= fetch(`${config.oidc.issuer}/.well-known/openid-configuration`).then(async (r) => {
    if (!r.ok) throw new Error(`OIDC discovery failed: ${r.status}`);
    return (await r.json()) as Discovery;
  }).catch((e) => {
    discovery = undefined; // try again next time
    throw e;
  });
  return discovery;
}

/** A PKCE verifier to keep (in the login state cookie) and the URL to send the person to. */
export async function oidcAuthorize(redirectUri: string, state: string): Promise<{ url: string; verifier: string }> {
  const d = await discover();
  const verifier = randomToken(32);
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', config.oidc.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', config.oidc.scopes);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  u.searchParams.set('code_challenge_method', 'S256');
  // Google shows only accounts of this Workspace domain (the domain check below still decides)
  if (config.oidc.allowedDomains.length === 1) u.searchParams.set('hd', config.oidc.allowedDomains[0]);
  return { url: u.toString(), verifier };
}

interface UserInfo { sub: string; name?: string; preferred_username?: string; given_name?: string; family_name?: string; email?: string; email_verified?: boolean | string; picture?: string }

export async function oidcExchange(code: string, redirectUri: string, verifier: string): Promise<Identity> {
  const d = await discover();
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, client_id: config.oidc.clientId });
  if (config.oidc.clientSecret) {
    headers.authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(config.oidc.clientId)}:${encodeURIComponent(config.oidc.clientSecret)}`).toString('base64');
  }
  const t = await fetch(d.token_endpoint, { method: 'POST', headers, body });
  const tokens = (await t.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!t.ok || !tokens.access_token) throw new Error(`OIDC token exchange failed: ${tokens.error_description ?? tokens.error ?? t.status}`);
  const r = await fetch(d.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' } });
  if (!r.ok) throw new Error(`OIDC userinfo failed: ${r.status}`);
  const info = (await r.json()) as UserInfo;
  if (!info.sub) throw new Error('OIDC userinfo has no sub');
  // an unverified address must not match HUB_ADMINS or a colleague's email
  const verified = info.email_verified === undefined || info.email_verified === true || info.email_verified === 'true';
  const email = verified ? info.email?.toLowerCase() : undefined;
  if (config.oidc.allowedDomains.length && !config.oidc.allowedDomains.includes(email?.split('@')[1] ?? '')) {
    throw new UserError('err.login.domainNotAllowed', { email: info.email ?? '—' });
  }
  const name = info.name || [info.given_name, info.family_name].filter(Boolean).join(' ') || info.preferred_username || email || info.sub;
  return { id: info.sub, name, email, avatar: info.picture };
}
