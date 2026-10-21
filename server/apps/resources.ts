/**
 * Lark Bases and documents the hub set up for an app. They are shared with whoever may open the app (its owner,
 * collaborators and members, or the whole company), and re-shared when that changes.
 */
import { all, get, now, run, type App, type User } from '../db.ts';
import { shareWithAudience, type DriveKind } from '../lark/workspace.ts';

export interface Resource { kind: DriveKind; token: string; name: string; url: string }

export function appResources(slug: string): Resource[] {
  return all<Resource>('SELECT kind, token, name, url FROM app_resources WHERE app_slug = ? ORDER BY created_at', slug);
}

export function recordResource(app: App, user: User, r: Resource) {
  run(`INSERT INTO app_resources (app_slug, kind, token, name, url, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_slug, token) DO UPDATE SET name = excluded.name, url = excluded.url`, app.slug, r.kind, r.token, r.name, r.url, user.id, now());
}

/** Remembers a Base the hub created for the person, so it can be tied to an app that declares it later. */
export function rememberCreated(user: User, r: Resource) {
  run(`INSERT INTO lark_created (token, kind, name, url, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(token) DO NOTHING`, r.token, r.kind, r.name, r.url, user.id, now());
}

/**
 * Bases among `tokens` that the hub created for the app's owner or a collaborator and that are not yet the app's:
 * they become the app's and are shared with its audience. This is what lets an agent create the Base before
 * publishing the app.
 */
export async function adoptCreated(user: User, app: App, tokens: string[]) {
  const keepers = new Set([app.owner_id, ...all<{ user_id: string }>("SELECT user_id FROM collaborators WHERE kind = 'app' AND slug = ?", app.slug).map((r) => r.user_id)]);
  const mine = new Set(appResources(app.slug).map((r) => r.token));
  const adopted: Resource[] = [];
  const failed: string[] = [];
  for (const token of new Set(tokens)) {
    if (mine.has(token)) continue;
    const c = get<Resource & { created_by: string }>('SELECT kind, token, name, url, created_by FROM lark_created WHERE token = ?', token);
    if (!c || !keepers.has(c.created_by)) continue;
    const r: Resource = { kind: c.kind, token: c.token, name: c.name, url: c.url };
    recordResource(app, user, r);
    failed.push(...(await shareAppResources(user, app.slug, r)).failed);
    adopted.push(r);
  }
  return { adopted, failed };
}

/** Everyone who should be able to edit what the app keeps: members of a members-only app plus its owner and collaborators. */
export function audience(app: App) {
  const members = [
    app.owner_id,
    ...all<{ user_id: string }>('SELECT user_id FROM app_members WHERE app_slug = ?', app.slug).map((r) => r.user_id),
    ...all<{ user_id: string }>("SELECT user_id FROM collaborators WHERE kind = 'app' AND slug = ?", app.slug).map((r) => r.user_id),
  ];
  // owners and collaborators always need access, even when the app itself is private
  const visibility = app.visibility === 'private' && members.length > 1 ? 'members' : app.visibility;
  return { visibility, members: [...new Set(members)] };
}

/** Shares one resource (or all of the app's) as the app's audience says; failures are returned, not thrown. */
export async function shareAppResources(user: User, slug: string, only?: Resource) {
  const app = get<App>('SELECT * FROM apps WHERE slug = ?', slug);
  if (!app) return { shared: 0, failed: [] as string[] };
  const failed: string[] = [];
  let shared = 0;
  for (const r of only ? [only] : appResources(slug)) {
    try {
      const res = await shareWithAudience(user, r.kind, r.token, audience(app));
      failed.push(...res.failed.map((id) => `${r.name}: ${get<{ name: string }>('SELECT name FROM users WHERE id = ?', id)?.name ?? id}`));
      shared++;
    } catch (e) {
      failed.push(`${r.name}: ${(e as Error).message}`);
    }
  }
  return { shared, failed };
}

/** After who-can-open changes: re-share in the background, as the person who made the change. */
export function reshareLater(user: User, slug: string) {
  if (!appResources(slug).length) return;
  void shareAppResources(user, slug).then((r) => {
    if (r.failed.length) console.warn('[app-resources]', slug, r.failed.join('; '));
  });
}
