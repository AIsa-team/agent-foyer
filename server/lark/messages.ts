/**
 * Lark messages and files sent as the person by their agent ("send Alex the quote and tell him it moved to three").
 * Off until the person turns it on on their Me page and allows it in Lark. Every message is previewed first and sent
 * only with the person's yes to that preview, so it goes out exactly as they saw it, signed as sent by their AI twin.
 * Where the hub is set up for it, the yes comes from a card the hub's bot sends in Lark, the channel the message goes
 * out on; otherwise from the agent's own app, which shows the preview as a question (MCP elicitation). Either way it
 * does not depend on the agent passing it on. Agents whose app cannot ask get a code to send with once the person
 * agreed in the chat. Someone who trusts their agents can turn confirming off, and then messages go out at once.
 * The hub keeps who was messaged and when, never the text or the file, and never reads anyone's messages with their
 * access (asUser refuses).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { config } from '../config.ts';
import { all, get, now, run, type User } from '../db.ts';
import { decrypt, encrypt } from '../crypto.ts';
import { tr, UserError } from '../i18n/index.ts';
import { peekUpload, takeUpload } from '../uploads.ts';
import { getTenantToken } from './auth.ts';
import { localTime } from './calendar.ts';
import { DENIED_CODES, larkFetch, LarkError, SCOPE_CODES } from './client.ts';
import type { Answer } from '../mcp.ts';
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
  return { on: messagesOn(user.id), noConfirm: withoutConfirm(user.id), granted: granted(user.id), connectUrl: messagesConnectUrl(), sentThisWeek: sent };
}

/** Whether the person lets their agents send without showing them each message first (off again when sending is). */
const withoutConfirm = (userId: string) => !!get<{ send_no_confirm: number }>('SELECT send_no_confirm FROM users WHERE id = ?', userId)?.send_no_confirm;

export function setMessagesOn(user: User, on: boolean) {
  run('UPDATE users SET send_as_me = ? WHERE id = ?', on ? 1 : 0, user.id);
  if (!on) {
    run('UPDATE users SET send_no_confirm = 0 WHERE id = ?', user.id);
    run('DELETE FROM lark_pending WHERE user_id = ?', user.id);
  }
}

export function setWithoutConfirm(user: User, noConfirm: boolean) {
  run('UPDATE users SET send_no_confirm = ? WHERE id = ?', noConfirm && messagesOn(user.id) ? 1 : 0, user.id);
}

function ready(user: User) {
  if (!messagesOn(user.id)) throw new UserError('err.messages.off', { url: `${config.hubUrl}/me` });
  if (!granted(user.id)) throw new UserError('err.messages.scope', { url: messagesConnectUrl(), detail: '' });
}

export interface FileRef { upload_id: string; name: string }
/**
 * A preview waiting for the person's yes. Kept in the database (so a restart does not lose it), encrypted, emptied once
 * sent or declined, and deleted when it expires or when the person turns sending off.
 */
interface Pending { to: string[]; text: string; file: FileRef | null }
interface Waiting extends Pending { code: string; card: string | null }
const pendingOf = (userId: string): Waiting[] => {
  run('DELETE FROM lark_pending WHERE expires < ?', now());
  return all<{ code: string; payload: string; card: string | null }>("SELECT code, payload, card FROM lark_pending WHERE user_id = ? AND state = 'waiting'", userId)
    .map((r) => ({ code: r.code, card: r.card, ...(JSON.parse(decrypt(r.payload)) as Pending) }));
};
const nameOf = (id: string) => get<{ name: string }>('SELECT name FROM users WHERE id = ?', id)?.name ?? id;
const localeOf = (id: string) => get<{ locale: string | null }>('SELECT locale FROM users WHERE id = ?', id)?.locale ?? config.defaultLocale;
const names = (ids: string[], locale: string) => new Intl.ListFormat(locale, { type: 'conjunction' }).format(ids.map(nameOf));

/** The last line of every message, after a blank line, in the recipient's language: who sent it, through their AI twin. */
const signed = (text: string, sender: User, locale: string) => [text, tr(locale, 'lark.msg.sentByTwin', { name: sender.name })].filter(Boolean).join('\n\n');

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
  const name = file?.name.trim().replace(/[\\/]/g, '_').slice(0, 200) || 'file';
  const message: Pending = { to: ids, text: body, file: file && { upload_id: file.upload_id, name } };
  // the same message prepared again (an agent that lost the code) keeps its code, so the user's yes still sends it
  const same = pendingOf(user.id).find((p) => JSON.stringify([p.to, p.text, p.file]) === JSON.stringify([message.to, message.text, message.file]));
  const code = same?.code ?? randomBytes(4).toString('hex');
  run('INSERT INTO lark_pending (code, user_id, payload, expires) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET expires = excluded.expires',
    code, user.id, encrypt(JSON.stringify(message)), now() + PREVIEW_MS);
  return {
    preview: { from: user.name, to: ids.map(nameOf), ...(file ? { file: { name, bytes: size } } : {}), text: signed(body, user, locale) },
    send_code: code,
    next: `NOT SENT YET. Show the user exactly who gets this (the file, then the text with the last line saying it was sent by their AI twin). When they agree, call send_lark_message with only {"send_code": "${code}"}: calling it with to/text again does not send, it only shows this preview again. If they want changes, prepare a new one.`,
  };
}

