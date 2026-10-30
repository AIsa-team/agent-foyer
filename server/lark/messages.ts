/**
 * Lark messages sent as the person by their agent ("tell Alex the meeting moved to three"). Off until the person turns
 * it on on their Me page and allows it in Lark. Every message is previewed first and sent only with the code from that
 * preview, so it goes out exactly as the person saw it. The hub keeps who was messaged and when, never the text, and
 * never reads anyone's messages with their access (asUser refuses).
 */
import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { get, now, run, type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { DENIED_CODES, LarkError, SCOPE_CODES } from './client.ts';
import { asUser, connection } from './userToken.ts';

/** Lark asks for both to send as a person; the hub only ever sends with them. */
export const MESSAGE_SCOPES = ['im:message', 'im:message.send_as_user'];
export const messagesConnectUrl = (returnPath = '/me') => `${config.hubUrl}/auth/lark/connect?return=${encodeURIComponent(returnPath)}&messages=1`;

const PER_HOUR = 30;
const MAX_TO = 10;
const MAX_TEXT = 4000;
const PREVIEW_MS = 10 * 60_000;

export const messagesOn = (userId: string) => !!get<{ send_as_me: number }>('SELECT send_as_me FROM users WHERE id = ?', userId)?.send_as_me;
const granted = (userId: string) => {
  const c = connection(userId);
  return c.connected && MESSAGE_SCOPES.every((s) => c.scopes.includes(s));
};

/** For the Me page: whether it is on, whether Lark allows it yet, and how many messages went out this week. */
export function messagesStatus(user: User) {
  const sent = get<{ n: number }>('SELECT COUNT(*) AS n FROM lark_sent WHERE user_id = ? AND at > ?', user.id, now() - 7 * 86_400_000)!.n;
  return { on: messagesOn(user.id), granted: granted(user.id), connectUrl: messagesConnectUrl(), sentThisWeek: sent };
}

export function setMessagesOn(user: User, on: boolean) {
  run('UPDATE users SET send_as_me = ? WHERE id = ?', on ? 1 : 0, user.id);
  if (!on) for (const [code, p] of pending) if (p.userId === user.id) pending.delete(code);
}

function ready(user: User) {
  if (!messagesOn(user.id)) throw new UserError('err.messages.off', { url: `${config.hubUrl}/me` });
  if (!granted(user.id)) throw new UserError('err.messages.scope', { url: messagesConnectUrl(), detail: '' });
}

interface Pending { userId: string; to: string[]; text: string; expires: number }
const pending = new Map<string, Pending>();
const nameOf = (id: string) => get<{ name: string }>('SELECT name FROM users WHERE id = ?', id)?.name ?? id;

/** The preview: who gets what, and the code that sends exactly that. */
export function prepareMessage(user: User, to: string[], text: string) {
  ready(user);
  const body = text.trim();
  const ids = [...new Set(to)];
  if (!body || !ids.length) throw new UserError('err.messages.empty');
  if (body.length > MAX_TEXT || ids.length > MAX_TO) throw new UserError('err.messages.tooLong', { text: MAX_TEXT, to: MAX_TO });
  for (const [code, p] of pending) if (p.expires < now()) pending.delete(code);
  const code = randomBytes(4).toString('hex');
  pending.set(code, { userId: user.id, to: ids, text: body, expires: now() + PREVIEW_MS });
  return {
    preview: { from: user.name, to: ids.map(nameOf), text: body },
    confirm: code,
    next: 'Show the user exactly who gets this text. Only after they agree, call send_lark_message again with just confirm. If they want changes, prepare it again.',
  };
}

/** Sends the message a preview showed, as the person, to each recipient in turn. */
export async function sendPrepared(user: User, code: string) {
  ready(user);
  const p = pending.get(code);
  if (!p || p.userId !== user.id || p.expires < now()) throw new UserError('err.messages.expired');
  const recent = get<{ n: number }>('SELECT COUNT(*) AS n FROM lark_sent WHERE user_id = ? AND at > ?', user.id, now() - 3_600_000)!.n;
  if (recent + p.to.length > PER_HOUR) throw new UserError('err.messages.rateLimited', { n: PER_HOUR });
  pending.delete(code);
  const sent: string[] = [];
  const failed: { to: string; reason: string }[] = [];
  for (const id of p.to) {
    try {
      await asUser(user, '/im/v1/messages?receive_id_type=open_id', {
        method: 'POST', body: JSON.stringify({ receive_id: id, msg_type: 'text', content: JSON.stringify({ text: p.text }) }),
      });
      run('INSERT INTO lark_sent (user_id, to_id, at) VALUES (?, ?, ?)', user.id, id, now());
      sent.push(nameOf(id));
    } catch (e) {
      if (e instanceof LarkError && SCOPE_CODES.has(e.code)) throw new UserError('err.messages.scope', { url: messagesConnectUrl(), detail: e.message });
      failed.push({ to: nameOf(id), reason: e instanceof LarkError && DENIED_CODES.has(e.code) ? 'Lark did not allow messaging this person' : (e as Error).message });
    }
  }
  return { sent, ...(failed.length ? { failed } : {}) };
}
