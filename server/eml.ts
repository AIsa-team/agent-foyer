/**
 * An email as one EML message, for saving drafts in a mailbox (Lark Mail, Gmail): non-ASCII headers RFC 2047
 * encoded, non-ASCII bodies base64, plain text and HTML as alternatives when both are given.
 */
import { randomBytes } from 'node:crypto';

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
