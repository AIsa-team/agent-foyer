/**
 * What happened on the hub today (company time zone), for the home page: apps and Skills that were published or
 * updated, limited to what the viewer can open (the rings), and the colleagues who used the hub (the fireflies).
 */
import { config } from './config.ts';
import { all, get, type App, type User } from './db.ts';
import { canAccessApp } from './apps/access.ts';
import { localize } from './localized.ts';

/** Midnight today in the company time zone, as epoch ms. */
export function startOfToday(at = Date.now()): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(at)).map((x) => [x.type, Number(x.value)]));
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offset = wall - Math.floor(at / 1000) * 1000;   // how far the zone's wall clock is ahead of UTC
  return Date.UTC(p.year, p.month - 1, p.day) - offset;
}

export interface PulseEvent { kind: 'appNew' | 'appUpdated' | 'skillNew' | 'skillUpdated'; name: string; who: string; at: number; url: string }

export function homePulse(user: User, locale: string): { people: number; who: { id: string; name: string; at: number }[]; count: number; events: PulseEvent[] } {
  const from = startOfToday();
  const nameOf = (id: string) => get<{ name: string }>('SELECT name FROM users WHERE id = ?', id)?.name ?? '';
  const events: PulseEvent[] = [];

  // the latest release of each app today; the first release of an app is a new app
  const releases = all<{ app_slug: string; version: number; created_by: string; created_at: number }>(
    `SELECT r.app_slug, r.version, r.created_by, r.created_at FROM app_releases r
     WHERE r.created_at >= ? AND r.status IN ('online', 'superseded')
       AND r.id = (SELECT MAX(id) FROM app_releases x WHERE x.app_slug = r.app_slug AND x.created_at >= ? AND x.status IN ('online', 'superseded'))`, from, from);
  for (const r of releases) {
    const app = get<App>('SELECT * FROM apps WHERE slug = ?', r.app_slug);
    if (!app || app.status !== 'online' || !canAccessApp(app, user)) continue;
    const first = !get('SELECT 1 FROM app_releases WHERE app_slug = ? AND created_at < ?', app.slug, from);
    events.push({ kind: first ? 'appNew' : 'appUpdated', name: localize(app, app.i18n, locale).name, who: nameOf(r.created_by), at: r.created_at, url: `/apps/${app.slug}` });
  }

  const skills = all<{ slug: string; name: string; description: string; i18n: string | null; owner_id: string; created_at: number; updated_at: number }>(
    'SELECT slug, name, description, i18n, owner_id, created_at, updated_at FROM skills WHERE updated_at >= ? AND (listed = 1 OR owner_id = ?)', from, user.id);
  for (const s of skills) {
    events.push({ kind: s.created_at >= from ? 'skillNew' : 'skillUpdated', name: localize(s, s.i18n, locale).name, who: nameOf(s.owner_id), at: s.updated_at, url: `/skills/${s.slug}` });
  }

  // anyone who opened the hub, an app or used their agent today, with when they were last seen
  const active = all<{ id: string; at: number }>(
    `SELECT id, MAX(at) AS at FROM (
       SELECT id, last_seen_at AS at FROM users WHERE last_seen_at >= ?
       UNION ALL SELECT user_id, last_used_at FROM agent_connections WHERE last_used_at >= ?
       UNION ALL SELECT user_id, ? FROM app_visits WHERE day >= ?)
     GROUP BY id ORDER BY at DESC`,
    from, from, from, new Date(from).toISOString().slice(0, 10));
  if (!active.some((p) => p.id === user.id)) active.unshift({ id: user.id, at: Date.now() });
  const people = active.slice(0, 24).map((p) => ({ id: p.id, name: nameOf(p.id), at: p.at }));

  return { people: active.length, who: people, count: events.length, events: events.sort((a, b) => b.at - a.at).slice(0, 10) };
}
