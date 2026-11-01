/**
 * Google as an integration of the hub (integration.ts): each person's own Google connection, used by apps that save
 * email drafts in their Gmail (when the company's mail is Gmail: MAIL_DRAFTS=google).
 */
import { config } from '../config.ts';
import type { Integration } from '../integration.ts';
import { finishGoogleConnect, forgetGoogle, googleAuthorize, googleConnection, googleConnectUrl } from './auth.ts';
import { createGmailDraft } from './gmail.ts';

const available = () => config.mailDrafts === 'google';

export const google: Integration = {
  id: 'google',
  enabled: available,
  connect: {
    available,
    authorize: (user, state) => googleAuthorize(user, state),
    finish: (user, code, verifier) => finishGoogleConnect(user, code, verifier ?? ''),
    denied: 'err.google.scopeDenied',
  },
  mailbox: {
    name: 'Gmail',
    connectUrl: (user, returnPath) => (googleConnection(user.id).connected ? null : googleConnectUrl(returnPath)),
    saveDraft: createGmailDraft,
  },
  api(r) {
    r.get('/google/status', (c) => c.json({ ...googleConnection(c.get('user').id), available: available(), connectUrl: googleConnectUrl('/me') }));
    r.post('/google/disconnect', (c) => {
      forgetGoogle(c.get('user').id);
      return c.json({ ok: true });
    });
  },
};
