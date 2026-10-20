import { get, type App, type User } from '../db.ts';
import { isCollaborator } from '../collab.ts';

/** Publish, change settings, handle feedback: the owner, collaborators and admins. */
export function canManageApp(app: App, user: User): boolean {
  return canAdministerApp(app, user) || isCollaborator('app', app.slug, user.id);
}

/** Delete it, choose collaborators, hand it over: the owner and admins. */
export function canAdministerApp(app: App, user: User): boolean {
  return app.owner_id === user.id || user.role === 'admin';
}

/** user is undefined for anonymous visitors. */
export function canAccessApp(app: App, user: User | undefined): boolean {
  if (app.visibility === 'public' && app.public_status === 'approved') return true;
  if (!user) return false;
  if (canManageApp(app, user)) return true;
  switch (app.visibility) {
    case 'private':
      return false;
    case 'members':
      return !!get('SELECT 1 FROM app_members WHERE app_slug = ? AND user_id = ?', app.slug, user.id);
    case 'company':
    case 'public': // public while waiting for approval behaves like company
      return true;
  }
}
