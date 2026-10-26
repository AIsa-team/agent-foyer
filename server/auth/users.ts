import { config } from '../config.ts';
import { all, get, now, run, tx, type User } from '../db.ts';

/** Who signed in, as the sign-in provider (Lark, OIDC, dev) describes them. `id` is the provider's stable id. */
export interface Identity {
  id: string; name: string; enName?: string; email?: string; avatar?: string;
  /** false when the provider did not say the email was verified: it then cannot make someone an admin */
  emailVerified?: boolean;
}

/** Creates or refreshes a person. The first person ever, and anyone listed in HUB_ADMINS, is an admin. */
export function upsertUser(info: Identity, touch = true): User {
  const email = info.email || null;
  return tx(() => {
    const isFirst = !get('SELECT 1 FROM users LIMIT 1');
    const isConfiguredAdmin = config.admins.includes(info.id) || (!!email && info.emailVerified !== false && config.admins.includes(email));
    run(
      `INSERT INTO users (id, name, en_name, email, avatar, role, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, en_name = excluded.en_name, email = excluded.email,
         avatar = excluded.avatar, last_seen_at = COALESCE(excluded.last_seen_at, users.last_seen_at),
         role = CASE WHEN ? THEN 'admin' ELSE users.role END`,
      info.id, info.name, info.enName ?? null, email, info.avatar ?? null,
      isFirst || isConfiguredAdmin ? 'admin' : 'member', now(), touch ? now() : null, isConfiguredAdmin ? 1 : 0,
    );
    return get<User>('SELECT * FROM users WHERE id = ?', info.id)!;
  });
}

/** Fake people for local development without a Lark app; removed again once Lark login is configured. */
export function seedDevUsers() {
  if (!config.devLogin) {
    run(`DELETE FROM users WHERE id LIKE 'ou_dev_%'
         AND NOT EXISTS (SELECT 1 FROM apps WHERE owner_id = users.id) AND NOT EXISTS (SELECT 1 FROM skills WHERE owner_id = users.id)`);
    return;
  }
  if (all('SELECT 1 FROM users LIMIT 1').length) return;
  const people = [
    { id: 'ou_dev_alex', name: 'Alex', email: 'alex@example.com' },
    { id: 'ou_dev_alice', name: '林小雨', email: 'alice@example.com' },
    { id: 'ou_dev_bob', name: '周明', email: 'bob@example.com' },
  ];
  for (const p of people) upsertUser(p, false);
}
