/**
 * Each person's own Lark access, used to read Lark data as them (Base tables, OKRs): the hub never sees more
 * than the person could open in Lark. Tokens are stored encrypted and refreshed before they expire; refresh
 * tokens are single-use, so refreshes for one person are serialised.
 */
import { config } from '../config.ts';
import { decrypt, encrypt } from '../crypto.ts';
import { get, now, run, type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import type { UserTokens } from '../lark/auth.ts';
import { larkFetch, LarkError, TOKEN_CODES } from './client.ts';

/** What "connect Lark data" asks for. offline_access is what makes Lark return a refresh token. */
export const DATA_SCOPES = ['offline_access', 'bitable:app:readonly', 'wiki:wiki:readonly', 'okr:okr:readonly', 'docx:document:readonly'];

interface Row { user_id: string; access_enc: string; access_expires_at: number; refresh_enc: string | null; refresh_expires_at: number | null; scopes: string | null }

export function saveTokens(userId: string, t: UserTokens) {
  const at = now();
  run(`INSERT INTO lark_tokens (user_id, access_enc, access_expires_at, refresh_enc, refresh_expires_at, scopes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET access_enc = excluded.access_enc, access_expires_at = excluded.access_expires_at,
         refresh_enc = excluded.refresh_enc, refresh_expires_at = excluded.refresh_expires_at, scopes = excluded.scopes, updated_at = excluded.updated_at`,
    userId, encrypt(t.access_token), at + t.expires_in * 1000, t.refresh_token ? encrypt(t.refresh_token) : null,
    t.refresh_token_expires_in ? at + t.refresh_token_expires_in * 1000 : null, t.scope ?? null, at);
}

export function forgetTokens(userId: string) {
  run('DELETE FROM lark_tokens WHERE user_id = ?', userId);
}

/** Write access to Base, asked for only when an app the person uses needs to add or change records. */
export const WRITE_SCOPE = 'bitable:app';

export const connectUrl = (returnPath = '/me', write = false) =>
  `${config.hubUrl}/auth/lark/connect?return=${encodeURIComponent(returnPath)}${write ? '&write=1' : ''}`;

/** Whether the person has connected, and until when the hub can keep reading for them. */
export function connection(userId: string) {
  const r = get<Row>('SELECT * FROM lark_tokens WHERE user_id = ?', userId);
  if (!r) return { connected: false as const };
  const until = r.refresh_expires_at ?? r.access_expires_at;
  if (until < now()) return { connected: false as const, expired: true };
  return { connected: true as const, until, scopes: (r.scopes ?? '').split(/\s+/).filter(Boolean) };
}

const refreshing = new Map<string, Promise<string>>();

/** A valid user access token, refreshed when it is about to expire (or when `force`). Throws err.lark.notConnected otherwise. */
export async function userAccessToken(user: Pick<User, 'id'>, force = false): Promise<string> {
  const r = get<Row>('SELECT * FROM lark_tokens WHERE user_id = ?', user.id);
  if (!r) throw new UserError('err.lark.notConnected', { url: connectUrl() });
  if (!force && r.access_expires_at > now() + 120_000) return decrypt(r.access_enc);
  if (!r.refresh_enc || (r.refresh_expires_at ?? 0) < now()) throw new UserError('err.lark.notConnected', { url: connectUrl() });
  let p = refreshing.get(user.id);
  if (!p) {
    p = (async () => {
      try {
        const t = await larkFetch<UserTokens>('/authen/v2/oauth/token', {
          method: 'POST',
          body: JSON.stringify({ grant_type: 'refresh_token', client_id: config.lark.appId, client_secret: config.lark.appSecret, refresh_token: decrypt(r.refresh_enc!) }),
        });
        saveTokens(user.id, t);
        return t.access_token;
      } catch (e) {
        // a refresh token that Lark no longer accepts means the person has to connect again
        if (e instanceof LarkError) {
          console.warn(`[lark] refresh failed for ${user.id}: ${e.message}`);
          forgetTokens(user.id);
          throw new UserError('err.lark.notConnected', { url: connectUrl() });
        }
        throw e;
      } finally {
        refreshing.delete(user.id);
      }
    })();
    refreshing.set(user.id, p);
  }
  return p;
}

/**
 * What a person's access may do in Lark's messaging API: send messages and the files in them (lark/messages.ts), and,
 * only while they keep reading turned on (lark/reading.ts), read a conversation, find their chats and fetch files from
 * messages; while their AI twin is on too (lark/twin.ts), search their messages and look up single messages and chats.
 * Everything else under /im/ is refused, whatever the person allowed in Lark.
 */
export function imAllowed(userId: string, path: string, method = 'GET'): boolean {
  const reading = () => !!get<{ read_as_me: number }>('SELECT read_as_me FROM users WHERE id = ?', userId)?.read_as_me;
  const twin = () => reading() && !!get<{ enabled: number }>('SELECT enabled FROM twin WHERE user_id = ?', userId)?.enabled;
  // searching all of the person's messages is only for their AI twin (lark/twin.ts), while it is on
  if (path.startsWith('/search/v2/message')) return method === 'POST' && twin();
  if (!path.startsWith('/im/')) return true;
  if (method === 'POST' && (path.startsWith('/im/v1/messages?') || path === '/im/v1/files' || path === '/im/v1/images')) return true;
  const read = (method === 'GET' && (/^\/im\/v1\/messages\?/.test(path) || /^\/im\/v1\/messages\/[^/?]+\/resources\/[^/?]+\?/.test(path) || path.startsWith('/im/v1/chats/search?')))
    || (method === 'POST' && path.startsWith('/im/v1/chat_p2p/batch_query?'));
  // the twin also looks up single messages its search found, and the chats they are in
  const twinRead = method === 'GET' && (/^\/im\/v1\/messages\/[^/?]+\?user_id_type=open_id$/.test(path) || /^\/im\/v1\/chats\/oc_[\w-]+\?user_id_type=open_id$/.test(path));
  return (read && reading()) || (twinRead && twin());
}

/**
 * Calls Lark as the person. If Lark rejects the access token, it is refreshed once and the call retried; only when
 * that fails too is the connection dropped (the person is asked to connect again).
 */
export async function asUser<T>(user: Pick<User, 'id'>, path: string, init: RequestInit = {}): Promise<T> {
  if (!imAllowed(user.id, path, init.method ?? 'GET')) throw new Error(`refusing ${path.split('?')[0]} with a person's Lark access`);
  try {
    return await larkFetch<T>(path, { ...init, token: await userAccessToken(user) });
  } catch (e) {
    if (!(e instanceof LarkError && TOKEN_CODES.has(e.code))) throw e;
    console.warn(`[lark] user token rejected for ${user.id} on ${path.split('?')[0]}: ${e.code} ${e.message}`);
  }
  // userAccessToken(force) drops the connection itself if the refresh token is no longer accepted
  return larkFetch<T>(path, { ...init, token: await userAccessToken(user, true) });
}
