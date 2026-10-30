/**
 * Lark messages read as the person by their agent: what a colleague replied, what a group has been discussing, and the
 * files people sent them. Off until the person turns it on on their Me page and allows it in Lark; then the agent reads
 * only the one conversation it is asked about, at most 100 recent messages at a time. The hub keeps which conversation
 * was read and when, never the messages, and passes files straight through without keeping them.
 */
import { config } from '../config.ts';
import { get, now, run, type User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { signToken, verifyToken } from '../crypto.ts';
import { localTime } from './calendar.ts';
import { DENIED_CODES, LarkError, SCOPE_CODES } from './client.ts';
import { asUser, connection, imAllowed, userAccessToken } from './userToken.ts';

/** Reading direct and group messages as the person, and finding their chats (Lark asks for each). */
export const READ_SCOPES = ['im:message:readonly', 'im:message.p2p_msg:get_as_user', 'im:message.group_msg:get_as_user', 'im:chat:read'];
export const readingConnectUrl = (returnPath = '/me') => `${config.hubUrl}/auth/lark/connect?return=${encodeURIComponent(returnPath)}&reading=1`;

const PER_HOUR = 60;
const MAX_MESSAGES = 100;
const FILE_LINK_MS = 10 * 60_000;

export const readingOn = (userId: string) => !!get<{ read_as_me: number }>('SELECT read_as_me FROM users WHERE id = ?', userId)?.read_as_me;
const granted = (userId: string) => {
  const c = connection(userId);
  return c.connected && READ_SCOPES.every((s) => c.scopes.includes(s));
};

/** For the Me page: whether it is on, whether Lark allows it yet, and how often the agent read this week. */
export function readingStatus(user: User) {
  const reads = get<{ n: number }>('SELECT COUNT(*) AS n FROM lark_reads WHERE user_id = ? AND at > ?', user.id, now() - 7 * 86_400_000)!.n;
  return { on: readingOn(user.id), granted: granted(user.id), connectUrl: readingConnectUrl(), readsThisWeek: reads };
}

export function setReadingOn(user: User, on: boolean) {
  run('UPDATE users SET read_as_me = ? WHERE id = ?', on ? 1 : 0, user.id);
}

function ready(user: User) {
  if (!readingOn(user.id)) throw new UserError('err.reading.off', { url: `${config.hubUrl}/me` });
  if (!granted(user.id)) throw new UserError('err.reading.scope', { url: readingConnectUrl(), detail: '' });
}

async function call<T>(user: User, path: string, init?: RequestInit): Promise<T> {
  try {
    return await asUser<T>(user, path, init);
  } catch (e) {
    if (e instanceof LarkError && SCOPE_CODES.has(e.code)) throw new UserError('err.reading.scope', { url: readingConnectUrl(), detail: e.message });
    if (e instanceof LarkError && DENIED_CODES.has(e.code)) throw new UserError('err.reading.denied');
    throw e;
  }
}

/** Group chats the person is in (or may see) whose name or members match. */
export async function findChats(user: User, query: string) {
  ready(user);
  const q = query.trim().slice(0, 64);
  if (!q) throw new UserError('err.reading.needWho');
  const r = await call<{ data: { items?: { chat_id: string; name?: string; description?: string }[] } }>(user, `/im/v1/chats/search?query=${encodeURIComponent(q)}&page_size=20`);
  return { chats: (r.data.items ?? []).map((c) => ({ chat_id: c.chat_id, name: c.name ?? '', ...(c.description ? { description: c.description } : {}) })) };
}

/** The person's direct chat with a colleague. */
async function directChat(user: User, colleagueId: string): Promise<string> {
  const r = await call<{ data: { p2p_chats?: { chat_id: string }[] } }>(user, '/im/v1/chat_p2p/batch_query?user_id_type=open_id', {
    method: 'POST', body: JSON.stringify({ chatter_ids: [colleagueId] }),
  });
  const id = r.data.p2p_chats?.[0]?.chat_id;
  if (!id) throw new UserError('err.reading.noChat');
  return id;
}

interface Item {
  message_id: string; msg_type: string; create_time: string; deleted?: boolean; thread_id?: string;
  sender?: { id?: string; sender_type?: string };
  body?: { content?: string };
  mentions?: { key: string; name?: string }[];
}

const nameOf = (id: string | undefined) => (id ? get<{ name: string }>('SELECT name FROM users WHERE id = ?', id)?.name ?? id : '');

/** A message as plain text: text and rich text as written (with @names), anything else as a short marker. */
function asText(m: Item): { text: string; file?: { file_key: string; type: 'file' | 'image'; name?: string } } {
  let c: Record<string, unknown> = {};
  try { c = JSON.parse(m.body?.content ?? '{}'); } catch { /* left empty */ }
  const at = (s: string) => (m.mentions ?? []).reduce((t, x) => t.replaceAll(x.key, `@${x.name ?? ''}`), s);
  if (m.msg_type === 'text') return { text: at(String(c.text ?? '')) };
  if (m.msg_type === 'post') {
    const lines = (c.content as { tag: string; text?: string; user_name?: string; href?: string }[][] | undefined) ?? [];
    const body = lines.map((l) => l.map((e) => (e.tag === 'at' ? `@${e.user_name ?? ''}` : e.tag === 'img' ? '[image]' : e.text ?? '')).join('')).join('\n');
    return { text: at([c.title, body].filter(Boolean).join('\n')) };
  }
  if (m.msg_type === 'file' || m.msg_type === 'media' || m.msg_type === 'audio') {
    return { text: `[${m.msg_type}${c.file_name ? `: ${c.file_name}` : ''}]`, file: { file_key: String(c.file_key ?? ''), type: 'file', name: c.file_name ? String(c.file_name) : undefined } };
  }
  if (m.msg_type === 'image') return { text: '[image]', file: { file_key: String(c.image_key ?? ''), type: 'image' } };
  return { text: `[${m.msg_type}]` };
}

/** Recent messages of one conversation, oldest first, read as the person. */
export async function readMessages(user: User, a: { colleague?: string; chat_id?: string; hours?: number; limit?: number }) {
  ready(user);
  if (!a.colleague === !a.chat_id) throw new UserError('err.reading.needWho');
  if (a.chat_id && !/^oc_[\w-]+$/.test(a.chat_id)) throw new UserError('err.reading.badChat');
  const recent = get<{ n: number }>('SELECT COUNT(*) AS n FROM lark_reads WHERE user_id = ? AND at > ?', user.id, now() - 3_600_000)!.n;
  if (recent >= PER_HOUR) throw new UserError('err.reading.rateLimited', { n: PER_HOUR });
  const chat = a.chat_id ?? await directChat(user, a.colleague!);
  const limit = Math.min(Math.max(a.limit ?? 30, 1), MAX_MESSAGES);
  const since = a.hours ? `&start_time=${Math.floor((now() - a.hours * 3_600_000) / 1000)}` : '';
  const items: Item[] = [];
  let page = '';
  do {
    const r = await call<{ data: { items?: Item[]; has_more?: boolean; page_token?: string } }>(user,
      `/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chat)}&sort_type=ByCreateTimeDesc&page_size=${Math.min(50, limit - items.length)}${since}${page ? `&page_token=${encodeURIComponent(page)}` : ''}`);
    items.push(...(r.data.items ?? []));
    page = r.data.has_more ? r.data.page_token ?? '' : '';
  } while (page && items.length < limit);
  run('INSERT INTO lark_reads (user_id, chat_id, at) VALUES (?, ?, ?)', user.id, chat, now());
  const messages = items.filter((m) => !m.deleted).reverse().map((m) => {
    const { text, file } = asText(m);
    const from = m.sender?.sender_type === 'app' ? 'bot' : nameOf(m.sender?.id);
    return {
      message_id: m.message_id, time: localTime(Number(m.create_time)), from, text,
      ...(file?.file_key ? { file: { ...file, download: fileLink(user, m.message_id, file.file_key, file.type) } } : {}),
    };
  });
  return { chat_id: chat, timezone: config.timezone, messages, note: 'Files: download each from its link (valid 10 minutes), e.g. with curl -fsSLo <name> <link>.' };
}

// ---- files from messages: a short-lived link that fetches the file from Lark as the person, without keeping it ----
const linkPayload = (userId: string, messageId: string, fileKey: string, type: string) => `larkfile:${userId}:${messageId}:${fileKey}:${type}`;
function fileLink(user: User, messageId: string, fileKey: string, type: 'file' | 'image') {
  const q = new URLSearchParams({ u: user.id, type, t: signToken(linkPayload(user.id, messageId, fileKey, type), FILE_LINK_MS) });
  return `${config.hubUrl}/lark-file/${encodeURIComponent(messageId)}/${encodeURIComponent(fileKey)}?${q}`;
}

/** Streams a file from a message to whoever holds the link, read from Lark as the person it was made for. */
export async function fetchMessageFile(messageId: string, fileKey: string, q: URLSearchParams): Promise<Response> {
  const userId = q.get('u') ?? '';
  const type = q.get('type') === 'image' ? 'image' : 'file';
  if (!verifyToken(linkPayload(userId, messageId, fileKey, type), q.get('t') ?? '')) return new Response('link expired, read the messages again for a new one', { status: 403 });
  const path = `/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${type}`;
  if (!imAllowed(userId, path, 'GET')) return new Response('reading messages is off for this person', { status: 403 });
  const res = await fetch(config.lark.apiBase + path, { headers: { authorization: `Bearer ${await userAccessToken({ id: userId })}` }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok || (res.headers.get('content-type') ?? '').includes('application/json')) {
    const body = await res.json().catch(() => ({})) as { msg?: string };
    return new Response(`Lark did not hand out this file: ${body.msg ?? res.status}`, { status: 502 });
  }
  const headers = new Headers({ 'content-type': res.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-store' });
  for (const h of ['content-length', 'content-disposition']) { const v = res.headers.get(h); if (v) headers.set(h, v); }
  return new Response(res.body, { headers });
}
