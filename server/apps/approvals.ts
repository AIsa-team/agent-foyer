/**
 * Opening an app to everyone on the internet needs an admin. Admins are messaged when someone asks; the owner is
 * messaged when an admin decides. Without a chat tool, the request waits on the Admin page as before.
 */
import { config } from '../config.ts';
import { all, get, type App, type User } from '../db.ts';
import { tr } from '../i18n/index.ts';
import { localize } from '../localized.ts';
import { messenger } from '../notify.ts';

async function tell(userId: string, text: (locale: string) => string) {
  if (!messenger) return;
  const locale = get<{ locale: string | null }>('SELECT locale FROM users WHERE id = ?', userId)?.locale ?? config.defaultLocale;
  try {
    await messenger.toPerson(userId, text(locale));
  } catch (e) {
    console.warn('[approvals] could not message', userId, (e as Error).message);
  }
}

export function publicRequested(app: App, by: User) {
  for (const { id } of all<{ id: string }>("SELECT id FROM users WHERE role = 'admin'")) {
    if (id === by.id) continue;
    void tell(id, (L) => tr(L, 'approval.msg.requested', { name: by.name, app: localize(app, app.i18n, L).name, url: `${app.slug}.${config.appsDomain}`, admin: `${config.hubUrl}/admin` }));
  }
}

export function publicDecided(slug: string, approved: boolean, admin: User) {
  const app = get<App>('SELECT * FROM apps WHERE slug = ?', slug);
  if (!app || app.owner_id === admin.id) return;
  void tell(app.owner_id, (L) => tr(L, approved ? 'approval.msg.approved' : 'approval.msg.rejected', {
    app: localize(app, app.i18n, L).name, admin: admin.name, url: `${config.hubUrl}/apps/${slug}`,
  }));
}
