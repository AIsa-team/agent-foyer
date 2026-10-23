/**
 * Email drafts for apps: saved in the person's own mailbox, never sent. Where depends on the company's mail
 * (MAIL_DRAFTS): Gmail through each person's Google connection, or Lark Mail through their Lark connection.
 */
import { config } from './config.ts';
import type { User } from './db.ts';
import { createGmailDraft } from './google/gmail.ts';
import { googleConnectUrl, googleConnection } from './google/auth.ts';
import { createDraft as createLarkDraft } from './lark/mail.ts';
import type { Draft } from './eml.ts';

export type { Draft };

/** "Gmail" or "Lark Mail", for the consent screen and the app page. */
export const mailboxName = () => (config.mailDrafts === 'google' ? 'Gmail' : config.mailDrafts === 'lark' ? 'Lark Mail' : '');

/** Where to send the person before drafts can be saved for them (Lark's mail access is part of "connect Lark data"). */
export function mailConnectUrl(user: User, returnPath: string): string | null {
  if (config.mailDrafts === 'google' && !googleConnection(user.id).connected) return googleConnectUrl(returnPath);
  return null;
}

export async function saveDraft(user: User, d: Draft): Promise<{ draftId: string; url?: string }> {
  return config.mailDrafts === 'google' ? createGmailDraft(user, d) : createLarkDraft(user, d);
}
