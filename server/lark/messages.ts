/**
 * Lark messages and files sent as the person by their agent ("send Alex the quote and tell him it moved to three").
 * Off until the person turns it on on their Me page and allows it in Lark. Every message is previewed first and sent
 * only with the code from that preview, so it goes out exactly as the person saw it, signed as sent by their AI twin.
 * The hub keeps who was messaged and when, never the text or the file, and never reads anyone's messages with their
 * access (asUser refuses).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { config } from '../config.ts';
import { get, now, run, type User } from '../db.ts';
import { tr, UserError } from '../i18n/index.ts';
import { peekUpload, takeUpload } from '../uploads.ts';
import { DENIED_CODES, LarkError, SCOPE_CODES } from './client.ts';
import { asUser, connection } from './userToken.ts';

/** Lark asks for both to send as a person; the hub only ever sends with them. */
export const MESSAGE_SCOPES = ['im:message', 'im:message.send_as_user'];
/**
 * Uploading a file to send, asked for the first time someone sends one. Lark's scope also covers reading the images and
 * files in messages; the hub only uploads (asUser refuses reading anything under /im/).
 */
export const FILE_SCOPE = 'im:resource';
export const messagesConnectUrl = (returnPath = '/me', files = false) =>
  `${config.hubUrl}/auth/lark/connect?return=${encodeURIComponent(returnPath)}&messages=1${files ? '&files=1' : ''}`;

const PER_HOUR = 30;
const MAX_TO = 10;
const MAX_TEXT = 4000;
/** Lark's limit for a file sent in a chat. */
const MAX_FILE = 30 * 1024 * 1024;
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

export interface FileRef { upload_id: string; name: string }
interface Pending { userId: string; to: string[]; text: string; file: FileRef | null; expires: number }
const pending = new Map<string, Pending>();
const nameOf = (id: string) => get<{ name: string }>('SELECT name FROM users WHERE id = ?', id)?.name ?? id;
const localeOf = (id: string) => get<{ locale: string | null }>('SELECT locale FROM users WHERE id = ?', id)?.locale ?? config.defaultLocale;

/** The last lines of every message, in the recipient's language: who sent it, through their AI twin. */
const signed = (text: string, sender: User, locale: string) => [text, tr(locale, 'lark.msg.sentByTwin', { name: sender.name })].filter(Boolean).join('\n');

/** Lark's file types; anything else goes as a plain file. */
function fileType(name: string) {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'pdf' || ext === 'mp4') return ext;
  if (ext === 'doc' || ext === 'docx') return 'doc';
  if (ext === 'xls' || ext === 'xlsx') return 'xls';
  if (ext === 'ppt' || ext === 'pptx') return 'ppt';
  return 'stream';
}

/** The preview: who gets what, and the code that sends exactly that. */
export function prepareMessage(user: User, to: string[], text: string, file: FileRef | null, locale: string) {
  ready(user);
  const body = text.trim();
  const ids = [...new Set(to)];
  if ((!body && !file) || !ids.length) throw new UserError('err.messages.empty');
  if (body.length > MAX_TEXT || ids.length > MAX_TO) throw new UserError('err.messages.tooLong', { text: MAX_TEXT, to: MAX_TO });
  let size = 0;
  if (file) {
    if (!connection(user.id).scopes?.includes(FILE_SCOPE)) throw new UserError('err.messages.fileScope', { url: messagesConnectUrl('/me', true), detail: '' });
    size = peekUpload(file.upload_id, user.id, 'file');
    if (size > MAX_FILE) throw new UserError('err.messages.fileTooBig', { mb: MAX_FILE / 1024 / 1024 });
  }
  for (const [code, p] of pending) if (p.expires < now()) pending.delete(code);
  const code = randomBytes(4).toString('hex');
  const name = file?.name.trim().replace(/[\\/]/g, '_').slice(0, 200) || 'file';
  pending.set(code, { userId: user.id, to: ids, text: body, file: file && { upload_id: file.upload_id, name }, expires: now() + PREVIEW_MS });
  return {
    preview: { from: user.name, to: ids.map(nameOf), ...(file ? { file: { name, bytes: size } } : {}), text: signed(body, user, locale) },
    confirm: code,
    next: 'Show the user exactly who gets this (the file, then the text with the last line saying it was sent by their AI twin). Only after they agree, call send_lark_message again with just confirm. If they want changes, prepare it again.',
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
  // the file goes up to Lark once, as the person, and is then sent to each recipient
  let fileKey = '';
  if (p.file) {
    const path = takeUpload(p.file.upload_id, user.id, 'file');
    try {
      const form = new FormData();
      form.set('file_type', fileType(p.file.name));
      form.set('file_name', p.file.name);
      form.set('file', new Blob([readFileSync(path)]), p.file.name);
      fileKey = (await asUser<{ data: { file_key: string } }>(user, '/im/v1/files', { method: 'POST', body: form })).data.file_key;
    } catch (e) {
      if (e instanceof LarkError && SCOPE_CODES.has(e.code)) throw new UserError('err.messages.fileScope', { url: messagesConnectUrl('/me', true), detail: e.message });
      throw e;
    } finally {
      rmSync(path, { force: true });
    }
  }
  const send = (id: string, msgType: 'text' | 'file', content: object) =>
    asUser(user, '/im/v1/messages?receive_id_type=open_id', { method: 'POST', body: JSON.stringify({ receive_id: id, msg_type: msgType, content: JSON.stringify(content) }) });
  const sent: string[] = [];
  const failed: { to: string; reason: string }[] = [];
  for (const id of p.to) {
    try {
      if (fileKey) await send(id, 'file', { file_key: fileKey });
      await send(id, 'text', { text: signed(p.text, user, localeOf(id)) });
      run('INSERT INTO lark_sent (user_id, to_id, at) VALUES (?, ?, ?)', user.id, id, now());
      sent.push(nameOf(id));
    } catch (e) {
      if (e instanceof LarkError && SCOPE_CODES.has(e.code)) throw new UserError('err.messages.scope', { url: messagesConnectUrl(), detail: e.message });
      failed.push({ to: nameOf(id), reason: e instanceof LarkError && DENIED_CODES.has(e.code) ? 'Lark did not allow messaging this person' : (e as Error).message });
    }
  }
  return { sent, ...(p.file ? { file: p.file.name } : {}), ...(failed.length ? { failed } : {}) };
}
