/**
 * Several people looking after one app or Skill. The owner (or an admin) adds colleagues as collaborators, who can do
 * everything but delete it, change who the collaborators are, or hand it to someone else. Added people are told in
 * Lark; anyone can leave on their own.
 */
import { config } from './config.ts';
import { all, get, now, run, tx, type User } from './db.ts';
import { tr, UserError } from './i18n/index.ts';
import { localize } from './localized.ts';
import { messenger } from './notify.ts';
import { reshareLater } from './apps/resources.ts';

export type Kind = 'app' | 'skill';
export interface Collaborator { id: string; name: string; avatar: string | null; role: 'owner' | 'collaborator' }

export const isCollaborator = (kind: Kind, slug: string, userId: string) =>
  !!get('SELECT 1 FROM collaborators WHERE kind = ? AND slug = ? AND user_id = ?', kind, slug, userId);

/** Slugs this person collaborates on (not the ones they own). */
export const collaboratingOn = (kind: Kind, userId: string) =>
  new Set(all<{ slug: string }>('SELECT slug FROM collaborators WHERE kind = ? AND user_id = ?', kind, userId).map((r) => r.slug));

interface Thing { ownerId: string; name: (locale: string) => string; link: string }

function thing(kind: Kind, slug: string): Thing {
  const row = get<{ owner_id: string; name: string; description: string; i18n: string | null }>(
    `SELECT owner_id, name, description, i18n FROM ${kind === 'app' ? 'apps' : 'skills'} WHERE slug = ?`, slug);
  if (!row) throw new UserError(kind === 'app' ? 'err.appNotFound' : 'err.skill.notFound', { slug });
  return { ownerId: row.owner_id, name: (L) => localize(row, row.i18n, L).name, link: `${config.hubUrl}/${kind === 'app' ? 'apps' : 'skills'}/${slug}` };
}

/** The owner first, then collaborators in the order they were added. */
export function collaboratorsOf(kind: Kind, slug: string): Collaborator[] {
  const t = thing(kind, slug);
  const owner = get<{ id: string; name: string; avatar: string | null }>('SELECT id, name, avatar FROM users WHERE id = ?', t.ownerId);
  const rest = all<{ id: string; name: string; avatar: string | null }>(
    'SELECT u.id, u.name, u.avatar FROM collaborators c JOIN users u ON u.id = c.user_id WHERE c.kind = ? AND c.slug = ? ORDER BY c.added_at', kind, slug);
  return [...(owner ? [{ ...owner, role: 'owner' as const }] : []), ...rest.map((p) => ({ ...p, role: 'collaborator' as const }))];
}

async function tell(userId: string, text: (locale: string) => string) {
  if (!messenger) return;
  const locale = get<{ locale: string | null }>('SELECT locale FROM users WHERE id = ?', userId)?.locale ?? config.defaultLocale;
  try {
    await messenger.toPerson(userId, text(locale));
  } catch (e) {
    console.warn('[collab] could not message', userId, (e as Error).message);
  }
}

const kindName = (L: string, kind: Kind) => tr(L, kind === 'app' ? 'collab.kind.app' : 'collab.kind.skill');

/**
 * Adds and removes collaborators (user ids). Only the owner or an admin may change the list; anyone may remove
 * themselves. Returns the list afterwards.
 */
export function setCollaborators(user: User, kind: Kind, slug: string, change: { add?: string[]; remove?: string[] }): Collaborator[] {
  const t = thing(kind, slug);
  const administers = t.ownerId === user.id || user.role === 'admin';
  const add = [...new Set(change.add ?? [])];
  const remove = [...new Set(change.remove ?? [])];
  if (!administers && (add.length || remove.some((id) => id !== user.id))) throw new UserError('err.collab.ownerOnly');
  if (!administers && remove.length && !isCollaborator(kind, slug, user.id)) throw new UserError('err.collab.ownerOnly');
  const added: string[] = [];
  tx(() => {
    for (const id of add) {
      const person = get<{ id: string; name: string }>('SELECT id, name FROM users WHERE id = ?', id);
      if (!person) throw new UserError('err.collab.unknownUser', { id });
      if (id === t.ownerId) throw new UserError('err.collab.isOwner', { name: person.name });
      if (run('INSERT OR IGNORE INTO collaborators (kind, slug, user_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)', kind, slug, id, user.id, now()).changes) added.push(id);
    }
    for (const id of remove) run('DELETE FROM collaborators WHERE kind = ? AND slug = ? AND user_id = ?', kind, slug, id);
  });
  if (kind === 'app') reshareLater(user, slug);
  for (const id of added) {
    if (id === user.id) continue;
    void tell(id, (L) => tr(L, 'collab.msg.added', { name: user.name, kind: kindName(L, kind), target: t.name(L), url: t.link }));
  }
  return collaboratorsOf(kind, slug);
}

/** Hands it to another colleague, who becomes the owner; the previous owner stays on as a collaborator. */
export function transferOwnership(user: User, kind: Kind, slug: string, toUserId: string): Collaborator[] {
  const t = thing(kind, slug);
  if (t.ownerId !== user.id && user.role !== 'admin') throw new UserError('err.collab.ownerOnly');
  if (!get('SELECT 1 FROM users WHERE id = ?', toUserId)) throw new UserError('err.collab.unknownUser', { id: toUserId });
  if (toUserId === t.ownerId) return collaboratorsOf(kind, slug);
  tx(() => {
    run(`UPDATE ${kind === 'app' ? 'apps' : 'skills'} SET owner_id = ?, updated_at = ? WHERE slug = ?`, toUserId, now(), slug);
    run('DELETE FROM collaborators WHERE kind = ? AND slug = ? AND user_id = ?', kind, slug, toUserId);
    run('INSERT OR IGNORE INTO collaborators (kind, slug, user_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)', kind, slug, t.ownerId, user.id, now());
  });
  if (toUserId !== user.id) void tell(toUserId, (L) => tr(L, 'collab.msg.owner', { name: user.name, kind: kindName(L, kind), target: t.name(L), url: t.link }));
  return collaboratorsOf(kind, slug);
}

/** Everyone who looks after it: messages about it (feedback, for one) go to all of them. */
export const keepers = (kind: Kind, slug: string) => collaboratorsOf(kind, slug).map((c) => c.id);
