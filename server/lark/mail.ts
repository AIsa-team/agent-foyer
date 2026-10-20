/**
 * Saving an email as a draft in the person's own Lark mailbox (never sending it). Lark takes the whole message as
 * EML, base64url-encoded: LF line breaks, non-ASCII headers RFC 2047 encoded, non-ASCII bodies base64.
 * Needs the user scopes in MAIL_SCOPES.
 */
import { randomBytes } from 'node:crypto';
import type { User } from '../db.ts';
import { UserError } from '../i18n/index.ts';
import { LarkError, SCOPE_CODES } from './client.ts';
import { asUser } from './userToken.ts';

export const MAIL_SCOPES = ['mail:user_mailbox.message:modify', 'mail:user_mailbox:readonly'];

export interface Draft { to: string[]; cc?: string[]; bcc?: string[]; subject: string; html?: string; text?: string }

const header = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v).toString('base64')}?=`);
const lines76 = (b64: string, nl: string) => b64.match(/.{1,76}/g)?.join(nl) ?? '';
const clean = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();

/** The whole message as EML. Lark wants LF line breaks; Gmail takes CRLF. */
export function buildEml(from: string, d: Draft, nl = '\n'): string {
  const id = `${Date.now()}.${randomBytes(6).toString('hex')}@hub`;
  const head = [
    `Subject: ${header(clean(d.subject))}`,
    `From: ${from}`,
    'MIME-Version: 1.0',
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${id}>`,
    ...(d.to.length ? [`To: ${d.to.join(', ')}`] : []),
    ...(d.cc?.length ? [`Cc: ${d.cc.join(', ')}`] : []),
    ...(d.bcc?.length ? [`Bcc: ${d.bcc.join(', ')}`] : []),
  ];
  const part = (type: string, body: string) => [`Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', lines76(Buffer.from(body).toString('base64'), nl)].join(nl);
  if (d.html && d.text) {
    const boundary = `hub-${randomBytes(8).toString('hex')}`;
    return [...head, `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
      `--${boundary}`, part('text/plain', d.text), `--${boundary}`, part('text/html', d.html), `--${boundary}--`, ''].join(nl);
  }
  return [...head, part(d.html ? 'text/html' : 'text/plain', d.html ?? d.text ?? ''), ''].join(nl);
}

async function call<T>(user: User, path: string, init?: RequestInit): Promise<T> {
  try {
    return await asUser<T>(user, path, init);
  } catch (e) {
    if (e instanceof LarkError && SCOPE_CODES.has(e.code)) throw new UserError('err.lark.scopeMissing', { detail: e.message });
    throw e;
  }
}

/** Creates the draft as the person, from their own primary address. Returns the draft id. */
export async function createDraft(user: User, d: Draft): Promise<{ draftId: string }> {
  const profile = await call<{ data: { primary_email_address?: string } }>(user, '/mail/v1/user_mailboxes/me/profile');
  const from = profile.data.primary_email_address;
  if (!from) throw new UserError('err.mail.noLarkMailbox');
  const raw = Buffer.from(buildEml(from, d)).toString('base64url');
  const r = await call<{ data: { draft_id?: string; draft?: { draft_id?: string } } }>(user, '/mail/v1/user_mailboxes/me/drafts', { method: 'POST', body: JSON.stringify({ raw }) });
  return { draftId: r.data.draft_id ?? r.data.draft?.draft_id ?? '' };
}
