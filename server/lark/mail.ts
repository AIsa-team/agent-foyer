/**
 * Saving an email as a draft in the person's own Lark mailbox (never sending it). Lark takes the whole message as
 * EML (see ../eml.ts), base64url-encoded, with LF line breaks. Needs the user scopes in MAIL_SCOPES.
 */
import type { User } from '../db.ts';
import { buildEml, type Draft } from '../eml.ts';
import { UserError } from '../i18n/index.ts';
import { LarkError, SCOPE_CODES } from './client.ts';
import { asUser } from './userToken.ts';

export const MAIL_SCOPES = ['mail:user_mailbox.message:modify', 'mail:user_mailbox:readonly'];

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
