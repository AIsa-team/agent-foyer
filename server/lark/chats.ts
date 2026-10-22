import { UserError } from '../i18n/index.ts';
import { getTenantToken } from './auth.ts';
import { larkFetch } from './client.ts';

/** Lark groups the hub's bot is in (needs im:chat:readonly), for admins choosing where the hub posts. */
export async function botChats(): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let page = '';
  try {
    for (let i = 0; i < 10; i++) {
      const r = await larkFetch<{ data: { items?: { chat_id: string; name: string }[]; has_more?: boolean; page_token?: string } }>(
        `/im/v1/chats?page_size=100${page ? `&page_token=${encodeURIComponent(page)}` : ''}`, { token: await getTenantToken() });
      out.push(...(r.data.items ?? []).map((c) => ({ id: c.chat_id, name: c.name })));
      if (!r.data.has_more || !r.data.page_token) break;
      page = r.data.page_token;
    }
  } catch (e) {
    if (/99991672|scope/i.test((e as Error).message)) throw new UserError('err.lark.chatsScope', { scope: 'im:chat:readonly' });
    throw e;
  }
  return out;
}