/**
 * The preview and its code, with a card in Lark where the hub is set up for it; otherwise the message sent once the
 * person said yes in their agent's app (`ask`). Sent at once if they turned confirming off.
 */
export async function sendOrPrepare(user: User, to: string[], text: string, file: FileRef | null, locale: string, ask?: (message: string) => Promise<Answer>) {
  const prepared = prepareMessage(user, to, text, file, locale);
  if (withoutConfirm(user.id)) {
    return { ...(await sendPrepared(user, prepared.send_code)), message: prepared.preview, note: 'Sent at once: the user turned off confirming each message. Tell them briefly what was sent to whom.' };
  }
  if (config.lark.confirmCards) {
    if (!(await askInLark(user, prepared.send_code))) return prepared;
    return {
      ...prepared,
      next: `NOT SENT YET. The hub also sent the user this preview in Lark, as a card with Send and Don't send. Show them who gets this and tell them they can tap Send there, or tell you to send it; then call send_lark_message with only {"send_code": "${prepared.send_code}"}. If that says it was already sent, they sent it from the card: do not send again. If they want changes, prepare a new one.`,
    };
  }
  const answer = ask ? await ask(question(prepared.preview, localeOf(user.id))) : null;
  if (answer === 'accept') return { ...(await sendPrepared(user, prepared.send_code)), message: prepared.preview, note: 'The user confirmed this message in the dialog, and it was sent.' };
  if (answer === 'decline') {
    run("UPDATE lark_pending SET state = 'declined', payload = '' WHERE code = ?", prepared.send_code);
    return { sent: [], declined: true, note: 'The user declined this message in the dialog; nothing was sent. Ask them what to change.' };
  }
  if (answer === 'cancel') return { ...prepared, next: `NOT SENT: the user closed the dialog without answering. If they then agree in the chat, call send_lark_message with only {"send_code": "${prepared.send_code}"}.` };
  return prepared;
}

/** Sends the message a preview showed, as the person, and updates its confirmation card in Lark. */
export async function sendPrepared(user: User, code: string) {
  const p = claim(user, code);
  try {
    const result = await deliver(user, p);
    if (p.card) void updateCard(p.card, user, p, sentLine(result, localeOf(user.id)));
    return result;
  } catch (e) {
    if (p.card) void updateCard(p.card, user, p, tr(localeOf(user.id), 'lark.card.failed', { reason: (e as Error).message }));
    throw e;
  }
}

/**
 * Takes a waiting message for sending: from then on neither the agent nor the card can send it a second time. Done in
 * one go, without waiting on anything, so a tap and the agent's call cannot both get it.
 */
function claim(user: User, code: string): Waiting {
  ready(user);
  const p = pendingOf(user.id).find((x) => x.code === code);
  if (!p) {
    const done = get<{ state: string }>('SELECT state FROM lark_pending WHERE code = ? AND user_id = ?', code, user.id)?.state;
    throw new UserError(done === 'sent' ? 'err.messages.alreadySent' : done === 'declined' ? 'err.messages.declined' : 'err.messages.expired');
  }
  const recent = get<{ n: number }>('SELECT COUNT(*) AS n FROM lark_sent WHERE user_id = ? AND at > ?', user.id, now() - 3_600_000)!.n;
  if (recent + p.to.length > PER_HOUR) throw new UserError('err.messages.rateLimited', { n: PER_HOUR });
  run("UPDATE lark_pending SET state = 'sent', payload = '' WHERE code = ?", code);
  return p;
}

