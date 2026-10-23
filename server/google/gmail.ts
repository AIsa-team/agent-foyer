import { config } from '../config.ts';
import type { User } from '../db.ts';
import { buildEml, type Draft } from '../eml.ts';
import { googleAccessToken, googleConnection } from './auth.ts';

/** Saves a draft in the person's Gmail (never sends), from the Google account they connected. */
export async function createGmailDraft(user: User, d: Draft): Promise<{ draftId: string; url: string }> {
  const from = googleConnection(user.id).email ?? user.email ?? '';
  const raw = Buffer.from(buildEml(from, d, '\r\n')).toString('base64url');
  const res = await fetch(`${config.google.gmailBase}/gmail/v1/users/me/drafts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await googleAccessToken(user)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { raw } }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: { id?: string }; error?: { message?: string } };
  if (!res.ok || !body.id) throw new Error(`Gmail draft failed: ${body.error?.message ?? res.status}`);
  return { draftId: body.id, url: `https://mail.google.com/mail/u/0/#drafts?compose=${body.message?.id ?? ''}` };
}
