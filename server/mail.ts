/**
 * Email drafts for apps: saved in the person's own mailbox, never sent. Where depends on the company's mail
 * (MAIL_DRAFTS): Gmail through each person's Google connection, or Lark Mail through their Lark connection.
 */
import { config } from './config.ts';
import type { User } from './db.ts';
import { integrations } from './integrations.ts';
import type { Draft } from './eml.ts';

export type { Draft };

/** The mailbox the company picked (MAIL_DRAFTS names the integration that brings it), if any. */
const mailbox = () => integrations.find((i) => i.id === config.mailDrafts)?.mailbox;

/** "Gmail" or "Lark Mail", for the consent screen and the app page. */
export const mailboxName = () => mailbox()?.name ?? '';

/** Where to send the person before drafts can be saved for them. */
export function mailConnectUrl(user: User, returnPath: string): string | null {
  return mailbox()?.connectUrl(user, returnPath) ?? null;
}

export async function saveDraft(user: User, d: Draft): Promise<{ draftId: string; url?: string }> {
  const box = mailbox();
  if (!box) throw new Error('no mailbox for drafts on this hub (MAIL_DRAFTS)');
  return box.saveDraft(user, d);
}
