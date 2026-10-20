import { config } from '../config.ts';
import { randomToken, sha256 } from '../crypto.ts';
import { get, now, run, type User } from '../db.ts';

// Over HTTPS the __Host- prefix stops any other subdomain (e.g. a deployed app) from setting or overwriting these cookies.
const prefix = config.secure ? '__Host-' : '';
export const HUB_COOKIE = prefix + 'hub_session';
export const STATE_COOKIE = prefix + 'hub_login_state';
// Apps may be served over plain http (e.g. a temporary sslip.io domain) even when the hub is https.
const appsSecure = config.appsProtocol === 'https';
export const APP_COOKIE = (appsSecure ? '__Host-' : '') + 'hub_app';
const SESSION_TTL = 30 * 24 * 3600 * 1000;

export function createSession(userId: string, appSlug: string | null = null): string {
  const id = randomToken();
  run('INSERT INTO sessions (id_hash, user_id, app_slug, expires_at) VALUES (?, ?, ?, ?)', sha256(id), userId, appSlug, now() + SESSION_TTL);
  return id;
}

export function sessionUser(id: string | undefined, appSlug: string | null = null): User | undefined {
  if (!id) return undefined;
  const user = get<User>(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ? AND s.expires_at > ? AND s.app_slug IS ?`,
    sha256(id), now(), appSlug,
  );
  return user;
}

export function deleteSession(id: string | undefined) {
  if (id) run('DELETE FROM sessions WHERE id_hash = ?', sha256(id));
}

/** Set-Cookie for the per-app session on an app subdomain. */
export function appCookieHeader(value: string, maxAgeSec = SESSION_TTL / 1000): string {
  const name = APP_COOKIE;
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
    appsSecure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

export function parseCookies(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(raw);
    } catch {
      out[part.slice(0, i).trim()] = raw;
    }
  }
  return out;
}

/** Only same-origin paths. Rejects //host, /\\host and any whitespace/control char (browsers strip tabs: "/\t/evil" → "//evil"). */
export function safeReturnPath(p: string | undefined | null): string {
  if (!p || !/^\/(?![/\\])[^\s\\\x00-\x1f\x7f]*$/.test(p)) return '/';
  return p;
}
