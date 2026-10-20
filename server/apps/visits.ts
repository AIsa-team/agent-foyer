/** Who opens which app: counted per person per day, so owners and colleagues can see whether an app is used. */
import { all, get, run, type App } from '../db.ts';

const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

const seen = new Set<string>();
/** Called by the gateway for every signed-in request; one row per app, person and day. */
export function recordVisit(slug: string, userId: string) {
  const key = `${today()}|${slug}|${userId}`;
  if (seen.has(key)) return;
  if (seen.size > 50_000) seen.clear();
  seen.add(key);
  run('INSERT OR IGNORE INTO app_visits (app_slug, user_id, day) VALUES (?, ?, ?)', slug, userId, today());
}

/** People who opened each app in the last 30 days (owners not counted). */
export function usageBySlug(): Map<string, number> {
  const rows = all<{ app_slug: string; n: number }>(
    `SELECT v.app_slug, COUNT(DISTINCT v.user_id) AS n FROM app_visits v JOIN apps a ON a.slug = v.app_slug
     WHERE v.day >= ? AND v.user_id != a.owner_id GROUP BY v.app_slug`, daysAgo(30));
  return new Map(rows.map((r) => [r.app_slug, r.n]));
}

/** For the app's owner: people per day over the last 30 days, and everyone who has opened it. */
export function usageDetail(app: App) {
  const from = daysAgo(29);
  const perDay = new Map(all<{ day: string; n: number }>(
    'SELECT day, COUNT(*) AS n FROM app_visits WHERE app_slug = ? AND day >= ? AND user_id != ? GROUP BY day', app.slug, from, app.owner_id,
  ).map((r) => [r.day, r.n]));
  const days = Array.from({ length: 30 }, (_, i) => daysAgo(29 - i)).map((day) => ({ day, people: perDay.get(day) ?? 0 }));
  const total = get<{ n: number }>('SELECT COUNT(DISTINCT user_id) AS n FROM app_visits WHERE app_slug = ? AND user_id != ?', app.slug, app.owner_id)!.n;
  return { days, last30: usageBySlug().get(app.slug) ?? 0, total };
}
