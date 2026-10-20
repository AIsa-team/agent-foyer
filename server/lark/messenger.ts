import type { Messenger } from '../notify.ts';
import { getTenantToken } from './auth.ts';
import { larkFetch } from './client.ts';

/** Text messages from the hub's Lark bot (needs im:message:send_as_bot). People by open_id, groups by chat_id. */
async function send(type: 'open_id' | 'chat_id', id: string, text: string) {
  await larkFetch(`/im/v1/messages?receive_id_type=${type}`, {
    method: 'POST', token: await getTenantToken(), body: JSON.stringify({ receive_id: id, msg_type: 'text', content: JSON.stringify({ text }) }),
  });
}

export const larkMessenger: Messenger = {
  toPerson: (userId, text) => send('open_id', userId, text),
  toGroup: (groupId, text) => send('chat_id', groupId, text),
};
