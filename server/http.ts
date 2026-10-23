/** What the hub's API handlers share: the signed-in person on the context, the request's language, JSON bodies, admin checks. */
import type { Context } from 'hono';
import type { User } from './db.ts';
import { requestLocale, UserError } from './i18n/index.ts';

export type HubEnv = { Variables: { user: User } };

export const localeOf = (c: Context) => requestLocale((h) => c.req.header(h));
export const body = async <T>(c: Context) => (await c.req.json().catch(() => ({}))) as T;
export const requireAdmin = (u: User) => {
  if (u.role !== 'admin') throw new UserError('err.adminOnly');
};