/** Sends a claimed message, as the person, to each recipient in turn. */
async function deliver(user: User, p: Waiting) {
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

/** The question the agent's app shows the person: who gets what, as they will see it. */
const question = (p: ReturnType<typeof prepareMessage>['preview'], locale: string) => [
  tr(locale, 'lark.confirm.question', { names: new Intl.ListFormat(locale, { type: 'conjunction' }).format(p.to) }),
  ...(p.file ? [tr(locale, 'lark.card.file', { name: p.file.name, size: size(p.file.bytes) })] : []),
  '',
  p.text,
].join('\n');

// ---- the confirmation card: the preview from the hub's bot, with Send and Don't send ----
type Result = Awaited<ReturnType<typeof deliver>>;
const sentLine = (r: Result, locale: string) => [
  r.sent.length ? tr(locale, 'lark.card.sent', { time: localTime(now()).slice(-5), names: new Intl.ListFormat(locale, { type: 'conjunction' }).format(r.sent) }) : '',
  r.failed?.length ? tr(locale, 'lark.card.notSentTo', { names: r.failed.map((f) => `${f.to} (${f.reason})`).join(', ') }) : '',
].filter(Boolean).join('\n');
const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** The card: who gets what, then the buttons, or, once it is settled, a line saying what happened. */
function card(user: User, p: Waiting, end?: string) {
  const locale = localeOf(user.id);
  const plain = (content: string) => ({ tag: 'plain_text', content });
  const button = (choice: 'send' | 'decline') => ({
    tag: 'button', type: choice === 'send' ? 'primary' : 'default', text: plain(tr(locale, `lark.card.${choice}`)),
    value: { hub: 'send_message', code: p.code, choice },
  });
  const file = p.file && get<{ size: number }>('SELECT size FROM uploads WHERE id = ?', p.file.upload_id)?.size;
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: end ? 'grey' : 'blue', title: plain(tr(locale, 'lark.card.title')) },
    elements: [
      { tag: 'div', text: plain(tr(locale, 'lark.card.to', { names: names(p.to, locale) })) },
      ...(p.file ? [{ tag: 'div', text: plain(tr(locale, 'lark.card.file', { name: p.file.name, size: file ? size(file) : '' })) }] : []),
      { tag: 'hr' },
      { tag: 'div', text: plain(signed(p.text, user, locale)) },
      ...(end
        ? [{ tag: 'note', elements: [plain(end)] }]
        : [{ tag: 'action', actions: [button('send'), button('decline')] }, { tag: 'note', elements: [plain(tr(locale, 'lark.card.hint'))] }]),
    ],
  };
}

/** Sends the person the card for a preview (once per preview). False if Lark did not take it; the agent's yes still works. */
async function askInLark(user: User, code: string): Promise<boolean> {
  const p = pendingOf(user.id).find((x) => x.code === code);
  if (!p) return false;
  if (p.card) return true;
  try {
    const r = await larkFetch<{ data: { message_id: string } }>('/im/v1/messages?receive_id_type=open_id', {
      method: 'POST', token: await getTenantToken(), body: JSON.stringify({ receive_id: user.id, msg_type: 'interactive', content: JSON.stringify(card(user, p)) }),
    });
    run('UPDATE lark_pending SET card = ? WHERE code = ?', r.data.message_id, code);
    return true;
  } catch (e) {
    console.warn('[messages] confirmation card not sent:', (e as Error).message);
    return false;
  }
}

async function updateCard(messageId: string, user: User, p: Waiting, end: string) {
  await larkFetch(`/im/v1/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH', token: await getTenantToken(), body: JSON.stringify({ content: JSON.stringify(card(user, p, end)) }),
  }).catch((e) => console.warn('[messages] confirmation card not updated:', (e as Error).message));
}

/** What Lark asks the hub when someone taps a button on one of its cards (through the long connection, lark/events.ts). */
export interface CardTap { operator?: { open_id?: string }; action?: { value?: { hub?: string; code?: string; choice?: string } } }

/**
 * A tap on Send or Don't send. Lark waits about three seconds for the answer, so a slow send (a big file) answers
 * "sending" and updates the card when it is done.
 */
export async function onCardTap(tap: CardTap) {
  const v = tap.action?.value;
  if (v?.hub !== 'send_message' || !v.code) return undefined;
  const user = get<User>('SELECT * FROM users WHERE id = ?', tap.operator?.open_id ?? '');
  const locale = user ? localeOf(user.id) : config.defaultLocale;
  const toast = (type: 'info' | 'success' | 'error', content: string) => ({ toast: { type, content } });
  const row = get<{ user_id: string; state: string }>('SELECT user_id, state FROM lark_pending WHERE code = ? AND expires >= ?', v.code, now());
  if (!row) return toast('error', tr(locale, 'lark.card.expired'));
  if (!user || row.user_id !== user.id) return toast('error', tr(locale, 'lark.card.notYours'));
  const p = pendingOf(user.id).find((x) => x.code === v.code);
  if (!p) return toast('info', tr(locale, 'lark.card.handled'));
  const settled = (type: 'info' | 'success' | 'error', end: string) => ({ ...toast(type, end), card: { type: 'raw', data: card(user, p, end) } });
  if (v.choice === 'decline') {
    run("UPDATE lark_pending SET state = 'declined', payload = '' WHERE code = ?", p.code);
    return settled('info', tr(locale, 'lark.card.declined'));
  }
  let claimed: Waiting;
  try {
    claimed = claim(user, p.code);
  } catch (e) {
    return toast('error', (e as Error).message);
  }
  const outcome = deliver(user, claimed).then((r) => ({ ok: !!r.sent.length, end: sentLine(r, locale) }), (e: Error) => ({ ok: false, end: tr(locale, 'lark.card.failed', { reason: e.message }) }));
  const quick = await Promise.race([outcome, new Promise<null>((ok) => setTimeout(ok, 2500, null))]);
  if (quick) return settled(quick.ok ? 'success' : 'error', quick.end);
  void outcome.then((o) => { if (p.card) void updateCard(p.card, user, p, o.end); });
  return settled('info', tr(locale, 'lark.card.sending'));
}
